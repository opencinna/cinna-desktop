import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A kit agent's `mcp_servers[]` as detach and the Addons tab's Remove change
 * it: through the manifest on disk, only where the user may change the agent,
 * a refusal answered as data, and a connector no requirement was written for
 * (a plugin's, a custom one) leaving the manifest alone.
 */

const kit = vi.hoisted(() => ({
  target: null as { rootId: string; dir: string } | { ok: false; code: string; message: string } | null,
  access: 'ok' as 'ok' | 'read_only' | 'access_unknown',
  settle: vi.fn()
}))
vi.mock('../catalogSkillService', () => ({
  locateKit: () => kit.target,
  changeability: async () => kit.access,
  changeabilitySentence: (access: string) => `sentence:${access}`,
  settle: kit.settle
}))
vi.mock('../catalogSkillUpdates', () => ({ activeListing: () => null }))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('../../db/mcpProviders', () => ({ mcpProviderRepo: { getOwned: (_userId: string, id: string) => rows.get(id) } }))

const { dropRequirementOfProvider, removeRequirementByName, REQUIREMENT_NOT_KIT } = await import('./requirements')

const REF = { source: 'core-mcp-directory', id: 'fs' }
const OTHER = { source: 'mcp-registry:cinna-official', id: 'granola' }
let dir: string

const servers = (): unknown => (JSON.parse(readFileSync(join(dir, 'cinna-agent.json'), 'utf8')) as { mcp_servers?: unknown }).mcp_servers

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-req-'))
  writeFileSync(
    join(dir, 'cinna-agent.json'),
    JSON.stringify({
      name: 'fs-agent',
      mcp_servers: [
        { name: 'fs', ref: REF, transport: 'stdio', command: 'npx' },
        { name: 'granola', ref: OTHER, transport: 'http', url: 'https://g.example/mcp', auth: 'oauth' },
        { name: 'mine', transport: 'stdio', command: './srv' }
      ]
    })
  )
  kit.target = { rootId: 'r1', dir }
  kit.access = 'ok'
  kit.settle.mockClear()
  rows.clear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const names = (): string[] => ((servers() as Array<{ name: string }> | undefined) ?? []).map((item) => item.name)

describe('dropRequirementOfProvider', () => {
  it('drops the requirement of the directory entry the detached connector was made from', async () => {
    rows.set('m1', { id: 'm1', registryRef: REF, managedBy: null })
    await dropRequirementOfProvider('u', 'folder:a', 'm1')
    expect(names()).toEqual(['granola', 'mine'])
    expect(kit.settle).toHaveBeenCalledWith('r1', 'folder:a')
  })

  it('leaves the manifest alone for a plugin’s connector, a custom one, a gone one, and a team agent shared to use', async () => {
    rows.set('plugin', { id: 'plugin', registryRef: REF, managedBy: 'plugin:e@s' })
    rows.set('custom', { id: 'custom', registryRef: null, managedBy: null })
    rows.set('m1', { id: 'm1', registryRef: REF, managedBy: null })
    await dropRequirementOfProvider('u', 'folder:a', 'plugin')
    await dropRequirementOfProvider('u', 'folder:a', 'custom')
    await dropRequirementOfProvider('u', 'folder:a', 'gone')
    kit.access = 'read_only'
    await dropRequirementOfProvider('u', 'folder:a', 'm1')
    expect(names()).toEqual(['fs', 'granola', 'mine'])
    expect(kit.settle).not.toHaveBeenCalled()
  })
})

describe('removeRequirementByName', () => {
  it('removes the named requirement, a ref-less one too, and a name it does not hold is a no-op', async () => {
    expect(await removeRequirementByName('u', 'folder:a', 'granola')).toEqual({ ok: true, next: null })
    expect(await removeRequirementByName('u', 'folder:a', 'mine')).toEqual({ ok: true, next: null })
    expect(names()).toEqual(['fs'])
    expect(await removeRequirementByName('u', 'folder:a', 'nope')).toEqual({ ok: true, next: null })
    expect(kit.settle).toHaveBeenCalledTimes(2)
    await removeRequirementByName('u', 'folder:a', 'fs')
    // The last one goes with its key.
    expect(servers()).toBeUndefined()
  })

  it('answers a read-only agent and an agent with no manifest as data, and writes nothing', async () => {
    kit.access = 'read_only'
    expect(await removeRequirementByName('u', 'folder:a', 'fs')).toEqual({ ok: false, code: 'read_only', message: 'sentence:read_only' })
    kit.target = { ok: false, code: 'not_kit_agent', message: 'x' }
    expect(await removeRequirementByName('u', 'folder:a', 'fs')).toEqual({ ok: false, code: 'not_kit_agent', message: REQUIREMENT_NOT_KIT })
    expect(names()).toEqual(['fs', 'granola', 'mine'])
  })
})
