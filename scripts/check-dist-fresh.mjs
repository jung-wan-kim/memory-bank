#!/usr/bin/env node
/**
 * dist freshness check (the `pretest` step).
 *
 * dist/ is git-tracked, and several tests import it (worker-dist-contract,
 * hook scripts, …). `pretest` used to run the build, so every `npm test`
 * rewrote tracked files in the working tree. This check writes nothing into
 * the repository: it compiles into a temp dir exactly as `npm run build` does
 * (tsc, then the esbuild bundle of the MCP server), compares the result with
 * dist/, and fails with "run npm run build first" when they differ.
 *
 * Files only dist/ has (left over from deleted sources) are reported but do
 * not fail the check — a rebuild does not remove them, so failing would have
 * no fix.
 *
 *   node scripts/check-dist-fresh.mjs [--root <project dir>]
 *
 * Exit: 0 fresh · 1 stale or a usage error · 2 the compile itself failed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_OUTFILE_FLAG = '--outfile=dist/mcp-server.js';

function usage(message) {
  process.stderr.write(`check-dist-fresh: ${message}\nusage: node scripts/check-dist-fresh.mjs [--root <project dir>]\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let root = REPO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) usage('--root needs a directory');
      root = path.resolve(value);
    } else {
      usage(`unknown argument ${JSON.stringify(argv[i])}`);
    }
  }
  return { root };
}

function run(label, bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `${result.stdout}${result.stderr}`.trim();
    throw new Error(`${label} failed (exit ${result.status ?? 'none'})\n${detail}`);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const distDir = path.join(root, 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // The bundle step is read from package.json so this check cannot drift from the build.
  const bundle = String(pkg.scripts?.bundle ?? '').split(/\s+/).filter(Boolean);
  if (bundle[0] !== 'esbuild' || !bundle.includes(BUNDLE_OUTFILE_FLAG)) {
    throw new Error(`package.json "bundle" is not the expected esbuild command with ${BUNDLE_OUTFILE_FLAG} — update this check with it`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-dist-check-'));
  try {
    const bin = (name) => path.join(REPO, 'node_modules', '.bin', name);
    run('tsc', bin('tsc'), ['-p', path.join(root, 'tsconfig.json'), '--outDir', tmp], root);
    run('esbuild bundle', bin('esbuild'),
      bundle.slice(1).map((arg) => (arg === BUNDLE_OUTFILE_FLAG ? `--outfile=${path.join(tmp, 'mcp-server.js')}` : arg))
        .concat('--log-level=warning'),
      root);

    const expected = listFiles(tmp);
    const missing = [];
    const different = [];
    for (const rel of expected) {
      const target = path.join(distDir, rel);
      if (!fs.existsSync(target)) missing.push(rel);
      else if (!fs.readFileSync(path.join(tmp, rel)).equals(fs.readFileSync(target))) different.push(rel);
    }
    const expectedSet = new Set(expected);
    const leftover = fs.existsSync(distDir) ? listFiles(distDir).filter((rel) => !expectedSet.has(rel)) : [];
    if (leftover.length > 0) {
      process.stderr.write(`check-dist-fresh: note — ${leftover.length} file(s) in dist/ have no source any more (not checked): ${leftover.slice(0, 5).join(', ')}${leftover.length > 5 ? ', …' : ''}\n`);
    }

    if (missing.length === 0 && different.length === 0) {
      process.stdout.write(`check-dist-fresh: dist is fresh (${expected.length} files match a build of the current sources)\n`);
      return 0;
    }
    const show = (label, list) => (list.length === 0 ? '' : `  ${label} (${list.length}): ${list.slice(0, 20).join(', ')}${list.length > 20 ? ', …' : ''}\n`);
    process.stderr.write(
      `check-dist-fresh: dist is stale — run \`npm run build\` first (tests import dist/, and this check does not rebuild it).\n` +
      show('differs from a build of the current sources', different) +
      show('missing from dist', missing),
    );
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  // The compile could not run: neither "fresh" nor "stale" is known.
  process.stderr.write(`check-dist-fresh: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
