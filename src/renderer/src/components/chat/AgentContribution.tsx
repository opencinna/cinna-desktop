import { Bot, CornerDownRight } from 'lucide-react'
import type { MessagePart } from '../../../../shared/messageParts'
import { presetForAgentId } from '../../utils/agentColors'
import { MessageBubble } from './MessageBubble'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { ToolResultBlock } from './ToolResultBlock'
import { CommandResultBlock } from './CommandResultBlock'

interface AgentContributionProps {
  /** The agent's full-fidelity parts (thinking / tool / tool_result / text). */
  parts: MessagePart[]
  /** Drives the optional name label + hash color. */
  agentId?: string | null
  /** When set, render a Bot + name label above the parts (switchboard reuse). */
  agentName?: string | null
  /**
   * The orchestrator-authored task message — rendered as the first line of the
   * sub-thread ("the ask that went to the agent").
   */
  askMessage?: string
  /** Show a streaming cursor on the last part. */
  isStreaming?: boolean
}

/**
 * Renders an agent's contribution to a conversation: an optional name label
 * (hash-derived color) plus its `parts[]` rendered with the same block
 * components the direct-chat transcript uses (thinking / tool / tool_result /
 * text / command_result). Reusable in two placements — top-level in the
 * switchboard transcript, or nested inside an orchestrated tool-call block via
 * {@link AgentToolSubThread}. Pure presentational; identity/color is the only
 * thing that ties a contribution to its agent.
 */
export function AgentContribution({
  parts,
  agentId,
  agentName,
  askMessage,
  isStreaming
}: AgentContributionProps): React.JSX.Element {
  const color = agentName || agentId ? presetForAgentId(agentId ?? agentName ?? '') : null
  const lastIdx = parts.length - 1

  return (
    <div className="space-y-2">
      {agentName && (
        <div
          className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide"
          style={{ color: color?.border ?? 'var(--color-text-muted)' }}
        >
          <Bot size={10} />
          <span>{agentName}</span>
        </div>
      )}

      {askMessage && (
        <div className="flex items-start gap-1 text-[11px] text-[var(--color-text-muted)] italic">
          <CornerDownRight size={11} className="mt-0.5 shrink-0" />
          <span className="break-words whitespace-pre-wrap">{askMessage}</span>
        </div>
      )}

      {parts.map((p, idx) => {
        const k = `part-${idx}`
        const live = isStreaming && idx === lastIdx
        if (p.kind === 'thinking') {
          return <ThinkingBlock key={k} content={p.text} isStreaming={live} defaultExpanded={false} />
        }
        if (p.kind === 'tool') {
          return (
            <ToolNarrationBlock
              key={k}
              content={p.text}
              toolName={p.toolName}
              toolInput={p.toolInput}
              isStreaming={live}
              defaultExpanded={false}
            />
          )
        }
        if (p.kind === 'tool_result') {
          return (
            <ToolResultBlock
              key={k}
              content={p.text}
              toolStream={p.toolStream}
              isStreaming={live}
              defaultExpanded={false}
            />
          )
        }
        if (p.kind === 'command_result') {
          return (
            <CommandResultBlock
              key={k}
              content={p.text}
              commandInvocation={p.commandInvocation}
              isStreaming={live}
            />
          )
        }
        return <MessageBubble key={k} role="assistant" content={p.text} isStreaming={live} />
      })}
    </div>
  )
}
