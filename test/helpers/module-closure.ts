import fs from 'node:fs';
import path from 'node:path';

/**
 * Every first-party module a set of entry files can load: static imports, re-exports and dynamic imports of a
 * relative path, followed until nothing new turns up. Paths are absolute `.ts` files.
 *
 * A dynamic import whose path is computed at run time is not followed — the guards that use this list name
 * the entry files such a path can lead to as roots of their own.
 */
const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

export function moduleClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const stack = roots.map((r) => path.resolve(r));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`module-closure: ${file} does not exist`);
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = path.resolve(path.dirname(file), m[1]).replace(/\.js$/, '.ts');
      stack.push(target.endsWith('.ts') ? target : `${target}.ts`);
    }
  }
  return [...seen].sort();
}

export interface SourceHit { file: string; line: number; text: string }

/** Lines of `files` that match `pattern` — comments included: a guard that reads text must not be argued with. */
export function findInSources(files: string[], pattern: RegExp): SourceHit[] {
  const hits: SourceHit[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}
