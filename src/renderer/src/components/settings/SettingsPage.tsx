import { useUIStore } from '../../stores/ui.store'
import { LLMSettingsSection } from './LLMSettingsSection'
import { MCPSettingsSection } from './MCPSettingsSection'
import { AgentsSettingsSection } from './AgentsSettingsSection'
import { TrashSection } from './TrashSection'
import { ChatModesSection } from './ChatModesSection'
import { UserAccountsSection } from './UserAccountsSection'
import { FeaturesSettingsSection } from './FeaturesSettingsSection'
import { DevelopmentSettingsSection } from './DevelopmentSettingsSection'
import { CatalogSettingsSection } from './CatalogSettingsSection'
import { ConnectionSettingsSection } from './ConnectionSettingsSection'
import { CloudSyncSettingsSection } from './CloudSyncSettingsSection'

const sectionTitles = {
  chats: 'Chat Modes',
  llm: 'LLM Providers',
  agents: 'Agents',
  mcp: 'MCP Providers',
  accounts: 'User Accounts',
  features: 'Features',
  development: 'Development',
  'profile-agents': 'Profile Agents',
  'profile-catalog': 'Catalog',
  'profile-connection': 'Connection',
  'profile-sync': 'Cloud Sync',
  trash: 'Trash'
} as const

export function SettingsPage(): React.JSX.Element {
  const { settingsTab } = useUIStore()

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 pt-[calc(var(--topbar-h)+12px)] pb-5">
        <h1 className="text-base font-semibold mb-4">{sectionTitles[settingsTab]}</h1>
        {settingsTab === 'chats' && <ChatModesSection key="chats" />}
        {settingsTab === 'llm' && <LLMSettingsSection key="llm" />}
        {settingsTab === 'agents' && <AgentsSettingsSection key="agents" scope="default" />}
        {settingsTab === 'profile-agents' && (
          <AgentsSettingsSection key="profile-agents" scope="profile" />
        )}
        {settingsTab === 'profile-catalog' && <CatalogSettingsSection key="profile-catalog" />}
        {settingsTab === 'profile-connection' && (
          <ConnectionSettingsSection key="profile-connection" />
        )}
        {settingsTab === 'profile-sync' && <CloudSyncSettingsSection key="profile-sync" />}
        {settingsTab === 'mcp' && <MCPSettingsSection key="mcp" />}
        {settingsTab === 'accounts' && <UserAccountsSection key="accounts" />}
        {settingsTab === 'features' && <FeaturesSettingsSection key="features" />}
        {settingsTab === 'development' && <DevelopmentSettingsSection key="development" />}
        {settingsTab === 'trash' && <TrashSection key="trash" />}
      </div>
    </div>
  )
}
