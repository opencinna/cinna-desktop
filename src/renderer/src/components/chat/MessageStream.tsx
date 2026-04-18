import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { MessageMetaFooter } from './MessageMetaFooter'

interface MessageStreamProps {
  chatId: string
  bottomPadding?: number
}

function SystemMessage({ message, detail }: { message: string; detail?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex justify-center">
      <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/8 px-4 py-2.5 max-w-md text-center">
        <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-danger)]">
          <AlertTriangle size={13} />
          <span>{message}</span>
        </div>
        {detail && (
          <>
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1.5 inline-flex items-center gap-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
            >
              <ChevronRight size={10} className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
              Details
            </button>
            {expanded && (
              <pre className="mt-1.5 text-[11px] text-left text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function MessageStream({ chatId, bottomPadding }: MessageStreamProps): React.JSX.Element {
  const { data: chatData } = useChatDetail(chatId)
  const { streamingBlocks, isStreaming, pendingUserMessage, streamedIncrementallyChatId } = useChatStore()
  const verboseMode = useUIStore((s) => s.verboseMode)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevRef = useRef<{ chatId: string | null; messageIds: string[] }>({
    chatId: null,
    messageIds: []
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatData?.messages, streamingBlocks])

  const messages = chatData?.messages ?? []
  const hasStreamingContent = streamingBlocks.length > 0

  // Animate only when exactly one message was appended since the previous render
  // for the same chat — this matches the "user sent a message" pattern and skips
  // initial loads and bulk re-fetches.
  const prev = prevRef.current
  const newMessageId =
    prev.chatId === chatId &&
    messages.length === prev.messageIds.length + 1 &&
    !prev.messageIds.includes(messages[messages.length - 1].id)
      ? messages[messages.length - 1].id
      : null

  useEffect(() => {
    prevRef.current = { chatId, messageIds: messages.map((m) => m.id) }
  }, [chatId, messages])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4" style={bottomPadding ? { paddingBottom: bottomPadding + 16 } : undefined}>
      <div className="max-w-3xl mx-auto space-y-3">
        {messages.length === 0 && !isStreaming && !hasStreamingContent && (
          <div className="text-center text-[var(--color-text-muted)] py-16">
            <p className="text-sm">Start a conversation</p>
          </div>
        )}

        {messages.map((msg) => {
          const align: 'left' | 'right' = msg.role === 'user' ? 'right' : 'left'
          const footer = verboseMode ? <MessageMetaFooter msg={msg} align={align} /> : null

          if (msg.role === 'error') {
            let node: React.JSX.Element
            try {
              const err = JSON.parse(msg.content) as { short: string; detail?: string }
              node = <SystemMessage message={err.short} detail={err.detail} />
            } catch {
              node = <SystemMessage message={msg.content} />
            }
            return (
              <div key={msg.id}>
                {node}
                {footer}
              </div>
            )
          }
          if (msg.role === 'tool_call') {
            return (
              <div key={msg.id}>
                <ToolCallBlock
                  name={msg.toolName ?? 'unknown'}
                  input={msg.toolInput as Record<string, unknown>}
                  result={msg.content}
                  error={msg.toolError ? msg.content : undefined}
                  status={msg.toolError ? 'error' : 'done'}
                  provider={msg.toolProvider}
                />
                {footer}
              </div>
            )
          }
          if (msg.role === 'assistant' && !msg.content) {
            return null
          }
          // Assistant message with structured parts (e.g. A2A agents emitting
          // thinking + text via `cinna.content_kind` metadata) — render each
          // part in order using the appropriate block.
          const parts = msg.parts
          // Skip the fade-in when an assistant message replaces streaming blocks
          // that already animated piece-by-piece — otherwise the content blinks
          // as it re-animates on DB arrival. Scoped to the exact chat whose
          // stream just finished so out-of-band arrivals elsewhere still animate.
          const suppressStreamReanimation =
            msg.role === 'assistant' && streamedIncrementallyChatId === chatId
          const shouldAnimate = msg.id === newMessageId && !suppressStreamReanimation
          if (msg.role === 'assistant' && Array.isArray(parts) && parts.length > 0) {
            return (
              <div key={msg.id} className="space-y-2">
                {parts.map((p, idx) => {
                  const k = `${msg.id}-${idx}`
                  if (p.kind === 'thinking') {
                    return <ThinkingBlock key={k} content={p.text} animate={shouldAnimate} animateDelay={idx * 80} />
                  }
                  if (p.kind === 'tool') {
                    return (
                      <ToolNarrationBlock key={k} content={p.text} toolName={p.toolName} animate={shouldAnimate} animateDelay={idx * 80} />
                    )
                  }
                  return <MessageBubble key={k} role="assistant" content={p.text} animate={shouldAnimate} animateDelay={idx * 80} />
                })}
                {footer}
              </div>
            )
          }
          return (
            <div key={msg.id}>
              <MessageBubble
                role={msg.role as 'user' | 'assistant'}
                content={msg.content}
                animate={shouldAnimate}
              />
              {footer}
            </div>
          )
        })}

        {/* Optimistic user bubble — shown immediately while the DB round-trip
             is in flight so the dots always appear BELOW the user message. */}
        {pendingUserMessage && !messages.some((m) => m.role === 'user' && m.content === pendingUserMessage) && (
          <MessageBubble role="user" content={pendingUserMessage} animate />
        )}

        {isStreaming && !hasStreamingContent && (
          <div className="flex gap-1 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}

        {/* Render streaming blocks in order: text/thinking/tool interleaved */}
        {streamingBlocks.map((block, i) => {
          if (block.type === 'text') {
            const isLastBlock = i === streamingBlocks.length - 1
            if (block.kind === 'thinking') {
              return (
                <ThinkingBlock
                  key={`stream-think-${i}`}
                  content={block.content}
                  isStreaming={isStreaming && isLastBlock}
                  defaultExpanded={verboseMode ? undefined : false}
                />
              )
            }
            if (block.kind === 'tool') {
              return (
                <ToolNarrationBlock
                  key={`stream-tool-${i}`}
                  content={block.content}
                  toolName={block.toolName}
                  isStreaming={isStreaming && isLastBlock}
                  defaultExpanded={verboseMode ? undefined : false}
                />
              )
            }
            return (
              <div key={`stream-text-${i}`} className="text-sm leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">
                {block.segments.map((seg, si) => (
                  <span key={si} className="anim-chunk">
                    {seg}
                  </span>
                ))}
                {isStreaming && isLastBlock && (
                  <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-[var(--color-accent)] animate-pulse rounded-sm align-middle" />
                )}
              </div>
            )
          }
          return (
            <ToolCallBlock
              key={`stream-tc-${block.id}`}
              name={block.name}
              input={block.input}
              result={block.result != null ? (typeof block.result === 'string' ? block.result : JSON.stringify(block.result)) : undefined}
              error={block.error}
              status={block.status}
              provider={block.provider}
            />
          )
        })}

        {/* Persistent streaming indicator — stays at the bottom of all blocks
            while the stream is active so the user always sees progress. */}
        {isStreaming && hasStreamingContent && (
          <div className="flex gap-1 py-1">
            <span className="w-1 h-1 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
