import { useState } from 'react'
import { Info, Bot, ArrowRight, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { MetaPopup } from './MetaPopup'
import { markdownComponents } from '../../utils/markdownComponents'
import { presetForAgentId } from '../../utils/agentColors'
import { AttachmentList, type AttachmentBadgeData } from './AttachmentBadge'
import { useFileDownload } from '../../hooks/useFileDownload'

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
  /** Multi-agent: name of the agent that produced this assistant turn. */
  agentName?: string | null
  /** Multi-agent: id of the agent that produced this assistant turn — drives color. */
  agentId?: string | null
  /** Multi-agent: name of the agent this user message was routed to (non-root). */
  addressedAgentName?: string | null
  /** Multi-agent: id of the agent this user message was routed to — drives color. */
  addressedAgentId?: string | null
  /** File attachments to render under the bubble (user turn). */
  attachments?: AttachmentBadgeData[] | null
}

export function MessageBubble({
  role,
  content,
  isStreaming,
  meta,
  animate,
  animateDelay,
  agentName,
  agentId,
  addressedAgentName,
  addressedAgentId,
  attachments
}: MessageBubbleProps): React.JSX.Element {
  const isUser = role === 'user'
  const [showMeta, setShowMeta] = useState(false)
  const hasMeta = meta && Object.keys(meta).length > 0
  const agentColor = agentId ? presetForAgentId(agentId) : null
  const addressedColor = addressedAgentId ? presetForAgentId(addressedAgentId) : null
  // Download state is store-backed (see fileDownload.store) — every bubble
  // reads from the same source so the spinner and error stay consistent
  // across the whole message stream. Each bubble only renders the error
  // label for its own attachments by matching `errorFileId`.
  const {
    isDownloading,
    download,
    error: downloadError,
    errorFileId,
    dismissError
  } = useFileDownload()
  const downloadErrorForThisBubble =
    isUser && downloadError && attachments?.some((a) => a.id === errorFileId)
      ? downloadError
      : null

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="relative group max-w-[80%]">
          <div
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed markdown-body bg-[var(--color-user-bubble)] text-[var(--color-text)] ${animate ? 'anim-user-bubble-pop' : ''}`}
          >
            <div className={animate ? 'anim-user-bubble-content' : ''}>
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                {content}
              </Markdown>
            </div>
            {addressedAgentName && (
              <div className="mt-0.5 flex justify-end">
                <span
                  className="inline-flex items-center gap-0.5 text-[9px] font-medium opacity-70"
                  style={{ color: addressedColor?.border ?? 'var(--color-text-muted)' }}
                >
                  <ArrowRight size={8} />
                  <Bot size={9} />
                  <span>{addressedAgentName}</span>
                </span>
              </div>
            )}
          </div>
        </div>
        {attachments && attachments.length > 0 && (
          <AttachmentList
            attachments={attachments}
            variant="message"
            align="right"
            onClick={(a) => void download(a)}
            isLoading={isDownloading}
          />
        )}
        {downloadErrorForThisBubble && (
          <div className="flex items-center gap-1 max-w-[80%] justify-end text-[10px] text-[var(--color-danger)]">
            <span className="truncate">{downloadErrorForThisBubble}</span>
            <button
              type="button"
              onClick={dismissError}
              className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] shrink-0"
              aria-label="Dismiss download error"
            >
              <X size={10} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="relative group">
      {agentName && (
        <div
          className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide"
          style={{ color: agentColor?.border ?? 'var(--color-text-muted)' }}
        >
          <Bot size={10} />
          <span>{agentName}</span>
        </div>
      )}
      <div
        className={`text-sm leading-relaxed markdown-body text-[var(--color-text)] ${animate ? 'anim-assistant-bubble' : ''}`}
        style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
      >
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
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
