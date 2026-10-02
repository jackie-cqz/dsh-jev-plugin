import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNpm, parsePackReport } from './npm.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// Keep the fixture for inspection; it is ignored and never packed.
const fixture = mkdtempSync(join(root, '.release-smoke-'))
const cache = join(root, '.npm-cache')
const report = parsePackReport(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', fixture, '--cache', cache], { cwd: root }))
const dependencies = Object.fromEntries(Object.entries(manifest.devDependencies)
  .filter(([name]) => name.startsWith('@deepseek-ai/')))
// Exercise each supported prerelease explicitly: npm's latest tag and caret
// ranges do not select a newer minor's prerelease automatically.
const target = process.env.DSH_TEST_VERSION ?? manifest.devDependencies['@deepseek-ai/dsh-tools']
if (!['0.1.6-alpha.2', '0.1.7-rc.2', '0.2.0-rc.2'].includes(target)) {
  throw new Error(`Unsupported DSH_TEST_VERSION: ${target}`)
}
for (const name of Object.keys(dependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = target
}
dependencies['@deepseek-ai/cordis'] = target === '0.1.6-alpha.2' ? '4.0.2' : '4.0.4'
dependencies['@deepseek-ai/schemastery'] = target === '0.1.6-alpha.2' ? '3.18.2' : '3.18.4'
console.log(`check-install: testing DSH ${target}`)
dependencies[manifest.name] = `file:./${report.filename}`
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2))
runNpm(['install', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], { cwd: fixture, stdio: 'inherit' })
writeFileSync(join(fixture, 'verify.mjs'), readFileSync(join(root, 'scripts', 'verify-installed.mjs')))
execFileSync(process.execPath, ['verify.mjs'], { cwd: fixture, stdio: 'inherit' })
console.log(`check-install: passed; fixture: ${fixture}`)
