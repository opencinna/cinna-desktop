import { useState, useRef, useEffect } from 'react'
import { Info } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export interface MessageMeta {
  [key: string]: unknown
}

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: string
  isStreaming?: boolean
  meta?: MessageMeta
}

function MetaPopup({ meta, onClose }: { meta: MessageMeta; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-6 right-0 w-72 max-h-48 overflow-y-auto
        bg-[var(--color-bg-secondary)] border border-[var(--color-border)]
        rounded-lg shadow-xl z-50 p-2.5 text-[11px] text-[var(--color-text-secondary)]
        font-mono leading-relaxed"
    >
      {Object.entries(meta).map(([key, value]) => (
        <div key={key} className="mb-1 last:mb-0">
          <span className="text-[var(--color-text-muted)]">{key}: </span>
          <span className="text-[var(--color-text)] break-all whitespace-pre-wrap">
            {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function MessageBubble({ role, content, isStreaming, meta }: MessageBubbleProps): React.JSX.Element {
  const isUser = role === 'user'
  const [showMeta, setShowMeta] = useState(false)
  const hasMeta = meta && Object.keys(meta).length > 0

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="relative group max-w-[80%]">
          <div className="rounded-xl px-3 py-2 text-sm leading-relaxed markdown-body bg-[var(--color-user-bubble)] text-[var(--color-text)]">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content}
            </Markdown>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative group">
      <div className="text-sm leading-relaxed markdown-body text-[var(--color-text)]">
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
