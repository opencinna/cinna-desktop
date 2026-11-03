import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  enabled: true, title: 'New Chat', initialTitle: null as string | null, count: 1,
  resolve: vi.fn(), run: vi.fn(), update: vi.fn(), firstUser: 'My first message'
}))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => ({ id: 'chat', title: state.title, initialTitle: state.initialTitle, router: 'coordinator', agentId: 'root' }), updateMeta: (...args: unknown[]) => state.update(...args) } }))
vi.mock('../db/messages', () => ({ messageRepo: { countByRole: () => state.count, firstByRole: () => ({ content: state.firstUser }) } }))
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
  state.initialTitle = null
  state.count = 1
  state.firstUser = 'My first message'
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
  it('gives the model pasted text as its summary, and still treats the title derived from the raw text as auto', async () => {
    state.firstUser = '<pasted_text lines="2">\nDear Bob,\nsee you\n</pasted_text>\n\nreply politely'
    state.title = 'reply politely'
    await chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ userText: '[Pasted text · 2 lines]\n\nreply politely' }))
    expect(state.update).toHaveBeenCalledWith('user', 'chat', { title: 'A helpful title' })
  })
  it('gives the model the first paste\'s opening when nothing was typed', async () => {
    state.firstUser = '<pasted_text lines="2">\nDear Bob,\nsee you\n</pasted_text>'
    state.title = 'Dear Bob,'
    await chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ userText: '[Pasted text · 2 lines]\n\nThe first paste begins:\nDear Bob,\nsee you' }))
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

describe('a dashboard panel chat’s placeholder title', () => {
  it('is replaced while the chat still has it, with background titles on', async () => {
    state.title = state.initialTitle = 'Sales overview · Sales Desk'
    await chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })
    expect(state.update).toHaveBeenCalledWith('user', 'chat', { title: 'A helpful title' })
  })
  it('stays with background titles off', async () => {
    state.enabled = false
    state.title = state.initialTitle = 'Sales overview · Sales Desk'
    await expect(chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })).rejects.toMatchObject({ code: 'feature_disabled' })
    expect(state.update).not.toHaveBeenCalled()
  })
  it('once the user renamed the chat, is no longer the title and nothing replaces it', async () => {
    state.initialTitle = 'Sales overview · Sales Desk'
    state.title = 'Q3 questions'
    await expect(chatTitleService.autoGenerateForFirstMessage({ userId: 'user', chatId: 'chat' })).rejects.toMatchObject({ code: 'chat_renamed_initial' })
    expect(chatTitleService.applyEngineTitle({ userId: 'user', chatId: 'chat', agentId: 'root', title: 'Codex title' })).toBe(false)
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
