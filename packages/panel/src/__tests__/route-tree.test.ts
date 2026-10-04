import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Issue 674: `cores.$coreId.workspace.tsx` was a child of `cores.$coreId.tsx`, whose page renders no <Outlet />, so the
// workspace matched but never painted. These tests read the file routes (the generated tree is built by CI, not
// committed) and work out each route's parent the way TanStack's file router does: the longest other route id that
// is a whole-segment prefix of it. A trailing `_` on a segment (`$coreId_`) opts a route out of that nesting.

const ROUTES_DIR = path.resolve(__dirname, "../routes");

/** Routes that have children and deliberately render no <Outlet />. Empty on purpose: add a line, with the reason,
 *  only when a route's children are meant to replace it rather than render inside it. */
const NO_OUTLET_ALLOWED: ReadonlySet<string> = new Set();

type RouteFile = { file: string; id: string; source: string };

function readRouteFiles(dir: string): RouteFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((file) => {
      const source = readFileSync(path.join(dir, file), "utf8");
      const id = /createFileRoute\(\s*"([^"]+)"/.exec(source)?.[1] ?? "__root__";
      return { file, id, source };
    });
}

function parentOf(id: string, ids: readonly string[]): string {
  let best = "__root__";
  let bestLen = 0;
  for (const other of ids) {
    // "/" is the index route and `__root__` has no path: neither can be a parent.
    if (other === "/" || other === "__root__" || other === id) continue;
    if (id.startsWith(`${other}/`) && other.length > bestLen) {
      best = other;
      bestLen = other.length;
    }
  }
  return best;
}

function routesWithoutOutlet(routes: readonly RouteFile[], allowed: ReadonlySet<string>): string[] {
  const ids = routes.map((r) => r.id);
  const parents = new Set(ids.map((id) => parentOf(id, ids)));
  return routes
    .filter((r) => parents.has(r.id) && !allowed.has(r.id) && !/\bOutlet\b/.test(r.source))
    .map((r) => r.file);
}

describe("route tree", () => {
  const routes = readRouteFiles(ROUTES_DIR);
  const ids = routes.map((r) => r.id);

  it("makes the Core workspace a sibling of the Core page, not its child", () => {
    const workspace = routes.find((r) => r.file.startsWith("cores.") && r.file.includes("workspace"));
    expect(workspace).toBeDefined();
    expect(parentOf(workspace!.id, ids)).toBe("__root__");
    expect(parentOf("/cores/$coreId", ids)).toBe("__root__");
  });

  it("has no route with child routes that renders no <Outlet />", () => {
    expect(routesWithoutOutlet(routes, NO_OUTLET_ALLOWED)).toEqual([]);
  });

  it("the guard catches the 0.5.0 layout (a workspace nested under a Core page with no Outlet)", () => {
    const old: RouteFile[] = [
      { file: "cores.$coreId.tsx", id: "/cores/$coreId", source: "export const Route = createFileRoute()" },
      { file: "cores.$coreId.workspace.tsx", id: "/cores/$coreId/workspace", source: "" },
    ];
    expect(parentOf("/cores/$coreId/workspace", old.map((r) => r.id))).toBe("/cores/$coreId");
    expect(routesWithoutOutlet(old, NO_OUTLET_ALLOWED)).toEqual(["cores.$coreId.tsx"]);
  });
});
