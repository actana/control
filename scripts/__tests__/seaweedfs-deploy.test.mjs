import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "../lib/panel-image.mjs";

// The optional SeaweedFS service (#566): behind a profile, pinned, and a role
// that confines a Core to its own prefix. No docker here — the compose file is
// read as text and the entrypoint is run on a rewritten copy, the way
// core-fs-prep.test.mjs does it.

const COMPOSE = fs.readFileSync(path.join(repoRoot, "deploy/docker-compose.yml"), "utf8");
const ENV_EXAMPLE = fs.readFileSync(path.join(repoRoot, "deploy/.env.example"), "utf8");
const ENTRYPOINT = path.join(repoRoot, "deploy/seaweedfs/entrypoint.sh");
const TEMPLATE = path.join(repoRoot, "deploy/seaweedfs/iam.json.tmpl");

/** The lines of one top-level compose service, by indentation. */
function serviceBlock(name) {
  const lines = COMPOSE.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break; // next service, top-level key or comment
    block.push(line);
  }
  return block.join("\n");
}

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const GOOD_ENV = {
  SEAWEEDFS_S3_ADMIN_ACCESS_KEY: "test-admin-access",
  SEAWEEDFS_S3_ADMIN_SECRET_KEY: "test-admin-secret-value",
  SEAWEEDFS_STS_SIGNING_KEY: "dGVzdC1zaWduaW5nLWtleS0zMi1jaGFyYWN0ZXJzLWxvbmc=",
  SEAWEEDFS_OIDC_ISSUER: "https://panel.example.test",
  SEAWEEDFS_OIDC_JWKS_URL: "https://panel.example.test/.well-known/jwks.json",
  SEAWEEDFS_OIDC_AUDIENCE: "actana-shared",
  SEAWEEDFS_BUCKET: "actana-shared",
  SEAWEEDFS_PREFIX: "cores",
};

/** Run the shipped entrypoint with its fixed paths pointed at a temp dir. */
function render(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seaweedfs-"));
  scratch.push(dir);
  const script = fs
    .readFileSync(ENTRYPOINT, "utf8")
    .replace("TEMPLATE=/seaweedfs-config/iam.json.tmpl", `TEMPLATE=${TEMPLATE}`)
    .replace("OUT_DIR=/run/seaweedfs", `OUT_DIR=${dir}/out`)
    .replace("chown -R seaweed:seaweed \"$OUT_DIR\"", ":")
    .replace('exec /entrypoint.sh "$@"', 'echo "HANDOVER $*"; echo "JWT=$WEED_JWT_FILER_SIGNING_KEY"');
  const copy = path.join(dir, "entrypoint.sh");
  fs.writeFileSync(copy, script, { mode: 0o755 });
  const result = spawnSync("sh", [copy, "server", "-s3"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  const outFile = path.join(dir, "out/iam.json");
  return { ...result, iam: fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null };
}

describe("compose: the seaweedfs service is opt-in", () => {
  const block = serviceBlock("seaweedfs");

  it("exists and sits behind the seaweedfs profile", () => {
    expect(block).not.toBeNull();
    expect(block).toMatch(/^ {4}profiles: \["seaweedfs"\]$/m);
  });

  it("leaves every existing service without a profile, so a plain up is unchanged", () => {
    for (const name of ["panel", "core-init", "core"]) {
      expect(serviceBlock(name), name).not.toBeNull();
      expect(serviceBlock(name), name).not.toMatch(/profiles:/);
    }
    // Nothing else may have gained a dependency on the optional service.
    for (const name of ["panel", "core-init", "core"]) {
      expect(serviceBlock(name), name).not.toMatch(/seaweedfs/);
    }
  });

  it("pins an exact version and its sha256 digest, never latest", () => {
    const image = block.match(/^ {4}image: (\S+)$/m)?.[1] ?? "";
    expect(image).toMatch(/^chrislusf\/seaweedfs:\d+\.\d+(\.\d+)?@sha256:[0-9a-f]{64}$/);
    expect(image).not.toMatch(/latest/);
  });

  it("pins 4.47 by its digest, a release more than a week old", () => {
    expect(block).toContain(
      "chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882",
    );
  });

  // The master, volume server and filer take no authentication, and a Core
  // shares this network. Only the S3 gateway may listen beyond loopback.
  it("binds everything except the S3 gateway to loopback", () => {
    const args = block
      .split("\n")
      .filter((l) => /^ {6}- -/.test(l))
      .map((l) => l.replace(/^ {6}- /, ""));
    expect(args).toContain("-ip=127.0.0.1");
    expect(args).toContain("-ip.bind=127.0.0.1");
    expect(args).toContain("-s3.ip.bind=0.0.0.0");
    expect(args.filter((a) => a.startsWith("-ip"))).toEqual(["-ip=127.0.0.1", "-ip.bind=127.0.0.1"]);
    expect(args.filter((a) => /^-(s3\.)?ip\.bind=/.test(a) && !a.startsWith("-s3."))).toEqual([
      "-ip.bind=127.0.0.1",
    ]);
    // Neither the service name nor a wildcard as the base address, and no
    // other component opted out of the loopback bind.
    expect(args.join(" ")).not.toMatch(/-ip=seaweedfs|-ip=0\.0\.0\.0|-(master|volume|filer)\.ip/);
    // The one published port is the S3 gateway's, on the host's loopback.
    expect(block).toMatch(/^ {6}- "127\.0\.0\.1:8333:8333"$/m);
    expect(block.match(/^ {6}- "\d/gm)).toHaveLength(1);
  });

  it("keeps the gateway's open gRPC port behind a generated JWT key", () => {
    const one = render(GOOD_ENV);
    const two = render(GOOD_ENV);
    const key = (o) => o.stdout.match(/^JWT=([0-9a-f]{64})$/m)?.[1];
    expect(key(one)).toBeTruthy();
    expect(key(two)).toBeTruthy();
    expect(key(one)).not.toBe(key(two));
    expect(fs.readFileSync(ENTRYPOINT, "utf8")).toMatch(/^export WEED_JWT_FILER_SIGNING_KEY$/m);
  });

  it("enables the S3 gateway and reads its IAM/STS config from the rendered file", () => {
    expect(block).toMatch(/^ {6}- -s3$/m);
    expect(block).toMatch(/-s3\.iam\.config=\/run\/seaweedfs\/iam\.json/);
    expect(block).toMatch(/-s3\.iam\.readOnly=true/);
  });

  it("takes the OIDC issuer and JWKS URL from variables, not from the file", () => {
    expect(block).toMatch(/SEAWEEDFS_OIDC_ISSUER=\$\{SEAWEEDFS_OIDC_ISSUER:-\}/);
    expect(block).toMatch(/SEAWEEDFS_OIDC_JWKS_URL=\$\{SEAWEEDFS_OIDC_JWKS_URL:-\}/);
  });

  it("never uses a required-variable form, which would break the plain up", () => {
    // Except the Panel's own database password (#567): the Panel needs its
    // Postgres on every plain `up`, so that one is meant to stop compose when
    // it is unset. Nothing of SeaweedFS's may be required.
    const withoutPanelDatabase = COMPOSE.replace(/\$\{AC_PANEL_DB_PASSWORD:\?[^}]*\}/g, "");
    expect(withoutPanelDatabase).not.toMatch(/\$\{[A-Z_]+:?\?/);
  });

  it("gives every secret variable an empty or placeholder default only", () => {
    for (const name of [
      "SEAWEEDFS_S3_ADMIN_ACCESS_KEY",
      "SEAWEEDFS_S3_ADMIN_SECRET_KEY",
      "SEAWEEDFS_STS_SIGNING_KEY",
    ]) {
      expect(block).toContain(`${name}=\${${name}:-}`);
      expect(ENV_EXAMPLE).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });
});

describe("the rendered IAM config", () => {
  const out = render(GOOD_ENV);
  const iam = out.iam ? JSON.parse(out.iam) : null;

  it("renders, and hands over to the image entrypoint with the args", () => {
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("HANDOVER server -s3");
    expect(out.iam).not.toContain("@@");
  });

  it("trusts the configured issuer and JWKS URL, and only the Panel's provider", () => {
    const [provider] = iam.providers;
    expect(iam.providers).toHaveLength(1);
    expect(provider.type).toBe("oidc");
    expect(provider.config.issuer).toBe(GOOD_ENV.SEAWEEDFS_OIDC_ISSUER);
    expect(provider.config.jwksUri).toBe(GOOD_ENV.SEAWEEDFS_OIDC_JWKS_URL);
    expect(provider.config.clientId).toBe(GOOD_ENV.SEAWEEDFS_OIDC_AUDIENCE);
    const [role] = iam.roles;
    expect(iam.roles).toHaveLength(1);
    expect(role.trustPolicy.Statement).toHaveLength(1);
    expect(role.trustPolicy.Statement[0].Principal).toEqual({ Federated: provider.name });
    expect(role.trustPolicy.Statement[0].Action).toEqual(["sts:AssumeRoleWithWebIdentity"]);
  });

  it("does not hard-code a host in the template", () => {
    const text = fs.readFileSync(TEMPLATE, "utf8");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("denies by default and attaches exactly one policy to the role", () => {
    expect(iam.policy.defaultEffect).toBe("Deny");
    expect(iam.roles[0].attachedPolicies).toEqual([iam.policies[0].name]);
    expect(iam.policies).toHaveLength(1);
  });

  it("limits every S3 statement to <prefix>/<core-id>/ through the token subject", () => {
    const statements = iam.policies[0].document.Statement;
    const s3 = statements.filter((s) => s.Action.some((a) => a.startsWith("s3:")));
    expect(s3.length).toBeGreaterThan(0);
    for (const s of s3) {
      expect(s.Effect).toBe("Allow");
      expect(s.Action.every((a) => a.startsWith("s3:") && !a.includes("*")), s.Sid).toBe(true);
    }
    const objects = s3.find((s) => s.Sid === "ObjectsUnderOwnPrefix");
    expect(objects.Resource).toEqual(["arn:aws:s3:::actana-shared/cores/${jwt:sub}/*"]);
    expect(objects.Action).not.toContain("s3:ListBucket");
    const list = s3.find((s) => s.Sid === "ListOwnPrefixOnly");
    expect(list.Resource).toEqual(["arn:aws:s3:::actana-shared"]);
    // The trailing slash is the point: without it `core-a` lists `core-ab`.
    expect(list.Condition).toEqual({
      StringLike: { "s3:prefix": ["cores/${jwt:sub}/*"] },
    });
    expect(JSON.stringify(list.Condition)).not.toMatch(/\$\{jwt:sub\}"/);
  });

  it("has no statement on every resource", () => {
    const text = JSON.stringify(iam.policies[0].document);
    expect(text).not.toContain("sts:ValidateSession");
    for (const statement of iam.policies[0].document.Statement) {
      expect(statement.Resource).not.toContain("*");
    }
  });

  it("grants no wildcard action and no bucket-management action", () => {
    const text = JSON.stringify(iam.policies[0].document);
    expect(text).not.toMatch(/"s3:\*"|"\*"\s*[,\]].*Action/);
    expect(text).not.toMatch(/CreateBucket|DeleteBucket|PutBucketPolicy|ListAllMyBuckets/);
  });
});

describe("the entrypoint fails closed", () => {
  for (const name of Object.keys(GOOD_ENV)) {
    it(`refuses to start without ${name}`, () => {
      const out = render({ ...GOOD_ENV, [name]: "" });
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain(name);
      expect(out.iam).toBeNull();
    });
  }

  it("refuses a placeholder value", () => {
    const out = render({ ...GOOD_ENV, SEAWEEDFS_S3_ADMIN_SECRET_KEY: "change-me" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("placeholder");
  });

  it("refuses a signing key that is not base64", () => {
    const out = render({ ...GOOD_ENV, SEAWEEDFS_STS_SIGNING_KEY: "not base64 not base64 not base64 not base64 !!" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("base64");
  });

  it("refuses a signing key shorter than 32 bytes of base64", () => {
    const out = render({ ...GOOD_ENV, SEAWEEDFS_STS_SIGNING_KEY: "c2hvcnQ=" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("SEAWEEDFS_STS_SIGNING_KEY");
  });

  for (const prefix of ["/cores", "cores/", "co*res", "../cores", "a//b"]) {
    it(`refuses the prefix ${JSON.stringify(prefix)}`, () => {
      const out = render({ ...GOOD_ENV, SEAWEEDFS_PREFIX: prefix });
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain("SEAWEEDFS_PREFIX");
    });
  }

  it("refuses characters that would break out of the JSON or the sed expression", () => {
    for (const bad of ['a"b', "a|b", "a&b", "a\\b"]) {
      const out = render({ ...GOOD_ENV, SEAWEEDFS_OIDC_ISSUER: `https://x/${bad}` });
      expect(out.status, bad).not.toBe(0);
      expect(out.iam, bad).toBeNull();
    }
  });
});

describe("no secret is committed", () => {
  it("has no key material in the compose file, the template or .env.example", () => {
    for (const text of [COMPOSE, fs.readFileSync(TEMPLATE, "utf8"), ENV_EXAMPLE]) {
      expect(text).not.toContain(GOOD_ENV.SEAWEEDFS_STS_SIGNING_KEY);
      expect(text).not.toMatch(/SEAWEEDFS_[A-Z_]*(KEY|SECRET)=[^\s$]/);
      expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });
});

describe("the docs and the update path", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "deploy/seaweedfs/README.md"), "utf8");
  const dependabot = fs.readFileSync(path.join(repoRoot, ".github/dependabot.yml"), "utf8");

  it("names the case rule, the unescaped substitution and the trailing slash", () => {
    expect(readme).toMatch(/lowercase, or at least unique ignoring case/);
    expect(readme).toMatch(/without escaping/);
    expect(readme).toMatch(/`ListBucket prefix=cores\/core-a` \(no slash\) \| denied/);
    expect(readme).not.toMatch(/\(or `cores\/core-a`\)/);
  });

  it("does not claim the docker ecosystem moves the compose pin", () => {
    expect(COMPOSE).not.toMatch(/docker` ecosystem reads this file/);
    expect(readme).not.toMatch(/`docker` ecosystem\s+already watches/);
  });

  it("has a docker-compose Dependabot entry for /deploy, so the pin has an owner", () => {
    expect(dependabot).toMatch(/package-ecosystem: "docker-compose"\n\s+directory: "\/deploy"/);
    expect(dependabot).toMatch(/cooldown:\n\s+default-days: 7/);
  });

  it("lists seaweedfs-data where the volumes are documented", () => {
    for (const file of ["deploy/README.md", "DEPLOY.md"]) {
      expect(fs.readFileSync(path.join(repoRoot, file), "utf8"), file).toContain("seaweedfs-data");
    }
    expect(fs.readFileSync(path.join(repoRoot, "deploy/README.md"), "utf8")).not.toContain(
      "deletes the two named volumes",
    );
  });
});
