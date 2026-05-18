import { useCallback, useState, type RefObject } from 'react'
import type {
  PendingRewrite,
  RewriteErrorCode,
  SubmitResult
} from './useChatComposer'

export type RewriteUXState = 'idle' | 'rewriting' | 'confirming'

interface RewriteUXOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Sets the composer's text — used to swap to the rewrite, revert on Esc, etc. */
  setInput: (text: string) => void
  /** Resets the composer to its empty state — height + value. */
  clearComposer: () => void
}

export interface RewriteUX {
  state: RewriteUXState
  pending: PendingRewrite | null
  error: { code: RewriteErrorCode; detail: string } | null

  /** Drive the state machine forward from a `composer.submit()` result. */
  handleSubmitResult: (result: SubmitResult) => void
  /** Called by ChatInput when the second Enter fires while confirming. */
  beginConfirmDispatch: () => { text: string; pending: PendingRewrite } | null
  /** Esc-to-revert while confirming. Returns true when handled. */
  handleEscape: () => boolean
  /** Clearing the composer mid-confirm abandons the pending rewrite. */
  handleComposerCleared: (currentValue: string) => void
  /** Failure-modal actions. */
  dismissError: () => void
  /** Consume the pending rewrite for "Send anyway" — caller dispatches it. */
  consumePendingForSendAnyway: () => PendingRewrite | null

  /** Manual transitions — used by ChatInput on send-start. */
  beginRewriting: () => void
  reset: () => void
}

/**
 * Owns the Smart Rewrite UX state machine and its side-effects on the
 * composer textarea. `useChatComposer` handles the routing/network parts;
 * this hook handles the typing-and-confirm UX wrapped around it.
 */
export function useRewriteUX(options: RewriteUXOptions): RewriteUX {
  const { textareaRef, setInput, clearComposer } = options
  const [state, setState] = useState<RewriteUXState>('idle')
  const [pending, setPending] = useState<PendingRewrite | null>(null)
  const [error, setError] = useState<{ code: RewriteErrorCode; detail: string } | null>(
    null
  )

  const resizeTextareaToContent = useCallback((): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [textareaRef])

  const handleSubmitResult = useCallback(
    (result: SubmitResult): void => {
      if (result.kind === 'noop') {
        setState('idle')
        return
      }
      if (result.kind === 'sent') {
        clearComposer()
        setState('idle')
        return
      }
      if (result.kind === 'rewrite-pending') {
        setInput(result.rewrittenText)
        setState('confirming')
        setPending(result.pending)
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          resizeTextareaToContent()
          el.focus()
          el.setSelectionRange(result.rewrittenText.length, result.rewrittenText.length)
        })
        return
      }
      if (result.kind === 'rewrite-failed') {
        setState('idle')
        setError({ code: result.code, detail: result.detail })
        setPending(result.pending)
      }
    },
    [clearComposer, resizeTextareaToContent, setInput, textareaRef]
  )

  const beginConfirmDispatch = useCallback((): {
    text: string
    pending: PendingRewrite
  } | null => {
    if (state !== 'confirming' || !pending) return null
    const el = textareaRef.current
    const text = (el?.value ?? '').trim()
    const snapshot = pending
    clearComposer()
    setState('idle')
    setPending(null)
    return { text, pending: snapshot }
  }, [clearComposer, pending, state, textareaRef])

  const handleEscape = useCallback((): boolean => {
    if (state !== 'confirming' || !pending) return false
    setInput(pending.originalText)
    setState('idle')
    setPending(null)
    requestAnimationFrame(() => {
      resizeTextareaToContent()
      textareaRef.current?.focus()
    })
    return true
  }, [pending, resizeTextareaToContent, setInput, state, textareaRef])

  const handleComposerCleared = useCallback(
    (currentValue: string): void => {
      if (state !== 'confirming') return
      if (currentValue.trim() !== '') return
      setState('idle')
      setPending(null)
    },
    [state]
  )

  const dismissError = useCallback((): void => {
    setError(null)
    setState('idle')
    setPending(null)
  }, [])

  const consumePendingForSendAnyway = useCallback((): PendingRewrite | null => {
    const snapshot = pending
    clearComposer()
    setState('idle')
    setPending(null)
    setError(null)
    return snapshot
  }, [clearComposer, pending])

  const beginRewriting = useCallback((): void => {
    setState('rewriting')
    setError(null)
  }, [])

  const reset = useCallback((): void => {
    setState('idle')
    setPending(null)
    setError(null)
  }, [])

  return {
    state,
    pending,
    error,
    handleSubmitResult,
    beginConfirmDispatch,
    handleEscape,
    handleComposerCleared,
    dismissError,
    consumePendingForSendAnyway,
    beginRewriting,
    reset
  }
}
