import type { PendingInputRequest } from '../stores/chat.store'

/**
 * The decisions behind minimal view, kept pure so they are tested without a
 * renderer: when the cloud input shows, when minimal view refuses to start or
 * ends on its own, and which keys typed outside the cloud are sent into it.
 */

/** What the composer's draft holds, as far as the cloud is concerned. */
export interface CloudDraft {
  text: string
  attachments: number
  notes: number
  pathRefs: number
  pastes: number
  /** An attach error to show (a refused drop or paste): the cloud is its only place in minimal view. */
  attachError?: string | null
}

/**
 * Whether the cloud input is visible: the draft has something the regular
 * composer would send, or an attach error says why something was refused.
 * Whitespace-only text is nothing, as it is for Send.
 * An empty cloud stays focusable at opacity 0, so typing still lands in it.
 */
export function cloudHasContent(draft: CloudDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments > 0 || draft.notes > 0 || draft.pathRefs > 0 || draft.pastes > 0 || !!draft.attachError
}

/** What minimal view watches: the chat store's fields, and the open chat's pending handoff. */
export interface MinimalWatchState {
  sendError: string | null
  inputRequests: PendingInputRequest[]
  settledInputRequestIds: string[]
  /** A handoff of this chat waits on the user's review (`PendingHandoffControl`). */
  handoffPending?: boolean
}

/** What was already waiting when minimal view began; it does not end it. */
export interface MinimalBaseline {
  askIds: readonly string[]
  handoffPending: boolean
}

/**
 * The asks this chat's stream has open that the user answers here: top-level
 * only (a nested agent's ask carries `toolCallId` and is shown in its tool
 * call's sub-thread), and not already settled. Covers local permission asks
 * and agent questions (`reply`) and A2A input_required (`next_message`) alike.
 */
export function openTopLevelAskIds(state: Pick<MinimalWatchState, 'inputRequests' | 'settledInputRequestIds'>): string[] {
  return state.inputRequests
    .filter((entry) => !entry.toolCallId && !state.settledInputRequestIds.includes(entry.requestId))
    .map((entry) => entry.requestId)
}

/**
 * Whether entering minimal view is refused: the chat already needs the user
 * (a send error, an open ask, a pending handoff). Entering would hide exactly
 * what needs them.
 */
export function minimalRefused(state: MinimalWatchState): boolean {
  return state.sendError !== null || openTopLevelAskIds(state).length > 0 || !!state.handoffPending
}

/**
 * Whether minimal view should end on its own: a send error, an ask that was
 * not open when minimal view began, or a handoff that became pending since
 * (`baseline`). Informational notices (the prompt-cache notice and the like)
 * live elsewhere and never restore.
 */
export function shouldRestoreMinimal(state: MinimalWatchState, baseline: MinimalBaseline): boolean {
  if (state.sendError !== null) return true
  if (state.handoffPending && !baseline.handoffPending) return true
  return openTopLevelAskIds(state).some((id) => !baseline.askIds.includes(id))
}

/** An element that takes typing itself, so a key there is never redirected. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const element = target as HTMLElement
  if (element.isContentEditable) return true
  return element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null
}

/** The keydown fields `shouldForwardKey` reads. */
export interface ForwardKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
}

/**
 * Whether a key pressed outside any editable field goes to the cloud input:
 * a printable character (Option combinations included, as they type one) or
 * Cmd/Ctrl+V. Every other shortcut — Cmd+C on a transcript selection first of
 * all — stays where it was pressed. Space is left to scroll the transcript.
 */
export function shouldForwardKey(event: ForwardKey): boolean {
  if (event.isComposing) return false
  if (event.metaKey || event.ctrlKey) return !event.altKey && event.key.toLowerCase() === 'v'
  return event.key.length === 1 && event.key !== ' '
}
