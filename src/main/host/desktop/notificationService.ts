/**
 * OS desktop notifications: a chat the user cares about stopped while Cinna
 * was in the background.
 *
 * Core decides whether a settled turn is the user's (`services/turnNotices`:
 * their own chat, or the chat of a task they started; never their own Stop,
 * never the boot pass). This host adds what only the desktop knows — whether
 * any Cinna window has focus (the main window and the tray popover alike: a
 * minimized or hidden-to-tray app has none) — and the user's
 * Settings → Features toggle, read at the moment the turn settles.
 *
 * One notification per chat: a newer one replaces the older, and one is
 * closed once the chat's current result is marked read in the app. Every one
 * closes when the profile is left (a switch, a sign-out), and a click opens a
 * chat only while the active profile can still see it. Each is held in a map
 * until it is closed, clicked or replaced, so the garbage collector cannot
 * take its click handler while it is still on screen.
 *
 * **Never under the E2E harness.** Playwright's windows are never focused,
 * so every turn a spec runs would reach the developer's notification centre.
 * Under {@link BACKGROUND_WINDOW} — set by the E2E fixture and the live-backend
 * harness, nothing else — the notice is logged instead of shown, which a spec
 * can read from the log.
 */

import { BrowserWindow, Notification } from 'electron'
import { appSettingsRepo } from '../../db/appSettings'
import { userActivation } from '../../auth/activation'
import { visibleChat } from '../../auth/chatScope'
import { getProfileScopeUserId } from '../../auth/scope'
import { createLogger } from '../../logger/logger'
import {
  turnNotices,
  type TurnResultRead,
  type TurnSettledNotice
} from '../../services/turnNotices'
import { BACKGROUND_WINDOW, ensureMainWindow, focusMainWindow } from '../../window/focus'
import {
  NOTIFICATION_OPEN_CHAT_CHANNEL,
  type NotificationOpenChat
} from '../../../shared/desktopNotifications'
import type { ChatRunResultStatus } from '../../../shared/chatRunResult'

const logger = createLogger('notifications')

/** Enough to drop a repeat of any run still worth remembering. */
const SHOWN_RUNS_LIMIT = 200

const OUTCOME: Record<Exclude<ChatRunResultStatus, 'canceled'>, string> = {
  completed: 'Finished',
  needs_input: 'Needs your input',
  failed: 'Failed'
}

interface Shown {
  runId: string
  notification: Notification
}

/** The chat's live notification, by chat id. */
const live = new Map<string, Shown>()
/** Run ids already announced, oldest first. */
const shownRuns = new Set<string>()
let unsubscribe: (() => void)[] = []
/**
 * The chat the last click asked for, until a mounted renderer has it. A click
 * that recreates the window, or lands while the renderer loads or reloads,
 * sends its push to nobody, and so does one that lands while the window
 * still shows the startup gate (`ready-to-show` fires before the shell and
 * its listener mount). So it is never cleared on a push: the renderer takes
 * it on mount and on every push (`notifications:take-pending-open-chat`).
 * Latest click wins; opening a chat twice is harmless.
 */
let pendingOpenChat: NotificationOpenChat | null = null

/** The title and body a notice is shown with. No message text, ever. */
export function notificationContent(notice: TurnSettledNotice): { title: string; body: string } {
  const outcome = OUTCOME[notice.status as keyof typeof OUTCOME] ?? ''
  return {
    title: notice.title.trim() || 'Cinna',
    body: notice.agentName ? `${notice.agentName} · ${outcome}` : outcome
  }
}

function rememberRun(runId: string): void {
  shownRuns.add(runId)
  if (shownRuns.size > SHOWN_RUNS_LIMIT) {
    const oldest = shownRuns.values().next().value
    if (oldest !== undefined) shownRuns.delete(oldest)
  }
}

function forget(chatId: string, notification: Notification): void {
  if (live.get(chatId)?.notification === notification) live.delete(chatId)
}

/** The active profile can open this chat now: activated, visible to it, not in the trash. */
function openable(chatId: string): boolean {
  if (!userActivation.isActivated()) return false
  const chat = visibleChat(getProfileScopeUserId(), chatId)
  return !!chat && !chat.deletedAt
}

function closeAll(): void {
  for (const chatId of [...live.keys()]) closeFor(chatId)
  pendingOpenChat = null
}

function closeFor(chatId: string): void {
  const shown = live.get(chatId)
  if (!shown) return
  live.delete(chatId)
  try { shown.notification.close() } catch { /* already gone */ }
}

/** Raise the main window (reopening it if it was closed) and open the chat there. */
async function openChat(chatId: string): Promise<void> {
  // Another profile's chat, or one since trashed: bring the app forward and
  // name nothing.
  if (!openable(chatId)) {
    pendingOpenChat = null
    focusMainWindow()
    return
  }
  const payload: NotificationOpenChat = { chatId }
  pendingOpenChat = payload
  focusMainWindow()
  const win = await ensureMainWindow()
  if (!win || win.isDestroyed()) return
  focusMainWindow()
  win.webContents.send(NOTIFICATION_OPEN_CHAT_CHANNEL, payload)
}

function show(notice: TurnSettledNotice): void {
  if (!notice.notify) return
  if (!appSettingsRepo.get('desktopNotifications')) return
  // Not before a profile is open (first run, sign-in, a locked profile).
  if (!userActivation.isActivated()) return
  // Any focused Cinna window — the main one or the tray popover — means the
  // user is here and sees the sidebar change.
  if (BrowserWindow.getFocusedWindow() !== null) return
  if (shownRuns.has(notice.runId)) return
  rememberRun(notice.runId)

  const content = notificationContent(notice)
  if (BACKGROUND_WINDOW) {
    logger.info('desktop notification suppressed under the test harness', {
      chatId: notice.chatId, runId: notice.runId, status: notice.status, ...content
    })
    return
  }
  if (!Notification.isSupported()) return

  closeFor(notice.chatId)
  const notification = new Notification({ title: content.title, body: content.body })
  live.set(notice.chatId, { runId: notice.runId, notification })
  notification.on('click', () => {
    forget(notice.chatId, notification)
    void openChat(notice.chatId).catch((error) => {
      logger.warn('could not open the chat a notification named', { chatId: notice.chatId, error: String(error) })
    })
  })
  notification.on('close', () => forget(notice.chatId, notification))
  notification.show()
  logger.info('desktop notification shown', { chatId: notice.chatId, runId: notice.runId, status: notice.status })
}

function read(event: TurnResultRead): void {
  // Core fires this only when the run read is the chat's current result, so
  // whatever is shown for the chat — that run, or one it superseded while
  // the app was focused — is stale.
  closeFor(event.chatId)
}

export const notificationService = {
  /** Subscribe to core's turn notices. Called once from `index.ts`, after the app is ready. */
  install(): void {
    if (unsubscribe.length) return
    unsubscribe = [
      turnNotices.onSettled((notice) => show(notice)),
      turnNotices.onResultRead((event) => read(event)),
      userActivation.onProfileClosing(() => closeAll())
    ]
  },

  /** The chat a click asked for that no mounted renderer has opened yet; cleared by taking it. */
  takePendingOpenChat(): NotificationOpenChat | null {
    const pending = pendingOpenChat
    pendingOpenChat = null
    return pending && openable(pending.chatId) ? pending : null
  },

  /** Tests only: drop every subscription and everything remembered. */
  resetForTests(): void {
    pendingOpenChat = null
    for (const off of unsubscribe) off()
    unsubscribe = []
    live.clear()
    shownRuns.clear()
  }
}
