import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
const state = vi.hoisted(() => ({ db: null as TestDatabase | null, root: '', mode: { engine: 'claude', modelId: 'sonnet', providerId: null, systemPrompt: 'Original instructions', toolPolicy: 'connectors' } }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('./chatModeService', () => ({ chatModeService: { findMerged: () => state.mode, resolveEffectiveDefault: () => state.mode } }))
vi.mock('./localAgents/defaultEngineService', () => ({ defaultEngineService: { current: () => 'claude' } }))
vi.mock('./providerService', () => ({ providerService: { listMerged: () => [] } }))
vi.mock('./localAgents/runtimeService', () => ({ runtimeService: { resolve: (input: { model?: string }) => ({ modelId: input.model ?? 'sonnet', credentialId: null }) } }))
const { chatConductorService, conductorContext } = await import('./chatConductorService')
const { chatRepo } = await import('../db/chats')
const { agentRepo } = await import('../db/agents')
beforeEach(() => {
  state.db = createTestDatabase()
  state.root = mkdtempSync(join(tmpdir(), 'conductor-folders-'))
  state.mode = { engine: 'claude', modelId: 'sonnet', providerId: null, systemPrompt: 'Original instructions', toolPolicy: 'connectors' }
})
afterEach(() => { state.db?.close(); rmSync(state.root, { recursive: true, force: true }) })
describe('owned chat runtimes', () => {
  it('snapshots defaults, refreshes explicit mode changes in place, and isolates chat folders', () => {
    const chat = chatRepo.create('profile', {})
    const bound = chatConductorService.bind('profile', chat)
    const first = agentRepo.getOwned('profile', bound.agentId!)!
    const path = conductorContext(first).path
    expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toContain('Original instructions')
    state.mode.systemPrompt = 'Updated instructions'
    state.mode.modelId = 'opus'
    expect(conductorContext(chatConductorService.ensure('profile', bound)).instructions).toBe('Original instructions')
    const refreshed = chatConductorService.ensure('profile', bound, true)
    expect(refreshed.id).toBe(first.id)
    expect(conductorContext(refreshed)).toMatchObject({ instructions: 'Updated instructions', modelId: 'opus', path })
    const another = chatRepo.create('profile', {})
    const other = chatConductorService.ensure('profile', another)
    expect(conductorContext(other).path).not.toBe(path)
    expect(() => chatConductorService.runtime('profile', refreshed).validate(another.id)).toThrow('no longer available')
  })
  it('permanent cleanup removes only the generated row and folder owned by that chat', () => {
    const chat = chatRepo.create('profile', {})
    const generated = chatConductorService.ensure('profile', chat)
    const otherChat = chatRepo.create('profile', {})
    const other = chatConductorService.ensure('profile', otherChat)
    chatRepo.permanentDelete('profile', chat.id)
    chatConductorService.remove('profile', chat.id)
    expect(agentRepo.getOwned('profile', generated.id)).toBeUndefined()
    expect(existsSync(conductorContext(generated).path)).toBe(false)
    expect(agentRepo.getOwned('profile', other.id)).toBeDefined()
    expect(existsSync(conductorContext(other).path)).toBe(true)
  })
})
