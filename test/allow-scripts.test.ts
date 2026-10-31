import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// @xenova/transformers 2.x imports sharp when it loads (src/utils/image.js), so
// denying sharp's install script leaves no native binary and the embedder — and
// with it every sync — fails to load. obra #167 denies sharp because obra uses
// @huggingface/transformers, which does not; copying that verbatim broke 1.7.9–1.7.11.
describe('package.json allowScripts', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  it('allows the native installs the runtime loads', () => {
    expect(pkg.allowScripts['better-sqlite3']).toBe(true);
    expect(pkg.allowScripts['onnxruntime-node']).toBe(true);
    if (pkg.dependencies['@xenova/transformers']) expect(pkg.allowScripts.sharp).toBe(true);
  });
});
