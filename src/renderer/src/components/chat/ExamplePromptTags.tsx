import { useEffect, useRef, useState } from 'react'
import { Hash } from 'lucide-react'
import type { ExamplePrompt } from '../../utils/examplePrompts'

interface ExamplePromptTagsProps {
  prompts: ExamplePrompt[]
  onSelect: (prompt: ExamplePrompt) => void
  /** Changes when the source agent changes so the animation re-plays. */
  animationKey: string
}

const LEAVE_DURATION_MS = 400

/**
 * Always renders a fixed-height row so the surrounding centered column
 * doesn't reflow when tags appear or disappear. Entry: each child tag
 * fades in as a circle then expands into a pill. Exit: the row holds the
 * previous prompts rendered for {@link LEAVE_DURATION_MS} with an
 * `is-leaving` class that fades them out before unmounting.
 */
export function ExamplePromptTags({
  prompts,
  onSelect,
  animationKey
}: ExamplePromptTagsProps): React.JSX.Element {
  const [displayPrompts, setDisplayPrompts] = useState(prompts)
  const [displayKey, setDisplayKey] = useState(animationKey)
  const [leaving, setLeaving] = useState(false)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks whether tags are currently rendered so the effect can detect a
  // non-empty → empty transition without reading render-time state.
  const wasVisibleRef = useRef(prompts.length > 0)

  useEffect(() => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }

    if (prompts.length > 0) {
      // Swap in new prompts immediately; re-play entry animation via key.
      setDisplayPrompts(prompts)
      setDisplayKey(animationKey)
      setLeaving(false)
      wasVisibleRef.current = true
      return
    }

    // prompts is empty — if we were showing something, fade it out, then drop.
    if (wasVisibleRef.current) {
      wasVisibleRef.current = false
      setLeaving(true)
      leaveTimerRef.current = setTimeout(() => {
        setDisplayPrompts([])
        setLeaving(false)
        leaveTimerRef.current = null
      }, LEAVE_DURATION_MS)
    }

    return () => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current)
        leaveTimerRef.current = null
      }
    }
  }, [prompts, animationKey])

  return (
    <div className="w-full max-w-3xl mx-auto px-4 mb-3 min-h-10 flex flex-wrap justify-center items-start gap-2">
      {displayPrompts.map((prompt, i) => (
        <button
          key={`${displayKey}-${i}-${prompt.label}`}
          type="button"
          onClick={() => onSelect(prompt)}
          className={`example-prompt-tag group flex items-center gap-1.5 h-7 rounded-full
            border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10
            text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20
            hover:border-[var(--color-accent)]/70 transition-colors cursor-pointer
            overflow-hidden whitespace-nowrap${leaving ? ' is-leaving' : ''}`}
          style={
            {
              ['--tag-delay' as string]: `${i * 70}ms`
            } as React.CSSProperties
          }
          title={prompt.full}
        >
          <Hash size={12} className="shrink-0" />
          <span className="example-prompt-tag-text text-[11px] font-medium pr-1">
            {prompt.label}
          </span>
        </button>
      ))}
    </div>
  )
}
