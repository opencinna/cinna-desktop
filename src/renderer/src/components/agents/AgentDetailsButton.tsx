import { useState } from 'react'
import { BookOpenText } from 'lucide-react'
import type { AgentDetailsTarget } from '../../../../shared/agentDetails'
import { useAgentDetails } from '../../hooks/useAgentDetails'
import { AGENT_DETAILS_TEXT, AgentDetailsModal, agentDetailsShown } from './AgentDetailsModal'

/**
 * **Details**: opens the agent's Details page ({@link AgentDetailsModal}).
 * Rendered only when main has an answer or a failure worth retrying — hidden
 * while the server does not serve Details (`unsupported`) and for an agent
 * that has none (`not_found`, core's 404 or no file in the folder). The
 * caller sizes it like its neighbours; place it first in a right-aligned row
 * so that appearing when main answers moves none of them.
 */
export function AgentDetailsButton({
  target,
  agentName,
  className,
  iconSize = 13,
  overlayAttrs
}: {
  target: AgentDetailsTarget
  agentName: string
  className: string
  iconSize?: number
  overlayAttrs?: Record<string, string>
}): React.JSX.Element | null {
  const details = useAgentDetails(target)
  const [open, setOpen] = useState(false)
  if (!agentDetailsShown(details.data) && !open) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={AGENT_DETAILS_TEXT.buttonLabel(agentName)}
        title={AGENT_DETAILS_TEXT.buttonLabel(agentName)}
        data-agent-details-button
        className={className}
      >
        <BookOpenText size={iconSize} aria-hidden="true" />
        {AGENT_DETAILS_TEXT.button}
      </button>
      {open && (
        <AgentDetailsModal target={target} agentName={agentName} onClose={() => setOpen(false)} overlayAttrs={overlayAttrs} />
      )}
    </>
  )
}
