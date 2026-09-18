import { useState } from 'react'
import { Plus } from 'lucide-react'
import { ChatModeCard } from './ChatModeCard'
import { ChatModeForm } from './ChatModeForm'
import { useChatModes } from '../../hooks/useChatModes'
import { SettingsButton, SettingsInfoTip, SettingsSection } from './SettingsLayout'

export function ChatModesSection(): React.JSX.Element {
  const { data: modes } = useChatModes()
  const [showAdd, setShowAdd] = useState(false)

  // Account-provisioned modes live in the Profile group's Chats section.
  const own = (modes ?? []).filter((m) => !m.managed)

  return (
    <SettingsSection title="Saved modes"
      info={<SettingsInfoTip label="Saved modes">Choose a runtime, instructions, and connected tools for each mode, then use it when starting a chat.</SettingsInfoTip>}
      action={!showAdd && <SettingsButton onClick={() => setShowAdd(true)}><Plus size={14} />Add Chat Mode</SettingsButton>}>
      {own.map((mode) => <ChatModeCard key={mode.id} mode={mode} />)}
      {showAdd && <ChatModeForm onClose={() => setShowAdd(false)} />}
    </SettingsSection>
  )
}
