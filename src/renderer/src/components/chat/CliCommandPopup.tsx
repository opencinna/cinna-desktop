import type { RefObject } from 'react'
import { Terminal } from 'lucide-react'
import type { CliCommand } from '../../hooks/useCliCommands'
import { MentionPopup } from './MentionPopup'

interface CliCommandPopupProps {
  /** Already-filtered list — ChatInput owns the filter predicate. */
  items: CliCommand[]
  selectedIndex: number
  onSelect: (command: CliCommand) => void
  onClose: () => void
  listboxId: string
  /** Input that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>
}

export function CliCommandPopup(props: CliCommandPopupProps): React.JSX.Element | null {
  return (
    <MentionPopup<CliCommand>
      {...props}
      header="Agent Commands"
      ariaLabel="Agent commands"
      icon={Terminal}
      width="w-80"
      getKey={(cmd, i) => `${cmd.slug}-${i}`}
      getPrimary={(cmd) => cmd.command}
      getSecondary={(cmd) => cmd.description}
      secondaryClamp="line-clamp-2"
    />
  )
}
