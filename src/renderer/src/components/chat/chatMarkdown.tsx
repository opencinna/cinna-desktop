import type { Components, ExtraProps, Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { chatMarkdownComponents } from './fileRefs'
import { ChatTable } from './ChatTable'
import { ComponentCardList } from '../dashboards/ComponentCard'
import { COMPONENT_REFS_TAG, chatUrlTransform, componentRefItems, remarkComponentReferences } from '../dashboards/componentReferences'

/**
 * The one markdown configuration every chat message renders with
 * (`MessageBubble`, for a reply and for the user's own message): GFM, the
 * user's line breaks, file references and commands (`fileRefs`), tables
 * that can keep their header in view (`ChatTable`), and
 * component references as cards (`componentReferences`) with the
 * `urlTransform` that keeps their hrefs. Module-level, so identities never
 * change and the memoized renderer never re-parses for nothing.
 */

interface HastWithRefs {
  properties?: { dataRefs?: unknown }
}

/** The `cinna-component-refs` element the plugin leaves: the message's card list. */
function ComponentRefsElement({ node, ...props }: ExtraProps & { 'data-refs'?: unknown }): React.JSX.Element | null {
  const value = (node as HastWithRefs | undefined)?.properties?.dataRefs ?? props['data-refs']
  return <ComponentCardList items={componentRefItems(value)} />
}

export const chatMessageComponents = {
  ...chatMarkdownComponents,
  table: ChatTable,
  [COMPONENT_REFS_TAG]: ComponentRefsElement
} as Components

const settled = remarkComponentReferences
/** While a reply streams its last line may still grow, so it stays text until it ends. */
const streaming = (): ReturnType<typeof remarkComponentReferences> => remarkComponentReferences({ holdTail: true })

type PluggableList = NonNullable<Options['remarkPlugins']>

const PLUGINS: Record<'reply' | 'replyStreaming' | 'user', PluggableList> = {
  reply: [remarkGfm, settled],
  replyStreaming: [remarkGfm, streaming],
  user: [remarkGfm, remarkBreaks, settled]
}

export function chatRemarkPlugins({ breaks, streaming: isStreaming }: { breaks: boolean; streaming: boolean }): PluggableList {
  if (breaks) return PLUGINS.user
  return isStreaming ? PLUGINS.replyStreaming : PLUGINS.reply
}

export { chatUrlTransform }
