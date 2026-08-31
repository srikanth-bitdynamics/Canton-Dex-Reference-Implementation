import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

function textFilesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...textFilesBelow(path));
    else if (/\.(?:daml|json|md|mjs|sh|ts|tsx|yml)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("test taxonomy boundaries", () => {
  it("keeps opt-in Canton tests outside the ordinary offline test glob", () => {
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, "services/operator-backend/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    assert.equal(packageJson.scripts.test, "node --import tsx --test test/*.test.ts");
    assert.equal(
      packageJson.scripts["test:live:rfq"],
      "node --import tsx --test test/live/canton-live-rfq.test.ts",
    );
    assert.ok(
      existsSync(join(ROOT, "services/operator-backend/test/live/canton-live-rfq.test.ts")),
    );
    assert.ok(!existsSync(join(ROOT, "services/operator-backend/test/canton-live-rfq.test.ts")));
  });

  it("does not restore the misleading legacy E2E aliases", () => {
    assert.ok(!existsSync(join(ROOT, "scripts/e2e-smoke.sh")));
    assert.ok(!existsSync(join(ROOT, "scripts/localnet-dvp-e2e.ts")));

    const canonicalFiles = [
      join(ROOT, "README.md"),
      ...textFilesBelow(join(ROOT, "docs")),
      ...textFilesBelow(join(ROOT, "scripts")),
      ...textFilesBelow(join(ROOT, "services")),
      ...textFilesBelow(join(ROOT, "app")),
      ...textFilesBelow(join(ROOT, "trading-tests")),
      ...textFilesBelow(join(ROOT, ".github")),
    ];
    const stale = canonicalFiles
      .filter(
        (file) =>
          file !== join(ROOT, "services/operator-backend/test/test-taxonomy-boundaries.test.ts"),
      )
      .flatMap((file) => {
        const match = readFileSync(file, "utf8").match(
          /CANTON_E2E|e2e-smoke|localnet-dvp-e2e|localnet:dvp-e2e/,
        );
        return match ? [`${file}: ${match[0]}`] : [];
      });
    assert.deepEqual(stale, []);
  });

  it("keeps the mock-registry workflow proofs split into readable modules", () => {
    const testsDir = join(ROOT, "trading-tests/CantonDex/Tests");
    assert.ok(!existsSync(join(testsDir, "WorkflowIntegrationTests.daml")));

    const modules = readdirSync(testsDir)
      .filter((name) => /WorkflowTests\.daml$/.test(name))
      .sort();
    assert.deepEqual(modules, [
      "ChoiceContextWorkflowTests.daml",
      "OrderWorkflowTests.daml",
      "PoolWorkflowTests.daml",
      "TradeWorkflowTests.daml",
    ]);

    let declarations = 0;
    for (const module of modules) {
      const source = readFileSync(join(testsDir, module), "utf8");
      const lines = source.split("\n").length;
      assert.ok(lines <= 600, `${module} has ${lines} lines; split it again`);
      declarations += [...source.matchAll(/^test[A-Z]\w*\s*:\s*Script\b/gm)].length;
    }
    assert.equal(declarations, 21);

    const fixtures = readFileSync(join(testsDir, "WorkflowTestFixtures.daml"), "utf8");
    assert.ok(fixtures.split("\n").length <= 300, "workflow fixtures became a new monolith");
  });

  it("documents the live gate and the container runtime boundary", () => {
    const testing = readFileSync(join(ROOT, "docs/reference/testing.md"), "utf8");
    assert.match(testing, /CANTON_LIVE_RFQ=1 npm run test:live:rfq/);

    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /name: Container build \+ backend runtime smoke/);
  });

  it("keeps one canonical newcomer curriculum in both entry points", () => {
    const expected = [
      "concepts/canton-daml-primer.md",
      "concepts/overview.md",
      "getting-started.md",
      "tutorials/amm-first-walkthrough.md",
      "concepts/design-tour.md",
      "concepts/architecture.md",
      "concepts/workflows.md",
      "tutorials/make-your-first-amm-change.md",
      "guides/builder-guide.md",
    ];

    const index = readFileSync(join(ROOT, "docs/README.md"), "utf8");
    const indexSection = index
      .split("## Canonical newcomer learning path", 2)[1]!
      .split("\n## ", 1)[0]!;
    const indexPaths = [...indexSection.matchAll(/^\|\s*\d+\s*\|\s*\[[^\]]+\]\(([^)]+)\)/gm)]
      .map((match) => match[1]!);
    assert.deepEqual(indexPaths, expected);

    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const readmeSection = readme
      .split("## New To Canton Or Daml?", 2)[1]!
      .split("\n## ", 1)[0]!;
    const readmePaths = [...readmeSection.matchAll(/^\d+\.\s*\[[^\]]+\]\(([^)]+)\)/gm)]
      .map((match) => match[1]!.replace(/^docs\//, ""));
    assert.deepEqual(readmePaths, expected);

    const website = readFileSync(join(ROOT, "website/astro.config.mjs"), "utf8");
    const websiteSection = website
      .split("label: 'Newcomer learning path'", 2)[1]!
      .split("label: 'Concepts'", 1)[0]!;
    const websitePaths = [...websiteSection.matchAll(/slug:\s*'([^']+)'/g)]
      .map((match) => `${match[1]}.md`);
    assert.deepEqual(websitePaths, expected);
  });

  it("uses the current Canton Network docs for the Daml learning links", () => {
    const docs = [
      readFileSync(join(ROOT, "README.md"), "utf8"),
      readFileSync(join(ROOT, "docs/getting-started.md"), "utf8"),
      readFileSync(join(ROOT, "docs/concepts/canton-daml-primer.md"), "utf8"),
    ].join("\n");
    // The versioned 3.5 manuals were retired; links point at the current docs.
    assert.doesNotMatch(docs, /archived\.docs\.digitalasset\.com/);
    assert.doesNotMatch(docs, /https:\/\/docs\.digitalasset\.com\/build\/3\.5/);
    assert.match(docs, /https:\/\/docs\.canton\.network\/sdks-tools\/cli-tools\/dpm/);
    assert.match(docs, /https:\/\/docs\.canton\.network\/sdks-tools\/sdks\/daml-sdk/);
    assert.match(docs, /https:\/\/docs\.canton\.network\/appdev\/modules\/m3-contract-templates/);
  });

  it("keeps registry documentation operation-specific and staged-atomic for liquidity", () => {
    const guide = readFileSync(join(ROOT, "docs/guides/choice-context.md"), "utf8");
    const obsolete = [
      ["get", "Factories"],
      ["get", "ChoiceContext"],
      ["choiceContext", "TtlMs"],
    ].map((parts) => parts.join(""));
    for (const name of obsolete) {
      assert.ok(!guide.includes(name), `choice-context guide restored obsolete ${name}`);
    }
    assert.match(
      guide,
      /POST \/registry\/allocation-instruction\/v2\/allocation-factory/,
    );
    assert.match(guide, /POST \/registry\/allocation\/v2\/settlement-factory/);
    // Add/remove liquidity is now staged but atomic over any standard registry;
    // the old "generic HTTP cannot drive atomic liquidity" limitation was removed.
    assert.match(guide, /staged but atomic/i);
    assert.doesNotMatch(guide, /RegistryError\("unsupported"/);
  });
});
