// Sync the canonical docs/ tree into Starlight's content collection.
//
// The repo's docs/*.md are plain Markdown (no frontmatter) so they render
// cleanly in the GitHub file view. Starlight needs a `title` in frontmatter, so
// this derives it from each file's first H1 and injects it. Links that escape
// docs/ (into repo source, LICENSE, vendor/, examples/, etc.) are rewritten to
// GitHub blob URLs; intra-docs links are left relative for Astro to resolve.
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const DOCS = join(REPO, 'docs');
const OUT = resolve(HERE, '../src/content/docs');
const GH = 'https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation/blob/main';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const walk = (d) =>
  readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

// docs/README.md becomes the site homepage (index.md, slug '').
const outRelOf = (abs) => {
  const r = relative(DOCS, abs);
  return r === 'README.md' ? 'index.md' : r;
};

// URL-relative hop from a page back to the homepage (pages are dir URLs).
const toHome = (outRel) => {
  const slug = outRel.replace(/\.md$/, '');
  if (slug === 'index') return './';
  return '../'.repeat(slug.split('/').length);
};

let count = 0;
for (const abs of walk(DOCS)) {
  const outRel = outRelOf(abs);
  const outAbs = join(OUT, outRel);
  mkdirSync(dirname(outAbs), { recursive: true });

  if (!abs.endsWith('.md')) {
    cpSync(abs, outAbs); // assets (svgs, etc.) copied verbatim
    continue;
  }

  let src = readFileSync(abs, 'utf8');
  const h1 = src.match(/^#\s+(.+?)\s*$/m);
  const title = (h1 ? h1[1] : outRel.replace(/\.md$/, '')).replace(/`/g, '');
  if (h1) src = src.replace(h1[0], '').replace(/^\n+/, ''); // Starlight renders the title

  src = src.replace(/(\]\()([^)]+)(\))/g, (full, pre, target, post) => {
    const t = target.trim();
    if (/^(https?:|#|mailto:)/.test(t)) return full;
    const path = t.split('#')[0];
    const anchor = t.slice(path.length);
    if (!path) return full;
    const dest = resolve(dirname(abs), path);
    if (dest === join(DOCS, 'README.md')) return `${pre}${toHome(outRel)}${anchor}${post}`;
    if (dest.startsWith(DOCS)) return full; // intra-docs link — Astro resolves it
    return `${pre}${GH}/${relative(REPO, dest)}${anchor}${post}`; // escapes docs/
  });

  writeFileSync(outAbs, `---\ntitle: ${JSON.stringify(title)}\n---\n\n${src}`);
  count++;
}
console.log(`sync-docs: wrote ${count} pages to ${relative(REPO, OUT)}`);
