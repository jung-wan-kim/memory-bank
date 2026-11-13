import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TC-REL-002 (AC-012): the npm tarball must be a working plugin/CLI — every path hooks.json and plugin.json point at,
// the bin/main targets and the native client sources ship; development, QA and workspace files do not.
// Runs `npm pack --dry-run` on the working tree, so untracked local files that would leak are caught too.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function packList(): { files: string[]; unpackedSize: number } {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000,
  });
  const [pkg] = JSON.parse(out);
  return { files: pkg.files.map((f: { path: string }) => f.path), unpackedSize: pkg.unpackedSize };
}

// hooks.json quotes the placeholder inside its command strings (`node \"${CLAUDE_PLUGIN_ROOT}/x.js\"`), so in the file
// text the path ends at the backslash of the escaped quote.
const PLUGIN_REF = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s\\]+)/g;

describe('TC-REL-002 npm tarball contents (AC-012)', () => {
  const { files, unpackedSize } = packList();
  const set = new Set(files);

  it('carries every file the plugin hooks, the MCP declaration, bin and main point at', () => {
    const referenced = new Set<string>();
    for (const file of ['hooks/hooks.json', '.claude-plugin/plugin.json']) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      for (const m of text.matchAll(PLUGIN_REF)) referenced.add(m[1]);
    }
    expect(referenced.size).toBeGreaterThanOrEqual(8);
    expect([...referenced].filter((p) => !set.has(p))).toEqual([]);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    for (const target of Object.values(pkg.bin as Record<string, string>)) expect(set.has(target.replace(/^\.\//, '')), target).toBe(true);
    expect(set.has(pkg.main), pkg.main).toBe(true);
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('ships the native client sources the SessionStart build needs, with the pinned hash', () => {
    for (const f of ['native/inject-client/Cargo.toml', 'native/inject-client/Cargo.lock', 'native/inject-client/SRC_HASH',
      'native/inject-client/src/main.rs', 'scripts/build-native-client.sh', 'scripts/native-src-hash.mjs',
      'scripts/inject-context.js', 'hooks/inject-context.sh', 'cli/mcp-server-wrapper.js', 'dist/mcp-server.js']) {
      expect(set.has(f), f).toBe(true);
    }
    const shipped = files.filter((f) => f.startsWith('native/inject-client/src/') && f.endsWith('.rs')).sort();
    const onDisk = fs.readdirSync(path.join(REPO, 'native/inject-client/src')).filter((f) => f.endsWith('.rs'))
      .map((f) => `native/inject-client/src/${f}`).sort();
    expect(shipped).toEqual(onDisk);
  });

  // The session entry (dist/mcp-server.js, a bundle) starts one of two servers by path at run time: the shared
  // server, or — with the shared server off — a server of the session's own. Neither is imported statically by
  // anything hooks.json or plugin.json names, so nothing above would notice one of their files missing.
  it('ships both servers the session entry can start, with every compiled file they load', () => {
    const relative = /(?:from\s+|import\s*\(\s*)['"](\.\/[^'"]+\.js)['"]/g;
    const seen = new Set<string>();
    const queue = ['dist/shared-server.js', 'dist/stdio-server.js'];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(set.has(file), file).toBe(true);
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      for (const m of text.matchAll(relative)) queue.push(path.posix.join(path.posix.dirname(file), m[1]));
    }
    // the walk did follow imports (a pattern that matches nothing would pass on two files)
    expect(seen.size).toBeGreaterThan(15);
    for (const file of ['dist/shared-server-core.js', 'dist/server-core.js', 'dist/inject-daemon.js', 'dist/socket-transport.js']) {
      expect(seen.has(file), file).toBe(true);
    }
    // and the entry really does name them by path
    const entry = fs.readFileSync(path.join(REPO, 'dist/mcp-server.js'), 'utf8');
    expect(entry).toContain('shared-server.js');
    expect(entry).toContain('stdio-server');
  });

  it('leaves development, QA and workspace files out', () => {
    const forbiddenPrefixes = ['.codex/', '.claude/', 'docs/', 'bench/', 'test/', 'src/', 'vercel/', '.autoresearch/', '.qa-',
      '.githooks/', 'native/inject-client/target/', 'node_modules/', 'video/'];
    const forbiddenFiles = ['CLAUDE.md', 'CODEX.md', '.requirements-lock.md', '.completion-check.md', 'results.tsv', 'bench-perf.mjs',
      '.claude-plugin/marketplace.json', 'vitest.config.ts', 'tsconfig.json'];
    const bad = files.filter((f) => forbiddenPrefixes.some((p) => f.startsWith(p)) || forbiddenFiles.includes(f) || /(^|\/)\.env/.test(f));
    expect(bad).toEqual([]);
    expect(unpackedSize).toBeLessThan(20_000_000);
  });
});
