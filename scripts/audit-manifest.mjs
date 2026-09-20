import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const checksum = (path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');

if (git('status', '--porcelain').length !== 0) {
  throw new Error('Generate the audit manifest from a clean checkout.');
}

const yaml = readFileSync(resolve(root, 'trading/daml.yaml'), 'utf8');
const field = (name) => {
  const match = yaml.match(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm'));
  if (!match) throw new Error(`Missing trading/daml.yaml field: ${name}`);
  return match[1];
};
const dar = `trading/.daml/dist/${field('name')}-${field('version')}.dar`;
if (!existsSync(resolve(root, dar))) {
  throw new Error(`Build the trading DAR before generating the manifest: ${dar}`);
}

const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean).sort();
const files = Object.fromEntries(paths.map((path) => [path, checksum(path)]));
const manifest = {
  formatVersion: 1,
  sourceCommit: git('rev-parse', 'HEAD'),
  sourceTree: git('rev-parse', 'HEAD^{tree}'),
  sdkVersion: field('sdk-version'),
  tradingPackage: { name: field('name'), version: field('version'), dar, sha256: checksum(dar) },
  scope: 'AUDIT_SCOPE.md',
  trackedFilesSha256: files,
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
