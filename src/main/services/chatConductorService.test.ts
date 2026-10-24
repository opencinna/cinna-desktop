vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
const state = vi.hoisted(() => ({ db: null as TestDatabase | null, root: '', mode: { engine: 'claude', modelId: 'sonnet', providerId: null as string | null, systemPrompt: 'Original instructions', toolPolicy: 'connectors' } as Record<string, unknown> & { providerId: string | null } }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('./chatModeService', () => ({ chatModeService: { findMerged: () => state.mode, resolveEffectiveDefault: () => state.mode } }))
vi.mock('./localAgents/defaultEngineService', () => ({ defaultEngineService: { current: () => 'claude' } }))
type Provider = { id: string; type: string; name: string; enabled: boolean; hasApiKey: boolean; defaultModelId: string | null; managed: boolean; unsupported: boolean }
type Model = { id: string; providerId: string }
const resolved = vi.hoisted(() => ({ inputs: [] as Record<string, unknown>[], models: [] as unknown[], providers: [] as Provider[], cached: [] as Model[], fallbackCredential: null as string | null }))
vi.mock('./providerService', () => ({ providerService: { listMerged: () => resolved.providers } }))
vi.mock('../engine/engineConfigSource', () => ({ getCachedEngineModels: () => resolved.cached }))
// OpenCode: the named credential, else `resolveDefault`'s (fallbackCredential); a tier picks the credential's first listed model.
vi.mock('./localAgents/runtimeService', () => ({ runtimeService: { resolve: (input: { engine?: string; credential?: string; model?: string; complexity?: string }, _providers: unknown, models: Model[] = []) => {
  resolved.inputs.push(input)
  resolved.models.push(models)
  if (input.engine === 'opencode') {
    const credentialId = input.credential ?? resolved.fallbackCredential
    return { modelId: input.model ?? models.find((model) => model.providerId === credentialId)?.id ?? null, credentialId }
  }
  return { modelId: input.model ?? (input.complexity === 'complex' ? 'opus' : 'sonnet'), credentialId: null }
} } }))
const { chatConductorService, conductorContext, conductorGrantKey, conductorModelId, WORKSPACE_PROMPT } = await import('./chatConductorService')
const { externalRuntimeStatePath } = await import('./localAgents/desktopStateService')
const { installChatSessionForgetter } = await import('./chatSessionRelease')
const { chatRepo } = await import('../db/chats')
const { agentRepo } = await import('../db/agents')
beforeEach(() => {
  state.db = createTestDatabase()
  state.root = mkdtempSync(join(tmpdir(), 'conductor-folders-'))
  state.mode = { engine: 'claude', modelId: 'sonnet', providerId: null, systemPrompt: 'Original instructions', toolPolicy: 'connectors' }
  Object.assign(resolved, { inputs: [], models: [], providers: [], cached: [], fallbackCredential: null })
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
  it('refuses to make a shared chat\'s runtime from an account mode or credential, and allows a local one', () => {
    const chat = chatRepo.create('__default__', {})
    Object.assign(state.mode, { managed: true, userId: 'profile' })
    expect(() => chatConductorService.ensure('__default__', chat)).toThrow('shared across profiles')
    Object.assign(state.mode, { managed: false, userId: '__default__', providerId: 'managed:account-key' })
    expect(() => chatConductorService.ensure('__default__', chat)).toThrow('shared across profiles')
    expect(agentRepo.list('__default__')).toHaveLength(0)
    state.mode.providerId = null
    expect(conductorContext(chatConductorService.ensure('__default__', chat)).modelId).toBe('sonnet')
    // A profile's own chat may run on its account mode.
    Object.assign(state.mode, { managed: true, userId: 'profile' })
    expect(() => chatConductorService.ensure('profile', chatRepo.create('profile', {}))).not.toThrow()
  })
  it('passes the mode\'s effort to the runtime and keeps it on the chat\'s runtime; a model override still wins', () => {
    Object.assign(state.mode, { modelId: null, complexity: 'complex' })
    const tiered = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    expect(resolved.inputs.at(-1)).toMatchObject({ engine: 'claude', complexity: 'complex' })
    expect(resolved.inputs.at(-1)).not.toHaveProperty('model')
    expect(conductorContext(tiered)).toMatchObject({ complexity: 'complex', modelId: 'opus' })
    Object.assign(state.mode, { modelId: 'haiku' })
    const overridden = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    expect(resolved.inputs.at(-1)).toMatchObject({ model: 'haiku', complexity: 'complex' })
    expect(conductorContext(overridden)).toMatchObject({ complexity: 'complex', modelId: 'haiku' })
    Object.assign(state.mode, { complexity: null })
    const none = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    expect(resolved.inputs.at(-1)).not.toHaveProperty('complexity')
    expect(conductorContext(none).complexity).toBeNull()
  })
})

describe('an OpenCode chat runtime', () => {
  const provider = (id: string, over: Partial<Provider> = {}): Provider => ({ id, type: 'openai', name: id, enabled: true, hasApiKey: true, defaultModelId: null, managed: false, unsupported: false, ...over })
  beforeEach(() => { Object.assign(state.mode, { engine: 'opencode', modelId: null, providerId: null, complexity: 'medium' }) })

  it('with no credential named and none from the override or default mode, runs on the first credential that made its mode Ready', () => {
    resolved.providers = [provider('off', { enabled: false }), provider('keyless-key', { hasApiKey: false }), provider('ollama', { type: 'ollama', hasApiKey: false }), provider('later')]
    const agent = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    // Mutation: drop the third step and the chat captures no credential (the engine's NO_CREDENTIAL skip).
    expect(conductorContext(agent).credentialId).toBe('ollama')
    expect(resolved.inputs.at(-1)).toMatchObject({ engine: 'opencode', credential: 'ollama', complexity: 'medium' })
  })

  it('keeps the override or default mode credential when there is one, and a credential the mode names', () => {
    resolved.providers = [provider('first'), provider('default-mode')]
    resolved.fallbackCredential = 'default-mode'
    expect(conductorContext(chatConductorService.ensure('profile', chatRepo.create('profile', {}))).credentialId).toBe('default-mode')
    state.mode.providerId = 'named'
    resolved.fallbackCredential = null
    expect(resolved.inputs.length).toBe(1)
    chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    expect(resolved.inputs.at(-1)).toMatchObject({ credential: 'named' })
  })

  it('a shared chat falls back only to a local credential', () => {
    Object.assign(state.mode, { managed: false, userId: '__default__' })
    resolved.providers = [provider('account', { managed: true }), provider('local')]
    expect(conductorContext(chatConductorService.ensure('__default__', chatRepo.create('__default__', {}))).credentialId).toBe('local')
  })

  it('resolves Effort against the cached catalogue, and falls back to the credential\'s own default model', () => {
    resolved.providers = [provider('key', { defaultModelId: 'gpt-own-default' })]
    resolved.cached = [{ id: 'gpt-tier', providerId: 'key' }]
    state.mode.providerId = 'key'
    // Mutation: call resolve without the catalogue and Effort picks nothing (… names no model).
    expect(conductorContext(chatConductorService.ensure('profile', chatRepo.create('profile', {}))).modelId).toBe('gpt-tier')
    expect(resolved.models.at(-1)).toBe(resolved.cached)
    resolved.cached = []
    // Mutation: drop the default-model fallback and an empty catalogue launches with no model.
    expect(conductorContext(chatConductorService.ensure('profile', chatRepo.create('profile', {}))).modelId).toBe('gpt-own-default')
  })

  it('asks again for a model it could not capture, against the catalogue the engine config is built from', () => {
    resolved.providers = [provider('ollama', { type: 'ollama', hasApiKey: false })]
    const context = conductorContext(chatConductorService.ensure('profile', chatRepo.create('profile', {})))
    expect(context).toMatchObject({ credentialId: 'ollama', modelId: null })
    // Mutation: return context.modelId as captured and the engine skips the chat (no_model).
    expect(conductorModelId(context, [{ id: 'qwen3:8b', providerId: 'ollama' }])).toBe('qwen3:8b')
    expect(conductorModelId({ ...context, modelId: 'kept' }, [{ id: 'qwen3:8b', providerId: 'ollama' }])).toBe('kept')
    expect(conductorModelId({ ...context, credentialId: null }, [{ id: 'qwen3:8b', providerId: 'ollama' }])).toBeNull()
  })
})

describe('a workspace chat runtime', () => {
  const ask = { action: 'Bash', resources: ['ls -la'], savable: [] }

  it('keeps no instructions file in its folder, and writes them back when the policy changes away', () => {
    Object.assign(state.mode, { toolPolicy: 'workspace', systemPrompt: '' })
    const chat = chatRepo.create('profile', {})
    const bound = chatConductorService.bind('profile', chat)
    const row = agentRepo.getOwned('profile', bound.agentId!)!
    const path = conductorContext(row).path
    // Mutation: write the files for every policy and AGENTS.md is in the folder the model edits.
    expect(existsSync(join(path, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(path, 'CLAUDE.md'))).toBe(false)
    expect(conductorContext(row)).toMatchObject({ toolPolicy: 'workspace', instructions: WORKSPACE_PROMPT })
    expect(WORKSPACE_PROMPT).toMatch(/current directory/)
    state.mode.toolPolicy = 'connectors'
    const restricted = chatConductorService.ensure('profile', bound, true)
    expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toContain('no access to files')
    expect(conductorContext(restricted).instructions).not.toBe(WORKSPACE_PROMPT)
    state.mode.toolPolicy = 'workspace'
    chatConductorService.ensure('profile', bound, true)
    expect(existsSync(join(path, 'AGENTS.md'))).toBe(false)
  })

  it('follows a Tools change on the mode into an existing chat, releasing its sessions; other fields stay captured', () => {
    const forgotten: [string, string | undefined][] = []
    const uninstall = installChatSessionForgetter((chatId, agentId) => { forgotten.push([chatId, agentId]) })
    try {
      Object.assign(state.mode, { toolPolicy: 'workspace', systemPrompt: 'Captured' })
      const chat = chatConductorService.bind('profile', chatRepo.create('profile', {}))
      const row = agentRepo.getOwned('profile', chat.agentId!)!
      expect(chatConductorService.syncToolPolicy('profile', chat)).toBe(false)
      expect(chatConductorService.hasWorkspace(chat)).toBe(true)
      state.mode.systemPrompt = 'Edited'
      // Only Tools triggers a refresh: an instructions edit stays captured.
      expect(chatConductorService.syncToolPolicy('profile', chat)).toBe(false)
      expect(forgotten).toEqual([])
      state.mode.toolPolicy = 'none'
      // Mutation: return false unconditionally and the chat keeps shell and file tools.
      expect(chatConductorService.syncToolPolicy('profile', chat)).toBe(true)
      const refreshed = agentRepo.getOwned('profile', row.id)!
      expect(conductorContext(refreshed).toolPolicy).toBe('none')
      // Open Chat Folder reads the chat's runtime, which now has no workspace.
      expect(chatConductorService.hasWorkspace(chat)).toBe(false)
      expect(forgotten).toEqual([[chat.id, row.id]])
      expect(chatConductorService.syncToolPolicy('profile', chat)).toBe(false)
      // A row that is not this chat's runtime is never touched.
      expect(chatConductorService.syncToolPolicy('profile', { ...chatRepo.create('profile', {}), agentId: row.id })).toBe(false)
      state.mode.toolPolicy = 'workspace'
      chatConductorService.syncToolPolicy('profile', chat)
      expect(chatConductorService.hasWorkspace({ ...chatRepo.create('profile', {}), agentId: row.id })).toBe(false)
    } finally { uninstall() }
  })

  it('keeps a mode\'s own instructions over the default', () => {
    Object.assign(state.mode, { toolPolicy: 'workspace', systemPrompt: 'Mine' })
    expect(conductorContext(chatConductorService.ensure('profile', chatRepo.create('profile', {}))).instructions).toBe('Mine')
  })

  it('remembers Always allow per chat, never across chats, and only on workspace', () => {
    Object.assign(state.mode, { toolPolicy: 'workspace' })
    const first = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    const second = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    const runtime = chatConductorService.runtime('profile', first)
    expect(runtime.rememberScope).toBe('chat')
    expect(runtime.isGranted(ask)).toBe(false)
    expect(runtime.rememberGrant(ask)).toBe(true)
    expect(chatConductorService.runtime('profile', first).isGranted(ask)).toBe(true)
    // Mutation: key the store by user or engine and the other chat inherits the grant.
    expect(chatConductorService.runtime('profile', second).isGranted(ask)).toBe(false)
    state.mode.toolPolicy = 'connectors'
    const restricted = chatConductorService.ensure('profile', chatRepo.create('profile', {}))
    const plain = chatConductorService.runtime('profile', restricted)
    expect(plain.rememberGrant(ask)).toBe(false)
    expect(plain.isGranted(ask)).toBe(false)
    expect(plain.rememberScope).toBeUndefined()
  })

  it('keeps its folder and grants through Trash, and loses both on permanent delete', () => {
    Object.assign(state.mode, { toolPolicy: 'workspace' })
    const chat = chatRepo.create('profile', {})
    const row = chatConductorService.ensure('profile', chat)
    chatConductorService.runtime('profile', row).rememberGrant(ask)
    const grants = externalRuntimeStatePath(conductorGrantKey('profile', row))
    expect(existsSync(grants)).toBe(true)
    chatRepo.softDelete('profile', chat.id)
    // Trash only marks the chat: the runtime refuses turns, nothing is removed.
    expect(() => chatConductorService.runtime('profile', row)).toThrow('no longer available')
    expect(existsSync(grants)).toBe(true)
    expect(existsSync(conductorContext(row).path)).toBe(true)
    chatRepo.restore('profile', chat.id)
    expect(chatConductorService.runtime('profile', row).isGranted(ask)).toBe(true)
    chatRepo.permanentDelete('profile', chat.id)
    chatConductorService.remove('profile', chat.id)
    // Mutation: drop `removeExternal` from `remove` and the grants outlive the chat.
    expect(existsSync(grants)).toBe(false)
    expect(existsSync(conductorContext(row).path)).toBe(false)
  })
})
