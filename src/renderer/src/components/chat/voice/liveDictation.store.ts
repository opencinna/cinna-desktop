import { create } from 'zustand'
import type { DictationSpan } from './dictationSpan'

/**
 * What the composer needs from a dictation in progress, per draft: where it
 * sits, the partial it shows, and the three ways the composer itself ends it.
 * The voice control owns the session and writes here; `ChatInput` reads its
 * own draft's entry to render the live text and to route keys.
 */
export interface LiveDictationControls {
  /** A keystroke, paste or drop: keep everything shown as plain text, stop listening at once. */
  freeze(): void
  /** Esc: drop the partial, keep the confirmed text, stop listening. */
  cancel(): void
  /** Enter: stop, wait for the last words, then send. */
  send(): void
}

export interface LiveDictation {
  span: DictationSpan
  partial: string
  /** Stopped and waiting for the engine's last words. */
  finishing: boolean
  controls: LiveDictationControls
}

interface LiveDictationState {
  live: Record<string, LiveDictation>
  set(draftKey: string, entry: LiveDictation | null): void
}

export const useLiveDictationStore = create<LiveDictationState>((set) => ({
  live: {},
  set: (draftKey, entry) =>
    set((state) => {
      if (!entry) {
        if (!(draftKey in state.live)) return state
        const { [draftKey]: _gone, ...rest } = state.live
        return { live: rest }
      }
      return { live: { ...state.live, [draftKey]: entry } }
    })
}))

export function useLiveDictation(draftKey: string): LiveDictation | null {
  return useLiveDictationStore((s) => s.live[draftKey] ?? null)
}
