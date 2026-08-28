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

  it("testnet-server never enables the development write bypass", () => {
    const source = readFileSync(join(SRC, "testnet-server.ts"), "utf8");
    assert.match(source, /devOpen:\s*false/);
    assert.doesNotMatch(
      source,
      /devOpen:\s*process\.env\.DEX_DEV_OPEN/,
      "testnet-server must not honor the in-memory server's auth bypass",
    );
  });

  it("testnet-server never enables the arbitrary-command wallet relay", () => {
    const source = readFileSync(join(SRC, "testnet-server.ts"), "utf8");
    assert.match(source, /walletRelayEnabled:\s*false/);
    assert.doesNotMatch(
      source,
      /walletRelayEnabled:\s*process\.env\.DEX_DEV_WALLET_RELAY/,
      "testnet-server must not forward wallet commands under its participant JWT",
    );
  });

  it("testnet-server makes hosted trader-authority RFQ relay opt-in", () => {
    const source = readFileSync(join(SRC, "testnet-server.ts"), "utf8");
    assert.match(
      source,
      /hostedRfqEnabled\s*=\s*process\.env\.DEX_HOSTED_RFQ_RELAY\s*===\s*"1"/,
    );
    assert.match(source, /hostedRfqEnabled\s*&&\s*!callerJwtSecret/);
    assert.match(source, /readOnly\s*&&\s*hostedRfqEnabled/);
  });

  it("testnet-server uses the per-admin fixed self-registry adapter", () => {
    const source = readFileSync(join(SRC, "testnet-server.ts"), "utf8");
    assert.match(source, /class ConfiguredRegistry extends FixedRegistryClient/);
    assert.match(source, /super\(\(admin\)\s*=>/);
    assert.match(source, /factoriesByAdmin\.get\(admin\)/);
    assert.match(source, /registry:\s*new ConfiguredRegistry\(factoriesByAdmin\)/);
    assert.match(source, /required\("CANTON_LP_ALLOC_FACTORY_CID"\)/);
    assert.match(source, /required\("CANTON_LP_SETTLE_FACTORY_CID"\)/);
  });

  it("dev-server identifies seeded state as an in-memory preview", () => {
    const source = readFileSync(join(SRC, "dev-server.ts"), "utf8");
    assert.match(source, /network:\s*"preview:in-memory"/);
    assert.doesNotMatch(
      source,
      /network:\s*process\.env\.CANTON_NETWORK/,
      "The seeded server must not masquerade as a Canton network via an env label",
    );
  });
});
