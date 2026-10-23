import { createContext, useContext, useEffect, useMemo, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import { stripCinnaAttachTags } from '../../../../shared/cinnaAttach'
import type { AgentFileRef } from '../../../../shared/agentFiles'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { markdownComponents } from '../../utils/markdownComponents'
import { useAgentFileRefs, type FileRefScope } from '../../hooks/useAgentFileRefs'
import { repairNestedFences } from '../../utils/nestedFences'
import { artifactIdFromUrl } from '../../../../shared/artifacts'
import { ArtifactLinkCard } from '../artifacts/ArtifactCard'
import { detectCommand } from '../../../../shared/commandRun'
import { useRunScriptStore } from '../../stores/runScript.store'

export type { FileRefScope }

/**
 * The resolved file references (spans and links) for the bubble being rendered, or null where
 * nothing may link: outside a folder agent's chat, and while streaming.
 */
export const FileRefContext = createContext<FileRefScope | null>(null)

/**
 * The persisted message a bubble renders, or null (a live or optimistic
 * bubble). A reference remembers it, so what is published from it can show
 * its card right after that message.
 */
export const MessageIdContext = createContext<string | null>(null)

/**
 * Which persisted replies of the chat may have their commands run here (an
 * assistant message whose agent `agentRunsCommands`), by message id, with
 * the agent and its folder as far as the renderer knows them. Provided by
 * the transcript; null outside one.
 */
export interface CommandScope {
  chatId: string
  messages: ReadonlyMap<string, { agentId: string; folder: string | null }>
}
export const CommandScopeContext = createContext<CommandScope | null>(null)

/** The reply a bubble renders, when its commands are clickable: set by `MessageBubble` for a persisted, settled reply only. */
export interface CommandMessage {
  chatId: string
  messageId: string
  agentId: string
  folder: string | null
}
export const CommandMessageContext = createContext<CommandMessage | null>(null)

/** Open the Run Script window on a command: from the click point, or the centre after Enter or Space. */
function openRunScript(target: CommandMessage, command: string, origin: { x: number; y: number } | null): void {
  void useRunScriptStore.getState().openFromCode({ ...target, command, origin })
}

/** A click or a key on a command: what it opens with, or null for neither. */
function commandActivation(event: MouseEvent<HTMLElement>): { x: number; y: number } | null | false {
  // Ending a selection inside it is not a request to run it.
  if (window.getSelection()?.toString()) return false
  // The second click of a double-click: the first already opened it.
  if (event.detail > 1) return false
  return event.detail > 0 ? { x: event.clientX, y: event.clientY } : null
}

function commandKey(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return false
  event.preventDefault()
  return true
}

/** The reference a rendered `code.file-ref` or `a.file-link` stands for, and whose folder it resolved in. */
export interface FileRefTarget {
  agentId: string
  ref: AgentFileRef
  /** The message it was rendered in, when that message is persisted. */
  messageId?: string | null
}

/**
 * Rendered reference spans → what they name, for the transcript's context
 * menu, which starts from the DOM node a right-click landed on. Weak, so a
 * span that unmounts takes its entry with it.
 */
const fileRefTargets = new WeakMap<Element, FileRefTarget>()

/** The reference `element` renders, or null for any other element. */
export function fileRefTargetOf(element: Element): FileRefTarget | null {
  return fileRefTargets.get(element) ?? null
}

/** Open the preview; the message is passed on only when the bubble is a persisted one. */
function openPreview(agentId: string, ref: AgentFileRef, origin: { x: number; y: number } | null, messageId: string | null): void {
  const store = useFilePreviewStore.getState()
  void (messageId ? store.openAgentFile(agentId, ref, origin, messageId) : store.openAgentFile(agentId, ref, origin))
}

/** True inside a fenced block: a `code` there is never a reference. */
const InsidePreContext = createContext(false)

/**
 * True inside a rendered anchor: a `code` there is never a reference either,
 * or a click on ``[`out.csv`](/abs/out.csv)`` would act twice — once for the
 * span and once for the link.
 */
const InsideLinkContext = createContext(false)

function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children
  if (Array.isArray(children) && children.every((child) => typeof child === 'string')) {
    return children.join('')
  }
  return null
}

interface HastLike {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastLike[]
}

/** A hast node's text: highlighting splits a block into spans, so the text is read from the tree. */
function hastText(node: HastLike): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

/** A fenced block's text (without the fence's trailing newline) and language, from its `code` child; null for any other `pre`. */
function fencedBlock(node: HastLike | undefined): { text: string; lang: string | null } | null {
  const code = node?.children?.find((child) => child.type === 'element')
  if (!code || code.tagName !== 'code') return null
  const classes = code.properties?.className
  const list = Array.isArray(classes) ? classes.map(String) : typeof classes === 'string' ? classes.split(/\s+/) : []
  const lang = list.find((name) => name.startsWith('language-'))?.slice('language-'.length).toLowerCase() ?? null
  return { text: hastText(code).replace(/\n$/, ''), lang }
}

/**
 * react-markdown 10 has no `inline` prop; a `pre` tells its `code` instead.
 *
 * In a reply whose commands may run here, a fenced block holding a command
 * is clickable as a whole: it opens the Run Script window, nothing runs. Its
 * box stays the code block's (`pre.command-ref` only tints it), so nothing
 * moves. A click that ends a selection inside it opens nothing.
 */
function MarkdownPre({ node, children, className, ...props }: ComponentProps<'pre'> & ExtraProps): React.JSX.Element {
  const target = useContext(CommandMessageContext)
  const block = target ? fencedBlock(node as HastLike | undefined) : null
  const text = block?.text ?? null
  const lang = block?.lang ?? null
  // Detection runs once per block text, and only in a reply that may run commands.
  const command = useMemo(() => (text === null ? null : detectCommand(text, { fenced: true, lang })), [text, lang])
  if (!target || command === null) {
    return (
      <InsidePreContext.Provider value={true}>
        <pre className={className} {...props}>{children}</pre>
      </InsidePreContext.Provider>
    )
  }
  return (
    <InsidePreContext.Provider value={true}>
      <pre
        {...props}
        className={className ? `${className} command-ref` : 'command-ref'}
        role="button"
        tabIndex={0}
        title="Run…"
        aria-label={`Run… ${command.split('\n')[0]}`}
        onClick={(event) => {
          const origin = commandActivation(event)
          if (origin !== false) openRunScript(target, command, origin)
        }}
        onKeyDown={(event) => {
          if (commandKey(event)) openRunScript(target, command, null)
        }}
      >
        {children}
      </pre>
    </InsidePreContext.Provider>
  )
}

/** A folder's tooltip ends in `/`, so it does not read as a file of that name. */
function folderTitle(displayPath: string): string {
  return displayPath.endsWith('/') ? displayPath : `${displayPath}/`
}

/**
 * Inline code, clickable when its text resolved to a file or folder.
 *
 * A `<code role="button">` rather than a `<button>`, which would not wrap
 * inside a paragraph. A click opens the preview from the click point; Enter
 * and Space open it from the modal's centre. A folder is revealed instead.
 */
function MarkdownCode({ node: _node, children, className, ...props }: ComponentProps<'code'> & ExtraProps): React.JSX.Element {
  const insidePre = useContext(InsidePreContext)
  const insideLink = useContext(InsideLinkContext)
  const scope = useContext(FileRefContext)
  const messageId = useContext(MessageIdContext)
  const commandTarget = useContext(CommandMessageContext)
  const text = textOf(children)
  const ref = !insidePre && !insideLink && scope && text !== null ? scope.refs.get(text) : undefined
  // A span that is not a file reference may be a command; detected once per text, only where commands may run.
  const commandText = !ref && !insidePre && !insideLink && commandTarget ? text : null
  const command = useMemo(() => (commandText === null ? null : detectCommand(commandText, { fenced: false })), [commandText])
  if (command !== null && commandTarget) {
    return (
      <code
        {...props}
        className={className ? `${className} command-ref` : 'command-ref'}
        role="button"
        tabIndex={0}
        title="Run…"
        aria-label={`Run… ${command}`}
        onClick={(event) => {
          const origin = commandActivation(event)
          if (origin !== false) openRunScript(commandTarget, command, origin)
        }}
        onKeyDown={(event) => {
          if (commandKey(event)) openRunScript(commandTarget, command, null)
        }}
      >
        {children}
      </code>
    )
  }
  if (!scope || !ref || text === null) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }
  const activate = (origin: { x: number; y: number } | null): void => {
    openPreview(scope.agentId, ref, origin, messageId)
  }
  return (
    <code
      {...props}
      ref={(element) => {
        if (!element) return
        fileRefTargets.set(element, { agentId: scope.agentId, ref, messageId })
        return () => void fileRefTargets.delete(element)
      }}
      className={className ? `${className} file-ref` : 'file-ref'}
      role="button"
      tabIndex={0}
      aria-label={ref.kind === 'dir' ? `Show ${text} in its folder` : `Preview ${text}`}
      title={ref.kind === 'dir' ? folderTitle(ref.displayPath) : ref.displayPath}
      onClick={(event) => {
        // Selecting part of a path is not a request to open it.
        if (window.getSelection()?.toString()) return
        // The second click of a double-click: the first already opened it.
        if (event.detail > 1) return
        activate(event.detail > 0 ? { x: event.clientX, y: event.clientY } : null)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        activate(null)
      }}
    >
      {children}
    </code>
  )
}

const EXTERNAL_HREF = /^https?:\/\//i

/**
 * A markdown link. `http(s)` opens in the browser, as everywhere else. A link
 * whose `href` resolved to a file or folder in the agent's folder opens the
 * preview, like a reference span, and never navigates. Anything else — no
 * scope (a plain chat, or still streaming), a path that did not resolve,
 * `mailto:` — is its text with the `href` as a tooltip, as a document link
 * is: `setWindowOpenHandler` would drop it, so it must not look clickable.
 *
 * The resolved link is styled as an ordinary link (`a.file-link`), so the
 * span → link swap when resolution lands moves nothing.
 */
function MarkdownLink({ node: _node, children, href, ...props }: ComponentProps<'a'> & ExtraProps): React.JSX.Element {
  const scope = useContext(FileRefContext)
  const messageId = useContext(MessageIdContext)
  if (href && EXTERNAL_HREF.test(href)) {
    const link = (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
      </a>
    )
    // Core's page for an artifact (`/artifact/<uuid>`) on the profile's own
    // server or frontend renders as its card once main has read it; any
    // other host, and any failure, is this link.
    return artifactIdFromUrl(href) ? <ArtifactLinkCard href={href} link={link} /> : link
  }
  const ref = scope && href ? scope.links.get(href) : undefined
  if (!scope || !ref || !href) return <span title={href || undefined}>{children}</span>
  const label = textOf(children) ?? ref.displayPath
  const activate = (origin: { x: number; y: number } | null): void => {
    openPreview(scope.agentId, ref, origin, messageId)
  }
  return (
    <a
      {...props}
      ref={(element) => {
        if (!element) return
        fileRefTargets.set(element, { agentId: scope.agentId, ref, messageId })
        return () => void fileRefTargets.delete(element)
      }}
      href={href}
      className="file-link"
      role="button"
      aria-label={ref.kind === 'dir' ? `Show ${label} in its folder` : `Preview ${label}`}
      title={ref.kind === 'dir' ? folderTitle(ref.displayPath) : ref.displayPath}
      onClick={(event) => {
        // A local href must never navigate the window or reach the browser.
        event.preventDefault()
        // Selecting part of a link is not a request to open it.
        if (window.getSelection()?.toString()) return
        // The second click of a double-click: the first already opened it.
        if (event.detail > 1) return
        // Enter on an anchor arrives here as a click with no detail.
        activate(event.detail > 0 ? { x: event.clientX, y: event.clientY } : null)
      }}
      // A middle-click would open the href in a new window.
      onAuxClick={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // Enter is the anchor's own click (above); Space is the button role's.
        if (event.key !== ' ') return
        event.preventDefault()
        activate(null)
      }}
    >
      <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    </a>
  )
}

/** The chat bubble's markdown components: module-level, so their identity never changes. */
export const chatMarkdownComponents: Components = {
  ...markdownComponents,
  a: MarkdownLink,
  pre: MarkdownPre,
  code: MarkdownCode
}

interface FileRefMessage {
  role: string
  content: string
  parts?: ReadonlyArray<{ kind: string; text: string }> | null
  sourceAgentId?: string | null
  addressedAgentId?: string | null
}

interface FileRefAgent {
  id: string
  capabilities?: { cwd?: boolean } | null
}

/**
 * The persisted markdown each folder agent's references are resolved over, in
 * transcript order: an assistant row under `sourceAgentId ?? rootAgentId`, a
 * user row under `addressedAgentId ?? rootAgentId`, and only agents that run
 * in a folder (`capabilities.cwd`). Mirrors what the transcript renders
 * through `MessageBubble` — the text parts of a turn, with attach tags stripped
 * and nested fences repaired, so a path in prose a broken fence would have
 * swallowed is still resolved.
 */
export function collectFileRefSources(
  messages: readonly FileRefMessage[] | undefined,
  agents: readonly FileRefAgent[] | undefined,
  rootAgentId: string | null
): Map<string, string[]> {
  const sources = new Map<string, string[]>()
  const folderAgents = new Set((agents ?? []).filter((a) => a.capabilities?.cwd === true).map((a) => a.id))
  if (folderAgents.size === 0) return sources
  for (const message of messages ?? []) {
    let agentId: string | null
    let texts: string[]
    if (message.role === 'user') {
      agentId = message.addressedAgentId ?? rootAgentId
      texts = [repairNestedFences(message.content)]
    } else if (message.role === 'assistant') {
      agentId = message.sourceAgentId ?? rootAgentId
      texts =
        Array.isArray(message.parts) && message.parts.length > 0
          ? message.parts
              .filter((part) => part.kind === 'text' || part.kind === 'notice')
              .map((part) => repairNestedFences(stripCinnaAttachTags(part.text)))
          : [repairNestedFences(stripCinnaAttachTags(message.content))]
    } else {
      continue
    }
    if (!agentId || !folderAgents.has(agentId)) continue
    const list = sources.get(agentId) ?? []
    list.push(...texts)
    sources.set(agentId, list)
  }
  return sources
}

/**
 * Resolves the transcript's references and reports them upward. A sibling of
 * the transcript rather than a wrapper, so mounting it when the first folder
 * agent appears never remounts the bubbles.
 */
export function FileRefResolver({
  sources,
  onChange
}: {
  sources: ReadonlyMap<string, readonly string[]>
  onChange: (scopes: ReadonlyMap<string, FileRefScope>) => void
}): null {
  const scopes = useAgentFileRefs(sources)
  useEffect(() => {
    onChange(scopes)
  }, [scopes, onChange])
  useEffect(() => () => onChange(new Map()), [onChange])
  return null
}
