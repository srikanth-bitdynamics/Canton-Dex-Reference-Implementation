// Keep historical deployment feedback separate from the API this repository
// actually implements. A past external report referenced a public hostname,
// faucet, and /v1/testnet wrapper that are not present in this tree.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { ROOT, docFiles } from "./docs-harness.ts";

describe("hosted deployment scope", () => {
  it("does not advertise the retired external hostname", () => {
    const hits = docFiles().filter((file) =>
      /testnet-dex\.bitdynamics\.cc/i.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(
      hits.map((file) => relative(ROOT, file)),
      [],
      "The old hosted endpoint is not provisioned by this repository. " +
        "Keep historical reports as provenance, not current setup instructions.",
    );
  });

  it("does not present this repository as a current public deployment", () => {
    const security = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
    assert.doesNotMatch(
      security,
      /package version on the public testnet\s+is the deployed surface/i,
      "SECURITY.md must describe source support without inventing a hosted service.",
    );
    assert.match(
      security,
      /does not provision or promise a public testnet deployment/i,
    );
  });

  it("has no hidden /v1/testnet route implementation", () => {
    const server = readFileSync(
      join(ROOT, "services/operator-backend/src/http/index.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      server,
      /["'`]\/v1\/testnet(?:\/|["'`])/,
      "A /v1/testnet route was added. Document and secure it explicitly, or " +
        "keep deployment wrappers outside the reference API.",
    );
  });

  it("states the current repository boundary in the canonical docs", () => {
    const api = readFileSync(join(ROOT, "docs/reference/http-api.md"), "utf8");
    const nonGoals = readFileSync(join(ROOT, "docs/concepts/non-goals.md"), "utf8");
    const feedback = readFileSync(
      join(ROOT, "docs/reference/ecosystem-feedback.md"),
      "utf8",
    );

    assert.match(api, /has no `\/v1\/testnet\/\*` namespace, party faucet/i);
    assert.match(nonGoals, /does not create parties, mint faucet assets/i);
    assert.match(feedback, /does \*\*not\*\* provision a public hostname/i);
  });

  it("keeps npm package metadata on this reference repository", () => {
    const expected =
      "https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.git";
    for (const packagePath of [
      "app/web/package.json",
      "services/operator-backend/package.json",
    ]) {
      const manifest = JSON.parse(readFileSync(join(ROOT, packagePath), "utf8")) as {
        repository?: { url?: string };
      };
      assert.equal(manifest.repository?.url, expected, packagePath);
    }
  });
});
