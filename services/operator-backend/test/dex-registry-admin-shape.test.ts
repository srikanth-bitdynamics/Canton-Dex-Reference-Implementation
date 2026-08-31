// A trading pair carries full per-instrument identity: base and quote each name
// their own registry admin via `InstrumentId { admin, id }`, so a pair can span
// two registries. The standalone per-venue `admin` field is gone.
//
// A settled TransferLeg still names its instrument by bare Text, so the admins
// are recovered from on-ledger pool/order state, not the leg. Pinned here so the
// schema and the docs cannot silently drift apart.
//
// Flip MULTI_ADMIN_PAIRS_SUPPORTED back only if the schema regresses to a single
// shared admin; both directions of drift then fail here.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT,
  docFiles,
  fieldType,
  findClaims,
  formatHits,
  partyFields,
} from "./docs-harness.ts";

/** Base and quote carry independent admins. See the file header. */
export const MULTI_ADMIN_PAIRS_SUPPORTED = true;

const DEX = "trading/CantonDex/Dex";

before(() => {
  // An absence rule is trivially satisfied by an empty corpus.
  assert.ok(
    docFiles().length >= 20,
    `expected the docs corpus to be intact, found ${docFiles().length} markdown files`,
  );
});

describe("registry admin shape", () => {
  it("no venue template carries a standalone admin party", () => {
    // The per-venue `admin` field is gone; each instrument's admin now lives on
    // its own InstrumentId. Only the workflow parties remain typed `Party`.
    for (const [file, template, expected] of [
      [`${DEX}/DexPair.daml`, "DexPair", ["operator"]],
      [`${DEX}/Order.daml`, "Order", ["operator", "trader"]],
    ] as const) {
      assert.deepEqual(
        partyFields(file, template),
        expected,
        `${template}'s party fields changed. If a standalone admin returned, ` +
          `set MULTI_ADMIN_PAIRS_SUPPORTED = false and update the docs.`,
      );
    }
  });

  it("base and quote are structured InstrumentIds, each naming its own admin", () => {
    for (const field of ["baseInstrumentId", "quoteInstrumentId"]) {
      assert.match(
        fieldType(`${DEX}/DexPair.daml`, "DexPair", field),
        /InstrumentId/,
        `${field} is no longer a structured id; a pair could no longer span ` +
          `two registries.`,
      );
    }
  });

  it("the LP token id is structured too, so its admin can differ from base/quote", () => {
    // Every instrument on a pool is a structured id now; the LP token's admin is
    // the lpRegistrar, distinct from the traded instruments' admins.
    assert.match(
      fieldType(`${DEX}/Pool.daml`, "Pool", "lpInstrumentId"),
      /InstrumentId/,
      "Pool.lpInstrumentId must stay a structured id.",
    );
  });

  it("upstream transfer legs cannot carry their own admin", () => {
    // The root constraint: because the leg names its instrument by bare Text,
    // each leg's admin travels on the MatchedTrade.TradeLeg wrapper instead. If
    // this ever becomes structured upstream, that wrapper can be revisited.
    assert.equal(
      fieldType(
        "vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml",
        "TransferLeg",
        "instrumentId",
      ),
      "Text",
      "TransferLeg.instrumentId is no longer bare Text upstream; the reason " +
        "a trade cannot span two admins may no longer hold.",
    );
  });

  it("settlement plumbing is per-admin and cross-admin trades exercise it", () => {
    // MatchedTrade_Settle derives one batch per instrument admin. RFQ accept
    // tags each leg with its own instrument's admin, so a pair whose base and
    // quote are administered by different registries builds two batches — the
    // multi-admin path is reached, not merely inherited plumbing. Pinned so a
    // future cleanup does not collapse the seam.
    const src = readFileSync(join(ROOT, `${DEX}/MatchedTrade.daml`), "utf8");
    assert.match(
      src,
      /batchesByAdmin\s*:\s*Map\.Map Party/,
      "batchesByAdmin is the per-admin settlement seam; keep it.",
    );
  });

  it("no doc claims multi-registry pairs are supported", () => {
    if (MULTI_ADMIN_PAIRS_SUPPORTED) return;
    const hits = findClaims(
      /(?:does not assume the registry is a single party|multiple registrars[^.]{0,40}coexist|legs spanning two admins|pair of `?InstrumentId`?s? whose registries)/i,
      { negationAware: false },
    );
    assert.equal(
      hits.length,
      0,
      "Docs claim multi-registry pairs work, but every venue template carries " +
        "one shared admin and a transfer leg cannot name its own. Either " +
        "correct the docs, or implement it and set " +
        `MULTI_ADMIN_PAIRS_SUPPORTED = true.${formatHits(hits)}`,
    );
  });
});
