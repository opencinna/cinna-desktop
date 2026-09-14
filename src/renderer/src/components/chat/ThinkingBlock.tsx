import { useLayoutEffect, useRef } from 'react'
import { Brain } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '../../utils/markdownComponents'
import { DisclosureBlock } from './DisclosureBlock'

interface ThinkingBlockProps {
  content: string
  isStreaming?: boolean
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

/** How close to its bottom the box must be to keep following new thinking. */
const FOLLOW_SLACK_PX = 8

export function ThinkingBlock({
  content,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: ThinkingBlockProps): React.JSX.Element {
  return (
    <DisclosureBlock
      icon={<Brain size={11} className="shrink-0" />}
      header={<span className="font-medium">Thinking</span>}
      isStreaming={isStreaming}
      defaultExpanded={defaultExpanded}
      animate={animate}
      animateDelay={animateDelay}
    >
      <ThinkingBody content={content} isStreaming={isStreaming} />
    </DisclosureBlock>
  )
}

/**
 * Capped at about twelve lines with its own scroll: thinking opens by default,
 * and a long one was taller than the whole viewport at the minimum window
 * size. While it streams the box follows its newest line, unless the user has
 * scrolled it up to read.
 */
function ThinkingBody({ content, isStreaming }: { content: string; isStreaming?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && isStreaming && followRef.current) el.scrollTop = el.scrollHeight
  }, [content, isStreaming])
  return (
    <div
      ref={ref}
      data-thinking-body
      onScroll={(event) => {
        const el = event.currentTarget
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
      }}
      className="max-h-60 overflow-y-auto px-3 pb-2.5 pt-0 text-[12.5px] leading-relaxed italic
        text-[var(--color-text-secondary)] markdown-body opacity-80"
    >
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
    </div>
  )
}
