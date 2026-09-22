#!/usr/bin/env node
/**
 * Bundle the Web client half into the closure-factory artifact the DSH module
 * loader consumes.
 *
 * The loader does not import a client plugin as a module: it hands the shell a
 * factory and resolves the baseline externals (React, Cordis, the shared client
 * packages) through the `require` it injects. So the artifact is a CJS bundle
 * wrapped in `window.__ModuleLoader__.load({ id, factory })`, with React left
 * external because the host supplies it. Shipping React instead would load a
 * second copy and break hooks.
 *
 * Usage: node scripts/build-client.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(ROOT, 'src', 'client', 'index.ts')
const OUT = join(ROOT, 'lib', 'client.js')
const ID = 'dsh-jev-plugin'

/** Bare specifiers the host's module table supplies; none may be bundled. */
const BASELINE_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis']

const bundle = await rolldown({
  input: ENTRY,
  external: BASELINE_EXTERNALS,
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
})
const { output } = await bundle.generate({ format: 'cjs', exports: 'named' })
await bundle.close()

const chunk = output.find(entry => entry.type === 'chunk')
if (chunk === undefined) throw new Error('build-client: the bundle produced no chunk')

const artifact = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${chunk.code}
		return module.exports;
	}
})
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, artifact)
console.log(`build-client: ${OUT.replace(ROOT + '/', '')} (${artifact.length} bytes)`)
