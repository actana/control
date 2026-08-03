import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ACTANA_CONFIG_FILENAME,
  readActanaConfig,
  writeActanaConfig,
  endpointFor,
  type ActanaConfig,
} from "../actana-config";

let dir: string;

const config: ActanaConfig = {
  version: "0.49.0",
  port: 8443,
  host: "0.0.0.0",
  publicHost: "10.0.0.5",
  label: "prod-vm-1",
  installDir: "/home/op/.local/share/actana/versions/0.49.0",
  dataDir: "/home/op/.local/share/actana/data",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeActanaConfig / readActanaConfig", () => {
  it("round-trips what setup recorded", () => {
    writeActanaConfig(dir, config);
    expect(readActanaConfig(dir)).toEqual(config);
  });

  it("creates the config dir if it does not exist yet", () => {
    const nested = path.join(dir, "a", "b");
    writeActanaConfig(nested, config);
    expect(fs.existsSync(path.join(nested, ACTANA_CONFIG_FILENAME))).toBe(true);
  });

  it("overwrites on a re-run rather than appending a second install", () => {
    writeActanaConfig(dir, config);
    writeActanaConfig(dir, { ...config, version: "0.50.0" });
    expect(readActanaConfig(dir)?.version).toBe("0.50.0");
  });

  it("is readable JSON — an operator can look at what setup decided", () => {
    writeActanaConfig(dir, config);
    const raw = fs.readFileSync(path.join(dir, ACTANA_CONFIG_FILENAME), "utf8");
    expect(JSON.parse(raw).publicHost).toBe("10.0.0.5");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("holds no secrets — those stay in material.json", () => {
    writeActanaConfig(dir, config);
    const raw = fs.readFileSync(path.join(dir, ACTANA_CONFIG_FILENAME), "utf8");
    expect(raw).not.toMatch(/PRIVATE KEY|bearer|secret/i);
  });
});

describe("readActanaConfig", () => {
  it("is null when nothing is installed", () => {
    expect(readActanaConfig(dir)).toBeNull();
  });

  it("is null for corrupt JSON rather than throwing at the operator", () => {
    fs.writeFileSync(path.join(dir, ACTANA_CONFIG_FILENAME), "{not json");
    expect(readActanaConfig(dir)).toBeNull();
  });

  it("is null when a field is missing or wrong-typed", () => {
    const { port: _port, ...withoutPort } = config;
    fs.writeFileSync(path.join(dir, ACTANA_CONFIG_FILENAME), JSON.stringify(withoutPort));
    expect(readActanaConfig(dir)).toBeNull();

    fs.writeFileSync(
      path.join(dir, ACTANA_CONFIG_FILENAME),
      JSON.stringify({ ...config, port: "8443" }),
    );
    expect(readActanaConfig(dir)).toBeNull();
  });

  it("ignores unknown fields so an older CLI can read a newer file", () => {
    fs.writeFileSync(
      path.join(dir, ACTANA_CONFIG_FILENAME),
      JSON.stringify({ ...config, futureField: true }),
    );
    expect(readActanaConfig(dir)).toEqual(config);
  });
});

describe("endpointFor", () => {
  it("is the wss:// URL the Panel dials", () => {
    expect(endpointFor(config)).toBe("wss://10.0.0.5:8443");
  });

  it("brackets an IPv6 public host", () => {
    expect(endpointFor({ ...config, publicHost: "2001:db8::1" })).toBe("wss://[2001:db8::1]:8443");
  });

  it("does not double-bracket an already-bracketed host", () => {
    expect(endpointFor({ ...config, publicHost: "[2001:db8::1]" })).toBe(
      "wss://[2001:db8::1]:8443",
    );
  });
});
