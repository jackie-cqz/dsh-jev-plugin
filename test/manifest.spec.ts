/**
 * Package manifest contract: the fields DSH's profile readers resolve.
 *
 * DSH publishes `DshPackageManifest` for this, but typing against it would add
 * `@deepseek-ai/dsh-package-manifest` as a devDependency to check two fields, so
 * the assertions below state the same obligations directly. Declaring
 * `dsh.manifestVersion` and `engines.dsh` is declarative only: current loaders
 * do not enforce either, so a missing or wrong value fails silently at install
 * time and shows up as an incompatible profile later.
 *
 * @module dsh-jev/test/manifest
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The published manifest, read once. */
const manifest = JSON.parse(
  readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8'),
) as {
  name: string
  version: string
  private?: boolean
  files?: string[]
  engines?: { node?: string; dsh?: string }
  exports?: Record<string, { default?: string }>
  dsh?: { manifestVersion?: number; bundle?: { patch?: string }; client?: { platform?: string } }
  peerDependencies?: Record<string, string>
}

describe('package manifest', () => {
  it('declares the manifest format version DSH documents', () => {
    expect(manifest.dsh?.manifestVersion).toBe(1)
  })

  it('declares a DSH compatibility range beside the Node one', () => {
    // The declared range is advisory, so it is the only statement of which
    // harness releases this plugin was built against.
    expect(manifest.engines?.dsh).toBe('>=0.1.6-alpha.2 <0.2.0')
    expect(manifest.engines?.node).toBe('>=22')
  })

  it('resolves the bundle patch DSH loads', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the host bundle, the client bundle, and the two licence-adjacent files', () => {
    // `lib` holds the Web client half, which DSH loads as a module-loader
    // factory rather than through `main`; both entry points must ship.
    expect(manifest.files).toEqual(['dist', 'lib', 'cordis.patch.yml', 'README.md', 'LICENSE'])
  })

  it('exposes the client half under its own export and manifest field', () => {
    expect(manifest.exports?.['./client']?.default).toBe('./lib/client.js')
    expect(manifest.dsh?.client).toEqual({ platform: 'web' })
  })

  it('stays publishable and names the peers the host provides', () => {
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
    ])
  })
})
