// What Token Standard V2 does and does not cover.
//
// Instrument configuration and lifecycle are not part of it: the vendored
// standard has no such package, and the portable way to read instrument
// properties is the off-ledger metadata-v1 API. These guards keep DEX-specific
// registry features distinct from the portable Token Standard surface.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ROOT, docFiles, findClaims, formatHits } from "./docs-harness.ts";

before(() => {
  assert.ok(
    docFiles().length >= 20,
    `expected the docs corpus to be intact, found ${docFiles().length} markdown files`,
  );
});

describe("token standard scope", () => {
  it("the vendored standard really has no configuration or lifecycle package", () => {
    // Ground truth for every assertion below. If upstream ever ships one, the
    // docs may legitimately change and this test should be revisited first.
    const dir = join(ROOT, "vendor/splice/token-standard");
    assert.ok(existsSync(dir), "vendored token-standard tree is missing");
    const pkgs = readdirSync(dir).filter((d) => d.startsWith("splice-api-token-"));
    assert.ok(pkgs.length > 0, "no splice-api-token-* packages found");
    const offending = pkgs.filter((p) => /config|lifecycle|lifecycling/i.test(p));
    assert.deepEqual(
      offending,
      [],
      "Upstream now ships an instrument configuration or lifecycle package. " +
        "The docs' caveats about these being non-standard may need revisiting.",
    );
  });

  it("no doc claims the standard mandates instrument configuration", () => {
    const hits = findClaims(
      /\btoken standard\b[^.]{0,80}\b(?:mandates?|requires?|defines?|specifies?|standardi[sz]es?|provides?)\b[^.]{0,60}`?Instrument(?:Configuration|Config)`?/i,
    );
    assert.equal(
      hits.length,
      0,
      "Instrument configuration is NOT part of Token Standard V2 — there is no " +
        "such package in vendor/splice/token-standard. `InstrumentConfiguration` " +
        `and \`InstrumentConfig\` are templates of the reference registry.${formatHits(hits)}`,
    );
  });

  it("no doc claims the standard mandates instrument lifecycle", () => {
    const hits = findClaims(
      /\btoken standard\b[^.]{0,80}\b(?:mandates?|requires?|defines?|specifies?|standardi[sz]es?|provides?)\b[^.]{0,60}\blife-?cycl/i,
    );
    assert.equal(
      hits.length,
      0,
      "Instrument lifecycling is not standardized by Token Standard V2. A DEX " +
        `operator integrating with a registry that offers it does so custom.${formatHits(hits)}`,
    );
  });

  it("documents what falls outside Token Standard V2", () => {
    const rel = "docs/concepts/architecture.md";
    assert.match(
      readFileSync(join(ROOT, rel), "utf8"),
      /not (?:part of|mandated by|standardi[sz]ed)|(?:stays |falls )?outside (?:the |Token |DEX )/i,
      `${rel} must state what falls outside Token Standard V2.`,
    );
  });

  it("metadata-v1 is offered as the portable alternative", () => {
    // The only registry-agnostic way to read instrument properties.
    const hits = findClaims(/metadata-v1/i, { negationAware: false });
    assert.ok(
      hits.length > 0,
      "No doc mentions metadata-v1. It is the standard's off-ledger surface " +
        "for instrument properties and the portable substitute for reading a " +
        "registry's own configuration templates.",
    );
  });
});
