import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { useAgents } from '../../hooks/useAgents'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { ToolResultBlock } from './ToolResultBlock'
import { MessageMetaFooter } from './MessageMetaFooter'
import { CollapsibleGroup, type CollapsibleGroupItem } from './CollapsibleGroup'

type RenderNode =
  | { slot: 'plain'; key: string; node: React.ReactNode }
  | { slot: 'collapsible'; item: CollapsibleGroupItem }

/** Wrap runs of consecutive collapsible nodes (length >= 2) into a CollapsibleGroup. */
function groupConsecutive(nodes: RenderNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  while (i < nodes.length) {
    const n = nodes[i]
    if (n.slot !== 'collapsible') {
      out.push(<div key={n.key}>{n.node}</div>)
      i++
      continue
    }
    let j = i
    while (j < nodes.length && nodes[j].slot === 'collapsible') j++
    const run = nodes.slice(i, j) as Extract<RenderNode, { slot: 'collapsible' }>[]
    if (run.length >= 2) {
      out.push(
        <CollapsibleGroup
          key={`group-${run[0].item.key}`}
          items={run.map((r) => r.item)}
        />
      )
    } else {
      out.push(<div key={run[0].item.key}>{run[0].item.node}</div>)
    }
    i = j
  }
  return out
}

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
  const { data: agents } = useAgents()
  const { streamingBlocks, isStreaming, pendingUserMessage, streamedIncrementallyChatId } = useChatStore()
  const verboseMode = useUIStore((s) => s.verboseMode)
  const bottomRef = useRef<HTMLDivElement>(null)
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of agents ?? []) map.set(a.id, a.name)
    return map
  }, [agents])
  const rootAgentId = chatData?.agentId ?? null
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
    <div
      className="flex-1 overflow-y-auto px-4 pb-4 pt-[calc(var(--topbar-h)+12px)]"
      style={bottomPadding ? { paddingBottom: bottomPadding + 16 } : undefined}
    >
      <div className="max-w-3xl mx-auto space-y-3">
        {messages.length === 0 && !isStreaming && !hasStreamingContent && (
          <div className="text-center text-[var(--color-text-muted)] py-16">
            <p className="text-sm">Start a conversation</p>
          </div>
        )}

        {(() => {
          const renderNodes: RenderNode[] = []

          for (const msg of messages) {
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
              renderNodes.push({
                slot: 'plain',
                key: msg.id,
                node: <>{node}{footer}</>
              })
              continue
            }
            // Legacy `agent_transition` rows (from earlier builds) are skipped
            // silently — the persistent "Talking to X / Switch back" banner
            // above the input is now the source of truth for routing state.
            if (msg.role === 'agent_transition') {
              continue
            }
            if (msg.role === 'tool_call') {
              const toolBlock = (
                <ToolCallBlock
                  name={msg.toolName ?? 'unknown'}
                  input={msg.toolInput as Record<string, unknown>}
                  result={msg.content}
                  error={msg.toolError ? msg.content : undefined}
                  status={msg.toolError ? 'error' : 'done'}
                  provider={msg.toolProvider}
                />
              )
              // In verbose mode the per-message footer must stay attached, so
              // skip grouping (push as plain) — otherwise circles can be grouped
              // across consecutive tool_call / thinking blocks.
              if (verboseMode) {
                renderNodes.push({
                  slot: 'plain',
                  key: msg.id,
                  node: <>{toolBlock}{footer}</>
                })
              } else {
                renderNodes.push({
                  slot: 'collapsible',
                  item: {
                    key: msg.id,
                    kind: 'tool_call',
                    status: msg.toolError ? 'error' : 'done',
                    node: toolBlock
                  }
                })
              }
              continue
            }
            if (msg.role === 'assistant' && !msg.content) {
              continue
            }
            const parts = msg.parts
            const suppressStreamReanimation =
              msg.role === 'assistant' && streamedIncrementallyChatId === chatId
            const shouldAnimate = msg.id === newMessageId && !suppressStreamReanimation
            const sourceAgentId = msg.role === 'assistant' ? msg.sourceAgentId ?? null : null
            const sourceAgentName =
              sourceAgentId && sourceAgentId !== rootAgentId
                ? agentNameById.get(sourceAgentId) ?? null
                : null
            const addressedAgentId = msg.role === 'user' ? msg.addressedAgentId ?? null : null
            const addressedAgentName =
              addressedAgentId && addressedAgentId !== rootAgentId
                ? agentNameById.get(addressedAgentId) ?? null
                : null
            if (msg.role === 'assistant' && Array.isArray(parts) && parts.length > 0) {
              if (verboseMode) {
                renderNodes.push({
                  slot: 'plain',
                  key: msg.id,
                  node: (
                    <div className="space-y-2">
                      {parts.map((p, idx) => {
                        const k = `${msg.id}-${idx}`
                        if (p.kind === 'thinking') {
                          return <ThinkingBlock key={k} content={p.text} animate={shouldAnimate} animateDelay={idx * 80} />
                        }
                        if (p.kind === 'tool') {
                          return (
                            <ToolNarrationBlock key={k} content={p.text} toolName={p.toolName} toolInput={p.toolInput} animate={shouldAnimate} animateDelay={idx * 80} />
                          )
                        }
                        if (p.kind === 'tool_result') {
                          return (
                            <ToolResultBlock key={k} content={p.text} toolStream={p.toolStream} animate={shouldAnimate} animateDelay={idx * 80} />
                          )
                        }
                        return (
                          <MessageBubble
                            key={k}
                            role="assistant"
                            content={p.text}
                            animate={shouldAnimate}
                            animateDelay={idx * 80}
                            agentName={idx === 0 ? sourceAgentName : null}
                            agentId={sourceAgentId}
                          />
                        )
                      })}
                      {footer}
                    </div>
                  )
                })
              } else {
                parts.forEach((p, idx) => {
                  const k = `${msg.id}-${idx}`
                  if (p.kind === 'thinking') {
                    renderNodes.push({
                      slot: 'collapsible',
                      item: {
                        key: k,
                        kind: 'thinking',
                        status: 'done',
                        node: <ThinkingBlock content={p.text} animate={shouldAnimate} animateDelay={idx * 80} />
                      }
                    })
                  } else if (p.kind === 'tool') {
                    renderNodes.push({
                      slot: 'collapsible',
                      item: {
                        key: k,
                        kind: 'tool_narration',
                        status: 'done',
                        node: <ToolNarrationBlock content={p.text} toolName={p.toolName} toolInput={p.toolInput} animate={shouldAnimate} animateDelay={idx * 80} />
                      }
                    })
                  } else if (p.kind === 'tool_result') {
                    renderNodes.push({
                      slot: 'collapsible',
                      item: {
                        key: k,
                        kind: 'tool_result',
                        status: p.toolStream === 'stderr' ? 'error' : 'done',
                        node: <ToolResultBlock content={p.text} toolStream={p.toolStream} animate={shouldAnimate} animateDelay={idx * 80} />
                      }
                    })
                  } else {
                    renderNodes.push({
                      slot: 'plain',
                      key: k,
                      node: (
                        <MessageBubble
                          role="assistant"
                          content={p.text}
                          animate={shouldAnimate}
                          animateDelay={idx * 80}
                          agentName={idx === 0 ? sourceAgentName : null}
                          agentId={sourceAgentId}
                        />
                      )
                    })
                  }
                })
              }
              continue
            }
            renderNodes.push({
              slot: 'plain',
              key: msg.id,
              node: (
                <>
                  <MessageBubble
                    role={msg.role as 'user' | 'assistant'}
                    content={msg.content}
                    animate={shouldAnimate}
                    agentName={sourceAgentName}
                    agentId={sourceAgentId}
                    addressedAgentName={addressedAgentName}
                    addressedAgentId={addressedAgentId}
                    attachments={msg.role === 'user' ? msg.attachments ?? null : null}
                  />
                  {footer}
                </>
              )
            })
          }

          // Optimistic user bubble — shown immediately while the DB round-trip
          // is in flight so the dots always appear BELOW the user message.
          if (pendingUserMessage && !messages.some((m) => m.role === 'user' && m.content === pendingUserMessage)) {
            renderNodes.push({
              slot: 'plain',
              key: 'pending-user',
              node: <MessageBubble role="user" content={pendingUserMessage} animate />
            })
          }

          if (isStreaming && !hasStreamingContent) {
            renderNodes.push({
              slot: 'plain',
              key: 'stream-dots-pre',
              node: (
                <div className="flex gap-1 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              )
            })
          }

          streamingBlocks.forEach((block, i) => {
            const isLastBlock = i === streamingBlocks.length - 1
            if (block.type === 'text') {
              if (block.kind === 'thinking') {
                const live = isStreaming && isLastBlock
                const node = (
                  <ThinkingBlock
                    content={block.content}
                    isStreaming={live}
                    defaultExpanded={verboseMode ? undefined : false}
                  />
                )
                if (verboseMode) {
                  renderNodes.push({ slot: 'plain', key: `stream-think-${i}`, node })
                } else {
                  renderNodes.push({
                    slot: 'collapsible',
                    item: { key: `stream-think-${i}`, kind: 'thinking', status: 'done', isLive: live, node }
                  })
                }
                return
              }
              if (block.kind === 'tool') {
                const live = isStreaming && isLastBlock
                const node = (
                  <ToolNarrationBlock
                    content={block.content}
                    toolName={block.toolName}
                    toolInput={block.toolInput}
                    isStreaming={live}
                    defaultExpanded={verboseMode ? undefined : false}
                  />
                )
                if (verboseMode) {
                  renderNodes.push({ slot: 'plain', key: `stream-tool-${i}`, node })
                } else {
                  renderNodes.push({
                    slot: 'collapsible',
                    item: { key: `stream-tool-${i}`, kind: 'tool_narration', status: 'done', isLive: live, node }
                  })
                }
                return
              }
              if (block.kind === 'tool_result') {
                const live = isStreaming && isLastBlock
                // Tool output is the payload the user is actually waiting on
                // (especially for `/run:*` CLI commands), so leave it expanded
                // by default during streaming — unlike tool/thinking blocks
                // which default collapsed because their content is auxiliary
                // narration. Persisted reload uses the default collapsed
                // behavior from ToolResultBlock to keep long outputs from
                // crowding scrollback.
                const node = (
                  <ToolResultBlock
                    content={block.content}
                    toolStream={block.toolStream}
                    isStreaming={live}
                    defaultExpanded={verboseMode ? undefined : true}
                  />
                )
                if (verboseMode) {
                  renderNodes.push({ slot: 'plain', key: `stream-result-${i}`, node })
                } else {
                  renderNodes.push({
                    slot: 'collapsible',
                    item: {
                      key: `stream-result-${i}`,
                      kind: 'tool_result',
                      status: block.toolStream === 'stderr' ? 'error' : 'done',
                      isLive: live,
                      node
                    }
                  })
                }
                return
              }
              renderNodes.push({
                slot: 'plain',
                key: `stream-text-${i}`,
                node: (
                  <div className="text-sm leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">
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
              })
              return
            }
            const toolNode = (
              <ToolCallBlock
                name={block.name}
                input={block.input}
                result={block.result != null ? (typeof block.result === 'string' ? block.result : JSON.stringify(block.result)) : undefined}
                error={block.error}
                status={block.status}
                provider={block.provider}
              />
            )
            if (verboseMode) {
              renderNodes.push({ slot: 'plain', key: `stream-tc-${block.id}`, node: toolNode })
            } else {
              renderNodes.push({
                slot: 'collapsible',
                item: { key: `stream-tc-${block.id}`, kind: 'tool_call', status: block.status, node: toolNode }
              })
            }
          })

          return groupConsecutive(renderNodes)
        })()}

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
