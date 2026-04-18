import { useState } from 'react'
import { Info } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { MetaPopup } from './MetaPopup'

export interface MessageMeta {
  [key: string]: unknown
}

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: string
  isStreaming?: boolean
  meta?: MessageMeta
  animate?: boolean
  animateDelay?: number
}

export function MessageBubble({ role, content, isStreaming, meta, animate, animateDelay }: MessageBubbleProps): React.JSX.Element {
  const isUser = role === 'user'
  const [showMeta, setShowMeta] = useState(false)
  const hasMeta = meta && Object.keys(meta).length > 0

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="relative group max-w-[80%]">
          <div
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed markdown-body bg-[var(--color-user-bubble)] text-[var(--color-text)] ${animate ? 'anim-user-bubble-pop' : ''}`}
          >
            <div className={animate ? 'anim-user-bubble-content' : ''}>
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {content}
              </Markdown>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative group">
      <div
        className={`text-sm leading-relaxed markdown-body text-[var(--color-text)] ${animate ? 'anim-assistant-bubble' : ''}`}
        style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
      >
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </Markdown>
        {isStreaming && (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-[var(--color-accent)] animate-pulse rounded-sm" />
        )}
      </div>

      {hasMeta && (
        <button
          onClick={() => setShowMeta(!showMeta)}
          className="absolute -bottom-0.5 right-1 p-0.5 rounded
            text-[var(--color-text-muted)] opacity-0 group-hover:opacity-60
            hover:!opacity-100 transition-opacity"
        >
          <Info size={11} />
        </button>
      )}

      {showMeta && hasMeta && (
        <MetaPopup meta={meta} onClose={() => setShowMeta(false)} />
      )}
    </div>
  )
}
