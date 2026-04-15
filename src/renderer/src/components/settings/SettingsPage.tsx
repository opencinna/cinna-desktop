import { useUIStore } from '../../stores/ui.store'
import { LLMSettingsSection } from './LLMSettingsSection'
import { MCPSettingsSection } from './MCPSettingsSection'

export function SettingsPage(): React.JSX.Element {
  const { settingsTab } = useUIStore()

  const sectionTitle = settingsTab === 'llm' ? 'LLM Providers' : 'MCP Providers'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-5">
        <h1 className="text-base font-semibold mb-4">{sectionTitle}</h1>
        {settingsTab === 'llm' && <LLMSettingsSection key="llm" />}
        {settingsTab === 'mcp' && <MCPSettingsSection key="mcp" />}
      </div>
    </div>
  )
}
