/** Offline rule layer: hits, near misses, scoping, and counters. @module dsh-jev/test/rules */

import { describe, expect, it } from 'vitest'

import type { ResolvedRulesConfig } from '../src/config.ts'
import { JevRules } from '../src/rules.ts'

const BASE: ResolvedRulesConfig = { enabled: true, tools: [], deny: [] }

/**
 * Build a rule layer over the shared fixture.
 * @param overrides - configuration overrides for one case.
 * @returns the rule layer under test.
 */
function makeRules(overrides: Partial<ResolvedRulesConfig> = {}): JevRules {
  return new JevRules({ config: { ...BASE, ...overrides } })
}

/**
 * Judge one shell command.
 * @param engine - rule layer under test.
 * @param command - command text to judge.
 * @returns the refusal, or `undefined` when the call is allowed.
 */
function judge(engine: JevRules, command: string): string | undefined {
  return engine.inspect({ name: 'bash', arguments: { command } })
}

describe('scope', () => {
  it('never inspects anything while disabled', () => {
    const engine = makeRules({ enabled: false })

    expect(judge(engine, 'rm -rf /')).toBeUndefined()
    expect(engine.stats()).toEqual({ inspected: 0, denied: 0 })
  })

  it('skips a tool outside the configured scope without counting it', () => {
    const engine = makeRules({ tools: ['bash'] })

    expect(engine.inspect({ name: 'read', arguments: { path: '/etc/hosts' } })).toBeUndefined()
    expect(engine.stats()).toEqual({ inspected: 0, denied: 0 })
  })

  it('inspects every tool when the scope is empty', () => {
    const engine = makeRules()

    expect(engine.inspect({ name: 'anything', arguments: { command: 'rm -rf /' } })).toBeDefined()
    expect(engine.stats().inspected).toBe(1)
  })
})

describe('built-in rules', () => {
  it.each([
    ['rm -rf /'],
    ['rm -rf /*'],
    ['rm -rf ~'],
    ['sudo rm -rf /'],
    ['rm -fr /'],
  ])('refuses a recursive delete of a root or home: %s', (command) => {
    expect(judge(makeRules(), command)).toBeDefined()
  })

  it.each([
    ['a relative build directory', 'rm -rf ./build'],
    ['a specific absolute path', 'rm -rf /tmp/scratch'],
    ['a home subdirectory', 'rm -rf ~/projects/old'],
    ['a non-recursive delete', 'rm /tmp/one-file'],
  ])('allows a narrowed delete: %s', (_label, command) => {
    // Refusing ordinary work would teach the model to route around this layer.
    expect(judge(makeRules(), command)).toBeUndefined()
  })

  it('refuses a direct write to a block device but allows a regular file', () => {
    expect(judge(makeRules(), 'dd if=/dev/zero of=/dev/sda')).toBeDefined()
    expect(judge(makeRules(), 'dd if=x of=./copy.img')).toBeUndefined()
  })

  it('refuses filesystem formatting but allows the word in prose', () => {
    expect(judge(makeRules(), 'mkfs.ext4 /dev/sdb1')).toBeDefined()
    expect(judge(makeRules(), 'echo formatting the report')).toBeUndefined()
  })

  it('refuses a force push but allows its lease-guarded form', () => {
    expect(judge(makeRules(), 'git push --force origin main')).toBeDefined()
    expect(judge(makeRules(), 'git push -f origin main')).toBeDefined()
    expect(judge(makeRules(), 'git push --force-with-lease origin main')).toBeUndefined()
    expect(judge(makeRules(), 'git push origin main')).toBeUndefined()
  })

  it('refuses destructive SQL but allows a read', () => {
    expect(judge(makeRules(), 'DROP TABLE users')).toBeDefined()
    expect(judge(makeRules(), 'drop database production')).toBeDefined()
    expect(judge(makeRules(), 'TRUNCATE TABLE audit_log')).toBeDefined()
    expect(judge(makeRules(), 'SELECT * FROM users')).toBeUndefined()
  })

  it('refuses a world-writable root but allows a scoped chmod', () => {
    expect(judge(makeRules(), 'chmod -R 777 /')).toBeDefined()
    expect(judge(makeRules(), 'chmod 777 /var/www')).toBeUndefined()
    expect(judge(makeRules(), 'chmod 755 ./run.sh')).toBeUndefined()
  })

  it('refuses a fork bomb', () => {
    expect(judge(makeRules(), ':(){:|:&};:')).toBeDefined()
    expect(judge(makeRules(), 'echo done')).toBeUndefined()
  })

  it('refuses a host power command but allows the word in prose', () => {
    expect(judge(makeRules(), 'shutdown -h now')).toBeDefined()
    expect(judge(makeRules(), 'sudo reboot')).toBeDefined()
    expect(judge(makeRules(), 'systemctl stop app && reboot')).toBeDefined()
    expect(judge(makeRules(), 'echo reboot')).toBeUndefined()
  })

  it('matches regardless of case', () => {
    expect(judge(makeRules(), 'DROP table Users')).toBeDefined()
    expect(judge(makeRules(), 'Git Push --Force')).toBeDefined()
  })
})

describe('configuration and safety', () => {
  it('applies a deployment-supplied deny pattern', () => {
    const engine = makeRules({ deny: ['\\bterraform\\s+destroy\\b'] })

    expect(judge(engine, 'terraform destroy -auto-approve')).toBeDefined()
    expect(judge(engine, 'terraform plan')).toBeUndefined()
  })

  it('never echoes the arguments in a refusal', () => {
    const engine = makeRules()
    const secret = 'sk-secret-value'
    const refusals = [
      engine.inspect({ name: 'bash', arguments: { command: `rm -rf / # ${secret}` } }),
      engine.inspect({ name: 'bash', arguments: { command: `git push --force # ${secret}` } }),
      engine.inspect({ name: 'bash', arguments: { command: `DROP TABLE t -- ${secret}` } }),
    ]

    for (const refusal of refusals) {
      expect(refusal).toBeDefined()
      expect(refusal).not.toContain(secret)
    }
  })

  it('ignores non-string argument values without failing', () => {
    const engine = makeRules()

    expect(engine.inspect({ name: 'bash', arguments: { retries: 3, dryRun: false, note: null } })).toBeUndefined()
    expect(engine.inspect({ name: 'bash', arguments: undefined })).toBeUndefined()
    expect(engine.stats().denied).toBe(0)
  })

  it('finds a command nested inside the arguments', () => {
    const engine = makeRules()

    expect(engine.inspect({ name: 'bash', arguments: { step: { command: 'rm -rf /' } } })).toBeDefined()
    expect(engine.inspect({ name: 'bash', arguments: { steps: ['echo ok', 'rm -rf /'] } })).toBeDefined()
  })

  it('counts decisions and returns snapshots', () => {
    const engine = makeRules()
    const before = engine.stats()

    judge(engine, 'echo hello')
    judge(engine, 'rm -rf /')
    const after = engine.stats()

    expect(before).toEqual({ inspected: 0, denied: 0 })
    expect(after.inspected).toBe(2)
    expect(after.denied).toBe(1)
  })
})
