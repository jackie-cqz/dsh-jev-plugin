import { execFileSync } from 'node:child_process'

// npm supplies its JS entry point to lifecycle scripts. Invoke Node directly:
// Windows cannot execFile an npm.cmd shim without a command shell.
export function runNpm(args, options = {}) {
  const cli = process.env.npm_execpath
  if (!cli) throw new Error('Run this check through npm run (npm_execpath is required).')
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options,
  })
}

/** Parse npm 10/11 array reports and npm 12 reports keyed by package name. */
export function parsePackReport(stdout) {
  for (const match of stdout.matchAll(/^[\[{]/gm)) {
    let parsed
    try { parsed = JSON.parse(stdout.slice(match.index)) } catch { continue }
    const reports = Array.isArray(parsed) ? parsed : Object.values(parsed)
    if (reports.length === 1 && reports[0] && typeof reports[0].filename === 'string'
      && Array.isArray(reports[0].files)) return reports[0]
  }
  throw new Error('npm pack did not return exactly one valid package report')
}
