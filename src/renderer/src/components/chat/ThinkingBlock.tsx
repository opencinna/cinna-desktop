import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface ThinkingBlockProps {
  content: string
  isStreaming?: boolean
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

export function ThinkingBlock({
  content,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: ThinkingBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded ?? !!isStreaming)

  return (
    <div
      className={`rounded-lg border transition-colors duration-200 ${
        expanded
          ? 'border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/40'
          : 'border-transparent bg-transparent'
      } ${animate ? 'anim-assistant-bubble' : ''}`}
      style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]
          text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
          transition-colors"
      >
        <ChevronRight
          size={11}
          className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <Brain size={11} />
        <span className="font-medium">Thinking</span>
        {isStreaming && (
          <span className="ml-1 inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] animate-pulse" />
        )}
      </button>
      {expanded && (
        <div
          className="px-3 pb-2.5 pt-0 text-[12.5px] leading-relaxed italic
            text-[var(--color-text-secondary)] markdown-body
            opacity-80"
        >
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      )}
    </div>
  )
}
