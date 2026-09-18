import { Inbox } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '../../utils/markdownComponents'
import { DisclosureBlock } from './DisclosureBlock'

interface SystemTurnBlockProps {
  /** The system row's whole content, Markdown as the desktop wrote it. */
  content: string
  animate?: boolean
}

/** How much of the first line the accessible name carries. */
const HEADER_CAP = 80

/**
 * A `system` row: a turn the **desktop** put into the conversation, not a
 * person and not an agent.
 *
 * Two things write one today — an autonomous task runner's prompt, and a file
 * handover's report coming back to the chat that asked for it — and until now
 * both fell through to the transcript's generic tail and rendered as an
 * assistant bubble. That is the bug this fixes: a message nobody in the
 * conversation said, looking exactly like the agent saying it.
 *
 * So it reads as chrome rather than as speech: the chat collapsible-block
 * pattern (flat when collapsed, card only when open), collapsed by default
 * because the interesting thing in the chat is what the agent did with it, and
 * a header that is the row's own first line so the collapsed state still says
 * what arrived.
 */
export function SystemTurnBlock({ content, animate }: SystemTurnBlockProps): React.JSX.Element {
  return (
    <DisclosureBlock
      icon={<Inbox size={11} className="shrink-0" />}
      // One text node, not two styled ones: the accessible name of a button is
      // its element texts *trimmed* and then joined, so a two-span header is
      // announced as "Cinna Desktop· the first line" with the separator glued to
      // the label. The weight is uniform instead, as the sibling blocks' is.
      header={<span className="font-medium">{headerLabel(content)}</span>}
      animate={animate}
    >
      <div
        className="px-3 pb-2.5 pt-0 text-[12.5px] leading-relaxed
          text-[var(--color-text-secondary)] markdown-body opacity-90"
      >
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
      </div>
    </DisclosureBlock>
  )
}

/** `Cinna Desktop · <first line>`, or the name alone for a row with no text. */
function headerLabel(content: string): string {
  const line = headerLine(content)
  return line ? `Cinna Desktop · ${line}` : 'Cinna Desktop'
}

/**
 * The first line, as a label: Markdown heading marks and list bullets stripped,
 * because a header reading `## Handover report` shows the syntax rather than
 * the sentence. Capped so the accessible name stays a name; the visible span
 * truncates on width as well.
 */
function headerLine(content: string): string {
  const first = content.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  const plain = first.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim()
  return plain.length > HEADER_CAP ? `${plain.slice(0, HEADER_CAP - 1)}…` : plain
}
