// The servers bind the configured port, not an OS-assigned one.
//
// startHttpServer accepts port 0 so tests can bind freely, which makes an
// accidental `port: 0` in a server entrypoint silently start on a random port
// that no proxy is pointed at.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

describe("server entrypoints", () => {
  for (const f of ["testnet-server.ts", "dev-server.ts"]) {
    it(`${f} passes the configured port`, () => {
      const s = readFileSync(join(SRC, f), "utf8");
      assert.match(
        s,
        /const port = Number\(process\.env\.PORT/,
        `${f} no longer reads PORT`,
      );
      assert.doesNotMatch(
        s,
        /startHttpServer\(\{[\s\S]{0,120}?port:\s*0\b/,
        `${f} binds port 0, so it will start on a random port and the ` +
          `reverse proxy will 502`,
      );
    });
  }
});
