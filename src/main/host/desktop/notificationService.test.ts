import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnResultRead, TurnSettledNotice } from '../../services/turnNotices'

const h = vi.hoisted(() => ({
  focused: null as unknown,
  supported: true,
  enabled: true,
  activated: true,
  background: false,
  shown: [] as FakeNotification[],
  sent: [] as [string, unknown][],
  logged: [] as [string, unknown][],
  settled: [] as ((notice: TurnSettledNotice) => void)[],
  read: [] as ((event: TurnResultRead) => void)[],
  focusMainWindow: vi.fn(),
  loading: false,
  window: null as unknown,
  /** Chats the active profile can see, with whether each is in the trash. */
  visible: new Map<string, boolean>(),
  closing: [] as (() => void)[]
}))

class FakeNotification {
  static isSupported = (): boolean => h.supported
  handlers = new Map<string, () => void>()
  closed = false
  constructor(public options: { title: string; body: string }) {}
  on(event: string, handler: () => void): this { this.handlers.set(event, handler); return this }
  show(): void { h.shown.push(this) }
  close(): void { this.closed = true; this.handlers.get('close')?.() }
  click(): void { this.handlers.get('click')?.() }
}

const mainWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: unknown) => h.sent.push([channel, payload]),
    isLoading: () => h.loading
  }
}

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => h.focused },
  Notification: FakeNotification
}))
vi.mock('../../db/appSettings', () => ({
  appSettingsRepo: { get: (key: string) => (key === 'desktopNotifications' ? h.enabled : undefined) }
}))
vi.mock('../../auth/activation', () => ({
  userActivation: {
    isActivated: () => h.activated,
    onProfileClosing: (listener: () => void) => {
      h.closing.push(listener)
      return () => { h.closing.splice(h.closing.indexOf(listener), 1) }
    }
  }
}))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1' }))
vi.mock('../../auth/chatScope', () => ({
  visibleChat: (profile: string, chatId: string) => profile === 'profile-1' && h.visible.has(chatId)
    ? { id: chatId, deletedAt: h.visible.get(chatId) ? new Date() : null } : undefined
}))
vi.mock('../../window/focus', () => ({
  get BACKGROUND_WINDOW() { return h.background },
  focusMainWindow: h.focusMainWindow,
  ensureMainWindow: async () => h.window
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ info: (message: string, data: unknown) => h.logged.push([message, data]), warn: vi.fn() })
}))
vi.mock('../../services/turnNotices', () => ({
  turnNotices: {
    onSettled: (listener: (notice: TurnSettledNotice) => void) => {
      h.settled.push(listener)
      return () => { h.settled.splice(h.settled.indexOf(listener), 1) }
    },
    onResultRead: (listener: (event: TurnResultRead) => void) => {
      h.read.push(listener)
      return () => { h.read.splice(h.read.indexOf(listener), 1) }
    }
  }
}))

const { notificationService, notificationContent } = await import('./notificationService')
const { NOTIFICATION_OPEN_CHAT_CHANNEL } = await import('../../../shared/desktopNotifications')

function settle(overrides: Partial<TurnSettledNotice> = {}): void {
  const notice: TurnSettledNotice = {
    chatId: 'chat-1', runId: 'run-1', status: 'completed', notify: true, title: 'Plan the launch', agentName: 'Researcher', ...overrides
  }
  for (const listener of [...h.settled]) listener(notice)
}

function read(chatId: string, runId: string): void {
  for (const listener of [...h.read]) listener({ chatId, runId })
}

beforeEach(() => {
  notificationService.resetForTests()
  Object.assign(h, { focused: null, supported: true, enabled: true, activated: true, background: false, loading: false, window: mainWindow })
  h.shown.length = 0
  h.sent.length = 0
  h.logged.length = 0
  h.focusMainWindow.mockReset()
  h.visible = new Map([['chat-1', false], ['chat-2', false]])
  notificationService.install()
})

describe('desktop notifications', () => {
  it('shows the chat title and the agent with its outcome while no Cinna window is focused', () => {
    settle()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].options).toEqual({ title: 'Plan the launch', body: 'Researcher · Finished' })
    expect(notificationContent({ chatId: 'c', runId: 'r', status: 'needs_input', notify: true, title: 'T', agentName: null }))
      .toEqual({ title: 'T', body: 'Needs your input' })
    expect(notificationContent({ chatId: 'c', runId: 'r', status: 'failed', notify: true, title: ' ', agentName: 'A' }))
      .toEqual({ title: 'Cinna', body: 'A · Failed' })
  })

  it('shows nothing while a Cinna window (the main one or the tray popover) is focused', () => {
    h.focused = mainWindow
    settle()
    expect(h.shown).toEqual([])
  })

  it('shows nothing for a turn core says is not the user’s', () => {
    settle({ notify: false })
    expect(h.shown).toEqual([])
  })

  it('shows nothing with the setting off, before a profile is open, or where the OS has no notifications', () => {
    h.enabled = false
    settle({ runId: 'run-1' })
    h.enabled = true
    h.activated = false
    settle({ runId: 'run-2' })
    h.activated = true
    h.supported = false
    settle({ runId: 'run-3' })
    expect(h.shown).toEqual([])
  })

  it('announces a run once', () => {
    settle()
    settle()
    expect(h.shown).toHaveLength(1)
  })

  it('keeps one notification per chat: a newer run replaces the older', () => {
    settle({ runId: 'run-1' })
    settle({ chatId: 'chat-2', runId: 'run-9' })
    settle({ runId: 'run-2', status: 'needs_input' })
    expect(h.shown.map((n) => [n.options.body, n.closed])).toEqual([
      ['Researcher · Finished', true],
      ['Researcher · Finished', false],
      ['Researcher · Needs your input', false]
    ])
  })

  it('raises the main window and opens the chat when clicked', async () => {
    settle()
    h.shown[0].click()
    await vi.waitFor(() => expect(h.sent).toEqual([[NOTIFICATION_OPEN_CHAT_CHANNEL, { chatId: 'chat-1' }]]))
    expect(h.focusMainWindow).toHaveBeenCalled()
  })

  it('keeps a clicked chat for a renderer that was loading, until it is taken', async () => {
    // Mutation: clear the pending chat after every push → a reloading renderer never opens it.
    h.loading = true
    settle()
    h.shown[0].click()
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(notificationService.takePendingOpenChat()).toEqual({ chatId: 'chat-1' })
    // Taking it clears it.
    expect(notificationService.takePendingOpenChat()).toBeNull()
  })

  it('keeps a clicked chat when no window could be shown yet, and the latest click wins', async () => {
    h.window = null
    settle({ chatId: 'chat-1', runId: 'run-1' })
    settle({ chatId: 'chat-2', runId: 'run-2' })
    h.shown[0].click()
    h.shown[1].click()
    await vi.waitFor(() => expect(h.focusMainWindow).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sent).toEqual([])
    expect(notificationService.takePendingOpenChat()).toEqual({ chatId: 'chat-2' })
  })

  it('keeps a clicked chat after the push even when the page finished loading, until it is taken', async () => {
    // Mutation: clear the pending chat after a push to a loaded page → a click
    // while the startup gate shows (shell and listener not mounted) is lost.
    settle()
    h.shown[0].click()
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(notificationService.takePendingOpenChat()).toEqual({ chatId: 'chat-1' })
    expect(notificationService.takePendingOpenChat()).toBeNull()
  })

  it('opens nothing for a chat the active profile cannot see or has trashed: it only raises the app', async () => {
    // Mutation: drop the visibility check in `openChat` → another profile's chat id reaches the renderer.
    settle({ chatId: 'chat-x', runId: 'run-x' })
    h.visible.set('chat-2', true)
    settle({ chatId: 'chat-2', runId: 'run-2' })
    h.shown[0].click()
    h.shown[1].click()
    await vi.waitFor(() => expect(h.focusMainWindow).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sent).toEqual([])
    expect(notificationService.takePendingOpenChat()).toBeNull()
  })

  it('closes every notification and forgets a pending click when the profile is left', async () => {
    // Mutation: drop the profile-closing subscription → a switched profile still shows the last one's chats.
    settle({ chatId: 'chat-1', runId: 'run-1' })
    settle({ chatId: 'chat-2', runId: 'run-2' })
    h.loading = true
    h.shown[0].click()
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    for (const listener of [...h.closing]) listener()
    expect(h.shown.map((n) => n.closed)).toEqual([false, true])
    expect(notificationService.takePendingOpenChat()).toBeNull()
  })

  it('closes the chat’s notification when its current result is read, even one a newer run superseded', () => {
    // Run 1 notified; run 2 settled while the app was focused (not shown); opening the chat reads run 2.
    // Mutation: close only on a runId match → run 1's notification stays up.
    settle({ runId: 'run-1' })
    read('chat-2', 'run-9')
    expect(h.shown[0].closed).toBe(false)
    read('chat-1', 'run-2')
    expect(h.shown[0].closed).toBe(true)
  })

  it('under the test harness logs what it would have shown and shows nothing', () => {
    // Mutation: drop the BACKGROUND_WINDOW branch → an E2E run notifies the developer's machine.
    h.background = true
    settle()
    expect(h.shown).toEqual([])
    expect(h.logged).toContainEqual(['desktop notification suppressed under the test harness',
      expect.objectContaining({ chatId: 'chat-1', runId: 'run-1', title: 'Plan the launch', body: 'Researcher · Finished' })])
  })
})
