// The `core` noun, end to end through `runActanaCli` — dispatch, flags, output,
// `--json` shape and exit codes (#129 D10).

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { coreBlobPath, readCurrentCore } from "../blob-registry.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../exit-codes.ts";
import {
  healthyProbe,
  makeCliFixture,
  registerCore,
  sentinelBlobText,
  type CliFixture,
} from "./cli-harness.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/**
 * A Core in the registry, as a pairing leaves one.
 *
 * There used to be a `blobFile` helper here, and a whole `actana core add`
 * suite reading it back through a file, a `-` and a pipe. #287 deleted the verb
 * and this is what replaced the arrangement it did for every suite below —
 * `core-pair.test.ts` is where "a credential lands in the registry" is asserted
 * now, against the verb that actually puts one there.
 */
function haveCore(name: string, endpoint?: string): void {
  registerCore(cli().paths, name, sentinelBlobText(endpoint));
}

describe("actana core add", () => {
  // The removal itself, pinned. `add` was the client half of the hand-carry and
  // #280 took it out with no deprecation and no dual path, so the verb has to
  // be *unknown* — not hidden, not a stub that says "use pair", which would be
  // a compatibility shim with a nicer error message.
  it("is not a verb — the blob paste is gone (#287)", async () => {
    const run = await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain('unknown verb "add"');
    expect(run.err.join("\n")).toContain("pair");
    expect(readCurrentCore(cli().paths)).toBeNull();
  });

  it("is absent from the help, which offers pairing instead", async () => {
    const run = await cli().run(["core", "--help"]);
    expect(run.code).toBe(EXIT_OK);
    const help = run.out.join("\n");
    expect(help).not.toContain("core add");
    expect(help).not.toContain("blob file");
    expect(help).toContain("actana core pair");
  });

  it("leaves the registry it wrote readable by exactly its owner", async () => {
    haveCore("prod");
    expect(statSync(coreBlobPath(cli().paths, "prod")).mode & 0o777).toBe(0o600);
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
    haveCore("prod", "wss://prod.test:9444");
    haveCore("dev", "wss://dev.test:9444");

    const run = await cli().run(["core", "ls"]);
    expect(run.out[0]).toContain("NAME");
    expect(run.out.join("\n")).toContain("wss://prod.test:9444");
    const prodRow = run.out.find((line) => line.startsWith("prod"))!;
    expect(prodRow).toContain("*");
    expect(run.out.find((line) => line.startsWith("dev"))).not.toContain("*");
  });

  it("emits machine-readable rows for --json", async () => {
    haveCore("prod", "wss://prod.test:9444");
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
    haveCore("good");
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
    haveCore("first");
    haveCore("second");

    const run = await cli().run(["core", "use", "second"]);
    expect(run.code).toBe(EXIT_OK);
    expect(readCurrentCore(cli().paths)).toBe("second");
  });

  it("refuses to point at a Core this machine does not have, and lists what it does", async () => {
    haveCore("first");
    const run = await cli().run(["core", "use", "absent"]);
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("first");
  });

  it("drops the pointer with the Core it named", async () => {
    haveCore("only");
    const run = await cli().run(["core", "rm", "only"]);

    expect(run.code).toBe(EXIT_OK);
    expect(readCurrentCore(cli().paths)).toBeNull();
    expect(run.out.join("\n")).toContain("no Cores are registered");
  });

  it("leaves the pointer alone when it removes a different Core", async () => {
    haveCore("first");
    haveCore("second");

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
    haveCore("prod", "wss://prod.test:9444");
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
    haveCore("prod", "wss://prod.test:9444");
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
    haveCore("prod");
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
    haveCore("prod");
    const run = await cli().run(["core", "status"], {
      probe: healthyProbe({ protocolVersion: "99.0.0", compatible: false }),
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("does not");
  });

  it("honours --core over the pointer", async () => {
    haveCore("pointed", "wss://pointed.test:9444");
    haveCore("flagged", "wss://flagged.test:9444");

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
    expect(run.err.join("\n")).toContain("pair, ls, use, rm, status, shell");
  });

  it("prints the noun's help, and fails, when the verb is missing", async () => {
    const run = await cli().run(["core"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.out.join("\n")).toContain("actana core pair");
  });

  it("takes flags before the positionals too", async () => {
    haveCore("prod");
    const run = await cli().run(["--json", "core", "ls"]);
    expect(Array.isArray(JSON.parse(run.out.join("\n")))).toBe(true);
  });
});
