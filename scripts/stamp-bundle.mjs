#!/usr/bin/env node
/**
 * Stamps the MCP server bundle — the last step of `npm run bundle`.
 *
 * dist/mcp-server.js inlines third-party packages (@modelcontextprotocol/sdk,
 * zod, …). package-lock.json is not tracked, so two installs of the same
 * package.json resolve different versions of them and bundle to different
 * bytes: comparing the tracked bundle with a local rebuild calls a correct
 * bundle stale on every fresh clone. So the build writes down what the bundle
 * was made from, as the bundle's last line:
 *
 *   // memory-bank-bundle-stamp v1 inputs=<sha256> body=<sha256>
 *
 *   inputs  what this repository puts into the bundle: the first-party files
 *           esbuild read (from its metafile), the esbuild arguments of
 *           package.json "bundle", and package.json "dependencies" (the ranges
 *           the inlined packages were resolved from — not the versions that
 *           happened to be installed).
 *   body    sha256 of the bundle up to the stamp line: the stamp speaks for
 *           these bytes only.
 *
 * scripts/check-dist-fresh.mjs (`pretest`) recomputes `inputs` from the
 * current sources and compares it with the stamp.
 *
 * Before stamping, this step bundles once more into a temp dir and requires
 * the result to equal dist/mcp-server.js byte for byte — the stamp is written
 * only for a bundle this machine makes from the sources being hashed.
 *
 * A bundle built where node_modules is not a folder of the checkout (a git
 * worktree whose node_modules is a symlink to another directory) names every
 * inlined module by a path that leaves the project — `// ../../…/<home>/…/
 * node_modules/zod/…` — and so carries that machine's directory names. It runs
 * the same, and it is stamped, with a warning: the check refuses it (it must
 * not be committed or published), see outsideModulePathCount.
 *
 *   node scripts/stamp-bundle.mjs [--root <project dir>]
 *
 * Exit: 0 stamped · 1 not stamped (usage error, bundle missing, bundle is not
 * what the current sources build to, esbuild failed).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_REL = 'dist/mcp-server.js';
export const BUNDLE_OUTFILE_FLAG = `--outfile=${BUNDLE_REL}`;
export const STAMP_STEP = 'node scripts/stamp-bundle.mjs';
const STAMP_LINE = /^\/\/ memory-bank-bundle-stamp v1 inputs=([0-9a-f]{64}) body=([0-9a-f]{64})$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** A build tool of this repository (the project under --root may have no node_modules of its own). */
export function repoBin(name) {
  return path.join(REPO, 'node_modules', '.bin', name);
}

/**
 * The esbuild arguments of package.json "bundle". The script must be exactly
 * `esbuild … --outfile=dist/mcp-server.js … && node scripts/stamp-bundle.mjs`:
 * the check reads the build from here, so a bundle step it cannot read is an error, not a guess.
 */
export function bundleEsbuildArgs(pkg) {
  const steps = String(pkg.scripts?.bundle ?? '').split('&&').map((step) => step.trim());
  const esbuild = (steps[0] ?? '').split(/\s+/).filter(Boolean);
  if (steps.length !== 2 || esbuild[0] !== 'esbuild' || !esbuild.includes(BUNDLE_OUTFILE_FLAG) || steps[1] !== STAMP_STEP) {
    throw new Error(`package.json "bundle" is not \`esbuild … ${BUNDLE_OUTFILE_FLAG} … && ${STAMP_STEP}\` — update scripts/stamp-bundle.mjs with it`);
  }
  return esbuild.slice(1);
}

/**
 * Bundles the project into `outDir` the way package.json "bundle" does.
 * Returns the bundle bytes and the first-party files esbuild read.
 */
export function bundleInto(root, esbuildArgs, outDir) {
  const outfile = path.join(outDir, 'mcp-server.js');
  const metafile = path.join(outDir, 'mcp-server.meta.json');
  const args = esbuildArgs
    .map((arg) => (arg === BUNDLE_OUTFILE_FLAG ? `--outfile=${outfile}` : arg))
    .concat(`--metafile=${metafile}`, '--log-level=warning');
  const result = spawnSync(repoBin('esbuild'), args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `${result.stdout}${result.stderr}`.trim();
    throw new Error(`esbuild bundle failed (exit ${result.status ?? 'none'})\n${detail}`);
  }
  const meta = JSON.parse(fs.readFileSync(metafile, 'utf8'));
  return { bytes: fs.readFileSync(outfile), inputs: firstPartyInputs(root, Object.keys(meta.inputs ?? {})) };
}

/**
 * Of the paths esbuild read (relative to the project root), those that belong
 * to this repository: inside the project and not under a node_modules folder.
 * A node_modules that is a symlink to another folder resolves outside the
 * project, so it is left out the same way.
 */
function firstPartyInputs(root, keys) {
  const rootReal = fs.realpathSync(root);
  const inputs = [];
  for (const key of keys) {
    const absolute = path.resolve(root, key);
    let real;
    try { real = fs.realpathSync(absolute); }
    catch (error) { throw new Error(`esbuild read ${JSON.stringify(key)}, which is not a file on disk (${error.code ?? error.message})`); }
    const rel = path.relative(rootReal, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    if (parts.includes('node_modules')) continue;
    inputs.push(parts.join('/'));
  }
  if (inputs.length === 0) throw new Error('esbuild read no first-party file — the metafile is not what this script expects');
  return inputs.sort();
}

/** Digest of what the repository contributes to the bundle (see the header). */
export function inputsDigest(root, inputs, esbuildArgs, pkg) {
  const hash = createHash('sha256');
  hash.update('memory-bank-bundle-inputs v1\n');
  hash.update(`bundle ${JSON.stringify(esbuildArgs)}\n`);
  const dependencies = Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  hash.update(`dependencies ${JSON.stringify(dependencies)}\n`);
  for (const rel of inputs) hash.update(`${rel}\0${sha256(fs.readFileSync(path.join(root, rel)))}\n`);
  return hash.digest('hex');
}

/** Splits bundle bytes into the body and the stamp of its last line (`stamp` is null when there is none). */
export function splitStamp(bytes) {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? bytes.length - 1 : bytes.length;
  const lineStart = bytes.lastIndexOf(0x0a, end - 1) + 1;
  const match = STAMP_LINE.exec(bytes.subarray(lineStart, end).toString('utf8'));
  if (!match) return { body: bytes, stamp: null };
  return { body: bytes.subarray(0, lineStart), stamp: { inputs: match[1], body: match[2] } };
}

/** The stamped form of a bundle body. */
export function withStamp(body, inputs) {
  const terminated = body.length === 0 || body[body.length - 1] === 0x0a ? body : Buffer.concat([body, Buffer.from('\n')]);
  return Buffer.concat([terminated, Buffer.from(`// memory-bank-bundle-stamp v1 inputs=${inputs} body=${sha256(terminated)}\n`)]);
}

/**
 * Why the bundle at `file` is not a fresh build of the sources whose digest is
 * `expectedInputs`, or null when it is.
 */
export function bundleStaleReason(file, expectedInputs) {
  if (!fs.existsSync(file)) return 'missing';
  const { body, stamp } = splitStamp(fs.readFileSync(file));
  if (!stamp) return 'has no build stamp (it was built before bundles were stamped, or `tsc` alone wrote its unbundled module there; `npm run build` makes the stamped bundle)';
  if (stamp.body !== sha256(body)) return 'was changed after it was built (its bytes no longer match its stamp)';
  if (stamp.inputs !== expectedInputs) return 'was built from other sources, bundle arguments or dependency ranges than the current ones';
  return null;
}

/**
 * How many lines of a bundle name a module by a path that leaves the project:
 * esbuild's module comment (`// ../…`) and its CommonJS wrapper key (`"../…"(`).
 * 0 for a bundle built in a checkout that has its own node_modules.
 */
export function outsideModulePathCount(bytes) {
  let count = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (/^\/\/ \.\.\//.test(line) || /^\s+"\.\.\/[^"]*"\(/.test(line)) count++;
  }
  return count;
}

export const OUTSIDE_PATHS_ADVICE =
  'it was built where node_modules is not a folder of the checkout (a symlink to another directory?) and carries that machine\'s directory names — ' +
  'build the dist to commit in a checkout with its own node_modules (`npm install`, then `npm run build`)';

function usage(message) {
  process.stderr.write(`stamp-bundle: ${message}\nusage: node scripts/stamp-bundle.mjs [--root <project dir>]\n`);
  return 1;
}

function main(argv) {
  let root = REPO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return usage('--root needs a directory');
      root = path.resolve(value);
    } else {
      return usage(`unknown argument ${JSON.stringify(argv[i])}`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const esbuildArgs = bundleEsbuildArgs(pkg);
  const file = path.join(root, BUNDLE_REL);
  if (!fs.existsSync(file)) throw new Error(`${BUNDLE_REL} does not exist — the esbuild step of \`npm run bundle\` comes first`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-bundle-stamp-'));
  try {
    const built = bundleInto(root, esbuildArgs, tmp);
    const { body } = splitStamp(fs.readFileSync(file));
    if (!built.bytes.equals(body)) {
      throw new Error(`${BUNDLE_REL} is not what the current sources bundle to (did a source change while building?) — run \`npm run bundle\` again`);
    }
    fs.writeFileSync(file, withStamp(body, inputsDigest(root, built.inputs, esbuildArgs, pkg)));
    process.stdout.write(`stamp-bundle: ${BUNDLE_REL} stamped (${built.inputs.length} first-party source files)\n`);
    const outside = outsideModulePathCount(body);
    if (outside > 0) {
      // Not an error here: the bundle works, and tests that import dist/ run on it (`npx vitest run`).
      process.stderr.write(`stamp-bundle: warning — ${BUNDLE_REL} names ${outside} modules by a path outside the project: ${OUTSIDE_PATHS_ADVICE}. \`npm test\` refuses this bundle.\n`);
    }
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Run only as a command — check-dist-fresh.mjs imports the functions above.
// Both sides are real paths: a symlink on the way to this file must not turn the command into a silent no-op.
const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`stamp-bundle: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
