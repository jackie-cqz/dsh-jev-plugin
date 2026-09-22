// Copied into the isolated consumer: all imports must resolve there.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Jev from 'dsh-jev-plugin'

const require = createRequire(import.meta.url)
const entry = require.resolve('dsh-jev-plugin')
assert.ok(realpathSync(entry).startsWith(join(dirname(fileURLToPath(import.meta.url)), 'node_modules')))
const root = dirname(dirname(entry))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.match(readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8'), /name: dsh-jev-plugin/)
assert.ok(readFileSync(join(root, 'skills/jev-decisions/SKILL.md'), 'utf8').length > 0)
let client
runInNewContext(readFileSync(require.resolve('dsh-jev-plugin/client'), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { client = value } } },
})
assert.equal(client.id, manifest.name)
const web = client.factory(name => {
  assert.ok(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'].includes(name))
  // Client registration needs no React renderer.
  return {}
})
const slots = []
web.apply({ slots: {
  inject(name, callback) { assert.equal(name, 'tool.call.toolview'); callback() },
  register(entry) { slots.push(entry.key) },
} })
assert.deepEqual(slots.sort(), ['jev_decide', 'jev_evaluate'])

globalThis.fetch = async () => new Response(JSON.stringify({
  model: 'jev-smoke', answers: { decision: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 1, output_tokens: 1 },
}), { headers: { 'content-type': 'application/json' } })
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fork = await ctx.plugin(Jev, { apiKey: 'mock-release-key' })
  for (const name of ['jev_decide', 'jev_evaluate']) {
    assert.equal(ctx.tools.get(name)?.name, name)
    const args = name === 'jev_decide'
      ? { state: 'test', question: 'Urgent?', kind: 'noul' }
      : { state: 'test', questions: { decision: { type: 'noul', instructions: 'Urgent?' } } }
    const result = await ctx.tools.execute({ name, arguments: args, callId: 'release-smoke', signal: new AbortController().signal })
    assert.ok(!result.isError, JSON.stringify(result.content))
    assert.equal(result.value.model, 'jev-smoke')
    assert.ok(result.content.length > 0)
  }
  await fork.dispose()
  assert.equal(ctx.tools.get('jev_decide'), undefined)
  assert.equal(ctx.tools.get('jev_evaluate'), undefined)
} finally {
  await ctx.fiber.dispose()
}
console.log('Installed tarball: server calls, disposal, client registration, patch and skill passed (mock API).')
