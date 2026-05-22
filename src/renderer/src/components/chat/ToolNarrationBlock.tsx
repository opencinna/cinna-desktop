import { useState } from 'react'
import { Wrench, ChevronRight } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '../../utils/markdownComponents'
import { useUIStore } from '../../stores/ui.store'
import { ToolCallSummary } from './ToolCallSummary'

interface ToolNarrationBlockProps {
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  /**
   * Slash invocation from `cinna.command_invocation` when this tool part was
   * synthesized to wrap a `/run:*` execution. Drives narration-echo
   * suppression: the backend echoes the bare invocation as the text payload,
   * which is redundant once the parent CommandToolFrame already shows it.
   */
  commandInvocation?: string
  isStreaming?: boolean
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

export function ToolNarrationBlock({
  content,
  toolName,
  toolInput,
  commandInvocation,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: ToolNarrationBlockProps): React.JSX.Element {
  const verboseMode = useUIStore((s) => s.verboseMode)
  const [expanded, setExpanded] = useState(defaultExpanded ?? !!isStreaming)
  const hasStructured = !!(toolName && toolInput)
  // Compact mode hides structured args in the always-visible header; the
  // expanded body still shows full detail when the user clicks through.
  const showStructuredHeader = hasStructured && verboseMode
  // Backend echoes the bare slash-command invocation (e.g. "/run:foo") as the
  // tool's narration text when the call originates from a cinna-core command.
  // The parent CommandToolFrame already shows the invocation in its header, so
  // render it here would be pure noise — suppress when content is *only* a
  // slash slug. Marker-driven when present; regex fallback covers historic
  // messages persisted before the backend added the metadata. The fallback
  // requires the `/word:word` colon-separated shape so it matches `/run:foo`
  // but NOT generic paths like `/etc/hosts` or `/usr/local/bin` that an LLM
  // might legitimately narrate as a single line.
  const isSlashCommandEcho =
    !!content &&
    ((!!commandInvocation && content.trim() === commandInvocation) ||
      /^\s*\/[\w\-]+:[\w\-.]+\s*$/.test(content))
  const showContent = !!content && !isSlashCommandEcho

  return (
    <div
      className={`rounded-lg border transition-colors duration-200 ${
        expanded
          ? 'border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/40'
          : 'border-transparent bg-transparent'
      } ${animate ? 'anim-assistant-bubble' : ''}`}
      style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]
          text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
          transition-colors min-w-0 text-left"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <Wrench size={11} className="shrink-0" />
        <span className="flex-1 min-w-0 truncate">
          {showStructuredHeader ? (
            <ToolCallSummary name={toolName!} input={toolInput} variant="inline" />
          ) : toolName ? (
            <>
              <span className="font-medium">Tool: </span>
              <span className="font-mono">{toolName}</span>
            </>
          ) : (
            <span className="font-medium">Tool</span>
          )}
        </span>
        {isStreaming && (
          <span className="ml-1 inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0" />
        )}
      </button>
      {expanded && (
        <div
          className="px-3 pb-2.5 pt-0 text-[12.5px] leading-relaxed
            text-[var(--color-text-secondary)] markdown-body opacity-90 space-y-2"
        >
          {hasStructured && (
            <div className="rounded border border-[var(--color-border)]/60 bg-[var(--color-bg)] p-2">
              <ToolCallSummary name={toolName!} input={toolInput} variant="block" />
            </div>
          )}
          {/* Keep the model's narration text below the structured summary so
              the user can still read any surrounding prose. */}
          {showContent && (
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
          )}
        </div>
      )}
    </div>
  )
}
