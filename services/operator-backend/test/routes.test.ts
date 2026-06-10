// DEX-105 regression: the hand-rolled node:http router dispatches via inline
// `if (method === "X" && path === "/y")` blocks. Before the fix, three routes
// were registered twice (POST /v1/orders/match, GET /v1/orders/book, GET
// /v1/prices) so the second handler was dead. This test statically scans the
// router source and asserts no (method, exact-path) pair appears more than
// once, which would shadow the later handler.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const routerSrc = readFileSync(
  join(here, "../src/http/index.ts"),
  "utf8",
);

// Match `method === "POST"` ... `path === "/v1/..."` guard pairs on the same
// statement. The router always writes the method check immediately before the
// exact-path check, so a simple regex over the source is faithful.
function exactRouteGuards(src: string): string[] {
  const re =
    /method === "(GET|POST|PUT|DELETE|PATCH)"\s*&&\s*path === "([^"]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

describe("DEX-105: no duplicate route registration", () => {
  it("each (method, exact-path) guard appears at most once", () => {
    const guards = exactRouteGuards(routerSrc);
    const seen = new Map<string, number>();
    for (const g of guards) seen.set(g, (seen.get(g) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    assert.deepEqual(
      dupes,
      [],
      `duplicate route guards shadow later handlers: ${JSON.stringify(dupes)}`,
    );
  });

  it("keeps the read preview and execute routes distinct", () => {
    const guards = exactRouteGuards(routerSrc);
    assert.ok(
      guards.includes("GET /v1/orders/matches"),
      "read-only match preview moved to GET /v1/orders/matches",
    );
    assert.ok(
      guards.includes("POST /v1/orders/match"),
      "execute path stays at POST /v1/orders/match",
    );
  });

  it("registers the matched-trade settlement routes", () => {
    const guards = exactRouteGuards(routerSrc);
    for (const route of [
      "POST /v1/matched-trades/request-allocations",
      "POST /v1/matched-trades/settle",
      "POST /v1/matched-trades/cancel",
    ]) {
      assert.ok(guards.includes(route), `missing route: ${route}`);
    }
  });
});
