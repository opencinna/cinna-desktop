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
      <div
        className="px-3 pb-2.5 pt-0 text-[12.5px] leading-relaxed italic
          text-[var(--color-text-secondary)] markdown-body opacity-80"
      >
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
      </div>
    </DisclosureBlock>
  )
}
