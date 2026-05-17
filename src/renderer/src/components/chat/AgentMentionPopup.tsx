import type { RefObject } from 'react'
import { Bot } from 'lucide-react'
import { MentionPopup } from './MentionPopup'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

interface AgentMentionPopupProps {
  /** Already-filtered list — ChatInput owns the filter predicate. */
  items: AgentData[]
  selectedIndex: number
  onSelect: (agent: AgentData) => void
  onClose: () => void
  listboxId: string
  /** Input that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>
}

export function AgentMentionPopup(props: AgentMentionPopupProps): React.JSX.Element | null {
  return (
    <MentionPopup<AgentData>
      {...props}
      header="Agents"
      ariaLabel="Agents"
      icon={Bot}
      width="w-72"
      getKey={(agent) => agent.id}
      getPrimary={(agent) => agent.name}
      getSecondary={(agent) => agent.description}
      getMeta={(agent) => agent.protocol.toUpperCase()}
    />
  )
}
