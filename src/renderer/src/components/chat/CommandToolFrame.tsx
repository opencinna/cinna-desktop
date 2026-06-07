import { Terminal } from 'lucide-react'
import { DisclosureBlock } from './DisclosureBlock'

interface CommandToolFrameProps {
  /**
   * Verbatim slash invocation from `cinna.command_invocation` — drives the
   * "Command: <invocation>" header.
   */
  commandInvocation: string
  /**
   * Inner blocks (typically a `ToolNarrationBlock` + `ToolResultBlock` pair
   * already paired by `cinna.tool_id`). Rendered as the expandable body.
   */
  children: React.ReactNode
  isStreaming?: boolean
  /**
   * Outer frame default-collapsed: the bash plumbing is incidental — the
   * user already knows what command they invoked. Caller can override per
   * surface (e.g. verbose mode).
   */
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

/**
 * Outer wrapper for a `/run:*` tool/tool_result pair carrying
 * `cinna.command_invocation`. Logical grouping only — `frameless` so the inner
 * `ToolNarrationBlock` / `ToolResultBlock` cards aren't double-framed inside a
 * page-wide outer box.
 */
export function CommandToolFrame({
  commandInvocation,
  children,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: CommandToolFrameProps): React.JSX.Element {
  return (
    <DisclosureBlock
      frameless
      icon={<Terminal size={11} className="shrink-0" />}
      header={
        <>
          <span className="font-medium">Command: </span>
          <span className="font-mono">{commandInvocation}</span>
        </>
      }
      isStreaming={isStreaming}
      defaultExpanded={defaultExpanded}
      animate={animate}
      animateDelay={animateDelay}
    >
      <div className="space-y-2">{children}</div>
    </DisclosureBlock>
  )
}
