// Disclosures a June 2026 review asked for, pinned so they cannot quietly go.
//
// The reviewer asked two questions the docs now answer honestly in the
// negative: there is no rules contract governing pair creation, and the DEX
// defines no Daml interfaces of its own. Both answers are easy to lose in a
// rewrite, and losing them reads as the opposite claim.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, docFiles, findClaims, formatHits, stripEmphasis } from "./docs-harness.ts";

const read = (rel: string) =>
  stripEmphasis(readFileSync(join(ROOT, rel), "utf8")).replace(/\s+/g, " ");

before(() => {
  assert.ok(
    docFiles().length >= 20,
    `expected the docs corpus to be intact, found ${docFiles().length} markdown files`,
  );
});

describe("governance and decomposition disclosures", () => {
  it("the absence of a DexRules contract stays stated", () => {
    for (const rel of ["docs/concepts/architecture.md", "docs/concepts/workflows.md"]) {
      assert.match(
        read(rel),
        /no separate `?DexRules`?[^.]{0,30}contract/i,
        `${rel} no longer states that there is no DexRules contract. Pools have ` +
          "PoolRules for operation; nothing governs creation. Keep it disclosed.",
      );
    }
  });

  it("the absence of custom Daml interfaces stays stated", () => {
    for (const rel of ["docs/concepts/architecture.md", "README.md"]) {
      assert.match(
        read(rel),
        /does not define custom Daml interfaces|no custom Daml interfaces/i,
        `${rel} no longer states that the DEX defines no Daml interfaces of ` +
          "its own. That was a direct review question; keep the answer visible.",
      );
    }
  });

  it("the direct-create caveat covers every directly-created template", () => {
    // admin/index.ts creates Pool and PoolState with bare CreateCommands too,
    // so naming only DexPair reads as a promise about the others.
    const hits = findClaims(/directly[- ]operator[- ]created|directly created by the operator/i, {
      negationAware: false,
    });
    assert.ok(hits.length > 0, "the direct-create caveat has disappeared entirely");
    for (const h of hits) {
      assert.match(
        h.sentence,
        /Pool/,
        "A direct-create caveat naming only DexPair implies Pool and PoolState " +
          "go through a rules contract. They do not — admin/index.ts creates " +
          `both with bare CreateCommands.${formatHits([h])}`,
      );
    }
  });
});
