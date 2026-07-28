// This implementation targets Token Standard V2 allocations only.
//
// "Preferred" presupposes an alternative, and there is none: no V1 allocation
// package has ever been a dependency of trading/.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, docFiles, findClaims, formatHits } from "./docs-harness.ts";

before(() => {
  assert.ok(
    docFiles().length >= 20,
    `expected the docs corpus to be intact, found ${docFiles().length} markdown files`,
  );
});

describe("V2-only surface", () => {
  it("no V1 allocation package is a dependency", () => {
    const yaml = readFileSync(join(ROOT, "trading/daml.yaml"), "utf8");
    assert.doesNotMatch(
      yaml,
      /allocation-v1|allocation-instruction-v1/,
      "trading/ now depends on a V1 allocation package. The docs describe a " +
        "V2-only surface and should be updated deliberately.",
    );
  });

  it("no doc presents V2 as merely preferred over an alternative", () => {
    const hits = findClaims(
      /\bV2 allocations?\b[^.]{0,80}\b(?:preferred|primary|default|recommended)\b/i,
      { negationAware: false },
    );
    assert.equal(
      hits.length,
      0,
      "\"Preferred\" implies a supported alternative. This repo has never " +
        `declared a V1 allocation dependency; say "only", not "preferred".${formatHits(hits)}`,
    );
  });

  it("no doc claims V1 allocations are supported here", () => {
    const hits = findClaims(
      /\bV1 allocations?\b[^.]{0,80}\b(?:supported|available|accepted|fall ?back)\b/i,
    );
    assert.equal(
      hits.length,
      0,
      `V1 allocations are not supported by this implementation.${formatHits(hits)}`,
    );
  });
});
