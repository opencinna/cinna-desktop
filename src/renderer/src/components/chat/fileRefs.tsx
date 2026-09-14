import { createContext, useContext, useEffect, type ComponentProps, type ReactNode } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import { stripCinnaAttachTags } from '../../../../shared/cinnaAttach'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { markdownComponents } from '../../utils/markdownComponents'
import { useAgentFileRefs, type FileRefScope } from '../../hooks/useAgentFileRefs'

export type { FileRefScope }

/**
 * The resolved file references for the bubble being rendered, or null where
 * nothing may link: outside a folder agent's chat, and while streaming.
 */
export const FileRefContext = createContext<FileRefScope | null>(null)

/** True inside a fenced block: a `code` there is never a reference. */
const InsidePreContext = createContext(false)

function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children
  if (Array.isArray(children) && children.every((child) => typeof child === 'string')) {
    return children.join('')
  }
  return null
}

/** react-markdown 10 has no `inline` prop; a `pre` tells its `code` instead. */
function MarkdownPre({ node: _node, children, ...props }: ComponentProps<'pre'> & ExtraProps): React.JSX.Element {
  return (
    <InsidePreContext.Provider value={true}>
      <pre {...props}>{children}</pre>
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
  const scope = useContext(FileRefContext)
  const text = textOf(children)
  const ref = !insidePre && scope && text !== null ? scope.refs.get(text) : undefined
  if (!scope || !ref || text === null) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }
  const activate = (origin: { x: number; y: number } | null): void => {
    void useFilePreviewStore.getState().openAgentFile(scope.agentId, ref, origin)
  }
  return (
    <code
      {...props}
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

/** The chat bubble's markdown components: module-level, so their identity never changes. */
export const chatMarkdownComponents: Components = {
  ...markdownComponents,
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
 * through `MessageBubble` — the text parts of a turn, with attach tags stripped.
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
      texts = [message.content]
    } else if (message.role === 'assistant') {
      agentId = message.sourceAgentId ?? rootAgentId
      texts =
        Array.isArray(message.parts) && message.parts.length > 0
          ? message.parts
              .filter((part) => part.kind === 'text' || part.kind === 'notice')
              .map((part) => stripCinnaAttachTags(part.text))
          : [stripCinnaAttachTags(message.content)]
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
