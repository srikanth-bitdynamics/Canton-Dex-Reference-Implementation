import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { ROOT, docFiles, sentences } from "./docs-harness.ts";

function filesBelow(dir: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path, extension));
    else if (entry.name.endsWith(extension)) files.push(path);
  }
  return files;
}

function markdownAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]!
      .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9 _-]/g, "")
      .replace(/ /g, "-");
    const duplicate = occurrences.get(base) ?? 0;
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
    occurrences.set(base, duplicate + 1);
  }
  for (const match of source.matchAll(/<(?:a\s+(?:name|id)|[^>]+\s+id)=["']([^"']+)["'][^>]*>/gi)) {
    anchors.add(match[1]!);
  }
  return anchors;
}

describe("documentation references", () => {
  it("every local Markdown link points to an existing file", () => {
    const broken: string[] = [];
    for (const file of docFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const rawTarget = match[1]!.trim().replace(/^<|>$/g, "");
        if (/^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
        const pathPart = rawTarget.split("#", 1)[0]!.split("?", 1)[0]!;
        if (!pathPart) continue;
        const resolved = join(dirname(file), decodeURIComponent(pathPart));
        if (!existsSync(resolved)) {
          broken.push(`${relative(ROOT, file)} -> ${rawTarget}`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it("every local Markdown fragment points to an existing heading", () => {
    const broken: string[] = [];
    for (const file of docFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const rawTarget = match[1]!.trim().replace(/^<|>$/g, "");
        if (/^(?:https?:|mailto:)/.test(rawTarget)) continue;
        const [rawPath = "", rawFragment] = rawTarget.split("#", 2);
        if (!rawFragment) continue;
        const pathPart = rawPath.split("?", 1)[0]!;
        const target = pathPart
          ? join(dirname(file), decodeURIComponent(pathPart))
          : file;
        if (!target.endsWith(".md") || !existsSync(target)) continue;
        const fragment = decodeURIComponent(rawFragment);
        if (!markdownAnchors(readFileSync(target, "utf8")).has(fragment)) {
          broken.push(`${relative(ROOT, file)} -> ${rawTarget}`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it("every documented Daml test identifier is still declared", () => {
    const testFiles = filesBelow(join(ROOT, "trading-tests", "CantonDex"), ".daml");
    const declared = new Set<string>();
    for (const file of testFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(/^\s*(test[A-Z]\w*)\s*:\s*Script\b/gm)) {
        declared.add(match[1]!);
      }
    }

    const missing: string[] = [];
    for (const file of docFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/`(test[A-Z]\w*)`/g)) {
        if (!declared.has(match[1]!)) {
          missing.push(`${relative(ROOT, file)} -> ${match[1]}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("every documented Daml choice identifier is still declared", () => {
    const damlFiles = [
      ...filesBelow(join(ROOT, "trading"), ".daml"),
      ...filesBelow(join(ROOT, "vendor", "splice", "token-standard"), ".daml"),
    ];
    const choiceOwners = new Set<string>();
    const declared = new Set<string>();
    for (const file of damlFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^\s*(?:template|interface)\s+(\w+)/gm)) {
        choiceOwners.add(match[1]!);
      }
      for (const match of source.matchAll(/^\s*(?:nonconsuming\s+)?choice\s+(\w+)/gm)) {
        declared.add(match[1]!);
      }
    }

    const missing: string[] = [];
    for (const file of docFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/`([A-Z]\w*_[A-Z]\w*)`/g)) {
        const identifier = match[1]!;
        const owner = identifier.split("_", 1)[0]!;
        if (!choiceOwners.has(owner) || /(?:Result|View)$/.test(identifier)) continue;
        if (!declared.has(identifier)) {
          missing.push(`${relative(ROOT, file)} -> ${identifier}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("every Daml script states its invariant on the declaration", () => {
    const missing: string[] = [];
    for (const file of filesBelow(join(ROOT, "trading-tests", "CantonDex", "Tests"), ".daml")) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!/^\w+\s*:\s*Script\b/.test(lines[index]!)) continue;
        if (!/^-- \| Proves\b/.test(lines[index - 1] ?? "")) {
          missing.push(`${relative(ROOT, file)}:${index + 1} ${lines[index]}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("every template module links back to a design concept", () => {
    const missing = filesBelow(join(ROOT, "trading", "CantonDex"), ".daml")
      .filter((file) => /^template\s+/m.test(readFileSync(file, "utf8")))
      .filter((file) => !/Design guide: `docs\//.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    assert.deepEqual(missing, []);
  });

  it("Order_Fund remains consuming in code and prose", () => {
    const order = readFileSync(join(ROOT, "trading/CantonDex/Dex/Order.daml"), "utf8");
    assert.match(order, /^\s{4}choice Order_Fund\b/m);
    assert.doesNotMatch(order, /^\s{4}nonconsuming choice Order_Fund\b/m);

    const stale = docFiles().flatMap((file) =>
      sentences(readFileSync(file, "utf8"))
        .filter((sentence) => /Order_Fund/.test(sentence) && /nonconsuming/i.test(sentence))
        .map((sentence) => `${relative(ROOT, file)}: ${sentence}`),
    );
    assert.deepEqual(stale, []);
  });
});
