import { useUIStore } from '../../stores/ui.store'
import { LLMSettingsSection } from './LLMSettingsSection'
import { MCPSettingsSection } from './MCPSettingsSection'
import { TrashSection } from './TrashSection'

const sectionTitles = {
  llm: 'LLM Providers',
  mcp: 'MCP Providers',
  trash: 'Trash'
} as const

export function SettingsPage(): React.JSX.Element {
  const { settingsTab } = useUIStore()

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-5">
        <h1 className="text-base font-semibold mb-4">{sectionTitles[settingsTab]}</h1>
        {settingsTab === 'llm' && <LLMSettingsSection key="llm" />}
        {settingsTab === 'mcp' && <MCPSettingsSection key="mcp" />}
        {settingsTab === 'trash' && <TrashSection key="trash" />}
      </div>
    </div>
  )
}
