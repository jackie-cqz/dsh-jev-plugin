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
