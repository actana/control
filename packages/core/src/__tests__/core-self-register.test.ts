import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  localDialHost,
  localEndpoint,
  registerSelfWithLocalCli,
  type SelfRegistrationMaterial,
} from "../core-self-register";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { verifyBearer } from "@actana/shared/core-link-bearer";
import { registryPaths, writeCoreBlob, writeCurrentCore } from "@actana/shared/blob-registry";

// #288 D9, criterion 3. On metal `actana setup` registers the Core it just
// installed with the CLI on the same machine; in a container `setup` is refused
// and the daemon is the only program that ever holds the material, so it does
// its own wiring at boot. Without it `actana core ls` inside the image is empty
// and every `actana session …` there answers `no Core registered` — on the one
// machine that is unambiguously standing on a Core, and the machine the Core
// installed the `actana-sessions` skill onto.

const material: SelfRegistrationMaterial = {
  caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
  clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
  clientKey: "-----BEGIN PRIVATE KEY-----\nCLIENTKEY\n-----END PRIVATE KEY-----",
  bearerSecret: "deadbeef".repeat(8),
  coreId: "core_abcdef0123456789",
};

let home: string;

const register = (overrides: Partial<Parameters<typeof registerSelfWithLocalCli>[0]> = {}) =>
  registerSelfWithLocalCli({
    material,
    bindHost: "0.0.0.0",
    port: 8443,
    label: "core-01",
    bearerDays: 365,
    env: {},
    home,
    ...overrides,
  });

const paths = () => registryPaths({}, home);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-self-register-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a containerised Core registers itself with its own machine's CLI (#288 D9)", () => {
  it("writes the blob into the registry and selects it", () => {
    const result = register();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wiring).toEqual({ name: "core-01", selected: true, keptSelection: null });
    expect(fs.readFileSync(path.join(home, ".config/actana/current.txt"), "utf8").trim()).toBe(
      "core-01",
    );
    // The same 0600 every credential in this registry is written at: the file
    // holds a client key and a signed bearer, not a preference.
    const blobFile = path.join(home, ".config/actana/cores/core-01.txt");
    expect(fs.statSync(blobFile).mode & 0o777).toBe(0o600);
  });

  it("registers a blob the CLI can actually use", () => {
    const result = register();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = fs.readFileSync(path.join(home, ".config/actana/cores/core-01.txt"), "utf8");
    const blob = decodeRegistrationBlob(stored);
    expect(blob).not.toBeNull();
    expect(blob?.endpoint).toBe("wss://127.0.0.1:8443");
    expect(blob?.label).toBe("core-01");
    expect(blob?.clientCert).toBe(material.clientCert);
    // The bearer is signed here rather than copied from anywhere, so the entry
    // carries a full lease from this boot — the same property the printed blob
    // has, for the same reason.
    expect(verifyBearer(blob!.bearer, material.bearerSecret)).toMatchObject({
      coreId: material.coreId,
    });
  });

  it("dials the loopback address, not the host a Panel dials", () => {
    // `ACTANA_PUBLIC_HOST` is the address *other* machines use, and inside the
    // container it may not route at all. Every server cert's SAN carries
    // 127.0.0.1 (`core-cert-material.ts`) so this dial verifies.
    expect(localDialHost("0.0.0.0")).toBe("127.0.0.1");
    expect(localDialHost("")).toBe("127.0.0.1");
    // The IPv6 wildcard too: a dual-stack listener answers the v4 loopback, and
    // `::1` is in no SAN this product mints.
    expect(localDialHost("::")).toBe("127.0.0.1");
    // A daemon bound to one address is dialled on that address — the only one
    // it answers — and an IPv6 literal is bracketed before it can be a URL.
    expect(localDialHost("10.0.0.5")).toBe("10.0.0.5");
    expect(localEndpoint("fd00::5", 8443)).toBe("wss://[fd00::5]:8443");

    const result = register({ bindHost: "10.0.0.5" });
    expect(result.ok && result.endpoint).toBe("wss://10.0.0.5:8443");
  });

  it("names the Core after its label, and falls back when the label cannot be one", () => {
    expect(register({ label: "web 01" }).ok && fs.existsSync(path.join(home, ".config/actana/cores/web-01.txt"))).toBe(true);
    expect(register({ label: "" }).ok && fs.existsSync(path.join(home, ".config/actana/cores/local.txt"))).toBe(true);
  });

  it("does not clobber a selection the operator made", () => {
    // The rule `wireLocalCore` carries and this module adds nothing to: an
    // operator who pointed this machine's CLI at a *different* Core gets the
    // local one registered and named, not silently switched under them.
    writeCoreBlob(paths(), "elsewhere", "not-a-real-blob");
    writeCurrentCore(paths(), "elsewhere");

    const result = register();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wiring).toEqual({
      name: "core-01",
      selected: false,
      keptSelection: "elsewhere",
    });
    expect(fs.existsSync(path.join(home, ".config/actana/cores/core-01.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".config/actana/current.txt"), "utf8").trim()).toBe(
      "elsewhere",
    );
  });

  it("re-registers on a later boot, so a volume older than this repairs itself", () => {
    // Not gated on the boot that mints: a volume created before this existed
    // has material and a `registration-blob.txt` but no registry entry, and a
    // Core that wired itself only once would never fix one. Idempotent, and the
    // bearer is fresh each time.
    const first = register();
    const second = register();
    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.wiring.selected).toBe(true);
    expect(fs.readdirSync(path.join(home, ".config/actana/cores"))).toEqual(["core-01.txt"]);
  });

  it("honours XDG_CONFIG_HOME, because the registry does", () => {
    const xdg = path.join(home, "xdg");
    const result = register({ env: { XDG_CONFIG_HOME: xdg } });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(xdg, "actana/cores/core-01.txt"))).toBe(true);
  });

  it("reports a registry it cannot write instead of failing the boot", () => {
    // Serving Panels does not depend on this. A read-only home, or one owned by
    // somebody else, is a line in the log — the Core comes up either way and the
    // pairing token in the volume still works from anywhere.
    fs.mkdirSync(path.join(home, ".config"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/actana"), "not a directory");

    const result = register();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
  });
});
