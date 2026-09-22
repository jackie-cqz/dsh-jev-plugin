#!/usr/bin/env node
/**
 * Packaging gate for dsh-jev.
 *
 * Asserts that `npm pack` would publish exactly the intended files, that no
 * source or test material leaks into the tarball, and that every path declared
 * by `main` / `types` / `exports` is actually present in the packed set. The
 * last check guards a real regression: tsdown emits `.mjs` / `.d.mts` under
 * `platform: 'node'` unless `fixedExtension: false` is set, which silently
 * breaks the declared `.js` / `.d.ts` entry points.
 *
 * Usage:
 *   node scripts/check-pack.mjs
 *
 * Exits 0 when every check passes, 1 otherwise. Reads no third-party modules.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The complete, exact publish payload. */
const EXPECTED_FILES = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'dist/index.d.ts',
  'dist/index.js',
  'lib/client.js',
  'package.json',
]

/** Path segments that must never appear in a published tarball. */
const FORBIDDEN_SEGMENTS = ['test/', 'tests/', 'scripts/', 'src/', 'node_modules/', '.npm-cache/', '.git/']

/** Path suffixes that must never appear in a published tarball. */
const FORBIDDEN_SUFFIXES = ['.tgz', '.log', '.tsbuildinfo', '.tsx', '.map']

const results = []

/**
 * Record one check.
 * @param {string} label - what the check asserts.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - evidence printed either way.
 */
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/**
 * Run `npm pack --dry-run --json`.
 *
 * Two flags are forced, and neither is cosmetic:
 *
 * `--cache <package>/.npm-cache` is always passed because npm's default cache
 * lives under `$HOME`, and on a host where that directory is root-owned npm
 * fails writing both `_cacache` and `_logs`. Those two failures do not share a
 * recognizable error code — the `_logs` one only says "Log files were not
 * written due to an error writing to the directory" — so pattern-matching on
 * stderr cannot reliably trigger a retry. Pinning the cache removes the whole
 * class of failure instead of catching it.
 *
 * `--loglevel=notice` is forced because `--json` writes its report through npm's
 * logging channel: an inherited `npm_config_loglevel=silent` (from a caller
 * running `npm run --silent check:pack`) suppresses the report entirely and the
 * pack looks like it failed. A CLI flag outranks the inherited environment.
 * @returns the raw stdout of the successful run.
 */
function runPackDryRun() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = [
    'pack', '--dry-run', '--json',
    '--loglevel=notice',
    '--cache', join(PACKAGE_ROOT, '.npm-cache'),
  ]
  return execFileSync(npm, args, { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Extract the JSON payload from stdout that lifecycle scripts also write to.
 * @param {string} stdout - combined `npm pack --dry-run --json` output.
 * @returns the parsed array of pack reports.
 */
function extractPackReport(stdout) {
  const candidates = [0]
  for (let index = stdout.indexOf('\n['); index !== -1; index = stdout.indexOf('\n[', index + 1)) {
    candidates.push(index + 1)
  }
  for (const start of candidates) {
    try {
      const parsed = JSON.parse(stdout.slice(start))
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // Not the payload start; try the next candidate.
    }
  }
  throw new Error(
    `no JSON array found in ${stdout.length} bytes of npm output `
    + `(first line: ${JSON.stringify(stdout.split('\n')[0]?.slice(0, 80))})`,
  )
}

let report
try {
  report = extractPackReport(runPackDryRun())[0]
} catch (error) {
  // A lifecycle script writing to stdout, or npm itself failing, must surface as
  // its own failure rather than bubbling up as an unhandled exception.
  check(
    'npm pack --dry-run --json produced a parseable report',
    false,
    error instanceof Error ? error.message : String(error),
  )
  console.log('')
  console.error('check-pack: failed -> the pack report is unavailable, so the payload checks did not run')
  process.exit(1)
}

const packed = new Set(report.files.map(file => file.path))
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

console.log(`packing ${report.id} -> ${report.filename} (${report.files.length} files, ${report.size} B packed)`)
console.log('')

// --- exact payload -----------------------------------------------------------

const unexpected = [...packed].filter(path => !EXPECTED_FILES.includes(path)).sort()
const missing = EXPECTED_FILES.filter(path => !packed.has(path))
check(
  'payload is exactly the intended file set',
  unexpected.length === 0 && missing.length === 0,
  missing.length === 0 && unexpected.length === 0
    ? EXPECTED_FILES.join(', ')
    : `missing [${missing.join(', ')}] unexpected [${unexpected.join(', ')}]`,
)

// --- no source, test, or build residue --------------------------------------

const leaked = [...packed].filter(path =>
  path.endsWith('.ts') && !path.endsWith('.d.ts')
  || FORBIDDEN_SUFFIXES.some(suffix => path.endsWith(suffix))
  || FORBIDDEN_SEGMENTS.some(segment => path.includes(segment))
  || path.split('/').some(segment => segment.startsWith('.env')))
check('no source, test, script, or cache paths', leaked.length === 0, leaked.length === 0 ? `${packed.size} paths scanned` : leaked.join(', '))

// --- declared entry points exist in the payload ------------------------------

const declared = [
  ['main', manifest.main],
  ['types', manifest.types],
  ['exports["."].types', manifest.exports?.['.']?.types],
  ['exports["."].default', manifest.exports?.['.']?.default],
].filter(([, target]) => typeof target === 'string')
const normalized = declared.map(([field, target]) => [field, target.replace(/^\.\//, '')])
const unresolved = normalized.filter(([, target]) => !packed.has(target))
check(
  'main / types / exports point at packed files',
  unresolved.length === 0,
  unresolved.length === 0
    ? normalized.map(([field, target]) => `${field} -> ${target}`).join(', ')
    : unresolved.map(([field, target]) => `${field} -> ${target} (not in tarball)`).join(', '),
)

// --- build outputs are non-empty on disk and in the tarball ------------------

const dist = ['dist/index.js', 'dist/index.d.ts', 'lib/client.js']
const emptyOnDisk = dist.filter(path => !existsSync(join(PACKAGE_ROOT, path)) || statSync(join(PACKAGE_ROOT, path)).size === 0)
const emptyInPack = report.files.filter(file => dist.includes(file.path) && file.size === 0).map(file => file.path)
check(
  'dist and the client artifact are present and non-empty',
  emptyOnDisk.length === 0 && emptyInPack.length === 0,
  emptyOnDisk.length === 0 && emptyInPack.length === 0
    ? report.files.filter(file => dist.includes(file.path)).map(file => `${file.path} ${file.size} B`).join(', ')
    : `empty or missing: ${[...emptyOnDisk, ...emptyInPack].join(', ')}`,
)

// --- summary -----------------------------------------------------------------

const failed = results.filter(result => !result.ok)
console.log('')
console.log(`check-pack: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error(`check-pack: failed -> ${failed.map(result => result.label).join('; ')}`)
  process.exit(1)
}
