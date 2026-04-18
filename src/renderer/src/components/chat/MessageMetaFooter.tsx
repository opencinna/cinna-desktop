import { useState } from 'react'
import { Info } from 'lucide-react'
import { MetaPopup } from './MetaPopup'
import { useRelativeNow } from '../../hooks/useRelativeNow'

type ChatDetail = NonNullable<Awaited<ReturnType<typeof window.api.chat.get>>>
type MessageData = ChatDetail['messages'][number]

interface MessageMetaFooterProps {
  msg: MessageData
  align?: 'left' | 'right'
}

function formatRelative(from: Date, now: Date): string {
  const diffMs = now.getTime() - from.getTime()
  const diffSec = Math.max(0, Math.floor(diffMs / 1000))
  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec} seconds ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  return from.toLocaleDateString()
}

function buildMeta(msg: MessageData): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: msg.id,
    role: msg.role,
    createdAt: new Date(msg.createdAt).toISOString(),
    sortOrder: msg.sortOrder,
    chatId: msg.chatId,
    contentLength: msg.content?.length ?? 0
  }
  if (msg.toolName) meta.toolName = msg.toolName
  if (msg.toolProvider) meta.toolProvider = msg.toolProvider
  if (msg.toolCallId) meta.toolCallId = msg.toolCallId
  if (msg.toolError !== undefined) meta.toolError = msg.toolError
  if (msg.toolInput) meta.toolInput = msg.toolInput
  if (msg.parts && msg.parts.length > 0) {
    meta.parts = msg.parts.map((p) => ({
      kind: p.kind,
      toolName: p.toolName,
      textLength: p.text?.length ?? 0
    }))
  }
  return meta
}

export function MessageMetaFooter({ msg, align = 'left' }: MessageMetaFooterProps): React.JSX.Element {
  const [showMeta, setShowMeta] = useState(false)
  const now = useRelativeNow()

  const created = new Date(msg.createdAt)
  const relative = formatRelative(created, now)
  const absolute = created.toLocaleString()

  return (
    <div className={`relative flex items-center gap-1 mt-1 text-[10px] text-[var(--color-text-muted)] ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
      <span title={absolute}>{relative}</span>
      <button
        onClick={() => setShowMeta((v) => !v)}
        className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)] transition-colors"
        title="Show message metadata"
      >
        <Info size={10} />
      </button>
      {showMeta && (
        <MetaPopup meta={buildMeta(msg)} align={align} onClose={() => setShowMeta(false)} />
      )}
    </div>
  )
}
