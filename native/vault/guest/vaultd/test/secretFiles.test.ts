import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineCommand } from '../src/engine'
import { Client, startVaultd, type Harness } from './harness'

/**
 * Service credentials delivered into a vault (`secrets.putFile`): stored
 * root-only, copied 0400 to `run-secrets/` for the agent, named to every
 * engine by `CINNA_CREDENTIALS_PATH`, removable, never readable back.
 */

let h: Harness
let c: Client

beforeEach(async () => {
  h = await startVaultd()
  c = await Client.open(h.sock)
  await c.call('layout.ensure')
})

afterEach(async () => {
  c?.close()
  await h?.stop()
})

/** A runtime index naming an opencode executable and the vault's launch settings, so `engineCommand` can build its env. */
function fakeOpencode(): void {
  mkdirSync(join(h.root, 'state'), { recursive: true })
  writeFileSync(join(h.root, 'state', 'kv.json'), JSON.stringify({ 'cinna.launch': { kind: 'kit', model: 'gpt-5', approval: 'ask', provider: 'openai' } }))
  const dir = join(h.root, 'runtime', 'opencode', '1.0.0')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(h.root, 'runtime', 'index.json'), JSON.stringify({ runtimes: [{ engine: 'opencode', version: '1.0.0', kind: 'executable', name: 'opencode', sha256: 'x', installedAt: 1 }] }))
}

describe('secrets.putFile', () => {
  it('stores the file root-only, gives the agent a 0400 copy and names it to the engine', async () => {
    const content = JSON.stringify([{ id: 'c1', credential_data: { token: 'SECRET-TOKEN-42' } }])
    await c.call('secrets.putFile', { name: 'credentials.json', content })
    const stored = join(h.root, 'secrets', 'files', 'credentials.json')
    expect(statSync(join(h.root, 'secrets', 'files')).mode & 0o777).toBe(0o700)
    expect(statSync(stored).mode & 0o777).toBe(0o600)
    const run = join(h.root, 'run-secrets', 'credentials.json')
    expect(readFileSync(run, 'utf8')).toBe(content)
    expect(statSync(run).mode & 0o777).toBe(0o400)
    expect(statSync(join(h.root, 'run-secrets')).mode & 0o777).toBe(0o711)
    // Not an env secret, and never readable back.
    expect(await c.call('secrets.list')).toEqual({ names: [] })
    expect(JSON.stringify(await Promise.all([c.call('files.list', { path: '' }), c.call('hello')]))).not.toContain('SECRET-TOKEN-42')

    fakeOpencode()
    expect(engineCommand(h.vaultd.ctx, 'opencode', {}).env['CINNA_CREDENTIALS_PATH']).toBe(run)
  })

  it('replaces a file, removes one with content null, and drops stray files from the agent copy', async () => {
    await c.call('secrets.putFile', { name: 'credentials.json', content: 'one' })
    await c.call('secrets.putFile', { name: 'sa-1.json', content: '{"key":1}' })
    writeFileSync(join(h.root, 'run-secrets', 'planted.json'), 'x')
    await c.call('secrets.putFile', { name: 'credentials.json', content: 'two' })
    expect(readFileSync(join(h.root, 'run-secrets', 'credentials.json'), 'utf8')).toBe('two')
    expect(existsSync(join(h.root, 'run-secrets', 'planted.json'))).toBe(false)
    await c.call('secrets.putFile', { name: 'credentials.json', content: null })
    expect(existsSync(join(h.root, 'run-secrets', 'credentials.json'))).toBe(false)
    expect(existsSync(join(h.root, 'secrets', 'files', 'credentials.json'))).toBe(false)
    expect(existsSync(join(h.root, 'run-secrets', 'sa-1.json'))).toBe(true)
    fakeOpencode()
    expect(engineCommand(h.vaultd.ctx, 'opencode', {}).env['CINNA_CREDENTIALS_PATH']).toBeUndefined()
  })

  it('refuses other names, oversized content, and the credential env names as secrets', async () => {
    for (const name of ['../x.json', 'creds.txt', '.json', 'a/b.json', 'x'.repeat(129) + '.json']) {
      expect(await c.code('secrets.putFile', { name, content: 'x' })).toBe('invalid')
    }
    expect(await c.code('secrets.putFile', { name: 'credentials.json', content: 'x'.repeat(512 * 1024 + 1) })).toBe('invalid')
    expect(await c.code('secrets.putFile', { name: 'credentials.json', content: 5 })).toBe('invalid')
    for (const name of ['CINNA_CREDENTIALS_PATH', 'CINNA_CREDENTIALS_TOKEN_URL', 'CINNA_CREDENTIALS_TOKEN']) {
      expect(await c.code('secrets.put', { name, value: '/tmp/x' })).toBe('invalid')
    }
  })
})
