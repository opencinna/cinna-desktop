import { Bot, CornerDownRight } from 'lucide-react'
import type { MessagePart } from '../../../../shared/messageParts'
import { presetForAgentId } from '../../utils/agentColors'
import { MessageBubble } from './MessageBubble'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { ToolResultBlock } from './ToolResultBlock'
import { CommandResultBlock } from './CommandResultBlock'
import { AgentAttachment } from './AgentAttachment'
import { type RenderNode, groupConsecutiveCollapsibles } from './CollapsibleGroup'

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
  /**
   * Verbose mode renders every part inline; compact (default) folds runs of
   * consecutive auxiliary blocks (thinking / tool / tool_result) into a dots
   * group — the same treatment the main transcript uses.
   */
  verbose?: boolean
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
  isStreaming,
  verbose
}: AgentContributionProps): React.JSX.Element {
  const color = agentName || agentId ? presetForAgentId(agentId ?? agentName ?? '') : null
  const lastIdx = parts.length - 1

  const renderNodes: RenderNode[] = []
  parts.forEach((p, idx) => {
    const k = `part-${idx}`
    const live = isStreaming && idx === lastIdx
    if (p.kind === 'thinking') {
      const node = <ThinkingBlock content={p.text} isStreaming={live} defaultExpanded={false} />
      renderNodes.push(
        verbose
          ? { slot: 'plain', key: k, node }
          : { slot: 'collapsible', item: { key: k, kind: 'thinking', status: 'done', isLive: live, node } }
      )
    } else if (p.kind === 'tool') {
      const node = (
        <ToolNarrationBlock
          content={p.text}
          toolName={p.toolName}
          toolInput={p.toolInput}
          isStreaming={live}
          defaultExpanded={false}
        />
      )
      renderNodes.push(
        verbose
          ? { slot: 'plain', key: k, node }
          : { slot: 'collapsible', item: { key: k, kind: 'tool_narration', status: 'done', isLive: live, node } }
      )
    } else if (p.kind === 'tool_result') {
      const node = (
        <ToolResultBlock
          content={p.text}
          toolStream={p.toolStream}
          isStreaming={live}
          defaultExpanded={false}
        />
      )
      renderNodes.push(
        verbose
          ? { slot: 'plain', key: k, node }
          : {
              slot: 'collapsible',
              item: {
                key: k,
                kind: 'tool_result',
                status: p.toolStream === 'stderr' ? 'error' : 'done',
                isLive: live,
                node
              }
            }
      )
    } else if (p.kind === 'command_result') {
      renderNodes.push({
        slot: 'plain',
        key: k,
        node: (
          <CommandResultBlock content={p.text} commandInvocation={p.commandInvocation} isStreaming={live} />
        )
      })
    } else if (p.kind === 'file' && p.file) {
      renderNodes.push({ slot: 'plain', key: k, node: <AgentAttachment file={p.file} align="left" /> })
    } else {
      renderNodes.push({
        slot: 'plain',
        key: k,
        node: <MessageBubble role="assistant" content={p.text} isStreaming={live} />
      })
    }
  })

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

      {groupConsecutiveCollapsibles(renderNodes)}
    </div>
  )
}
