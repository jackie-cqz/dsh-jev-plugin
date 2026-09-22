#!/usr/bin/env node
/**
 * Jev case suite: exercises the built plugin against the live TypeSafe API with a
 * fixed battery of cases and prints one report line per case.
 *
 * Usage:
 *   npm run build
 *   TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/jev-cases.mjs
 *   TYPESAFE_API_KEY=... node --tls-max-v1.2 scripts/jev-cases.mjs score   # filter by kind
 *
 * Three assertion levels:
 *   structural  - the envelope and per-primitive ranges must hold; a failure fails the run
 *   expect      - a golden answer for an unambiguous case; a mismatch fails the run
 *   characterize- a known-weakness probe; the answer is recorded but never fails the run
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(PACKAGE_ROOT, 'dist', 'index.js')
const API_KEY_ENV = 'TYPESAFE_API_KEY'

if (!existsSync(ENTRY)) {
  console.error(`cases: ${ENTRY} is missing. Run "npm run build" first.`)
  process.exit(2)
}
if (!process.env[API_KEY_ENV]) {
  console.error(`cases: ${API_KEY_ENV} is not set.`)
  process.exit(2)
}

const Jev = await import(ENTRY)
const kindFilter = process.argv[2]

/**
 * One case. `expect` is a golden answer; `characterize` marks a Jev-weakness probe.
 */
const CASES = [
  // ---- noul: 是/否闸门 ----
  {
    id: 'noul-destructive-action',
    kind: 'noul',
    state: { action: 'DROP DATABASE production', requestedBy: 'user', reversible: false },
    question: 'Does this action require explicit human confirmation before execution?',
    expect: { noul: 'high' },
  },
  {
    id: 'noul-all-clear',
    kind: 'noul',
    state: '所有服务运行正常，过去 24 小时没有任何告警，错误率为 0。',
    question: 'Is there any incident to escalate right now?',
    expect: { noul: 'low' },
    note: '反向对照：全绿状态不应被升级',
  },
  {
    id: 'noul-moderation',
    kind: 'noul',
    state: '这条评论包含针对个人的侮辱和明确的威胁。',
    question: 'Does this content violate the community guidelines?',
    expect: { noul: 'high' },
  },
  {
    id: 'noul-low-risk-routing',
    kind: 'noul',
    state: 'How do I change my display name?',
    question: 'Is this a simple, low-risk request that needs no human review?',
    expect: { noul: 'high' },
  },

  // ---- choice: 标签分类 ----
  {
    id: 'choice-ticket-team',
    kind: 'choice',
    state: "Help! My payouts have been failing for 3 days. I'm losing sales.",
    question: 'Which team should handle this?',
    options: ['billing', 'technical', 'sales'],
    expect: { choice: 'billing' },
  },
  {
    id: 'choice-intent-routing',
    kind: 'choice',
    state: '这个函数为什么在并发时会返回旧值？帮我看看 packages/core/cache.ts 的 get 方法。',
    question: 'What does the user want?',
    options: ['explain-code', 'fix-bug', 'write-new-code', 'search'],
    expect: { choice: 'explain-code' },
  },
  {
    id: 'choice-language',
    kind: 'choice',
    state: 'Bonjour, je voudrais annuler mon abonnement.',
    question: 'Which language is this message written in?',
    options: ['English', 'Chinese', 'French', 'Spanish'],
    expect: { choice: 'French' },
  },

  // ---- score: 有序等级 ----
  {
    id: 'score-outage-urgency-zh',
    kind: 'score',
    state: '系统已经宕机 20 分钟，所有客户都无法登录。',
    question: '这个事件的紧急程度是几级？',
    options: ['低', '中', '高', '紧急'],
    expect: { score: 'top' },
  },
  {
    id: 'score-outage-urgency-en',
    kind: 'score',
    state: 'The system has been down for 20 minutes and every customer is unable to log in.',
    question: 'How urgent is this incident?',
    options: ['Low', 'Medium', 'High', 'Critical'],
    expect: { score: 'top' },
    note: '与上一条同义，用来对照中英文判断差异',
  },
  {
    id: 'score-cosmetic-issue',
    kind: 'score',
    state: '设置页面的帮助链接少了一个句号，其余一切正常。',
    question: '这个问题的严重程度是几级？',
    options: ['低', '中', '高', '紧急'],
    expect: { score: 'bottom' },
  },
  {
    id: 'score-customer-frustration',
    kind: 'score',
    state: 'This is the third time I have contacted support and nobody has replied. I am cancelling my account.',
    question: 'How frustrated is this customer?',
    options: ['Calm', 'Annoyed', 'Frustrated', 'Very angry'],
    expect: { score: 'top' },
  },

  // ---- evaluate: 原生多问题 ----
  {
    id: 'evaluate-ticket-triage',
    kind: 'evaluate',
    state: "Help! My payouts have been failing for 3 days. I'm losing sales and getting angry.",
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
    expect: { answers: ['department', 'is_urgent', 'frustration'] },
  },
  {
    id: 'evaluate-risk-gate',
    kind: 'evaluate',
    state: 'Run the migration that drops the legacy_users table on production.',
    questions: {
      needs_human: { type: 'noul', instructions: 'Does this require explicit human confirmation?' },
      risk: {
        type: 'score',
        instructions: 'How risky is this action?',
        criteria: ['none', 'low', 'medium', 'high', 'critical'],
      },
      reversible: { type: 'noul', instructions: 'Is this action reversible?' },
    },
    expect: { answers: ['needs_human', 'risk', 'reversible'] },
  },

  // ---- characterize: Jev 的已知短板 ----
  {
    id: 'weak-counting',
    kind: 'noul',
    state: 'apple apple apple banana banana',
    question: 'Does the word "apple" appear exactly 3 times?',
    characterize: { truth: 'yes' },
  },
  {
    id: 'weak-arithmetic',
    kind: 'choice',
    state: 'What is 17 * 23?',
    question: 'Select the correct product.',
    options: ['371', '391', '401', '411'],
    characterize: { truth: '391' },
  },
  {
    id: 'weak-date-compare',
    kind: 'noul',
    state: 'Event A happened on 2026-03-01. Event B happened on 2026-02-28.',
    question: 'Did Event A happen before Event B?',
    characterize: { truth: 'no' },
  },
  {
    id: 'weak-double-negation',
    kind: 'noul',
    state: 'It is not the case that the system is not down.',
    question: 'Is the system down?',
    characterize: { truth: 'yes' },
  },
]

/** Require an object. */
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Check the structural contract for one answer.
 * @returns array of violations (empty when the answer is well formed).
 */
function structural(kind, answer, options) {
  const problems = []
  if (!isObject(answer)) return ['answer is not an object']
  if (typeof answer.type !== 'string') problems.push('answer.type missing')
  const probabilities = answer.probabilities
  if (isObject(probabilities)) {
    const sum = Object.values(probabilities).reduce((total, value) => total + (typeof value === 'number' ? value : 0), 0)
    if (Math.abs(sum - 1) > 0.05) problems.push(`probabilities sum to ${sum.toFixed(3)}`)
  }
  if (kind === 'noul') {
    if (typeof answer.noul !== 'number' || answer.noul < 0 || answer.noul > 1) problems.push(`noul=${String(answer.noul)}`)
  }
  if (kind === 'choice') {
    if (typeof answer.choice !== 'string') problems.push('choice missing')
    else if (options && !options.includes(answer.choice)) problems.push(`choice "${answer.choice}" not in options`)
  }
  if (kind === 'score') {
    const levels = options?.length ?? 0
    if (typeof answer.score !== 'number') problems.push('score missing')
    else if (answer.score < 0 || answer.score > levels - 1) problems.push(`score=${answer.score} outside 0..${levels - 1}`)
    if (isObject(answer.legend) && levels > 0) {
      for (const [index, label] of Object.entries(answer.legend)) {
        if (options[Number(index)] !== label) problems.push(`legend[${index}]="${String(label)}" != "${String(options[Number(index)])}"`)
      }
    }
  }
  if ((kind === 'choice' || kind === 'score') && answer.confidence !== undefined) {
    if (typeof answer.confidence !== 'number' || answer.confidence < 0 || answer.confidence > 1) {
      problems.push(`confidence=${String(answer.confidence)}`)
    }
  }
  return problems
}

/** Compare the answer against a golden expectation. */
function golden(kind, answer, expected, options) {
  if (expected.noul !== undefined) {
    const actual = answer.noul >= 0.75 ? 'high' : answer.noul <= 0.25 ? 'low' : 'ambiguous'
    return actual === expected.noul ? null : `expected noul=${expected.noul}, got ${answer.noul}`
  }
  if (expected.choice !== undefined) {
    return answer.choice === expected.choice ? null : `expected "${expected.choice}", got "${answer.choice}"`
  }
  if (expected.score !== undefined) {
    const levels = options.length
    const actual = answer.score >= levels - 1.5 ? 'top' : answer.score <= 0.5 ? 'bottom' : 'middle'
    return actual === expected.score ? null : `expected score ${expected.score}, got ${answer.score}`
  }
  return null
}

const selected = CASES.filter(test => kindFilter === undefined || test.kind === kindFilter)
if (selected.length === 0) {
  console.error(`cases: no case matches "${kindFilter}"`)
  process.exit(2)
}

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(Jev, { timeoutMs: 30_000, retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } })

const failures = []
const characterized = []

for (const test of selected) {
  const started = Date.now()
  const arguments_ = test.kind === 'evaluate'
    ? { state: test.state, questions: test.questions }
    : test.kind === 'noul'
      ? { state: test.state, question: test.question, kind: 'noul' }
      : { state: test.state, question: test.question, kind: test.kind, options: test.options }

  const result = await ctx.tools.execute({
    name: test.kind === 'evaluate' ? 'jev_evaluate' : 'jev_decide',
    arguments: arguments_,
    callId: ToolCallId(test.id),
    signal: new AbortController().signal,
  })
  const elapsed = Date.now() - started

  if (result.isError) {
    failures.push(test.id)
    console.log(`FAIL  ${test.id.padEnd(28)} ${elapsed} ms  ${JSON.stringify(result.content).slice(0, 160)}`)
    continue
  }

  const value = result.value
  const answers = test.kind === 'evaluate' ? value.answers : { [test.id]: value.answer }
  const problems = []

  for (const [id, answer] of Object.entries(answers)) {
    const criteria = test.kind === 'evaluate' ? test.questions[id]?.criteria : test.options
    const kind = test.kind === 'evaluate' ? test.questions[id]?.type : test.kind
    // A choice question's criteria is a label -> rubric object; a score question's is an ordered array.
    const labels = Array.isArray(criteria) ? criteria : isObject(criteria) ? Object.keys(criteria) : undefined
    problems.push(...structural(kind, answer, labels).map(problem => `${id}: ${problem}`))
  }

  let summary
  if (test.kind === 'evaluate') {
    summary = Object.entries(answers).map(([id, answer]) => `${id}=${answer.choice ?? answer.noul ?? answer.score}`).join(' ')
    const missing = test.expect.answers.filter(id => !(id in answers))
    if (missing.length > 0) problems.push(`missing answers: ${missing.join(',')}`)
  } else if (test.kind === 'noul') {
    summary = `noul=${value.answer.noul}`
    const mismatch = golden('noul', value.answer, test.expect ?? {}, [])
    if (mismatch && !test.characterize) problems.push(mismatch)
    if (test.characterize) characterized.push(`${test.id}: truth=${test.characterize.truth} got=${value.answer.noul >= 0.5 ? 'yes' : 'no'} (${value.answer.noul})`)
  } else if (test.kind === 'choice') {
    summary = `choice=${value.answer.choice} p=${value.answer.probabilities?.[value.answer.choice]}`
    const mismatch = golden('choice', value.answer, test.expect ?? {}, test.options)
    if (mismatch && !test.characterize) problems.push(mismatch)
    if (test.characterize) characterized.push(`${test.id}: truth=${test.characterize.truth} got=${value.answer.choice}`)
  } else {
    summary = `score=${value.answer.score} confidence=${value.answer.confidence}`
    const mismatch = golden('score', value.answer, test.expect ?? {}, test.options)
    if (mismatch && !test.characterize) problems.push(mismatch)
  }

  const tokens = `${value.usage?.input_tokens}/${value.usage?.output_tokens}`
  if (problems.length > 0) {
    failures.push(test.id)
    console.log(`FAIL  ${test.id.padEnd(28)} ${String(elapsed).padStart(5)} ms  ${summary}`)
    for (const problem of problems) console.log(`        ${problem}`)
  } else {
    const tag = test.characterize ? 'INFO' : 'PASS'
    console.log(`${tag}  ${test.id.padEnd(28)} ${String(elapsed).padStart(5)} ms  ${summary}  (tok ${tokens})`)
  }
}

await ctx.fiber.dispose()

if (characterized.length > 0) {
  console.log('\nknown-weakness probes (recorded, never fail the run):')
  for (const line of characterized) console.log(`  ${line}`)
}

console.log(`\ncases: ${selected.length - failures.length}/${selected.length} passed`)
if (failures.length > 0) {
  console.error(`cases: failed -> ${failures.join('; ')}`)
  process.exit(1)
}
