// The two environments a Core refuses to boot on (#348).
//
// The second of them is the security property of this file: a plaintext,
// unauthenticated core-link must never end up listening on an address other
// than this machine's own — and the way that happened in the field was not a
// mistake anybody made, but an auto-start LaunchAgent written before the
// Harness → Core rename, whose variables this daemon silently does not read.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isLoopbackHost,
  legacyEnvRefusal,
  legacyEnvVars,
  plaintextExposureRefusal,
} from "../core-boot-refusals";

/**
 * The environment the pre-rename LaunchAgent really sets.
 *
 * Three variables were renamed and three were not, and that split is the whole
 * bug: `AC_CORE_LINK_PORT`, `AC_CORE_LINK_HOST` and `AC_USER_DATA_DIR` are read
 * exactly as they always were, so the daemon comes up looking configured while
 * remote mode, the public host and the material file have all quietly vanished.
 */
const PRE_RENAME_PLIST_ENV: NodeJS.ProcessEnv = {
  AC_HARNESS_REMOTE: "1",
  AC_HARNESS_PUBLIC_HOST: "core1.example.com",
  AC_HARNESS_MATERIAL_FILE: "/Users/op/.config/actana/material.json",
  AC_CORE_LINK_PORT: "8443",
  AC_CORE_LINK_HOST: "0.0.0.0",
  AC_USER_DATA_DIR: "/Users/op/.local/share/actana/data",
};

describe("an environment left by a pre-rename install", () => {
  it("stops the boot, whichever of the old variables is set", () => {
    for (const name of ["AC_HARNESS_REMOTE", "AC_HARNESS_PUBLIC_HOST", "AC_HARNESS_MATERIAL_FILE"]) {
      expect(legacyEnvRefusal({ [name]: "1" })).toContain(name);
    }
  });

  it("stops on any `AC_HARNESS_` variable, not just the three that are known", () => {
    // The list is what one plist happened to set, not a specification. A
    // machine carrying a fourth is carrying the same stale service.
    expect(legacyEnvRefusal({ AC_HARNESS_SOMETHING_ELSE: "x" })).not.toBeNull();
  });

  it("names the rename and the command that fixes it, not just the variable", () => {
    const refusal = legacyEnvRefusal(PRE_RENAME_PLIST_ENV)!;
    expect(refusal).toMatch(/rename/i);
    expect(refusal).toContain("actana setup");
    // The operator has to be able to find the thing that set them.
    expect(refusal).toContain("com.actana.harness");
    expect(refusal).toContain("actana-harness.service");
  });

  it("lists every one it found, so a partial cleanup is visible", () => {
    expect(legacyEnvVars(PRE_RENAME_PLIST_ENV)).toEqual([
      "AC_HARNESS_MATERIAL_FILE",
      "AC_HARNESS_PUBLIC_HOST",
      "AC_HARNESS_REMOTE",
    ]);
  });

  it("says nothing about an environment written for this daemon", () => {
    expect(
      legacyEnvRefusal({
        AC_CORE_REMOTE: "1",
        AC_CORE_LINK_HOST: "0.0.0.0",
        AC_CORE_LINK_PORT: "8443",
        AC_CORE_MATERIAL_FILE: "/var/lib/actana/material.json",
        AC_CORE_PUBLIC_HOST: "core1.example.com",
      }),
    ).toBeNull();
    expect(legacyEnvRefusal({})).toBeNull();
  });
});

describe("plaintext core-link on a public interface", () => {
  it("is refused — no TLS, no client cert, no bearer, and every interface", () => {
    const refusal = plaintextExposureRefusal({ remoteMode: false, host: "0.0.0.0" })!;
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("0.0.0.0");
    expect(refusal).toContain("AC_CORE_REMOTE");
    expect(refusal).toMatch(/unauthenticated/i);
  });

  it("is refused on a LAN address and a hostname too, not only the wildcard", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "192.168.1.10", "core1.example.com"]) {
      expect(plaintextExposureRefusal({ remoteMode: false, host })).not.toBeNull();
    }
  });

  it("leaves a loopback Core exactly as it was", () => {
    for (const host of ["", "127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost", "LocalHost"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(plaintextExposureRefusal({ remoteMode: false, host })).toBeNull();
    }
  });

  it("leaves a real remote Core alone — that one has TLS, a CA and a bearer", () => {
    expect(plaintextExposureRefusal({ remoteMode: true, host: "0.0.0.0" })).toBeNull();
    expect(plaintextExposureRefusal({ remoteMode: true, host: "10.0.0.5" })).toBeNull();
  });

  it("cannot be reached silently from any (remote, host) combination", () => {
    // The property, stated over the whole space rather than over the cases
    // somebody thought of: if the server would be plaintext and reachable from
    // off this machine, there is a refusal. No combination serves it quietly.
    const hosts = ["", "127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "10.0.0.5", "core.local"];
    for (const remoteMode of [true, false]) {
      for (const host of hosts) {
        const plaintextAndExposed = !remoteMode && !isLoopbackHost(host);
        expect(plaintextExposureRefusal({ remoteMode, host }) !== null).toBe(plaintextAndExposed);
      }
    }
  });
});

describe("the machine in the report", () => {
  it("is refused twice over: the old variables, and what ignoring them produces", () => {
    // Both halves matter. The first is what a machine actually carries; the
    // second is what the daemon would do with it — `AC_CORE_REMOTE` is unset
    // there, so remote mode is off, while `AC_CORE_LINK_HOST` still says
    // 0.0.0.0 and `AC_CORE_LINK_PORT` still says 8443.
    expect(legacyEnvRefusal(PRE_RENAME_PLIST_ENV)).not.toBeNull();

    const remoteMode = PRE_RENAME_PLIST_ENV.AC_CORE_REMOTE === "1";
    const host = PRE_RENAME_PLIST_ENV.AC_CORE_LINK_HOST ?? "127.0.0.1";
    expect(remoteMode).toBe(false);
    expect(plaintextExposureRefusal({ remoteMode, host })).not.toBeNull();
  });
});

describe("the daemon's boot order", () => {
  const entry = fs.readFileSync(path.resolve(__dirname, "..", "core-entry.ts"), "utf8");

  /**
   * Asserted on the source, because there is nothing else to assert it on:
   * `startCore` is not exported and importing the module boots a daemon. A
   * refusal that ran after the server was constructed would still print the
   * right sentence and would still have listened, so the ordering is the
   * property — not the message.
   */
  it("refuses before it builds a server", () => {
    for (const guard of ["legacyEnvRefusal(process.env)", "plaintextExposureRefusal("]) {
      expect(entry).toContain(guard);
      expect(entry.indexOf(guard)).toBeLessThan(entry.indexOf("new PtyCoreLinkServer("));
    }
  });

  it("reads the old spellings nowhere else", () => {
    // The refusal is the only thing in the daemon that knows `AC_HARNESS_`
    // exists. A fallback would be the other possible fix and is the wrong one:
    // it would keep a plaintext 0.0.0.0 Core running on purpose.
    expect(entry).not.toMatch(/process\.env\.AC_HARNESS_/);
  });
});
