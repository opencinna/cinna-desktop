import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Draws the composer's text while a dictation is live, with the unconfirmed
 * partial lighter, so its revisions read as a guess settling rather than a
 * glitch. A textarea cannot style part of its text: during the dictation its
 * own text is transparent (the caret and selection stay native) and this
 * layer, laid exactly over it with the same padding, font and wrapping, shows
 * the text. It follows the textarea's box and scroll; it takes no input.
 */
export function DictationMirror({
  textareaRef,
  value,
  partialStart,
  partialEnd
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  partialStart: number
  partialEnd: number
}): React.JSX.Element {
  const mirrorRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) return
    const follow = (): void => {
      mirror.style.top = `${textarea.offsetTop}px`
      mirror.style.left = `${textarea.offsetLeft}px`
      // clientWidth leaves out a scrollbar, so the text wraps where the textarea's does.
      mirror.style.width = `${textarea.clientWidth}px`
      mirror.style.height = `${textarea.clientHeight}px`
      mirror.scrollTop = textarea.scrollTop
    }
    follow()
    // The composer sizes the textarea in its own layout effect, after this one.
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null
    resize?.observe(textarea)
    textarea.addEventListener('scroll', follow)
    return () => {
      resize?.disconnect()
      textarea.removeEventListener('scroll', follow)
    }
  }, [textareaRef, value])

  return (
    <div
      ref={mirrorRef}
      aria-hidden="true"
      data-dictation-mirror=""
      className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-3 text-sm leading-relaxed text-[var(--color-text)]"
    >
      {value.slice(0, partialStart)}
      {partialEnd > partialStart && (
        <span data-dictation-partial="" className="text-[var(--color-text-muted)]">
          {value.slice(partialStart, partialEnd)}
        </span>
      )}
      {value.slice(partialEnd)}
      {/* A trailing newline only takes height when something follows it. */}
      {value.endsWith('\n') ? '​' : null}
    </div>
  )
}
