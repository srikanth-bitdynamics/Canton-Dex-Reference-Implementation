// Shared helpers for the docs-vs-code guards.
//
// Not named *.test.ts on purpose: typechecked with the suite, never run as one.
//
// The helpers account for three Markdown details:
//
//   1. Markdown reflows. A claim can be split across lines, so a per-line regex
//      finds nothing in text that is plainly there. Blocks are normalised to
//      one line before matching.
//   2. A caveat contains the words it disclaims. "The standard does not mandate
//      an InstrumentConfiguration" matches a naive search for exactly the claim
//      it refutes. Absence rules are
//      negation-aware.
//   3. Headings and list items must end a block, or a sentence runs into the
//      next one and produces a hit that spans two unrelated claims.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Repo root, from services/operator-backend/test/. */
export const ROOT = resolve(import.meta.dirname, "..", "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

/** Every markdown file the guards read: docs/** plus the top-level README. */
export function docFiles(): string[] {
  return [...walk(join(ROOT, "docs")), join(ROOT, "README.md")];
}

/** Drop bold/italic markers: `does **not** define` must match `does not define`. */
export function stripEmphasis(src: string): string {
  return src.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1");
}

/**
 * Split markdown into normalised sentences. Code fences and tables are dropped
 * (they are examples, not claims); blank lines, headings and list bullets all
 * end a block; each block is collapsed to one line and then split on sentence
 * boundaries.
 */
export function sentences(src: string): string[] {
  const prose = stripEmphasis(src)
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/^\s*\|.*$/gm, "\n");
  const blocks = prose.split(
    /\n\s*\n|\n(?=\s*#)|\n(?=\s*[-*+]\s)|\n(?=\s*\d+\.\s)/,
  );
  const out: string[] = [];
  for (const b of blocks) {
    const flat = b
      .replace(/^\s*#+\s*/, "")
      .replace(/^\s*[-*+]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!flat) continue;
    for (const s of flat.split(/(?<=[.;])\s+(?=[A-Z`])/)) {
      if (s.trim()) out.push(s.trim());
    }
  }
  return out;
}

const NEGATION = /\b(?:not|never|no|without|neither|nor|n't|outside|rather than)\b/i;

export interface Hit {
  file: string;
  sentence: string;
}

/**
 * Sentences matching `pattern`. With `negationAware` (the default) a sentence
 * that also carries a negation is skipped, so a rule banning a claim does not
 * fire on the caveat that refutes it. Pass false when the pattern itself
 * already encodes the negation being searched for.
 */
export function findClaims(
  pattern: RegExp,
  opts: { negationAware?: boolean; files?: string[] } = {},
): Hit[] {
  const negationAware = opts.negationAware ?? true;
  const hits: Hit[] = [];
  for (const f of opts.files ?? docFiles()) {
    for (const s of sentences(readFileSync(f, "utf8"))) {
      if (!pattern.test(s)) continue;
      if (negationAware && NEGATION.test(s)) continue;
      hits.push({ file: relative(ROOT, f), sentence: s.slice(0, 200) });
    }
  }
  return hits;
}

export function formatHits(hits: Hit[]): string {
  return hits.map((h) => `\n    ${h.file}\n      "${h.sentence}"`).join("");
}

/** Body of a `template X with` or `data X = X with` declaration, up to `where`. */
function recordBody(damlPath: string, name: string): string {
  const src = readFileSync(join(ROOT, damlPath), "utf8");
  const start = src.search(
    new RegExp(`^(?:template\\s+${name}\\s+with|data\\s+${name}\\s*=\\s*${name}\\s+with)`, "m"),
  );
  if (start < 0) throw new Error(`${name} not found in ${damlPath}`);
  return src.slice(start).split(/^\s*where\s*$|^\s*deriving\s/m)[0] ?? "";
}

/**
 * Party-typed field names, in declaration order. Reads the source as text
 * rather than building a DAR, so the guards stay in the cheap test loop.
 */
export function partyFields(damlPath: string, name: string): string[] {
  const body = recordBody(damlPath, name);
  return [...body.matchAll(/^\s{4}(\w+)\s*:\s*Party\s*$/gm)].map((m) => m[1]!);
}

/** Declared type of one field, as written, comments stripped. */
export function fieldType(
  damlPath: string,
  name: string,
  field: string,
): string {
  const body = recordBody(damlPath, name);
  const m = body.match(new RegExp(`^\\s{4}${field}\\s*:\\s*(.+?)\\s*$`, "m"));
  if (!m) throw new Error(`field ${field} not found on ${name}`);
  return m[1]!.replace(/\s*--.*$/, "").trim();
}
