import { useUIStore } from '../../stores/ui.store'
import { LLMSettingsSection } from './LLMSettingsSection'
import { MCPSettingsSection } from './MCPSettingsSection'
import { AgentsSettingsSection } from './AgentsSettingsSection'
import { TrashSection } from './TrashSection'
import { ChatModesSection } from './ChatModesSection'
import { ProfileChatModesSection } from './ProfileChatModesSection'
import { ProfileLLMSection } from './ProfileLLMSection'
import { UserAccountsSection } from './UserAccountsSection'
import { FeaturesSettingsSection } from './FeaturesSettingsSection'
import { DevelopmentSettingsSection } from './DevelopmentSettingsSection'
import { CatalogSettingsSection } from './CatalogSettingsSection'
import { CloudSyncSettingsSection } from './CloudSyncSettingsSection'

const sectionTitles = {
  chats: 'Chat Modes',
  llm: 'AI Credentials',
  agents: 'Agents',
  mcp: 'MCP Providers',
  accounts: 'User Accounts',
  features: 'Features',
  development: 'Development',
  'profile-agents': 'Profile Agents',
  'profile-chats': 'Chat Modes',
  'profile-llm': 'AI Credentials',
  'profile-catalog': 'Catalog',
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
        {settingsTab === 'profile-chats' && <ProfileChatModesSection key="profile-chats" />}
        {settingsTab === 'profile-llm' && <ProfileLLMSection key="profile-llm" />}
        {settingsTab === 'profile-catalog' && <CatalogSettingsSection key="profile-catalog" />}
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
