import { Terminal, AlertTriangle } from 'lucide-react'
import type { ToolStream } from '../../../../shared/messageParts'
import { DisclosureBlock } from './DisclosureBlock'

interface ToolResultBlockProps {
  content: string
  toolStream?: ToolStream
  isStreaming?: boolean
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

export function ToolResultBlock({
  content,
  toolStream,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: ToolResultBlockProps): React.JSX.Element {
  const isErr = toolStream === 'stderr'

  return (
    <DisclosureBlock
      tone={isErr ? 'error' : 'default'}
      icon={
        isErr ? (
          <AlertTriangle size={11} className="shrink-0" />
        ) : (
          <Terminal size={11} className="shrink-0" />
        )
      }
      header={<span className="font-medium">{isErr ? 'stderr' : 'Output'}</span>}
      isStreaming={isStreaming}
      defaultExpanded={defaultExpanded}
      animate={animate}
      animateDelay={animateDelay}
    >
      {content && (
        <pre
          className={`px-3 pb-2.5 pt-0 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto ${
            isErr ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
          }`}
        >
          {content}
        </pre>
      )}
    </DisclosureBlock>
  )
}
