import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle, ChevronRight, RefreshCw } from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { useAgents } from '../../hooks/useAgents'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'
import { CINNA_REAUTH_REQUIRED_CODE } from '../../../../shared/cinnaErrors'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { ToolResultBlock } from './ToolResultBlock'
import { CommandResultBlock } from './CommandResultBlock'
import { AgentAttachment } from './AgentAttachment'
import { AgentToolSubThread } from './AgentToolSubThread'
import { CommandToolFrame } from './CommandToolFrame'
import { NoticeBlock } from './NoticeBlock'
import { MessageMetaFooter } from './MessageMetaFooter'
import {
  type RenderNode,
  groupConsecutiveCollapsibles
} from './CollapsibleGroup'
import type { ToolStream } from '../../../../shared/messageParts'

/**
 * Pair `tool` parts/blocks (with `cinna.command_invocation`) to their matching
 * `tool_result` (by `toolId`) so the renderer can wrap each pair in a single
 * `CommandToolFrame`. Returns the toolIdx → resultIdx map plus the set of
 * result indices to skip (they're consumed by the wrapper).
 */
function pairCommandTools<
  T extends { kind: string; toolId?: string; commandInvocation?: string }
>(items: T[]): { pairResultIdx: Map<number, number>; consumed: Set<number> } {
  const pairResultIdx = new Map<number, number>()
  const consumed = new Set<number>()
  items.forEach((item, idx) => {
    if (item.kind !== 'tool' || !item.commandInvocation || !item.toolId) return
    const ri = items.findIndex(
      (q, j) => j > idx && q.kind === 'tool_result' && q.toolId === item.toolId
    )
    if (ri !== -1) {
      pairResultIdx.set(idx, ri)
      consumed.add(ri)
    }
  })
  return { pairResultIdx, consumed }
}

/**
 * Single source of truth for the slash-command-pair JSX. Used by all three
 * MessageStream render paths (verbose persisted, compact persisted, live
 * streaming). The inner block defaults are identical across paths — narration
 * starts collapsed (the parent frame header already shows the invocation),
 * result starts expanded (the command output is what matters). The frame's
 * default-expanded and streaming state vary per path and are forwarded by the
 * caller.
 */
function renderCommandToolPair(opts: {
  key: string
  commandInvocation: string
  toolText: string
  toolName?: string
  toolInput?: Record<string, unknown>
  result?: { text: string; toolStream?: ToolStream }
  frameDefaultExpanded?: boolean
  frameIsStreaming?: boolean
  narrationIsStreaming?: boolean
  resultIsStreaming?: boolean
  animate?: boolean
  animateDelay?: number
}): React.ReactNode {
  const {
    key,
    commandInvocation,
    toolText,
    toolName,
    toolInput,
    result,
    frameDefaultExpanded,
    frameIsStreaming,
    narrationIsStreaming,
    resultIsStreaming,
    animate,
    animateDelay
  } = opts
  return (
    <CommandToolFrame
      key={key}
      commandInvocation={commandInvocation}
      defaultExpanded={frameDefaultExpanded}
      isStreaming={frameIsStreaming}
      animate={animate}
      animateDelay={animateDelay}
    >
      <ToolNarrationBlock
        content={toolText}
        toolName={toolName}
        toolInput={toolInput}
        commandInvocation={commandInvocation}
        defaultExpanded={false}
        isStreaming={narrationIsStreaming}
      />
      {result && (
        <ToolResultBlock
          content={result.text}
          toolStream={result.toolStream}
          isStreaming={resultIsStreaming}
          defaultExpanded
        />
      )}
    </CommandToolFrame>
  )
}

interface MessageStreamProps {
  chatId: string
  bottomPadding?: number
}

function SystemMessage({
  message,
  detail,
  code
}: {
  message: string
  detail?: string
  code?: string
}): React.JSX.Element {
  // Reauth-required errors get a dedicated bubble that swaps its entire
  // appearance (danger → success) once the user completes re-auth — leaving
  // the persisted "Cinna session expired" copy in place after the user has
  // already fixed the session would be misleading.
  if (code === CINNA_REAUTH_REQUIRED_CODE) {
    return <ReauthErrorBubble detail={detail} />
  }

  return <GenericErrorBubble message={message} detail={detail} />
}

function GenericErrorBubble({
  message,
  detail
}: {
  message: string
  detail?: string
}): React.JSX.Element {
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

/**
 * Bubble dedicated to the "Cinna session expired" error. Owns two states:
 *  - Pre-reauth: danger-styled, with the original error copy + "Re-authenticate" button
 *  - Post-reauth: success-styled, replacing the now-stale "expired" message
 *    with a friendly "session restored" note so the user isn't staring at a
 *    red bubble after fixing the problem.
 *
 * The Cinna-user gate is on the button only, not the bubble itself — a non-
 * Cinna user (somehow) seeing this error would still see the danger copy
 * but no action button, matching the generic-error layout.
 */
function ReauthErrorBubble({ detail }: { detail?: string }): React.JSX.Element {
  const currentUser = useAuthStore((s) => s.currentUser)
  const cinnaReauth = useCinnaReauth()
  const [done, setDone] = useState(false)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const canReauth = currentUser?.type === 'cinna_user'

  const handleReauth = async (): Promise<void> => {
    if (!currentUser) return
    setReauthError(null)
    const result = await cinnaReauth.mutateAsync()
    if (result.success) {
      setDone(true)
    } else {
      setReauthError(result.error ?? 'Re-authentication failed')
    }
  }

  if (done) {
    return (
      <div className="flex justify-center">
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/8 px-4 py-2.5 max-w-md text-center">
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-success)]">
            <CheckCircle size={13} />
            <span>Authenticated — you can resend your message now.</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-center">
      <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/8 px-4 py-2.5 max-w-md text-center">
        <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-danger)]">
          <AlertTriangle size={13} />
          <span>Cinna session expired — please re-authenticate.</span>
        </div>
        {canReauth && (
          <div className="mt-2 flex flex-col items-center gap-1">
            <button
              onClick={handleReauth}
              disabled={cinnaReauth.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium
                bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
                disabled:opacity-50"
            >
              <RefreshCw size={10} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
              {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
            </button>
            {reauthError && (
              <div className="text-[10px] text-[var(--color-danger)] max-w-xs break-words">{reauthError}</div>
            )}
          </div>
        )}
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
                const err = JSON.parse(msg.content) as {
                  short: string
                  detail?: string
                  code?: string
                }
                node = <SystemMessage message={err.short} detail={err.detail} code={err.code} />
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
            // `agent_transition` rows are agent-side system messages — the
            // streaming pipeline persists `cinna.content_kind: 'notice'` parts
            // here (e.g. "Starting up the agent environment, this may take a
            // moment..."). In compact mode the persisted row collapses to a
            // small info-toned dot so it doesn't crowd the transcript; in
            // verbose mode it stays inline alongside the rest of the surfaced
            // meta. Excluded from catch-up replay + LLM history rebuilds by role.
            if (msg.role === 'agent_transition') {
              renderNodes.push({
                slot: 'plain',
                key: msg.id,
                node: <NoticeBlock content={msg.content} defaultExpanded={verboseMode} />
              })
              continue
            }
            if (msg.role === 'tool_call') {
              // Agent-backed tool call (orchestrated mode): the rich agent
              // `parts[]` were persisted on the row — render the nested,
              // expandable sub-thread instead of the bare tool block. Plain
              // slot (not collapsible-grouped) since it's a substantial thread.
              const subParts = msg.parts
              if (Array.isArray(subParts) && subParts.length > 0) {
                const askMessage =
                  msg.toolInput && typeof (msg.toolInput as Record<string, unknown>).message === 'string'
                    ? ((msg.toolInput as Record<string, unknown>).message as string)
                    : undefined
                renderNodes.push({
                  slot: 'plain',
                  key: msg.id,
                  node: (
                    <>
                      <AgentToolSubThread
                        agentName={msg.toolProvider ?? msg.toolName ?? 'Agent'}
                        agentId={msg.toolAgentId}
                        parts={subParts}
                        askMessage={askMessage}
                        status={msg.toolError ? 'error' : 'done'}
                        errorText={msg.toolError ? msg.content : undefined}
                        verbose={verboseMode}
                      />
                      {footer}
                    </>
                  )
                })
                continue
              }
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
            const parts = msg.parts
            // Skip empty assistant rows — but NOT when they carry structured
            // parts (e.g. an agent turn that only attached a file has no text
            // content yet still renders a download badge from `parts[]`).
            if (
              msg.role === 'assistant' &&
              !msg.content &&
              !(Array.isArray(parts) && parts.length > 0)
            ) {
              continue
            }
            const suppressStreamReanimation =
              msg.role === 'assistant' && streamedIncrementallyChatId === chatId
            // The optimistic user bubble already played its expand animation;
            // when its persisted row lands mid-handoff (same content, pending
            // not yet retired) the swap must be silent — otherwise the bubble
            // animates a second time. Mirrors the assistant suppression above.
            const suppressOptimisticReanimation =
              msg.role === 'user' && pendingUserMessage?.content === msg.content
            const shouldAnimate =
              msg.id === newMessageId &&
              !suppressStreamReanimation &&
              !suppressOptimisticReanimation
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
              const { pairResultIdx, consumed } = pairCommandTools(parts)
              if (verboseMode) {
                renderNodes.push({
                  slot: 'plain',
                  key: msg.id,
                  node: (
                    <div className="space-y-2">
                      {parts.map((p, idx) => {
                        const k = `${msg.id}-${idx}`
                        // tool_result already absorbed into a CommandToolFrame
                        // alongside its paired tool — skip the standalone render.
                        if (consumed.has(idx)) return null
                        if (p.kind === 'tool' && p.commandInvocation) {
                          const ri = pairResultIdx.get(idx)
                          const result = ri !== undefined ? parts[ri] : undefined
                          return renderCommandToolPair({
                            key: k,
                            commandInvocation: p.commandInvocation,
                            toolText: p.text,
                            toolName: p.toolName,
                            toolInput: p.toolInput,
                            result: result ? { text: result.text, toolStream: result.toolStream } : undefined,
                            frameDefaultExpanded: true,
                            animate: shouldAnimate,
                            animateDelay: idx * 80
                          })
                        }
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
                        if (p.kind === 'command_result') {
                          return (
                            <CommandResultBlock
                              key={k}
                              content={p.text}
                              commandInvocation={p.commandInvocation}
                              animate={shouldAnimate}
                              animateDelay={idx * 80}
                            />
                          )
                        }
                        if (p.kind === 'file' && p.file) {
                          return <AgentAttachment key={k} file={p.file} align="left" />
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
                  if (consumed.has(idx)) return
                  if (p.kind === 'tool' && p.commandInvocation) {
                    const ri = pairResultIdx.get(idx)
                    const result = ri !== undefined ? parts[ri] : undefined
                    // `/run:*` pair — frame as a slash-command UI, not as bare
                    // tool plumbing. Plain slot (same as command_result) since
                    // this IS the assistant turn, not auxiliary narration.
                    renderNodes.push({
                      slot: 'plain',
                      key: k,
                      node: renderCommandToolPair({
                        key: k,
                        commandInvocation: p.commandInvocation,
                        toolText: p.text,
                        toolName: p.toolName,
                        toolInput: p.toolInput,
                        result: result ? { text: result.text, toolStream: result.toolStream } : undefined,
                        animate: shouldAnimate,
                        animateDelay: idx * 80
                      })
                    })
                  } else if (p.kind === 'thinking') {
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
                  } else if (p.kind === 'command_result') {
                    // Slash-command output — render inline as the assistant
                    // turn, default-expanded. Not collapsible-grouped because
                    // it IS the answer, not auxiliary narration.
                    renderNodes.push({
                      slot: 'plain',
                      key: k,
                      node: (
                        <CommandResultBlock
                          content={p.text}
                          commandInvocation={p.commandInvocation}
                          animate={shouldAnimate}
                          animateDelay={idx * 80}
                        />
                      )
                    })
                  } else if (p.kind === 'file' && p.file) {
                    // Agent-attached file — downloadable badge inline at the
                    // position the agent declared it. Plain slot, left-aligned
                    // like the rest of the assistant turn.
                    renderNodes.push({
                      slot: 'plain',
                      key: k,
                      node: <AgentAttachment file={p.file} align="left" />
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
          // Retired the instant a *new* user row lands: the persisted count
          // growing past the send-time baseline means this message's own row is
          // now in `messages`. Count- (not content-) keyed so repeating the
          // previous turn's exact text still shows the optimistic bubble.
          const persistedUserCount = messages.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0)
          if (pendingUserMessage && persistedUserCount <= pendingUserMessage.baselineUserCount) {
            renderNodes.push({
              slot: 'plain',
              key: 'pending-user',
              node: <MessageBubble role="user" content={pendingUserMessage.content} animate />
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

          // Pair streaming `tool` + `tool_result` blocks the same way as
          // persisted parts so live `/run:*` turns render in a CommandToolFrame
          // even before the stream finishes.
          const streamingTextBlocks = streamingBlocks.map((b) =>
            b.type === 'text'
              ? { kind: b.kind, toolId: b.toolId, commandInvocation: b.commandInvocation }
              : { kind: 'tool_call' }
          )
          const { pairResultIdx: streamPairResultIdx, consumed: streamConsumed } =
            pairCommandTools(streamingTextBlocks)
          streamingBlocks.forEach((block, i) => {
            const isLastBlock = i === streamingBlocks.length - 1
            if (streamConsumed.has(i)) return
            if (block.type === 'text' && block.kind === 'tool' && block.commandInvocation) {
              const ri = streamPairResultIdx.get(i)
              const resultBlock =
                ri !== undefined && streamingBlocks[ri].type === 'text'
                  ? (streamingBlocks[ri] as Extract<typeof streamingBlocks[number], { type: 'text' }>)
                  : undefined
              // Live: streaming flag rides the whole frame so the header shows
              // a pulse while either the tool or its paired result is still
              // arriving (last block in the stream).
              const live = isStreaming && (isLastBlock || (ri !== undefined && ri === streamingBlocks.length - 1))
              const key = `stream-cmd-tool-${i}`
              renderNodes.push({
                slot: 'plain',
                key,
                node: renderCommandToolPair({
                  key,
                  commandInvocation: block.commandInvocation,
                  toolText: block.content,
                  toolName: block.toolName,
                  toolInput: block.toolInput,
                  result: resultBlock
                    ? { text: resultBlock.content, toolStream: resultBlock.toolStream }
                    : undefined,
                  frameDefaultExpanded: true,
                  frameIsStreaming: live,
                  narrationIsStreaming: live && !resultBlock,
                  resultIsStreaming: live && ri === streamingBlocks.length - 1
                })
              })
              return
            }
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
              if (block.kind === 'notice') {
                // Live streaming agent-side system message (startup ping etc.).
                // Renders through NoticeBlock with `live` so the layout matches
                // the expanded persisted form (left-aligned Info+text row).
                // After the stream completes, the persisted `agent_transition`
                // row takes over via the same component without `live`, which
                // switches it to the collapsed-dot default.
                renderNodes.push({
                  slot: 'plain',
                  key: `stream-notice-${i}`,
                  node: <NoticeBlock content={block.content} live />
                })
                return
              }
              if (block.kind === 'command_result') {
                const live = isStreaming && isLastBlock
                renderNodes.push({
                  slot: 'plain',
                  key: `stream-cmd-${i}`,
                  node: (
                    <CommandResultBlock
                      content={block.content}
                      commandInvocation={block.commandInvocation}
                      isStreaming={live}
                    />
                  )
                })
                return
              }
              if (block.kind === 'file' && block.file) {
                // Agent-attached file streamed in at finalize — render the
                // download badge live; the post-`done` refetch replaces it with
                // the persisted `file` part (same badge, no visual change).
                renderNodes.push({
                  slot: 'plain',
                  key: `stream-file-${i}`,
                  node: <AgentAttachment file={block.file} align="left" />
                })
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
              // Render the live assistant text through the same MessageBubble /
              // react-markdown path as the persisted message so markdown (bold,
              // lists, tables) renders progressively while streaming — not as
              // raw `**…**` that only snaps to formatted once the stream ends.
              // (Trade-off: drops the per-chunk fade since markdown re-parses the
              // whole string each chunk; the cursor is owned by MessageBubble.)
              renderNodes.push({
                slot: 'plain',
                key: `stream-text-${i}`,
                node: (
                  <MessageBubble
                    role="assistant"
                    content={block.content}
                    isStreaming={isStreaming && isLastBlock}
                  />
                )
              })
              return
            }
            // Agent-backed tool call: render the live sub-thread, streaming the
            // agent's parts into an expandable block keyed by this tool call.
            if (block.providerType === 'agent') {
              const askMessage =
                typeof block.input.message === 'string' ? block.input.message : undefined
              renderNodes.push({
                slot: 'plain',
                key: `stream-agent-${block.id}`,
                node: (
                  <AgentToolSubThread
                    agentName={block.provider ?? block.name}
                    agentId={block.agentId}
                    parts={block.subParts ?? []}
                    askMessage={askMessage}
                    status={block.status}
                    isStreaming={block.status === 'pending'}
                    errorText={block.error}
                    verbose={verboseMode}
                  />
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

          return groupConsecutiveCollapsibles(renderNodes)
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
