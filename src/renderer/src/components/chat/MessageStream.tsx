import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  CheckCircle,
  ChevronRight,
  ChevronsDownUp,
  RefreshCw
} from 'lucide-react'
import { useChatDetail } from '../../hooks/useChat'
import { isLiveInputRequest, isSettledInputRequest, useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { useAgents } from '../../hooks/useAgents'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'
import { CINNA_REAUTH_REQUIRED_CODE } from '../../../../shared/cinnaErrors'
import { MessageBubble } from './MessageBubble'
import { FileRefContext, FileRefResolver, collectFileRefSources, type FileRefScope } from './fileRefs'
import { useMessageContextMenu } from './MessageContextMenu'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { ToolResultBlock } from './ToolResultBlock'
import { CommandResultBlock } from './CommandResultBlock'
import { AgentAttachment } from './AgentAttachment'
import { AgentToolSubThread } from './AgentToolSubThread'
import { CommandToolFrame } from './CommandToolFrame'
import { CinnaCliBlock } from './CinnaCliBlock'
import { pairCinnaCliTools } from '../../utils/cinnaCli'
import { NoticeBlock } from './NoticeBlock'
import { SystemTurnBlock } from './SystemTurnBlock'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { isAskUserQuestionTool, parseAskQuestions } from '../../utils/askUserQuestion'
import {
  isEngineRequestId,
  isPermissionRequestTool,
  parsePermissionRequest,
  questionCallId
} from '../../../../shared/localAgentRequests'
import { PermissionRequestBlock } from './PermissionRequestBlock'
import { useAgentRequests } from '../../hooks/useAgentRequests'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { MessageMetaFooter } from './MessageMetaFooter'
import { QueuedMessages, useQueuedMessages } from './QueuedMessages'
import { holdCollapseAnchor } from './transcriptAnchor'
import {
  type RenderNode,
  groupConsecutiveCollapsibles
} from './CollapsibleGroup'
import {
  TranscriptExpansionContext,
  createTranscriptExpansionStore,
  type TranscriptExpansionStore
} from './transcriptExpansion'
import type { ToolStream } from '../../../../shared/messageParts'

/**
 * Pair `tool` parts/blocks (with `cinna.command_invocation`) to their matching
 * `tool_result` (by `toolId`) so the renderer can wrap each pair in a single
 * `CommandToolFrame`. Returns the toolIdx → resultIdx map plus the set of
 * result indices to skip (they're consumed by the wrapper).
 */
function pairCommandTools<
  T extends {
    kind: string
    toolId?: string
    toolName?: string
    toolInput?: Record<string, unknown>
    toolStream?: ToolStream
    commandInvocation?: string
  }
>(items: T[]): { pairResultIdx: Map<number, number>; consumed: Set<number> } {
  const pairResultIdx = new Map<number, number>()
  const consumed = new Set<number>()
  items.forEach((item, idx) => {
    // Two kinds of tool part own their result rather than letting it render as
    // a standalone block: a synthesized `/run:*` pair, and a local agent's
    // permission or question ask, whose result is the decision record folded
    // into the request block.
    if (item.kind !== 'tool' || !item.toolId) return
    if (!item.commandInvocation && !isEngineRequestId(item.toolId)) return
    const ri = items.findIndex(
      (q, j) => j > idx && q.kind === 'tool_result' && q.toolId === item.toolId
    )
    if (ri !== -1) {
      pairResultIdx.set(idx, ri)
      consumed.add(ri)
    }
    // A local agent's question raised from its own `AskUserQuestion` call: that
    // call's result is the tool restating the answer ("Your questions have been
    // answered: …") beside the block that already shows it. Hidden only when the
    // question names the call **and** the call is that tool — an MCP tool that
    // asked mid-call has output of its own — and never when the call failed.
    const callId = isAskUserQuestionTool(item.toolName) ? questionCallId(item.toolInput) : undefined
    if (!callId) return
    const call = items.findIndex(
      (q) => q.kind === 'tool' && q.toolId === callId && isAskUserQuestionTool(q.toolName)
    )
    if (call === -1) return
    // The call itself goes too. It is a question tool by name, so one whose
    // part kept its input would render as a second card — answerable, under a
    // non-engine id — for a question this block already asked.
    consumed.add(call)
    const echo = items.findIndex(
      (q, j) => j > idx && q.kind === 'tool_result' && q.toolId === callId && q.toolStream !== 'stderr'
    )
    if (echo !== -1) consumed.add(echo)
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

const PILL_CLASS = `pointer-events-auto inline-flex items-center gap-1.5
  px-3 py-1 rounded-full text-xs
  text-[var(--color-text-secondary)] hover:text-[var(--color-text)]
  bg-[var(--color-bg-secondary)]/80 hover:bg-[var(--color-bg-secondary)]
  border border-[var(--color-border)] shadow-sm backdrop-blur transition-colors`

/**
 * The transcript's floating actions: "Collapse expanded" while the user has
 * opened any block, "Jump to latest" while the view is not following. Its own
 * component so a block toggling re-renders this row, not the transcript.
 *
 * Sits low enough to straddle the composer's fade band rather than clear of
 * it: centred over undimmed prose the pill hid about twenty characters
 * mid-sentence. Each text node is its button's accessible name, so neither
 * carries an `aria-label` or `title` restating it.
 */
function TranscriptPills({
  store,
  pinned,
  onCollapse,
  onJumpToLatest,
  bottomPadding
}: {
  store: TranscriptExpansionStore
  pinned: boolean
  onCollapse: () => void
  onJumpToLatest: () => void
  bottomPadding?: number
}): React.JSX.Element | null {
  const hasExpanded = useSyncExternalStore(store.subscribe, store.hasExpanded)
  if (pinned && !hasExpanded) return null
  // Three columns so neither pill moves when the other comes or goes: "Jump to
  // latest" keeps the centre it always had, and "Collapse expanded" is pinned
  // to its left. Centring the pair as one row slid the survivor under the
  // pointer the moment its neighbour was clicked away (ux_rules §1). The
  // centre pill is kept in layout but `invisible` while the view is pinned,
  // which also takes it out of the tab order and the accessibility tree.
  return (
    <div
      className="absolute inset-x-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 whitespace-nowrap pointer-events-none"
      style={{ bottom: Math.max(0, (bottomPadding ?? 0) - 8) }}
    >
      <div className="flex justify-end">
        {hasExpanded && (
          <button type="button" onClick={onCollapse} className={PILL_CLASS}>
            <ChevronsDownUp size={12} className="shrink-0" />
            Collapse expanded
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onJumpToLatest}
        aria-hidden={pinned || undefined}
        tabIndex={pinned ? -1 : undefined}
        className={`${PILL_CLASS} ${pinned ? 'invisible' : ''}`}
      >
        <ArrowDown size={12} className="shrink-0" />
        Jump to latest
      </button>
      <div />
    </div>
  )
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

const NO_FILE_REF_SCOPES: ReadonlyMap<string, FileRefScope> = new Map()

export function MessageStream({ chatId, bottomPadding }: MessageStreamProps): React.JSX.Element {
  const messageContextMenu = useMessageContextMenu(chatId)
  const { data: chatData } = useChatDetail(chatId)
  const { data: agents } = useAgents()
  const { streamingBlocks, isStreaming, liveBaselineMessageIds, pendingUserMessage, streamedIncrementallyChatId, inputRequests, settledInputRequestIds, sentVersion } = useChatStore()
  const verboseMode = useUIStore((s) => s.verboseMode)
  // **While a request block is answerable, new content must not move it.** A
  // second ask arriving under a pinned view scrolled the first block's buttons
  // away and put the second's exactly where the pointer was, so a click aimed at
  // one permission answered another (ux_rules §1). The view stops following and
  // the jump-to-latest pill says there is more below. Only top-level `reply`
  // asks count: a nested agent's has no block on screen to protect.
  const holdForAnswer = inputRequests.some(
    (r) => r.resume === 'reply' && !r.toolCallId && !settledInputRequestIds.includes(r.requestId)
  )
  const { containerRef, contentRef, pinned, scrollToBottom } = useStickToBottom(chatId, {
    hold: holdForAnswer
  })
  // Which blocks the user opened, for "Collapse expanded". One per chat: this
  // component is not remounted when the active chat changes, and a new chat
  // must not inherit the last one's registrations.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const expansionStore = useMemo(() => createTranscriptExpansionStore(), [chatId])
  // Collapsing must not move what the reader is looking at (ux_rules §1). A
  // pinned transcript simply stays at the bottom; an unpinned one holds its
  // anchor through the groups' height transition — see `transcriptAnchor.ts`.
  const releaseAnchorRef = useRef<(() => void) | null>(null)
  useEffect(() => () => {
    releaseAnchorRef.current?.()
    releaseAnchorRef.current = null
  }, [chatId])
  const collapseExpanded = useCallback(() => {
    releaseAnchorRef.current?.()
    releaseAnchorRef.current = null
    const container = containerRef.current
    const content = contentRef.current
    // A group header lands below the top padding, clear of the top bar.
    if (!pinned && container && content) releaseAnchorRef.current = holdCollapseAnchor(container, content)
    expansionStore.collapseAll()
  }, [pinned, containerRef, contentRef, expansionStore])
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of agents ?? []) map.set(a.id, a.name)
    return map
  }, [agents])
  const rootAgentId = chatData?.agentId ?? null
  // Inline file references in folder agents' bubbles, resolved per agent over
  // the persisted transcript. The resolver is a sibling of the transcript (see
  // `FileRefResolver`) and reports the scopes here.
  const fileRefSources = useMemo(
    () => collectFileRefSources(chatData?.messages, agents, rootAgentId),
    [chatData?.messages, agents, rootAgentId]
  )
  const [fileRefScopes, setFileRefScopes] = useState<ReadonlyMap<string, FileRefScope>>(NO_FILE_REF_SCOPES)
  const fileRefScopeFor = (agentId: string | null): FileRefScope | null =>
    agentId ? fileRefScopes.get(agentId) ?? null : null
  const prevRef = useRef<{ chatId: string | null; messageIds: string[] }>({
    chatId: null,
    messageIds: []
  })

  // Sending re-engages following: the user just acted, and the thing they
  // acted on is at the bottom. Nothing else re-pins on the transcript's
  // behalf — an arriving chunk never does.
  useEffect(() => {
    if (pendingUserMessage) scrollToBottom()
  }, [pendingUserMessage, scrollToBottom])
  // The same for a send that shows no optimistic bubble — one taken into the
  // running turn or queued behind it.
  const mountedSentVersion = useRef(sentVersion)
  useEffect(() => {
    if (sentVersion !== mountedSentVersion.current) scrollToBottom()
  }, [sentVersion, scrollToBottom])

  // A model can persist completed tool rounds while its turn is still live.
  // Replay represents those same rows until the terminal transcript refetch.
  const baselineIds = liveBaselineMessageIds && new Set(liveBaselineMessageIds)
  const messages = (chatData?.messages ?? []).filter((message) =>
    !baselineIds || message.role === 'user' || message.role === 'system' || baselineIds.has(message.id))
  const hasStreamingContent = streamingBlocks.length > 0
  const queuedView = useQueuedMessages(
    chatId,
    messages.filter((message) => message.role === 'user').map((message) => message.content),
    // Messages the turn took in are saved only when it ends: rows on their way.
    streamingBlocks.flatMap((block) => (block.type === 'user' ? [block.content] : []))
  )

  // The agent's `AskUserQuestion` tool is answerable only while the chat is
  // waiting on it: it's the final turn (no user reply after it) and nothing is
  // streaming. Once the user answers, a new user row lands after it (or a
  // stream starts), so the prompt reverts to a muted, read-only record.
  // What a **local** agent is parked on right now. A local request is
  // answerable while the turn is still streaming, which is precisely the state
  // `activeQuestionMsgId` below excludes — the two live side by side rather
  // than one replacing the other.
  const { isPending, answerPermission, answerQuestion } = useAgentRequests(chatId, isStreaming || !!chatData?.activeRunId)


  /**
   * One interactive block for a `tool` part that is a permission ask or a
   * question.
   *
   * Shared by all four render sites — persisted single-agent, persisted
   * grouped, and the two live-stream paths — because the decision "is this
   * request still open" has exactly one right answer and four copies of it
   * would drift.
   */
  const renderRequestBlock = (
    key: string,
    part: { toolName?: string; toolId?: string; toolInput?: Record<string, unknown> },
    questionInteractive: boolean,
    decision?: string
  ): React.JSX.Element | null => {
    // `toolId` carries the engine's own request id (`per_*` / `que_*`), which
    // is also the address an answer is posted to. Either source can say it is
    // open: the stream's `needs_input` arrives with the ask, the registry poll
    // up to a tick later but also across a reload. The stream's word that it is
    // settled wins over both, because the poll can lag it by the same tick.
    const live =
      part.toolId &&
      !isSettledInputRequest({ settledInputRequestIds }, part.toolId) &&
      (isPending(part.toolId) || isLiveInputRequest({ inputRequests }, part.toolId))
        ? part.toolId
        : undefined
    // **A block replayed from history must never be live.** These parts are
    // persisted and re-rendered when the chat is reopened, and by then the
    // `per_*` behind them is long dead — the registry that owns it is
    // in-memory and died with the turn. `activeQuestionMsgId` cannot be
    // trusted here: it was written for a *cloud* question, which stays
    // answerable after its turn because the answer is simply the next user
    // turn. A local request has a live address instead, so only the registry
    // and the current stream's `reply` asks can say it is still open.
    const questionLive = isEngineRequestId(part.toolId) ? !!live : questionInteractive
    if (isPermissionRequestTool(part.toolName)) {
      const request = parsePermissionRequest(part.toolInput)
      if (!request) return null
      return (
        <PermissionRequestBlock
          key={key}
          request={request}
          // The id even when not live: the block holds its buttons while its
          // own answer is in flight, and the stream can settle the ask first.
          requestId={part.toolId}
          interactive={!!live}
          decision={decision}
          // The stream settled it (expired, or answered in another window) and
          // the outcome line is the next port message: hold the block's height
          // until it arrives. Only while streaming — a replayed block that
          // recorded no outcome must not hold forever.
          awaitingDecision={
            !live &&
            !decision &&
            isStreaming &&
            isSettledInputRequest({ settledInputRequestIds }, part.toolId)
          }
          onAnswer={answerPermission}
        />
      )
    }
    if (isAskUserQuestionTool(part.toolName)) {
      return (
        <AskUserQuestionBlock
          key={key}
          questions={parseAskQuestions(part.toolInput)}
          interactive={questionLive}
          chatId={chatId}
          liveRequestId={live}
          // The runner's `Answered: …` line, which `pairCommandTools` has
          // already consumed so it does not render standalone. It was computed
          // at all three call sites and handed only to the permission block, so
          // a replayed question said "A question asked" and never what the user
          // chose — the gap `run-events.spec.ts`'s `test.fail()` was written
          // against, and the one the inbox would otherwise have closed on its
          // own surface while the transcript stayed silent.
          decision={decision}
          onAnswerLocal={answerQuestion}
        />
      )
    }
    return null
  }

  const lastMsg = messages[messages.length - 1]
  const activeQuestionMsgId =
    !isStreaming &&
    !pendingUserMessage &&
    lastMsg &&
    lastMsg.role === 'assistant' &&
    Array.isArray(lastMsg.parts) &&
    lastMsg.parts.some((p) => p.kind === 'tool' && isAskUserQuestionTool(p.toolName))
      ? lastMsg.id
      : null

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
    // No wrapper element (the provider renders no DOM): the pills are
    // absolutely positioned against MainArea's `relative` chat container (the
    // same one the composer overlay anchors to), so they need no layout box of
    // their own and the scroll element stays the direct flex child it has
    // always been.
    <TranscriptExpansionContext.Provider value={expansionStore}>
    {/* Keyed by chat: the resolver remembers each agent's last answer, which
        belongs to this transcript only. */}
    {fileRefSources.size > 0 && <FileRefResolver key={chatId} sources={fileRefSources} onChange={setFileRefScopes} />}
    <div
      ref={containerRef}
      onContextMenu={messageContextMenu.onContextMenu}
      className="flex-1 overflow-y-auto px-4 pb-4 pt-[calc(var(--topbar-h)+12px)]"
      style={{
        paddingBottom: bottomPadding ? bottomPadding + 41 : undefined,
        // Fade the transcript itself so no text survives at the clipped edge.
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 10px)',
        maskImage: 'linear-gradient(to bottom, transparent 0, black 10px)'
      }}
    >
      <div ref={contentRef} className="max-w-3xl mx-auto space-y-3">
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
              // across consecutive tool_call blocks.
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
            // Likewise a row taking over from a queued bubble that was sent.
            const suppressOptimisticReanimation =
              msg.role === 'user' &&
              (pendingUserMessage?.content === msg.content || queuedView.handsOver(msg.content))
            const shouldAnimate =
              msg.id === newMessageId &&
              !suppressStreamReanimation &&
              !suppressOptimisticReanimation
            const sourceAgentId = msg.role === 'assistant' ? msg.sourceAgentId ?? null : null
            const sourceAgentName =
              sourceAgentId && sourceAgentId !== rootAgentId
                ? agentNameById.get(sourceAgentId) ?? null
                : null
            // A system row carries the agent it was addressed to as well — a
            // handover's report is addressed to the agent that asked for it —
            // and that is the scope its file references resolve in.
            const addressedAgentId =
              msg.role === 'user' || msg.role === 'system' ? msg.addressedAgentId ?? null : null
            const addressedAgentName =
              addressedAgentId && addressedAgentId !== rootAgentId
                ? agentNameById.get(addressedAgentId) ?? null
                : null
            if (msg.role === 'assistant' && Array.isArray(parts) && parts.length > 0) {
              const { pairResultIdx, consumed } = pairCommandTools(parts)
              const cli = pairCinnaCliTools(parts)
              cli.consumed.forEach((index) => consumed.add(index))
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
                        const cliCall = cli.calls.get(idx)
                        if (cliCall) return <CinnaCliBlock key={k} command={cliCall.command} narration={p.text} results={cliCall.resultIndices.map((index) => parts[index])} animate={shouldAnimate} animateDelay={idx * 80} />
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
                          return <ThinkingBlock key={k} content={p.text} defaultExpanded animate={shouldAnimate} animateDelay={idx * 80} />
                        }
                        if (
                          p.kind === 'tool' &&
                          (isAskUserQuestionTool(p.toolName) || isPermissionRequestTool(p.toolName))
                        ) {
                          const dri = pairResultIdx.get(idx)
                          const block = renderRequestBlock(
                            k,
                            p,
                            msg.id === activeQuestionMsgId,
                            dri !== undefined ? parts[dri].text : undefined
                          )
                          if (block) return block
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
                          <FileRefContext.Provider key={k} value={fileRefScopeFor(sourceAgentId ?? rootAgentId)}>
                            <MessageBubble
                              role="assistant"
                              content={p.text}
                              animate={shouldAnimate}
                              animateDelay={idx * 80}
                              agentName={idx === 0 ? sourceAgentName : null}
                              agentId={sourceAgentId}
                            />
                          </FileRefContext.Provider>
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
                  const cliCall = cli.calls.get(idx)
                  if (cliCall) {
                    const results = cliCall.resultIndices.map((index) => parts[index])
                    renderNodes.push({
                      slot: 'collapsible',
                      item: {
                        key: k, kind: 'tool_narration', groupWhenAlone: true,
                        status: results.some((result) => result.toolStream === 'stderr') ? 'error' : 'done',
                        node: <CinnaCliBlock command={cliCall.command} narration={p.text} results={results} animate={shouldAnimate} animateDelay={idx * 80} />
                      }
                    })
                    return
                  }
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
                    // Never folded into a dots group: open, on its own, so it
                    // breaks a long run of tool dots into readable steps.
                    renderNodes.push({
                      slot: 'plain',
                      key: k,
                      node: <ThinkingBlock content={p.text} defaultExpanded animate={shouldAnimate} animateDelay={idx * 80} />
                    })
                  } else if (
                    p.kind === 'tool' &&
                    (isAskUserQuestionTool(p.toolName) || isPermissionRequestTool(p.toolName))
                  ) {
                    // Interactive prompt — never collapse it into a dots group;
                    // the user must be able to act on it directly.
                    renderNodes.push({
                      slot: 'plain',
                      key: k,
                      node: renderRequestBlock(
                        k,
                        p,
                        msg.id === activeQuestionMsgId,
                        pairResultIdx.get(idx) !== undefined
                          ? parts[pairResultIdx.get(idx) as number].text
                          : undefined
                      )
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
                        <FileRefContext.Provider value={fileRefScopeFor(sourceAgentId ?? rootAgentId)}>
                          <MessageBubble
                            role="assistant"
                            content={p.text}
                            animate={shouldAnimate}
                            animateDelay={idx * 80}
                            agentName={idx === 0 ? sourceAgentName : null}
                            agentId={sourceAgentId}
                          />
                        </FileRefContext.Provider>
                      )
                    })
                  }
                })
              }
              continue
            }
            // A `system` row is the desktop's own turn in the conversation — a
            // task runner's prompt, a handover's returned report. Without this
            // branch it reaches the tail below and is drawn as an assistant
            // bubble, which puts words in the agent's mouth.
            if (msg.role === 'system') {
              renderNodes.push({
                slot: 'plain',
                key: msg.id,
                node: (
                  <>
                    <FileRefContext.Provider value={fileRefScopeFor(addressedAgentId ?? rootAgentId)}>
                      <SystemTurnBlock content={msg.content} animate={shouldAnimate} />
                    </FileRefContext.Provider>
                    {footer}
                  </>
                )
              })
              continue
            }
            renderNodes.push({
              slot: 'plain',
              key: msg.id,
              node: (
                <>
                  <FileRefContext.Provider
                    value={fileRefScopeFor(
                      msg.role === 'user' ? addressedAgentId ?? rootAgentId : sourceAgentId ?? rootAgentId
                    )}
                  >
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
                  </FileRefContext.Provider>
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
              // Keep this prop set in lockstep with the persisted user bubble
              // above — any new user-turn prop must be added in both places.
              // `addressedAgent*` is intentionally null: the optimistic turn has
              // no persisted addressed-agent yet; it fills in on refetch.
              node: (
                <MessageBubble
                  role="user"
                  content={pendingUserMessage.content}
                  attachments={pendingUserMessage.attachments ?? null}
                  addressedAgentName={null}
                  addressedAgentId={null}
                  animate
                />
              )
            })
          }

          // While a sent queued bubble stands in for its row, the dots go below
          // it — where they will be once the row takes its place.
          if (isStreaming && !hasStreamingContent && !queuedView.holdsSent) {
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
              ? { kind: b.kind, toolId: b.toolId, commandInvocation: b.commandInvocation, toolName: b.toolName, toolInput: b.toolInput, toolStream: b.toolStream }
              : { kind: b.type }
          )
          const { pairResultIdx: streamPairResultIdx, consumed: streamConsumed } =
            pairCommandTools(streamingTextBlocks)
          const streamingCli = pairCinnaCliTools(streamingTextBlocks)
          streamingCli.consumed.forEach((index) => streamConsumed.add(index))
          streamingBlocks.forEach((block, i) => {
            const isLastBlock = i === streamingBlocks.length - 1
            if (streamConsumed.has(i)) return
            if (block.type === 'user') {
              // Sent while the turn ran and taken into it, where it landed. A
              // plain node, so it also splits a run of tool dots in two. One
              // taking over from a queued bubble main handed to the turn does
              // not pop in again: the bubble it replaces already did.
              renderNodes.push({
                slot: 'plain',
                key: `stream-user-${i}`,
                node: <LiveUserBubble content={block.content} animate={!queuedView.handsOver(block.content)} />
              })
              return
            }
            const cliCall = streamingCli.calls.get(i)
            if (cliCall && block.type === 'text') {
              const results = cliCall.resultIndices.flatMap((index) => {
                const result = streamingBlocks[index]
                return result.type === 'text' ? [{ text: result.content, toolStream: result.toolStream }] : []
              })
              const live = isStreaming && (!results.length || isLastBlock || cliCall.resultIndices.includes(streamingBlocks.length - 1))
              const key = `stream-cli-${i}`
              const node = <CinnaCliBlock command={cliCall.command} narration={block.content} results={results} isStreaming={live} />
              renderNodes.push(verboseMode ? { slot: 'plain', key, node } : {
                slot: 'collapsible',
                item: {
                  key, kind: 'tool_narration', groupWhenAlone: true, isLive: live,
                  status: results.some((result) => result.toolStream === 'stderr') ? 'error' : isStreaming && !results.length ? 'pending' : 'done',
                  node
                }
              })
              return
            }
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
                // Plain in both modes; compact opens it, as on the persisted
                // path, so the live → persisted swap does not close it.
                renderNodes.push({
                  slot: 'plain',
                  key: `stream-think-${i}`,
                  node: (
                    <ThinkingBlock
                      content={block.content}
                      isStreaming={live}
                      defaultExpanded
                    />
                  )
                })
                return
              }
              if (
                block.kind === 'tool' &&
                (isAskUserQuestionTool(block.toolName) || isPermissionRequestTool(block.toolName))
              ) {
                // A **cloud** agent's question arriving mid-stream is passive:
                // it becomes answerable only once the turn finishes and
                // persists, because the answer is the next user turn. A
                // **local** agent's is the opposite — the agent loop is parked
                // right now and the answer has to arrive while the turn is
                // still open — and `renderRequestBlock` tells them apart by
                // whether the registry still lists the request as pending or
                // the stream has announced it as a `reply` ask.
                // The outcome the runner recorded, paired above, goes in as
                // `decision` exactly as on the persisted path. Without it a
                // live ask settled by expiry or by another window lost its
                // buttons and said nothing about what happened, and collapsed
                // by the height of the button row.
                const dri = streamPairResultIdx.get(i)
                const decisionBlock = dri !== undefined ? streamingBlocks[dri] : undefined
                renderNodes.push({
                  slot: 'plain',
                  key: `stream-askq-${i}`,
                  node: renderRequestBlock(
                    `stream-askq-${i}`,
                    block,
                    false,
                    decisionBlock?.type === 'text' ? decisionBlock.content : undefined
                  )
                })
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
                // by default during streaming — unlike tool narration blocks
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

        {/* Sent while the turn runs, waiting for it to end. Inside the content
            box, so following the bottom keeps them in view. */}
        <QueuedMessages view={queuedView} />
        {isStreaming && !hasStreamingContent && queuedView.holdsSent && (
          <div className="flex gap-1 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>
    </div>
      {/* A sibling of the scroll container, never inside it: useStickToBottom
          observes those boxes, and a pill mounting inside them would resize
          → settle → re-render → resize. */}
      <TranscriptPills
        store={expansionStore}
        pinned={pinned}
        onCollapse={collapseExpanded}
        onJumpToLatest={scrollToBottom}
        bottomPadding={bottomPadding}
      />
      {messageContextMenu.menu}
    </TranscriptExpansionContext.Provider>
  )
}

/**
 * A user message the running turn took in. Whether it pops in is decided when
 * it mounts: the hand-over from a queued bubble is a single render, and an
 * animation class added on the render after would play the pop anyway.
 */
function LiveUserBubble({ content, animate }: { content: string; animate: boolean }): React.JSX.Element {
  const [animateOnMount] = useState(animate)
  return <MessageBubble role="user" content={content} animate={animateOnMount} />
}
