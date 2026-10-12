/**
 * `scripts/pin-assets.mjs opencode` — run as `make pin-assets` runs it, with
 * `fetch` replaced by a preload, so no byte leaves the machine.
 *
 * What it pins: every pinned platform gets a row hashed from the downloaded
 * bytes at the release URL the app itself derives (`binaryResolver.assetUrl`),
 * and a row whose bytes disagree with GitHub's published `sha256:` digest is
 * refused rather than printed.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PINS } from './runtimePins'

const VERSION = '9.9.9'
const bytesOf = (file: string): string => `archive bytes of ${file}`
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Run the script with a fake `fetch`; `digests` is what the release API lists. */
function run(digests: Record<string, string> | 'down'): { status: number; stdout: string; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), 'cinna-pin-assets-'))
  const preload = join(dir, 'fetch.mjs')
  writeFileSync(preload, `
const digests = ${JSON.stringify(digests)}
globalThis.fetch = async (url) => {
  url = String(url)
  if (url === 'https://api.github.com/repos/anomalyco/opencode/releases/tags/v${VERSION}') {
    if (digests === 'down') return new Response('rate limited', { status: 403 })
    return Response.json({ assets: Object.entries(digests).map(([name, digest]) => ({ name, digest: 'sha256:' + digest })) })
  }
  const prefix = 'https://github.com/anomalyco/opencode/releases/download/v${VERSION}/'
  if (!url.startsWith(prefix)) return new Response('not found', { status: 404 })
  return new Response('archive bytes of ' + url.slice(prefix.length))
}
`)
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', preload, resolve('scripts/pin-assets.mjs'), 'opencode', VERSION],
    { encoding: 'utf8' }
  )
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr }
}

const assets = Object.entries(RUNTIME_PINS.opencode.assets)
const published = Object.fromEntries(assets.map(([, asset]) => [asset.file, sha(bytesOf(asset.file))]))

describe('pin-assets opencode', () => {
  it('prints one row per pinned platform, hashed from the release bytes, checked against GitHub', () => {
    const out = run(published)
    expect(out.status).toBe(0)
    for (const [platform, asset] of assets) {
      expect(out.stdout).toContain(`'${platform}': {\n  file: '${asset.file}',\n  sha256: '${sha(bytesOf(asset.file))}'\n},`)
    }
    expect(out.stdout.match(/file: /g)).toHaveLength(assets.length)
  }, 30_000)

  it('refuses a row whose bytes disagree with the published digest', () => {
    const [, first] = assets[0]
    const out = run({ ...published, [first.file]: sha('other bytes') })
    expect(out.status).not.toBe(0)
    expect(out.stderr).toContain('disagree with GitHub')
    expect(out.stdout).not.toContain('sha256:')
  }, 30_000)

  it('still prints when the release API does not answer, and says so on every row', () => {
    const out = run('down')
    expect(out.status).toBe(0)
    expect(out.stdout.match(/file: /g)).toHaveLength(assets.length)
    expect(out.stderr.match(/GitHub digest unavailable \(HTTP 403\)/g)).toHaveLength(assets.length)
  }, 30_000)
})
