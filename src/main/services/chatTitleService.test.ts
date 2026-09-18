import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  enabled: true, title: 'New Chat', count: 1,
  resolve: vi.fn(), run: vi.fn(), update: vi.fn()
}))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => ({ id: 'chat', title: state.title, router: 'coordinator', agentId: 'root' }), updateMeta: (...args: unknown[]) => state.update(...args) } }))
vi.mock('../db/messages', () => ({ messageRepo: { countByRole: () => state.count, firstByRole: () => ({ content: 'My first message' }) } }))
vi.mock('../db/appSettings', () => ({ appSettingsRepo: { get: () => state.enabled } }))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('./aiFunctionsService', async () => {
  const { DomainError } = await import('../errors')
  return { AiFunctionError: class extends DomainError {}, aiFunctions: { resolveBackend: (...args: unknown[]) => state.resolve(...args), runSingleShot: (...args: unknown[]) => state.run(...args) } }
})
import { chatTitleService } from './chatTitleService'

beforeEach(() => {
  state.enabled = true
  state.title = 'New Chat'
  state.count = 1
  state.resolve.mockReset().mockReturnValue({ kind: 'runtime', userId: 'user' })
  state.run.mockReset().mockResolvedValue('A helpful title')
  state.update.mockReset()
})

describe('automatic titles on AI Functions', () => {
  it('uses the own backend with warm-only runtime admission and the title output cap', async () => {
    await chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ backend: { kind: 'runtime', userId: 'user' }, warmOnly: true, maxOutputChars: 40 }))
    expect(state.update).toHaveBeenCalledWith('user', 'chat', { title: 'A helpful title' })
  })
  it('does not run when background titles are disabled or overwrite a manual rename', async () => {
    state.enabled = false
    await expect(chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })).rejects.toMatchObject({ code: 'feature_disabled' })
    expect(state.run).not.toHaveBeenCalled()
    state.enabled = true
    state.run.mockImplementation(async () => { state.title = 'My title'; return 'Generated' })
    await expect(chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })).rejects.toMatchObject({ code: 'chat_renamed_mid_flight' })
    expect(state.update).not.toHaveBeenCalled()
  })
  it('ignores an agent that is not the chat’s root', () => {
    expect(chatTitleService.applyEngineTitle({ userId: 'user', chatId: 'chat', agentId: 'addressed', title: 'Codex title' })).toBe(false)
    expect(state.update).not.toHaveBeenCalled()
  })
})

describe('a title the chat’s own engine gave its thread', () => {
  it('applies with background titles off, sanitized, and never calls a model', () => {
    state.enabled = false
    expect(chatTitleService.applyEngineTitle({ userId: 'user', chatId: 'chat', agentId: 'root', title: '  "Run a delayed shell command."  ' })).toBe(true)
    expect(state.update).toHaveBeenCalledWith('user', 'chat', { title: 'Run a delayed shell command' })
    expect(state.run).not.toHaveBeenCalled()
  })
  it('replaces the title derived from the first message', () => {
    state.title = 'My first message'
    expect(chatTitleService.applyEngineTitle({ userId: 'user', chatId: 'chat', agentId: 'root', title: 'Codex title' })).toBe(true)
    expect(state.update).toHaveBeenCalledWith('user', 'chat', { title: 'Codex title' })
  })
  it('keeps a title the user set', () => {
    state.title = 'My own name for it'
    expect(chatTitleService.applyEngineTitle({ userId: 'user', chatId: 'chat', agentId: 'root', title: 'Codex title' })).toBe(false)
    expect(state.update).not.toHaveBeenCalled()
  })
  it('ignores an agent that is not the chat’s root', () => {
    expect(chatTitleService.applyEngineTitle({ userId: 'user', chatId: 'chat', agentId: 'addressed', title: 'Codex title' })).toBe(false)
    expect(state.update).not.toHaveBeenCalled()
  })
})
