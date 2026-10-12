/**
 * `scripts/pin-assets.mjs opencode` — run as `make pin-assets` runs it, with
 * `fetch` replaced by a preload, so no byte leaves the machine.
 *
 * What it pins: every pinned platform gets a row hashed from the downloaded
 * bytes of its npm platform tarball (`@opencode/cli-<target>`, Windows named
 * `windows-*`), and a row whose bytes disagree with the package's
 * `dist.integrity` — or a package with no sha512 integrity — is refused rather
 * than printed.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PINS } from './runtimePins'

const VERSION = '9.9.9'
const targetOf = (platform: string): string => platform.replace(/^win32-/, 'windows-')
const tarballOf = (target: string): string =>
  `https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${VERSION}.tgz`
const bytesOf = (target: string): string => `tarball bytes of ${target}`
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const sha512 = (text: string): string => `sha512-${createHash('sha512').update(text).digest('base64')}`

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Run the script with a fake `fetch`; `integrity` is what npm lists per target (null: none). */
function run(integrity: Record<string, string | null>): { status: number; stdout: string; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), 'cinna-pin-assets-'))
  const preload = join(dir, 'fetch.mjs')
  writeFileSync(preload, `
const integrity = ${JSON.stringify(integrity)}
const version = ${JSON.stringify(VERSION)}
const registry = 'https://registry.npmjs.org/@opencode/cli-'
globalThis.fetch = async (url) => {
  url = String(url)
  if (!url.startsWith(registry)) return new Response('not found', { status: 404 })
  const [target, ...rest] = url.slice(registry.length).split('/')
  if (!(target in integrity)) return new Response('not found', { status: 404 })
  const tarball = registry + target + '/-/cli-' + target + '-' + version + '.tgz'
  if (url === tarball) return new Response('tarball bytes of ' + target)
  if (rest.join('/') !== version) return new Response('not found', { status: 404 })
  return Response.json({ dist: { tarball, ...(integrity[target] ? { integrity: integrity[target] } : {}) } })
}
`)
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', preload, resolve('scripts/pin-assets.mjs'), 'opencode', VERSION],
    { encoding: 'utf8' }
  )
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr }
}

const platforms = Object.keys(RUNTIME_PINS.opencode.assets)
const published = Object.fromEntries(platforms.map((platform) => [targetOf(platform), sha512(bytesOf(targetOf(platform)))]))

describe('pin-assets opencode', () => {
  it('prints one row per pinned platform, hashed from the npm tarball, checked against its integrity', () => {
    const out = run(published)
    expect(out.status).toBe(0)
    for (const platform of platforms) {
      const target = targetOf(platform)
      expect(out.stdout).toContain(`'${platform}': opencodeAsset('${target}', '${sha256(bytesOf(target))}', ${bytesOf(target).length}),`)
      expect(out.stderr).toContain(tarballOf(target))
    }
    expect(out.stdout.match(/opencodeAsset\(/g)).toHaveLength(platforms.length)
    expect(out.stderr.match(/matches npm integrity/g)).toHaveLength(platforms.length)
  }, 30_000)

  it('refuses a row whose bytes disagree with npm’s integrity', () => {
    const first = targetOf(platforms[0]!)
    const out = run({ ...published, [first]: sha512('other bytes') })
    expect(out.status).not.toBe(0)
    expect(out.stderr).toContain('disagree with npm')
    expect(out.stdout).not.toContain('opencodeAsset(')
  }, 30_000)

  it('refuses a package that publishes no sha512 integrity', () => {
    const first = targetOf(platforms[0]!)
    const out = run({ ...published, [first]: null })
    expect(out.status).not.toBe(0)
    expect(out.stderr).toContain('no sha512 integrity')
    expect(out.stdout).not.toContain('opencodeAsset(')
  }, 30_000)
})
