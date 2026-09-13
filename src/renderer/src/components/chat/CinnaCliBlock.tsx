import { Terminal } from 'lucide-react'
import type { ToolStream } from '../../../../shared/messageParts'
import { unwrapConsoleOutput } from '../../utils/consoleOutput'
import { DisclosureBlock } from './DisclosureBlock'

interface CinnaCliBlockProps {
  command: string
  results?: { text: string; toolStream?: ToolStream }[]
  narration?: string
  isStreaming?: boolean
  animate?: boolean
  animateDelay?: number
}

/** One command and its output, with no nested tool/argument/output cards. */
export function CinnaCliBlock({
  command, results = [], narration, isStreaming, animate, animateDelay
}: CinnaCliBlockProps): React.JSX.Element {
  const hasError = results.some((result) => result.toolStream === 'stderr')
  // ACP repeats "Bash: <command>" as narration. Preserve any actual explanation.
  const note = narration?.trim()
  const isEcho = !note || note === command || note.replace(/^(?:bash|shell):\s*/i, '') === command
  return (
    <DisclosureBlock
      icon={<Terminal size={12} className="shrink-0 text-[var(--color-accent)]" />}
      header={
        <span className="flex min-w-0 items-baseline gap-2 whitespace-normal">
          <span className="shrink-0 font-medium text-[var(--color-accent)]">Cinna CLI</span>{' '}
          <code className="min-w-0 text-xs text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">{command}</code>{' '}
          {hasError && <span className="shrink-0 font-medium text-[var(--color-danger)]">stderr</span>}
        </span>
      }
      tone={hasError ? 'error' : 'default'}
      defaultExpanded={false}
      isStreaming={isStreaming}
      animate={animate}
      animateDelay={animateDelay}
    >
      {!isEcho && <p className="px-3 pb-2 text-xs whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">{note}</p>}
      <div className="border-t border-[var(--color-border)]/40">
        {results.length ? <div className="max-h-96 overflow-auto px-3 py-2.5" tabIndex={0} role="region" aria-label="Cinna CLI output">
          {results.map((result, index) => (
            <pre key={index} className={`font-mono text-xs leading-[1.25] whitespace-pre ${result.toolStream === 'stderr' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`}>
              {unwrapConsoleOutput(result.text, isStreaming) || (isStreaming ? 'Waiting for output…' : 'No output.')}
            </pre>
          ))}
        </div> : <p className="px-3 py-2.5 text-xs text-[var(--color-text-muted)]">{isStreaming ? 'Waiting for output…' : 'No output recorded.'}</p>}
      </div>
    </DisclosureBlock>
  )
}
