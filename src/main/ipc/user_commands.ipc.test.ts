import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

/**
 * The user command channels are adapters: a chat the active profile does not
 * see, or a trashed one, is refused as data before the core service is asked.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }
}))
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
const state = vi.hoisted(() => ({ chats: new Map<string, { deletedAt: Date | null }>(), activated: true }))
vi.mock('../auth/chatScope', () => ({
  visibleChat: (_userId: string, chatId: string) => state.chats.has(chatId) ? { id: chatId, ...state.chats.get(chatId) } : undefined
}))
vi.mock('../auth/activation', () => ({
  userActivation: {
    isActivated: () => state.activated,
    requireActivated: () => { if (!state.activated) throw new Error('Session not activated') }
  }
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1' }))
const service = vi.hoisted(() => ({
  run: vi.fn(async () => ({ ok: true, itemId: 'cmd-1', folder: '~/a' })),
  outputText: vi.fn(() => ({ ok: true, text: 't', filename: 'output-ls.txt' })),
  outputFile: vi.fn(() => ({ ok: true, path: '/p', filename: 'output-ls.txt' })),
  dismiss: vi.fn(() => ({ ok: true })),
  watch: vi.fn(),
  inspect: vi.fn(async () => ({ ok: true, spec: null, folder: '~/a' })),
  argPathFolder: vi.fn(async (): Promise<unknown> => ({ ok: true, folder: '/agents/a' }))
}))
vi.mock('../services/userCommands', () => ({ userCommandService: service }))
vi.mock('../services/userCommands/userCommandService', () => ({
  relativeArgPath: (folder: string, chosen: string) => chosen.startsWith(`${folder}/`) ? chosen.slice(folder.length + 1) : chosen
}))
const dialog = vi.hoisted(() => ({ choose: vi.fn(async (): Promise<string | null> => '/agents/a/data/in.csv') }))
vi.mock('../host/desktop/argPathDialog', () => ({ chooseArgPathDialog: dialog.choose }))
const guard = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock('../services/pathGuard', () => ({ pathGuard: guard }))

const { registerUserCommandHandlers } = await import('./user_commands.ipc')
registerUserCommandHandlers()
const sender = { id: 7 }
const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({ sender } as unknown as IpcMainInvokeEvent, ...args)

beforeEach(() => {
  state.chats = new Map([['mine', { deletedAt: null }], ['binned', { deletedAt: new Date(1) }]])
  vi.clearAllMocks()
})

describe('userCommands IPC', () => {
  it('runs for a live chat of the profile, passing only the fields it knows', async () => {
    expect(await invoke('userCommands:run', { chatId: 'mine', messageId: 'm', command: 'ls', reviewed: 'yes', extra: 1 }))
      .toEqual({ ok: true, itemId: 'cmd-1', folder: '~/a' })
    expect(service.run).toHaveBeenCalledWith('profile-1', { chatId: 'mine', messageId: 'm', command: 'ls', reviewed: false })
  })

  it('passes the window\'s columns when it is a number, and drops anything else', async () => {
    await invoke('userCommands:run', { chatId: 'mine', messageId: 'm', command: 'ls', reviewed: true, columns: 88 })
    expect(service.run).toHaveBeenLastCalledWith('profile-1', { chatId: 'mine', messageId: 'm', command: 'ls', reviewed: true, columns: 88 })
    await invoke('userCommands:run', { chatId: 'mine', messageId: 'm', command: 'ls', reviewed: true, columns: '88' })
    expect(service.run).toHaveBeenLastCalledWith('profile-1', { chatId: 'mine', messageId: 'm', command: 'ls', reviewed: true })
  })

  it.each(['binned', 'theirs', 42])('refuses chat %s as data, before the service', async (chatId) => {
    expect(await invoke('userCommands:run', { chatId, messageId: 'm', command: 'ls', reviewed: true })).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(invoke('userCommands:outputText', chatId, 'cmd-1')).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(invoke('userCommands:outputFile', chatId, 'cmd-1')).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(invoke('userCommands:dismiss', chatId, 'cmd-1')).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(service.run).not.toHaveBeenCalled()
    expect(service.outputFile).not.toHaveBeenCalled()
  })

  it('hands output and dismiss to the service', () => {
    expect(invoke('userCommands:outputFile', 'mine', 'cmd-1')).toMatchObject({ ok: true, path: '/p' })
    // The composer ingests it like a pasted file.
    expect(guard.record).toHaveBeenCalledWith('/p')
    expect(invoke('userCommands:dismiss', 'mine', 'cmd-1')).toEqual({ ok: true })
    expect(invoke('userCommands:outputText', 'mine', 7)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('answers the home folder, for the renderer\'s ~ form', () => {
    expect(typeof invoke('userCommands:home')).toBe('string')
  })

  it('inspects for a live chat, passing only the fields it knows; refuses another chat before the service', async () => {
    expect(await invoke('userCommands:inspect', { chatId: 'mine', messageId: 'm', command: 'python3 x.py', extra: 1 }))
      .toEqual({ ok: true, spec: null, folder: '~/a' })
    expect(service.inspect).toHaveBeenCalledWith('profile-1', { chatId: 'mine', messageId: 'm', command: 'python3 x.py' })
    for (const chatId of ['binned', 'theirs', 42]) {
      expect(await invoke('userCommands:inspect', { chatId, messageId: 'm', command: 'x' })).toMatchObject({ ok: false, code: 'chat_not_found' })
    }
    expect(await invoke('userCommands:inspect', undefined)).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(service.inspect).toHaveBeenCalledTimes(1)
  })

  it('chooses a path in the agent\'s folder through the desktop dialog, relative when inside it', async () => {
    expect(await invoke('userCommands:chooseArgPath', 'mine', 'm')).toEqual({ ok: true, path: 'data/in.csv' })
    expect(service.argPathFolder).toHaveBeenCalledWith('profile-1', 'mine', 'm')
    expect(dialog.choose).toHaveBeenCalledWith(sender, '/agents/a')
    dialog.choose.mockResolvedValueOnce(null)
    expect(await invoke('userCommands:chooseArgPath', 'mine', 'm')).toEqual({ ok: true, canceled: true })
  })

  it('opens no dialog for another chat or a folder core refuses', async () => {
    expect(await invoke('userCommands:chooseArgPath', 'binned', 'm')).toMatchObject({ ok: false, code: 'chat_not_found' })
    service.argPathFolder.mockResolvedValueOnce({ ok: false, code: 'folder_missing', reason: 'gone' })
    expect(await invoke('userCommands:chooseArgPath', 'mine', 'm')).toEqual({ ok: false, code: 'folder_missing', reason: 'gone' })
    expect(dialog.choose).not.toHaveBeenCalled()
  })
})
