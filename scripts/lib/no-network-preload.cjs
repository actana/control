// Node preload (`node --require`) that takes the network away from a process, loopback aside.
//
// The Core tarball's claim is that an extracted tree needs nothing from the host: no system Node and
// no network (`scripts/smoke-core-tarball.mjs`). Sandboxing egress portably across Linux and macOS
// runners without privileges is not possible, so this does it inside the process, at the two places
// Node reaches out from: `net.Socket#connect` (every TCP, TLS, `fetch` and `ws` connection ends
// there) and `dns.lookup` (and its promise twin). Loopback, unix sockets and `localhost` pass: the
// bundled CLI dials the Core on this machine, and that is exactly what must keep working.
//
// Every refused attempt is appended, one line, to the file named by `ACTANA_NO_NETWORK_LOG`, and
// thrown as an `ENETUNREACH` error. The log is what a smoke asserts on: "the CLI worked" would also
// be true of a CLI that tried the network, failed, and carried on.
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const LOG = process.env.ACTANA_NO_NETWORK_LOG;

function isLoopback(host) {
  if (typeof host !== "string" || host === "") return true; // no host means this machine
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1" ||
    /^127\.\d+\.\d+\.\d+$/.test(bare) ||
    bare === "::ffff:127.0.0.1"
  );
}

function refuse(what, target) {
  const line = `${what} ${target}`;
  if (LOG) {
    try {
      fs.appendFileSync(LOG, `${line}\n`);
    } catch {
      /* the thrown error below is still the answer */
    }
  }
  const err = new Error(`network disabled for this process: ${line}`);
  err.code = "ENETUNREACH";
  return err;
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  let host;
  let isPath = false;
  if (options !== null && typeof options === "object") {
    isPath = typeof options.path === "string";
    host = options.host;
  } else if (typeof options === "number" || (typeof options === "string" && /^\d+$/.test(options))) {
    host = typeof args[1] === "string" ? args[1] : undefined;
  } else {
    isPath = typeof options === "string"; // connect(path)
  }
  if (!isPath && !isLoopback(host)) {
    const err = refuse("connect", `${host}:${options && options.port !== undefined ? options.port : args[0]}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
};

const realLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  if (!isLoopback(hostname) && !net.isIP(hostname)) {
    const cb = rest.find((arg) => typeof arg === "function");
    const err = refuse("lookup", hostname);
    if (cb) return process.nextTick(cb, err);
    throw err;
  }
  return realLookup.call(this, hostname, ...rest);
};

const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function lookup(hostname, ...rest) {
  if (!isLoopback(hostname) && !net.isIP(hostname)) return Promise.reject(refuse("lookup", hostname));
  return realPromiseLookup.call(this, hostname, ...rest);
};
