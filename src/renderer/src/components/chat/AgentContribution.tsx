import { useLayoutEffect, useRef, useState } from 'react'
import { Bot, CornerDownRight } from 'lucide-react'
import type { MessagePart } from '../../../../shared/messageParts'
import { presetForAgentId } from '../../utils/agentColors'
import { MessageBubble } from './MessageBubble'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolNarrationBlock } from './ToolNarrationBlock'
import { ToolResultBlock } from './ToolResultBlock'
import { CinnaCliBlock } from './CinnaCliBlock'
import { pairCinnaCliTools } from '../../utils/cinnaCli'
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
   * consecutive tool blocks (tool / tool_result / Cinna CLI) into a dots
   * group, with thinking as an open block between them — the same treatment
   * the main transcript uses.
   */
  verbose?: boolean
  renderRequest?: (part: MessagePart, decision?: string) => React.JSX.Element | null
  /**
   * A node drawn at `parts[index]` instead of the part — the caller's nested
   * group there (a delegated agent's own subagent, `subagentParts.ts`), plain
   * and never folded into a dots group. `null` draws the part as usual.
   */
  renderNested?: (index: number) => React.JSX.Element | null
}

/**
 * The task that went to the agent, clamped to two lines: a long prompt is a
 * wall of text above the work it asked for (UX rule 2). "Show more" sits under
 * the text, so opening it grows the line downward and moves nothing above it.
 * The toggle exists only when the text actually overflows two lines.
 */
export function AskLine({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, expanded])
  return (
    <div className="flex items-start gap-1 text-[11px] text-[var(--color-text-muted)] italic">
      <CornerDownRight size={11} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        {/* Never `block` beside `line-clamp-2`: the clamp needs `display: -webkit-box`,
            and in the built CSS `block` comes later and wins, so nothing is clamped
            and "Show more" never appears. jsdom has no CSS, so no test sees it. */}
        <span ref={ref} data-testid="agent-ask" className={`break-words whitespace-pre-wrap ${expanded ? 'block' : 'line-clamp-2'}`}>
          {text}
        </span>
        {(overflows || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="not-italic font-medium text-[var(--color-accent)] hover:underline"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
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
  verbose,
  renderRequest,
  renderNested
}: AgentContributionProps): React.JSX.Element {
  const color = agentName || agentId ? presetForAgentId(agentId ?? agentName ?? '') : null
  const lastIdx = parts.length - 1

  const renderNodes: RenderNode[] = []
  const cli = pairCinnaCliTools(parts)
  parts.forEach((p, idx) => {
    const k = `part-${idx}`
    const live = isStreaming && idx === lastIdx
    const nestedNode = renderNested?.(idx)
    if (nestedNode) {
      renderNodes.push({ slot: 'plain', key: k, node: nestedNode })
      return
    }
    if (cli.consumed.has(idx)) return
    if (renderRequest && p.kind === 'tool') {
      const decision = parts.find((part) => part.kind === 'tool_result' && part.toolId === p.toolId)?.text
      const request = renderRequest(p, decision)
      if (request) {
        renderNodes.push({ slot: 'plain', key: k, node: request })
        return
      }
    }
    if (renderRequest && p.kind === 'tool_result' && p.toolId) {
      const call = parts.find((part) => part.kind === 'tool' && part.toolId === p.toolId)
      if (call && renderRequest(call, p.text)) return
    }
    const cliCall = cli.calls.get(idx)
    if (cliCall) {
      const results = cliCall.resultIndices.map((index) => parts[index])
      const cliLive = isStreaming && (!results.length || idx === lastIdx || cliCall.resultIndices.includes(lastIdx))
      const node = (
          <CinnaCliBlock
            command={cliCall.command}
            narration={p.text}
            results={results}
            isStreaming={cliLive}
          />
      )
      renderNodes.push(verbose ? { slot: 'plain', key: k, node } : {
        slot: 'collapsible',
        item: {
          key: k, kind: 'tool_narration', groupWhenAlone: true, isLive: cliLive,
          status: results.some((result) => result.toolStream === 'stderr') ? 'error' : isStreaming && !results.length ? 'pending' : 'done',
          node
        }
      })
      return
    }
    if (p.kind === 'thinking') {
      // Never folded into a dots group: thinking stands alone, open, in both
      // modes, and breaks a run of tool dots.
      renderNodes.push({
        slot: 'plain',
        key: k,
        node: <ThinkingBlock content={p.text} isStreaming={live} defaultExpanded />
      })
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

      {askMessage && <AskLine text={askMessage} />}

      {groupConsecutiveCollapsibles(renderNodes)}
    </div>
  )
}
