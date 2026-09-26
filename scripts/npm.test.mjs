import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePackReport } from './npm.mjs'

const report = { filename: 'plugin.tgz', files: [{ path: 'package.json' }] }
test('accepts npm 10/11 arrays and npm 12 keyed reports with lifecycle output', () => {
  assert.deepEqual(parsePackReport(JSON.stringify([report])), report)
  assert.deepEqual(parsePackReport('build output\n' + JSON.stringify({ plugin: report })), report)
})
test('rejects errors, incomplete reports and ambiguous multiple packages', () => {
  for (const value of ['not json', '{}', '[]', '{"error":{"code":"EFAIL"}}',
    JSON.stringify([{ filename: 'plugin.tgz' }]), JSON.stringify([report, report])]) {
    assert.throws(() => parsePackReport(value))
  }
})
