import type { RefObject } from 'react'
import { Hash } from 'lucide-react'
import type { ExamplePrompt } from '../../utils/examplePrompts'
import { MentionPopup } from './MentionPopup'

interface ExamplePromptPopupProps {
  /** Already-filtered list — ChatInput owns the filter predicate. */
  items: ExamplePrompt[]
  selectedIndex: number
  onSelect: (prompt: ExamplePrompt) => void
  onClose: () => void
  listboxId: string
  /** Input that owns the popup — clicks inside it are treated as "inside". */
  anchorRef?: RefObject<HTMLElement | null>
}

export function ExamplePromptPopup(props: ExamplePromptPopupProps): React.JSX.Element | null {
  return (
    <MentionPopup<ExamplePrompt>
      {...props}
      header="Example Prompts"
      ariaLabel="Example prompts"
      icon={Hash}
      width="w-80"
      getKey={(prompt, i) => `${prompt.label}-${i}`}
      getPrimary={(prompt) => prompt.label}
      getSecondary={(prompt) => prompt.full}
      secondaryClamp="line-clamp-2"
    />
  )
}
