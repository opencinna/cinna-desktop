import { Sparkles } from 'lucide-react'

interface RewriteHintBarProps {
  state: 'idle' | 'rewriting' | 'confirming'
}

/**
 * Single-line status hint that appears above the textarea while Smart Rewrite
 * is in flight or awaiting confirmation. Pure props in.
 */
export function RewriteHintBar({ state }: RewriteHintBarProps): React.JSX.Element | null {
  if (state === 'rewriting') {
    return (
      <div className="px-1 pb-1.5 text-[10px] text-[var(--color-text-muted)] flex items-center gap-1">
        <Sparkles size={11} className="opacity-70 animate-pulse" />
        <span>Rewriting message for the new agent…</span>
      </div>
    )
  }
  if (state === 'confirming') {
    return (
      <div className="px-1 pb-1.5 text-[10px] text-[var(--color-text-muted)] flex items-center gap-1">
        <Sparkles size={11} className="text-[var(--color-accent)]" />
        <span>
          Rewritten. Press Enter to send, Esc to revert, or edit before sending.
        </span>
      </div>
    )
  }
  return null
}
