// The `core` noun, end to end through `runActanaCli` — dispatch, flags, output,
// `--json` shape and exit codes (#129 D10).

import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { coreBlobPath, readCurrentCore } from "../blob-registry.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../exit-codes.ts";
import { healthyProbe, makeCliFixture, sentinelBlobText, type CliFixture } from "./cli-harness.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** Write a blob file somewhere the fixture can hand it to `core add`. */
function blobFile(name = "blob.txt", endpoint?: string): string {
  const dir = path.join(cli().home, "blobs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `${sentinelBlobText(endpoint)}\n`);
  return file;
}

describe("actana core add", () => {
  it("takes a file", async () => {
    const run = await cli().run(["core", "add", "prod", blobFile()]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain('Added Core "prod"');
    expect(statSync(coreBlobPath(cli().paths, "prod")).mode & 0o777).toBe(0o600);
  });

  it("takes stdin, with or without the conventional `-`", async () => {
    const piped = sentinelBlobText("wss://piped.test:9444");
    const bare = await cli().run(["core", "add", "prod"], { stdin: piped });
    expect(bare.code).toBe(EXIT_OK);

    const dashed = await cli().run(["core", "add", "second", "-"], { stdin: piped });
    expect(dashed.code).toBe(EXIT_OK);
    expect(dashed.out.join("\n")).toContain("wss://piped.test:9444");
  });

  it("refuses to hang when there is no file and nothing piped", async () => {
    // Reading a TTY here would look exactly like a hang, with no prompt.
    const run = await cli().run(["core", "add", "prod"], { stdinIsTty: true });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("nothing is piped in");
  });

  it("makes the first Core `current`, and leaves the pointer alone after that", async () => {
    await cli().run(["core", "add", "first", blobFile("a.txt")]);
    expect(readCurrentCore(cli().paths)).toBe("first");

    const second = await cli().run(["core", "add", "second", blobFile("b.txt")]);
    expect(readCurrentCore(cli().paths)).toBe("first");
    expect(second.out.join("\n")).toContain("`current` is still \"first\"");
  });

  it("replaces a stored blob, which is what a reissued credential needs", async () => {
    await cli().run(["core", "add", "prod", blobFile("a.txt", "wss://old.test:9444")]);
    const again = await cli().run(["core", "add", "prod", blobFile("b.txt", "wss://new.test:9444")]);
    expect(again.code).toBe(EXIT_OK);
    expect(again.out.join("\n")).toContain('Replaced Core "prod"');
    expect(again.out.join("\n")).toContain("wss://new.test:9444");
  });

  it("rejects a name that could become a different path", async () => {
    const run = await cli().run(["core", "add", "../escape", blobFile()]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("Core name");
  });

  it("rejects a blob that is not one, without quoting it back", async () => {
    const run = await cli().run(["core", "add", "prod"], { stdin: "this is not a blob" });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.all).not.toContain("this is not a blob");
  });

  it("rejects a ws:// endpoint — mTLS is mandatory for a Core (ADR 0002)", async () => {
    const downgraded = Buffer.from(
      JSON.stringify({
        endpoint: "ws://core.test:9444",
        caCert: "x",
        clientCert: "x",
        clientKey: "x",
        bearer: "x",
      }),
    ).toString("base64");
    const run = await cli().run(["core", "add", "prod"], { stdin: downgraded });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("wss://");
  });

  it("reports an unreadable file by path, and does not register anything", async () => {
    const run = await cli().run(["core", "add", "prod", "/nowhere/blob.txt"]);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("/nowhere/blob.txt");
    expect(readCurrentCore(cli().paths)).toBeNull();
  });
});

describe("actana core ls", () => {
  it("says so, helpfully, when nothing is registered", async () => {
    const run = await cli().run(["core", "ls"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("No Cores registered");
  });

  it("emits an empty array for --json rather than prose", async () => {
    const run = await cli().run(["core", "ls", "--json"]);
    expect(JSON.parse(run.out.join("\n"))).toEqual([]);
  });

  it("tabulates the registry and marks `current`", async () => {
    await cli().run(["core", "add", "prod", blobFile("a.txt", "wss://prod.test:9444")]);
    await cli().run(["core", "add", "dev", blobFile("b.txt", "wss://dev.test:9444")]);

    const run = await cli().run(["core", "ls"]);
    expect(run.out[0]).toContain("NAME");
    expect(run.out.join("\n")).toContain("wss://prod.test:9444");
    const prodRow = run.out.find((line) => line.startsWith("prod"))!;
    expect(prodRow).toContain("*");
    expect(run.out.find((line) => line.startsWith("dev"))).not.toContain("*");
  });

  it("emits machine-readable rows for --json", async () => {
    await cli().run(["core", "add", "prod", blobFile("a.txt", "wss://prod.test:9444")]);
    const run = await cli().run(["core", "ls", "--json"]);

    expect(run.code).toBe(EXIT_OK);
    const rows = JSON.parse(run.out.join("\n"));
    expect(rows).toEqual([
      {
        name: "prod",
        current: true,
        endpoint: "wss://prod.test:9444",
        label: "the-test-core",
        insecureMode: false,
        error: null,
      },
    ]);
  });

  it("keeps a corrupt entry in the listing, with the reason on the row", async () => {
    await cli().run(["core", "add", "good", blobFile()]);
    mkdirSync(cli().paths.coresDir, { recursive: true });
    writeFileSync(coreBlobPath(cli().paths, "broken"), "not-a-blob");

    const run = await cli().run(["core", "ls", "--json"]);
    const rows = JSON.parse(run.out.join("\n"));
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["broken", "good"]);
    expect(rows[0].error).toBeTruthy();
    expect(rows[0].endpoint).toBeNull();
  });
});

describe("actana core use / rm", () => {
  it("moves the pointer", async () => {
    await cli().run(["core", "add", "first", blobFile("a.txt")]);
    await cli().run(["core", "add", "second", blobFile("b.txt")]);

    const run = await cli().run(["core", "use", "second"]);
    expect(run.code).toBe(EXIT_OK);
    expect(readCurrentCore(cli().paths)).toBe("second");
  });

  it("refuses to point at a Core this machine does not have, and lists what it does", async () => {
    await cli().run(["core", "add", "first", blobFile("a.txt")]);
    const run = await cli().run(["core", "use", "absent"]);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("first");
  });

  it("drops the pointer with the Core it named", async () => {
    await cli().run(["core", "add", "only", blobFile()]);
    const run = await cli().run(["core", "rm", "only"]);

    expect(run.code).toBe(EXIT_OK);
    expect(readCurrentCore(cli().paths)).toBeNull();
    expect(run.out.join("\n")).toContain("no Cores are registered");
  });

  it("leaves the pointer alone when it removes a different Core", async () => {
    await cli().run(["core", "add", "first", blobFile("a.txt")]);
    await cli().run(["core", "add", "second", blobFile("b.txt")]);

    await cli().run(["core", "rm", "second"]);
    expect(readCurrentCore(cli().paths)).toBe("first");
  });

  it("fails rather than reporting success for a Core it never had", async () => {
    const run = await cli().run(["core", "rm", "absent"]);
    expect(run.code).toBe(EXIT_FAILURE);
  });
});

describe("actana core status", () => {
  it("reaches the Core and reports the version it answered with", async () => {
    await cli().run(["core", "add", "prod", blobFile("a.txt", "wss://prod.test:9444")]);
    const run = await cli().run(["core", "status"], {
      probe: healthyProbe({ protocolVersion: "1.2.3", coreId: "core_abc" }),
    });

    expect(run.code).toBe(EXIT_OK);
    const text = run.out.join("\n");
    expect(text).toContain("1.2.3");
    expect(text).toContain("core_abc");
    expect(text).toContain("wss://prod.test:9444");
    expect(text).toContain("the `current` pointer");
  });

  it("emits the same facts as --json", async () => {
    await cli().run(["core", "add", "prod", blobFile("a.txt", "wss://prod.test:9444")]);
    const run = await cli().run(["core", "status", "--json"], {
      probe: healthyProbe({ protocolVersion: "1.2.3", coreId: "core_abc" }),
    });

    expect(JSON.parse(run.out.join("\n"))).toEqual({
      name: "prod",
      source: "current",
      endpoint: "wss://prod.test:9444",
      reachable: true,
      coreId: "core_abc",
      protocolVersion: "1.2.3",
      compatible: true,
      multiConnection: true,
      bearerExpiresAt: Date.UTC(2030, 0, 1),
    });
  });

  it("fails, and says the Core did not answer, when the dial throws", async () => {
    await cli().run(["core", "add", "prod", blobFile()]);
    const run = await cli().run(["core", "status", "--json"], {
      probe: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:9444");
      },
    });

    expect(run.code).toBe(EXIT_FAILURE);
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.reachable).toBe(false);
    expect(payload.error).toContain("ECONNREFUSED");
  });

  it("fails on a protocol this build does not speak, rather than degrading", async () => {
    await cli().run(["core", "add", "prod", blobFile()]);
    const run = await cli().run(["core", "status"], {
      probe: healthyProbe({ protocolVersion: "99.0.0", compatible: false }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("does not");
  });

  it("honours --core over the pointer", async () => {
    await cli().run(["core", "add", "pointed", blobFile("a.txt", "wss://pointed.test:9444")]);
    await cli().run(["core", "add", "flagged", blobFile("b.txt", "wss://flagged.test:9444")]);

    const run = await cli().run(["core", "status", "--json", "--core", "flagged"], {
      probe: healthyProbe(),
    });
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.name).toBe("flagged");
    expect(payload.source).toBe("flag");
    expect(payload.endpoint).toBe("wss://flagged.test:9444");
  });

  it("reports single-Core mode as unnamed rather than inventing a name", async () => {
    const run = await cli().run(["core", "status", "--json"], {
      env: { ACTANA_CORE_BLOB: sentinelBlobText("wss://env.test:9444") },
      probe: healthyProbe(),
    });
    const payload = JSON.parse(run.out.join("\n"));
    expect(payload.name).toBeNull();
    expect(payload.source).toBe("env");
  });

  it("fails with the three sources named when no Core is selected", async () => {
    const run = await cli().run(["core", "status"]);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("ACTANA_CORE_BLOB");
  });
});

describe("actana core shell", () => {
  it("is built, and no longer answers `not built yet`", async () => {
    // #162 turned the reserved verb into a command. What it does with a
    // terminal is `core-shell.test.ts`; all this asserts is that the dispatch
    // reaches it — a run with no Core selected fails like every other verb that
    // needs one, rather than reporting a ticket number.
    const run = await cli().run(["core", "shell"]);
    expect(run.code).not.toBe(EXIT_UNIMPLEMENTED);
    expect(run.err.join("\n")).not.toContain("not built yet");
  });

  it("is listed in the noun's help", async () => {
    const run = await cli().run(["core", "--help"]);
    expect(run.out.join("\n")).toContain("actana core shell");
  });
});

describe("usage errors", () => {
  it("names an unknown verb and lists the ones there are", async () => {
    const run = await cli().run(["core", "frobnicate"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("add, ls, use, rm, status, shell");
  });

  it("prints the noun's help, and fails, when the verb is missing", async () => {
    const run = await cli().run(["core"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toContain("actana core add");
  });

  it("takes flags before the positionals too", async () => {
    await cli().run(["core", "add", "prod", blobFile()]);
    const run = await cli().run(["--json", "core", "ls"]);
    expect(Array.isArray(JSON.parse(run.out.join("\n")))).toBe(true);
  });
});
