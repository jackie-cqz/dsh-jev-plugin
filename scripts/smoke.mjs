#!/usr/bin/env node
/**
 * Real-API smoke test for dsh-jev (PLAN P0-11).
 *
 * Drives the built plugin through a real DSH tool registry against the live
 * TypeSafe API, so it exercises the same path a profile does: argument
 * validation, the HTTP transport, envelope validation, and render.
 *
 * Usage:
 *   npm run build
 *   TYPESAFE_API_KEY=... npm run smoke
 *
 * If the network drops TLS 1.3 ClientHellos (symptom: every call fails after a
 * long wait with "no response from the TypeSafe API", while curl reaches the
 * same host instantly), cap the handshake at TLS 1.2 for this run:
 *
 *   TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/smoke.mjs
 *
 * Exits non-zero when a required call fails. The key is read from the
 * environment only; nothing is written to disk.
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(PACKAGE_ROOT, 'dist', 'index.js')
const API_KEY_ENV = 'TYPESAFE_API_KEY'
const REQUEST_TIMEOUT_MS = 30_000

if (!existsSync(ENTRY)) {
  console.error(`smoke: ${ENTRY} is missing. Run "npm run build" first.`)
  process.exit(2)
}

const apiKey = process.env[API_KEY_ENV]
if (apiKey === undefined || apiKey === '') {
  console.error(`smoke: ${API_KEY_ENV} is not set. Export a real TypeSafe API key and re-run.`)
  process.exit(2)
}

const Jev = await import(pathToFileURL(ENTRY).href)

/**
 * Mount the prompt and tool services plus one plugin instance.
 * @param config - plugin configuration for this instance.
 * @returns the context and a registry-backed call helper.
 */
async function mount(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Jev, config)
  const call = (name, args) => ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId('smoke'),
    signal: new AbortController().signal,
  })
  return { ctx, call }
}

const failures = []

/**
 * Run one smoke case and report its outcome.
 * @param label - human-readable case name.
 * @param run - performs the call and returns a one-line summary or throws.
 */
async function check(label, run) {
  const started = Date.now()
  try {
    const summary = await run()
    console.log(`PASS  ${label}  (${Date.now() - started} ms)  ${summary}`)
  } catch (error) {
    failures.push(label)
    console.log(`FAIL  ${label}  (${Date.now() - started} ms)`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Require a successful execution and return its canonical value. */
function value(result, label) {
  if (result.isError) {
    throw new Error(`${label} failed: ${JSON.stringify(result.content)}`)
  }
  return result.value
}

/** Require the Jev envelope fields the plugin promises the model. */
function assertEnvelope(envelope, key) {
  if (typeof envelope?.model !== 'string' || envelope.model === '') throw new Error('envelope.model missing')
  if (typeof envelope?.usage?.input_tokens !== 'number') throw new Error('envelope.usage.input_tokens missing')
  if (typeof envelope?.usage?.output_tokens !== 'number') throw new Error('envelope.usage.output_tokens missing')
  if (envelope[key] === undefined) throw new Error(`envelope.${key} missing`)
}

const STATE = 'Help! My payouts have been failing for 3 days. I am losing sales and getting angry.'

const { ctx, call } = await mount({
  apiKey,
  timeoutMs: REQUEST_TIMEOUT_MS,
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
})

await check('jev_decide noul', async () => {
  const envelope = value(await call('jev_decide', {
    state: STATE,
    question: 'Does this message convey urgency?',
    kind: 'noul',
  }), 'noul')
  assertEnvelope(envelope, 'answer')
  return `noul=${String(envelope.answer.noul)} model=${envelope.model}`
})

await check('jev_decide choice', async () => {
  const envelope = value(await call('jev_decide', {
    state: STATE,
    question: 'Which team should handle this?',
    kind: 'choice',
    options: ['billing', 'technical', 'sales'],
  }), 'choice')
  assertEnvelope(envelope, 'answer')
  return `choice=${String(envelope.answer.choice)} confidence=${String(envelope.answer.confidence)}`
})

await check('jev_decide score', async () => {
  const envelope = value(await call('jev_decide', {
    state: STATE,
    question: 'How urgent is this?',
    kind: 'score',
    options: ['low', 'medium', 'high', 'critical'],
  }), 'score')
  assertEnvelope(envelope, 'answer')
  return `score=${String(envelope.answer.score)} confidence=${String(envelope.answer.confidence)}`
})

await check('jev_evaluate multiple questions', async () => {
  const envelope = value(await call('jev_evaluate', {
    state: STATE,
    questions: {
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: {
          billing: 'Payment or subscription issues',
          technical: 'Bugs or integration problems',
          sales: 'Pricing or account questions',
        },
      },
      is_urgent: { type: 'noul', instructions: 'Does this message convey urgency?' },
      frustration: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['Calm', 'Frustrated', 'Very angry'],
      },
    },
  }), 'evaluate')
  assertEnvelope(envelope, 'answers')
  return `answers=${Object.keys(envelope.answers).join(',')}`
})

await check('state as object', async () => {
  const envelope = value(await call('jev_decide', {
    state: { ticket: 4821, subject: 'Payouts failing', days: 3, plan: 'pro' },
    question: 'Does this ticket describe a billing problem?',
    kind: 'noul',
  }), 'object state')
  assertEnvelope(envelope, 'answer')
  return `noul=${String(envelope.answer.noul)}`
})

await check('state as array', async () => {
  const envelope = value(await call('jev_decide', {
    state: ['payout failed', 'payout failed', 'payout failed', 'no response from support'],
    question: 'Is there a repeated failure pattern?',
    kind: 'noul',
  }), 'array state')
  assertEnvelope(envelope, 'answer')
  return `noul=${String(envelope.answer.noul)}`
})

await ctx.fiber.dispose()

await check('invalid credentials are reported readably', async () => {
  const bad = await mount({ apiKey: 'jev-invalid-key-for-smoke-test', timeoutMs: REQUEST_TIMEOUT_MS })
  try {
    const result = await bad.call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })
    if (!result.isError) throw new Error('an invalid key unexpectedly succeeded')
    const text = JSON.stringify(result.content)
    if (!/\b(401|403)\b/.test(text)) throw new Error(`expected a 401/403 message, received: ${text}`)
    return text.slice(0, 120)
  } finally {
    await bad.ctx.fiber.dispose()
  }
})

await check('a missing key is reported readably', async () => {
  const missing = await mount({ apiKeyEnv: 'DSH_JEV_SMOKE_ABSENT_KEY', timeoutMs: REQUEST_TIMEOUT_MS })
  try {
    const result = await missing.call('jev_decide', { state: 'x', question: 'y', kind: 'noul' })
    if (!result.isError) throw new Error('a missing key unexpectedly succeeded')
    const text = JSON.stringify(result.content)
    if (!text.includes('DSH_JEV_SMOKE_ABSENT_KEY')) {
      throw new Error(`expected the missing-key message to name the variable, received: ${text}`)
    }
    return text.slice(0, 160)
  } finally {
    await missing.ctx.fiber.dispose()
  }
})

console.log('')
if (failures.length > 0) {
  console.error(`smoke: ${failures.length} case(s) failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('smoke: all cases passed')
