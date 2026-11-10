#!/usr/bin/env node
/**
 * dist freshness check (the `pretest` step).
 *
 * dist/ is git-tracked, and several tests import it (worker-dist-contract,
 * hook scripts, …). `pretest` used to run the build, so every `npm test`
 * rewrote tracked files in the working tree. This check writes nothing into
 * the repository; it fails with "run npm run build first" when dist/ is not a
 * build of the current sources. Two kinds of file, two ways to tell:
 *
 *  - what `tsc` emits (every dist file but the bundle): compiled into a temp
 *    dir and compared byte for byte.
 *  - the esbuild bundle dist/mcp-server.js: it inlines third-party packages,
 *    and package-lock.json is not tracked — a fresh `npm install` resolves
 *    other versions of them, so a rebuild differs in bytes although nothing in
 *    this repository changed. The bundle is judged by the stamp the build
 *    wrote into it (scripts/stamp-bundle.mjs): the digest of the first-party
 *    sources, bundle arguments and dependency ranges it was made from must be
 *    the digest of the current ones, and its bytes must be the stamped ones.
 *    A bundle that names modules by paths outside the project (built where
 *    node_modules is a symlink to another directory) is refused even when it
 *    is fresh: it carries the directory names of the machine that built it.
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
import {
  BUNDLE_REL, OUTSIDE_PATHS_ADVICE, bundleEsbuildArgs, bundleInto, bundleStaleReason, inputsDigest, outsideModulePathCount, repoBin,
} from './stamp-bundle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Relative to dist/: tsc emits the unbundled module here, the bundle step overwrites it.
const BUNDLE_IN_DIST = path.relative('dist', BUNDLE_REL);

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
  const esbuildArgs = bundleEsbuildArgs(pkg);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-dist-check-'));
  try {
    const compiled = path.join(tmp, 'tsc');
    const bundled = path.join(tmp, 'bundle');
    fs.mkdirSync(bundled);
    run('tsc', repoBin('tsc'), ['-p', path.join(root, 'tsconfig.json'), '--outDir', compiled], root);
    // Bundled here only to learn which first-party files go in (and that the bundle step still works);
    // its bytes depend on the installed third-party versions and are not compared.
    const { inputs } = bundleInto(root, esbuildArgs, bundled);

    const expected = listFiles(compiled);
    const missing = [];
    const different = [];
    for (const rel of expected) {
      if (rel === BUNDLE_IN_DIST) continue; // judged by its stamp below
      const target = path.join(distDir, rel);
      if (!fs.existsSync(target)) missing.push(rel);
      else if (!fs.readFileSync(path.join(compiled, rel)).equals(fs.readFileSync(target))) different.push(rel);
    }
    const bundleFile = path.join(root, BUNDLE_REL);
    const bundleReason = bundleStaleReason(bundleFile, inputsDigest(root, inputs, esbuildArgs, pkg));
    const outside = fs.existsSync(bundleFile) ? outsideModulePathCount(fs.readFileSync(bundleFile)) : 0;
    const outsideLine = outside === 0 ? '' : `  the bundle ${BUNDLE_REL} names ${outside} modules by a path outside the project: ${OUTSIDE_PATHS_ADVICE}\n`;

    const expectedSet = new Set(expected).add(BUNDLE_IN_DIST);
    const leftover = fs.existsSync(distDir) ? listFiles(distDir).filter((rel) => !expectedSet.has(rel)) : [];
    if (leftover.length > 0) {
      process.stderr.write(`check-dist-fresh: note — ${leftover.length} file(s) in dist/ have no source any more (not checked): ${leftover.slice(0, 5).join(', ')}${leftover.length > 5 ? ', …' : ''}\n`);
    }

    if (missing.length === 0 && different.length === 0 && bundleReason === null && outside > 0) {
      // Fresh, and still not a dist to commit: rebuilding here would produce the same paths.
      process.stderr.write(`check-dist-fresh: dist matches the current sources, but it must not be committed as it is.\n${outsideLine}`);
      return 1;
    }
    if (missing.length === 0 && different.length === 0 && bundleReason === null) {
      const compared = expected.filter((rel) => rel !== BUNDLE_IN_DIST).length;
      process.stdout.write(`check-dist-fresh: dist is fresh (${compared} compiled files match a build of the current sources; the bundle's stamp matches its ${inputs.length} first-party sources)\n`);
      return 0;
    }
    const show = (label, list) => (list.length === 0 ? '' : `  ${label} (${list.length}): ${list.slice(0, 20).join(', ')}${list.length > 20 ? ', …' : ''}\n`);
    process.stderr.write(
      `check-dist-fresh: dist is stale — run \`npm run build\` first (tests import dist/, and this check does not rebuild it).\n` +
      show('differs from a build of the current sources', different) +
      show('missing from dist', missing) +
      (bundleReason === null ? '' : `  the bundle ${BUNDLE_REL} ${bundleReason}\n`) +
      outsideLine,
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
