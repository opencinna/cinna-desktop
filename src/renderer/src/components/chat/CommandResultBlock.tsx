import { Terminal } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { markdownComponents } from '../../utils/markdownComponents'

interface CommandResultBlockProps {
  content: string
  /**
   * Verbatim slash invocation (`cinna.command_invocation` from the backend).
   * When present, drives the header text "Command: <invocation>" so the user
   * sees the slug they typed rather than the generic "Command output" label.
   */
  commandInvocation?: string
  isStreaming?: boolean
  animate?: boolean
  animateDelay?: number
}

/**
 * Renders a `cinna.content_kind: 'command_result'` part — the synchronous
 * output of a platform slash-command (`/files`, `/agent-status`,
 * `/run:<name>`). This IS the assistant turn for that user message — the
 * agent stream did not run — so it's shown inline, default-expanded, but
 * visually distinct from a normal assistant bubble so the user can tell
 * they're looking at platform output, not an LLM voice.
 */
export function CommandResultBlock({
  content,
  commandInvocation,
  isStreaming,
  animate,
  animateDelay
}: CommandResultBlockProps): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border border-[var(--color-border)]/60 bg-[var(--color-bg-secondary)]/50 ${animate ? 'anim-assistant-bubble' : ''}`}
      style={animate && animateDelay ? { animationDelay: `${animateDelay}ms` } : undefined}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]
          text-[var(--color-text-muted)] border-b border-[var(--color-border)]/40"
      >
        <Terminal size={11} />
        <span className="font-medium">
          {commandInvocation ? (
            <>
              Command: <span className="font-mono">{commandInvocation}</span>
            </>
          ) : (
            'Command output'
          )}
        </span>
        {isStreaming && (
          <span className="ml-1 inline-block w-1 h-1 rounded-full bg-[var(--color-accent)] animate-pulse" />
        )}
      </div>
      <div className="px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text)] markdown-body max-h-[60vh] overflow-y-auto">
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
          {content}
        </Markdown>
      </div>
    </div>
  )
}
