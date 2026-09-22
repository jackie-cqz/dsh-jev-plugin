import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNpm } from './npm.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// Keep the fixture for inspection; it is ignored and never packed.
const fixture = mkdtempSync(join(root, '.release-smoke-'))
const cache = join(root, '.npm-cache')
const report = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', fixture, '--cache', cache], { cwd: root }))[0]
const dependencies = Object.fromEntries(Object.entries(manifest.devDependencies)
  .filter(([name]) => name.startsWith('@deepseek-ai/')))
dependencies[manifest.name] = `file:./${report.filename}`
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2))
runNpm(['install', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], { cwd: fixture, stdio: 'inherit' })
writeFileSync(join(fixture, 'verify.mjs'), readFileSync(join(root, 'scripts', 'verify-installed.mjs')))
execFileSync(process.execPath, ['verify.mjs'], { cwd: fixture, stdio: 'inherit' })
console.log(`check-install: passed; fixture: ${fixture}`)
