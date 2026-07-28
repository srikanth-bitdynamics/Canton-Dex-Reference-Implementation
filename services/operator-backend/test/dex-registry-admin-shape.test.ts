// A trading pair carries ONE registry admin, shared by base and quote.
//
// TransferLeg.instrumentId is bare Text, so a leg cannot name its own admin
// and two cannot be recovered from a settled trade. Pinned here so the docs
// cannot drift back into promising multi-registry pairs.
//
// Flip MULTI_ADMIN_PAIRS_SUPPORTED when the schema changes; both directions of
// drift then fail here rather than silently disagreeing.

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

/** One admin per pair today. See the file header before changing this. */
export const MULTI_ADMIN_PAIRS_SUPPORTED = false;

const DEX = "trading/CantonDex/Dex";

before(() => {
  // An absence rule is trivially satisfied by an empty corpus.
  assert.ok(
    docFiles().length >= 20,
    `expected the docs corpus to be intact, found ${docFiles().length} markdown files`,
  );
});

describe("registry admin shape", () => {
  it("each venue template carries exactly one admin party", () => {
    for (const [file, template, expected] of [
      [`${DEX}/DexPair.daml`, "DexPair", ["operator", "admin"]],
      [`${DEX}/Order.daml`, "Order", ["operator", "trader", "admin"]],
    ] as const) {
      assert.deepEqual(
        partyFields(file, template),
        expected,
        `${template}'s party fields changed. If a second admin was added, ` +
          `set MULTI_ADMIN_PAIRS_SUPPORTED = true and update the docs, which ` +
          `currently describe a single shared admin.`,
      );
    }
  });

  it("base and quote ids are bare Text under that one admin", () => {
    for (const field of ["baseInstrumentId", "quoteInstrumentId"]) {
      assert.equal(
        fieldType(`${DEX}/DexPair.daml`, "DexPair", field),
        "Text",
        `${field} is no longer bare Text. A structured id can carry its own ` +
          `admin, which would make multi-registry pairs expressible.`,
      );
    }
  });

  it("the codebase can carry a structured id and does so for the LP token", () => {
    // The contrast matters: this is a deliberate convention, not an oversight.
    // Pool.lpInstrumentId is structured precisely because the LP token's admin
    // (the lpRegistrar) differs from the traded instruments' admin.
    assert.match(
      fieldType(`${DEX}/Pool.daml`, "Pool", "lpInstrumentId"),
      /InstrumentId/,
      "Pool.lpInstrumentId is the reference case for a structured id.",
    );
  });

  it("upstream transfer legs cannot carry their own admin", () => {
    // The root constraint. If this ever becomes structured upstream, the
    // single-admin convention can be revisited.
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

  it("settlement plumbing stays per-admin even though nothing builds two", () => {
    // MatchedTrade_Settle is genuinely multi-admin shaped, inherited from the
    // upstream batching utility. Pinned so a future cleanup does not remove
    // the half that already works on the grounds that it is unreachable.
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
