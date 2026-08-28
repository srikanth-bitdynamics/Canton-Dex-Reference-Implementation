// Static deployment guards for defects that can survive TypeScript and unit
// tests: wrong working-directory defaults, missing template qualification,
// public container ports, skipped native install scripts, and root runtimes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("deployment wiring", () => {
  it("requires a DEX package prefix before registry bootstrap", () => {
    const deploy = read("scripts/deploy-testnet.sh");
    const bootstrap = read("scripts/bootstrap-registry.ts");
    assert.match(deploy, /CANTON_DEX_PACKAGE_ID; do/);
    assert.match(bootstrap, /required\("CANTON_DEX_PACKAGE_ID"\)/);
    assert.match(bootstrap, /templateIdPrefix:\s*dexPackageId/);
  });

  it("anchors the default bootstrap config beside the script", () => {
    const bootstrap = read("scripts/bootstrap-registry.ts");
    assert.match(bootstrap, /fileURLToPath\(import\.meta\.url\)/);
    assert.match(bootstrap, /resolve\(scriptDir,\s*"bootstrap-registry\.json"\)/);
  });

  it("keeps the Compose backend private behind nginx", () => {
    const compose = read("docker-compose.yml");
    const backend = compose.split(/^  frontend:/m)[0] ?? compose;
    assert.match(backend, /^    expose:/m);
    assert.doesNotMatch(backend, /^    ports:/m);
    assert.match(backend, /CANTON_LP_ALLOC_FACTORY_CID/);
    assert.match(backend, /CANTON_LP_SETTLE_FACTORY_CID/);
  });

  it("installs the native SQLite binding and runs the backend as non-root", () => {
    const dockerfile = read("Dockerfile.backend");
    assert.match(dockerfile, /WORKDIR \/app\/services\/operator-backend\s+RUN npm ci\s/m);
    assert.match(dockerfile, /^USER node$/m);
  });
});
