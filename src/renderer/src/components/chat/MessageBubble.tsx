import { memo, useContext, useMemo, useState } from 'react'
import { Info, Bot, ArrowRight, X, ClipboardList, ChevronDown } from 'lucide-react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { MetaPopup } from './MetaPopup'
import { CommandMessageContext, CommandScopeContext, FileRefContext, MessageIdContext, type CommandMessage } from './fileRefs'
import { chatMessageComponents, chatRemarkPlugins, chatUrlTransform } from './chatMarkdown'
import { ComponentRefScopeContext } from '../dashboards/ComponentCard'
import { repairNestedFences } from '../../utils/nestedFences'
import { useFrontmatter } from '../ui/FrontmatterTable'

/**
 * Memoized markdown renderer. Two reasons it's split out:
 *  - `React.memo` skips re-parsing when the surrounding transcript re-renders
 *    (e.g. a *different* message is streaming) but this bubble's content is
 *    unchanged.
 *  - `highlight={false}` drops `rehype-highlight` while a message is still
 *    streaming — re-highlighting every fenced block on every token is the main
 *    streaming-jank source, and highlighting an incomplete code block isn't
 *    useful anyway. The full pass runs once the turn finalizes.
 *
 * `breaks` turns a single newline into a line break. Only a user's message
 * gets it: they typed Shift+Enter for a new line and expect one, while a
 * model writes Markdown and relies on a lone newline being a soft wrap.
 *
 * Plugins, components and `urlTransform` are the chat's one shared
 * configuration (`chatMarkdown`), component references included.
 */
const MarkdownContent = memo(function MarkdownContent({
  content,
  highlight,
  breaks = false,
  streaming = false
}: {
  content: string
  highlight: boolean
  breaks?: boolean
  /** The reply is still arriving: its last line may still grow, so it is no card yet. */
  streaming?: boolean
}): React.JSX.Element {
  // A reply that quotes a file whole, or a pasted spec, opens with its
  // frontmatter; shown as a card rather than a rule over one bold heading.
  const { card, body } = useFrontmatter(content, 'mb-3')
  return (
    <>
      {card}
      <Markdown
        remarkPlugins={chatRemarkPlugins({ breaks, streaming })}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        components={chatMessageComponents}
        urlTransform={chatUrlTransform}
      >
        {body}
      </Markdown>
    </>
  )
})
import { useAgentColor } from '../../utils/agentColors'
import { AttachmentList, type AttachmentBadgeData } from './AttachmentBadge'
import { useFileDownload } from '../../hooks/useFileDownload'
import { useAttachmentOpen } from '../../hooks/useAttachmentOpen'
import { attachmentImageRef } from '../../utils/imageDataCache'
import { stripCinnaAttachTags } from '../../../../shared/cinnaAttach'
import { pasteLabel, pasteSizeLabel, splitPastes } from '../../../../shared/pastedText'
import { PastedTextPreviewModal } from './PastedTextPreviewModal'
import { useBubbleClamp } from './useBubbleClamp'

/**
 * A sent paste, one compact row inside the user bubble. Opens the preview
 * (Copy); a sent card never expands inline.
 */
function PasteCard({ text, onOpen }: { text: string; onOpen: () => void }): React.JSX.Element {
  const label = pasteLabel(text)
  const size = pasteSizeLabel(text)
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${label} (pasted text, ${size}) — click to preview`}
      aria-label={`Open pasted text ${label}`}
      data-testid="paste-card"
      className="flex items-center gap-1.5 max-w-full min-w-0 rounded-md border px-2 py-1 text-xs text-left
        border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 text-[var(--color-text-secondary)]
        hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
    >
      <ClipboardList size={13} className="shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 whitespace-nowrap text-[var(--color-text-muted)]">· {size}</span>
    </button>
  )
}

/**
 * A user bubble's content: its pastes as cards and its typed text as markdown,
 * in order, clamped with Show more / Show less when long (`useBubbleClamp`). A
 * message with no paste blocks renders exactly as it did before pastes.
 *
 * `data-message-markdown` carries what a whole-message Copy takes: the pastes'
 * raw text and the typed text, no tags.
 */
function UserMessageContent({
  content,
  markdown,
  animate
}: {
  content: string
  markdown: string
  animate?: boolean
}): React.JSX.Element {
  const segments = useMemo(() => {
    const split = splitPastes(content)
    return split.some((segment) => segment.kind === 'paste')
      ? split.map((segment) => (segment.kind === 'paste' ? segment : { ...segment, text: repairNestedFences(segment.text) }))
      : null
  }, [content])
  const readable = segments ? segments.map((segment) => segment.text).join('\n\n') : markdown
  const [preview, setPreview] = useState<string | null>(null)
  const clamp = useBubbleClamp()
  return (
    <>
      <div ref={clamp.boxRef} className="relative" style={clamp.boxStyle} onTransitionEnd={clamp.onTransitionEnd}>
        <div ref={clamp.contentRef} data-message-markdown={readable} className={animate ? 'anim-user-bubble-content' : ''}>
          {segments ? (
            <div className="flex flex-col items-start gap-1.5">
              {segments.map((segment, i) =>
                segment.kind === 'paste' ? (
                  <PasteCard key={i} text={segment.text} onOpen={() => setPreview(segment.text)} />
                ) : (
                  <div key={i} className="self-stretch">
                    <MarkdownContent content={segment.text} highlight breaks />
                  </div>
                )
              )}
            </div>
          ) : (
            <MarkdownContent content={markdown} highlight breaks />
          )}
        </div>
        {clamp.overflowing && !clamp.expanded && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--color-user-bubble)] to-transparent"
          />
        )}
      </div>
      {clamp.overflowing && (
        <button
          type="button"
          onClick={clamp.toggle}
          aria-expanded={clamp.expanded}
          className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium
            text-[var(--color-accent)] hover:underline"
        >
          <ChevronDown
            size={12}
            aria-hidden="true"
            className={`transition-transform duration-150 ${clamp.expanded ? 'rotate-180' : ''}`}
          />
          {clamp.expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {preview !== null && <PastedTextPreviewModal text={preview} onClose={() => setPreview(null)} />}
    </>
  )
}

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
  const colorOf = useAgentColor()
  const agentColor = agentId ? colorOf(agentId) : null
  const addressedColor = addressedAgentId ? colorOf(addressedAgentId) : null
  // Download state is store-backed (see fileDownload.store) — every bubble
  // reads from the same source so the spinner and error stay consistent
  // across the whole message stream. Each bubble only renders the error
  // label for its own attachments by matching `errorFileId`.
  const {
    isDownloading,
    error: downloadError,
    errorFileId,
    dismissError
  } = useFileDownload()
  const openAttachment = useAttachmentOpen()
  // File references link only once the message is persisted: a streaming
  // bubble renders plain inline code whatever scope surrounds it.
  const inheritedFileRefs = useContext(FileRefContext)
  // The persisted message an agent's reply renders, for the message menu's
  // Run items: main resolves the message's agent and folder from it.
  const messageId = useContext(MessageIdContext)
  const fileRefs = isStreaming ? null : inheritedFileRefs
  // A settled, persisted reply whose agent runs commands here: its commands are clickable.
  const commandScope = useContext(CommandScopeContext)
  const commandEntry = !isUser && !isStreaming && messageId ? commandScope?.messages.get(messageId) : undefined
  const commandChatId = commandScope?.chatId
  const commandAgentId = commandEntry?.agentId
  const commandFolder = commandEntry?.folder ?? null
  // Keyed on values, so a transcript refetch does not re-render every code span.
  const commandMessage = useMemo((): CommandMessage | null =>
    commandAgentId && commandChatId && messageId
      ? { chatId: commandChatId, messageId, agentId: commandAgentId, folder: commandFolder }
      : null,
  [commandAgentId, commandChatId, commandFolder, messageId])
  // One text for what the bubble shows and what Copy text / Save to Notes take,
  // so a copied snippet carries neither the model's broken nesting nor its
  // zero-width escapes (see `utils/nestedFences.ts`).
  const markdown = useMemo(
    () =>
      isUser
        ? repairNestedFences(content)
        : repairNestedFences(stripCinnaAttachTags(content, { streaming: isStreaming }), { streaming: isStreaming }),
    [content, isUser, isStreaming]
  )
  // A component reference resolves for the agent whose message it is: it wins a clash.
  const inheritedComponentScope = useContext(ComponentRefScopeContext)
  const messageAgentId = (isUser ? addressedAgentId : agentId) ?? null
  const componentScope = useMemo(
    () => (messageAgentId && messageAgentId !== inheritedComponentScope.agentId ? { ...inheritedComponentScope, agentId: messageAgentId } : inheritedComponentScope),
    [inheritedComponentScope, messageAgentId]
  )
  const downloadErrorForThisBubble =
    isUser && downloadError && attachments?.some((a) => a.id === errorFileId)
      ? downloadError
      : null

  if (isUser) {
    // A files-only message is its files: no empty pill above them.
    const showsPill = !!content.trim() || !!addressedAgentName || !attachments?.length
    return (
      <div className="flex flex-col items-end gap-1">
        {showsPill && <div className="relative group max-w-[80%]">
          <div
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed markdown-body bg-[var(--color-user-bubble)] [--table-under:var(--color-user-bubble)] text-[var(--color-text)] ${animate ? 'anim-user-bubble-pop' : ''}`}
          >
            <FileRefContext.Provider value={fileRefs}>
              <ComponentRefScopeContext.Provider value={componentScope}>
                <UserMessageContent content={content} markdown={markdown} animate={animate} />
              </ComponentRefScopeContext.Provider>
            </FileRefContext.Provider>
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
        </div>}
        {attachments && attachments.length > 0 && (
          <AttachmentList
            attachments={attachments}
            variant="message"
            align="right"
            onClick={(a) => openAttachment(a)}
            isLoading={isDownloading}
            previewsOnClick
            thumbnailFor={attachmentImageRef}
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
        data-message-markdown={markdown}
        data-message-id={!isStreaming && messageId ? messageId : undefined}
        className={`text-sm leading-relaxed markdown-body text-[var(--color-text)] ${animate ? 'anim-assistant-bubble' : ''}`}
        style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
      >
        {/* Strip any `<cinna_attach>` tag the agent streamed raw — the file is
            rendered as a separate badge. Streaming pass also hides partial tags
            mid-stream so no fragment flashes before the turn finalizes. */}
        <FileRefContext.Provider value={fileRefs}>
          <CommandMessageContext.Provider value={commandMessage}>
            <ComponentRefScopeContext.Provider value={componentScope}>
              <MarkdownContent content={markdown} highlight={!isStreaming} streaming={!!isStreaming} />
            </ComponentRefScopeContext.Provider>
          </CommandMessageContext.Provider>
        </FileRefContext.Provider>
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
