import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useUIStore } from '../stores/ui.store'
import { useChatStore } from '../stores/chat.store'
import { useHintsStore } from '../stores/hints.store'
import { isEditableTarget, minimalRefused, openTopLevelAskIds, shouldForwardKey, shouldRestoreMinimal, type MinimalBaseline } from '../utils/minimalView'
import type { ChatInputHandle } from '../components/chat/ChatInput'
import { OPEN_FLOATING_LAYER_SELECTOR } from './useSidebarHoverDock'
import { useChatHandoffPending } from '../components/tasks/PendingHandoffControl'

/** The sidebar's own duration; every minimal-view surface moves on it (main.css). */
export const MINIMAL_TRANSITION_MS = 260

/**
 * The composer's way through minimal view, one CSS state per step (main.css,
 * `.composer-dock[data-minimal-phase]`):
 * - `full` — the regular composer;
 * - `leaving` — the full composer slides down and fades;
 * - `cloud` — once that is done, it comes back as the cloud input;
 * - `returning` — the cloud slides down and fades;
 * - `entering` — the full composer slides back up.
 */
export type MinimalPhase = 'full' | 'leaving' | 'cloud' | 'returning' | 'entering'

/**
 * Whether minimal view can start now: an open chat in the chat view that does
 * not need the user. The chat's pending handoff lives in a query, not a store,
 * so the caller passes it (`useChatHandoffPending`).
 */
export function canEnterMinimalView(handoffPending = false): boolean {
  const ui = useUIStore.getState()
  const chat = useChatStore.getState()
  return ui.activeView === 'chat' && chat.activeChatId !== null && !minimalRefused({ ...chat, handoffPending })
}

/** Start minimal view, or do nothing while it cannot apply (`canEnterMinimalView`). */
export function requestMinimalView(handoffPending = false): boolean {
  if (!canEnterMinimalView(handoffPending)) return false
  useUIStore.getState().setMinimalView(true)
  useHintsStore.getState().observe('minimal-view-entered')
  return true
}

/**
 * Minimal view for the main chat view's open chat: the composer's phases,
 * the transcript padding frozen while the composer is out of its usual shape,
 * keys typed outside the cloud sent into it, and the auto-restore when the
 * chat needs the user. `enabled` is false for an embedded or hosted workspace
 * (the agent page, the dashboard panel), which minimal view never applies to.
 */
export function useMinimalView({ enabled, chatId, inputHeight, chatInputRef, areaRef }: {
  enabled: boolean
  chatId: string | null
  inputHeight: number
  chatInputRef: RefObject<ChatInputHandle | null>
  areaRef: RefObject<HTMLElement | null>
}): { on: boolean; phase: MinimalPhase; bottomPadding: number; restore: () => void; handoffPending: boolean } {
  const flag = useUIStore((s) => s.minimalView)
  const activeView = useUIStore((s) => s.activeView)
  const setMinimalView = useUIStore((s) => s.setMinimalView)
  const on = enabled && flag && chatId !== null && activeView === 'chat'
  // Read from the cache the chat's own pending-handoff control keeps polled.
  const handoffPending = useChatHandoffPending(enabled ? chatId : null)
  const handoffPendingRef = useRef(handoffPending)
  handoffPendingRef.current = handoffPending

  // The new-chat screen is not minimal view's: a chat closing ends it.
  useEffect(() => {
    if (enabled && flag && chatId === null) setMinimalView(false)
  }, [enabled, flag, chatId, setMinimalView])

  const [phase, setPhase] = useState<MinimalPhase>('full')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  // The transcript keeps the padding it had before minimal view, so nothing
  // in it moves on enter or exit and the last message never sits under the cloud.
  const [frozenPadding, setFrozenPadding] = useState(inputHeight)
  const inputHeightRef = useRef(inputHeight)
  inputHeightRef.current = inputHeight
  // Asks (and a handoff) already waiting when minimal view began do not end it.
  const baselineRef = useRef<MinimalBaseline>({ askIds: [], handoffPending: false })

  useLayoutEffect(() => {
    const current = phaseRef.current
    if (on) {
      if (current === 'full') setFrozenPadding(inputHeightRef.current)
      if (current !== 'cloud' && current !== 'leaving') setPhase('leaving')
      baselineRef.current = { askIds: openTopLevelAskIds(useChatStore.getState()), handoffPending: handoffPendingRef.current }
      // Typing goes on in the cloud: focus there unless the user is in the
      // chat already (a selection in the transcript, the composer itself).
      const focused = document.activeElement
      if (!focused || focused === document.body || !areaRef.current?.contains(focused)) chatInputRef.current?.focusAtEnd()
    } else {
      if (current === 'cloud') setPhase('returning')
      else if (current === 'leaving') setPhase('entering')
      // An auto-restore while focus had nowhere to be lands it in the composer.
      const focused = document.activeElement
      if (current !== 'full' && (!focused || focused === document.body)) chatInputRef.current?.focusAtEnd()
    }
  }, [on, chatInputRef, areaRef])

  useEffect(() => {
    if (phase === 'full' || phase === 'cloud') return
    const next: MinimalPhase = phase === 'leaving' ? 'cloud' : phase === 'returning' ? 'entering' : 'full'
    const timer = setTimeout(() => setPhase(next), MINIMAL_TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [phase])

  // A send error, a new ask or a handoff turning pending brings everything back.
  useEffect(() => {
    if (!on) return
    const check = (state: ReturnType<typeof useChatStore.getState>): void => {
      if (shouldRestoreMinimal({ ...state, handoffPending: handoffPendingRef.current }, baselineRef.current)) setMinimalView(false)
    }
    check(useChatStore.getState())
    return useChatStore.subscribe(check)
  }, [on, handoffPending, setMinimalView])

  // A printable key or Cmd/Ctrl+V pressed outside any field lands in the cloud.
  // Not while a dialog, menu or popover is open: its keys are its own.
  useEffect(() => {
    if (!on) return
    const forward = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditableTarget(event.target) || !shouldForwardKey(event)) return
      if (document.querySelector(`${OPEN_FLOATING_LAYER_SELECTOR}, .app-modal-panel`)) return
      chatInputRef.current?.focusAtEnd()
    }
    document.addEventListener('keydown', forward, true)
    return () => document.removeEventListener('keydown', forward, true)
  }, [on, chatInputRef])

  const restore = useCallback(() => {
    setMinimalView(false)
    chatInputRef.current?.focusAtEnd()
  }, [setMinimalView, chatInputRef])

  return { on, phase, bottomPadding: phase === 'full' ? inputHeight : frozenPadding, restore, handoffPending }
}
