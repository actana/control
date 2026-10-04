import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_KEY_ROUTES, acceptsApiKey } from "../api-key-auth";

/**
 * The OpenAPI 3 document for `/api/v1` (#572 PR 2) must name every public
 * route the router accepts a key on, and every path+method in the document
 * must be a key route. No new dependency: the document is plain JSON.
 */

type OpenApi = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
};

const doc = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../openapi/v1.json"), "utf8"),
) as OpenApi;

/** Turn `/api/v1/cores/{coreId}/agents` into a concrete path the allowlist regexes accept. */
function examplePath(template: string): string {
  return template.replace(/\{[^}]+\}/g, "x");
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

describe("OpenAPI v1", () => {
  it("is OpenAPI 3 and lists only /api/v1 paths", () => {
    expect(doc.openapi.startsWith("3.")).toBe(true);
    for (const p of Object.keys(doc.paths)) {
      expect(p.startsWith("/api/v1/")).toBe(true);
    }
  });

  it("every documented path+method is accepted as a key route", () => {
    const missing: string[] = [];
    for (const [template, ops] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        if (!(method in ops)) continue;
        const pathname = examplePath(template);
        if (!acceptsApiKey(method.toUpperCase(), pathname)) {
          missing.push(`${method.toUpperCase()} ${template} (as ${pathname})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every /api/v1 key route is in the OpenAPI document", () => {
    const documented = new Set<string>();
    for (const [template, ops] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        if (method in ops) documented.add(`${method.toUpperCase()} ${template}`);
      }
    }
    const v1Routes = API_KEY_ROUTES.filter((r) => r.pattern.source.includes("api\\/v1\\/"));
    // Concrete samples that cover each v1 allowlist entry.
    const samples: Array<{ method: string; path: string; template: string }> = [
      { method: "GET", path: "/api/v1/cores", template: "/api/v1/cores" },
      { method: "GET", path: "/api/v1/cores/x", template: "/api/v1/cores/{coreId}" },
      { method: "GET", path: "/api/v1/cores/x/agents", template: "/api/v1/cores/{coreId}/agents" },
      { method: "GET", path: "/api/v1/agents", template: "/api/v1/agents" },
      { method: "POST", path: "/api/v1/agents", template: "/api/v1/agents" },
      { method: "GET", path: "/api/v1/agents/x", template: "/api/v1/agents/{agentId}" },
      { method: "DELETE", path: "/api/v1/agents/x", template: "/api/v1/agents/{agentId}" },
      { method: "GET", path: "/api/v1/tasks", template: "/api/v1/tasks" },
      { method: "POST", path: "/api/v1/tasks", template: "/api/v1/tasks" },
      { method: "GET", path: "/api/v1/tasks/x", template: "/api/v1/tasks/{taskId}" },
      { method: "POST", path: "/api/v1/tasks/x/status", template: "/api/v1/tasks/{taskId}/status" },
      { method: "GET", path: "/api/v1/tasks/x/comments", template: "/api/v1/tasks/{taskId}/comments" },
      { method: "POST", path: "/api/v1/tasks/x/comments", template: "/api/v1/tasks/{taskId}/comments" },
    ];
    for (const s of samples) {
      expect(acceptsApiKey(s.method, s.path), `${s.method} ${s.path}`).toBe(true);
      expect(documented.has(`${s.method} ${s.template}`), `${s.method} ${s.template}`).toBe(true);
    }
    // Every v1 allowlist entry matches at least one sample.
    for (const route of v1Routes) {
      const hit = samples.some((s) => s.method === route.method && route.pattern.test(s.path));
      expect(hit, `${route.method} ${route.pattern}`).toBe(true);
    }
  });
});
