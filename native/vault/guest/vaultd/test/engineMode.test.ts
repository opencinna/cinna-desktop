import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setClaudeDefaultMode } from '../src/engine'
import { Client, startVaultd, type Harness } from './harness'

let home = ''
let harness: Harness | null = null

afterEach(async () => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = ''
  await harness?.stop()
  harness = null
})

describe('engine.spawn mode (Claude opens a session in the mode main names)', () => {
  it('records permissions.defaultMode in the vault\'s own Claude settings, keeping the rest', async () => {
    home = mkdtempSync(join(tmpdir(), 'vd-home-'))
    await setClaudeDefaultMode(home, 'default')
    const file = join(home, '.claude', 'settings.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ permissions: { defaultMode: 'default' } })
    writeFileSync(file, JSON.stringify({ model: 'haiku', permissions: { allow: ['Read'], defaultMode: 'default' } }))
    await setClaudeDefaultMode(home, 'auto')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'haiku', permissions: { allow: ['Read'], defaultMode: 'auto' } })
  })

  it('refuses a mode it does not know before starting anything', async () => {
    harness = await startVaultd()
    mkdirSync(harness.root, { recursive: true })
    const client = await Client.open(harness.sock)
    try {
      expect(await client.code('engine.spawn', { engine: 'claude', options: { mode: 'bypassPermissions' } })).toBe('invalid')
    } finally {
      client.close()
    }
  })
})
