import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'

/**
 * Features tab — opt-in toggles grouped by domain:
 *   • AI Functions — features that consume LLM tokens alongside the normal
 *     chat flow (chat-title autogen, future chat-summary, etc.)
 *   • Interface — chrome toggles (tray icon, future window/menu prefs)
 *
 * All settings live in the installation-global `app_settings` KV store and
 * are read by the corresponding main-process feature service.
 */
export function FeaturesSettingsSection(): React.JSX.Element {
  const { data: settings, isLoading, isError } = useAppSettings()
  const setSetting = useSetAppSetting()

  const disabled = isLoading || setSetting.isPending

  const autoChatTitles = settings?.autoChatTitles === true
  const enableTrayIcon = settings?.enableTrayIcon === true
  const prioritizeAccountDefaults = settings?.prioritizeAccountDefaults === true

  const toggleAutoChatTitles = (): void => {
    if (!settings || disabled) return
    setSetting.mutate({ key: 'autoChatTitles', value: !settings.autoChatTitles })
  }

  const togglePrioritizeAccountDefaults = (): void => {
    if (!settings || disabled) return
    setSetting.mutate({
      key: 'prioritizeAccountDefaults',
      value: !settings.prioritizeAccountDefaults
    })
  }

  const toggleEnableTrayIcon = (): void => {
    if (!settings || disabled) return
    setSetting.mutate({ key: 'enableTrayIcon', value: !settings.enableTrayIcon })
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          AI Functions
        </h2>
        <div className="space-y-3">
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <ToggleRow
              label="Auto-generate chat titles"
              description="Generates a short title from your first message in a new chat. Uses your default chat mode’s LLM provider — consumes tokens."
              checked={autoChatTitles}
              disabled={disabled}
              onToggle={toggleAutoChatTitles}
              title={
                autoChatTitles
                  ? 'New chats will get a generated title from your first message'
                  : 'Chats will keep the default "New Chat" name'
              }
              showError={isError}
            />
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <ToggleRow
              label="Prioritize ‘Account’ defaults over default profile"
              description="When you’re signed in to a Cinna account, use the account’s default chat mode as the one that auto-applies on new chats — overriding your local default. Off by default: your local default wins, and the account default only applies when you have none."
              checked={prioritizeAccountDefaults}
              disabled={disabled}
              onToggle={togglePrioritizeAccountDefaults}
              title={
                prioritizeAccountDefaults
                  ? 'Account default chat mode takes precedence over your local default'
                  : 'Your local default chat mode takes precedence'
              }
              showError={isError}
            />
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          Interface
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <ToggleRow
            label="Enable Tray Icon"
            description="Show the menu-bar icon for agent status at a glance. Turn off to hide it without quitting the app."
            checked={enableTrayIcon}
            disabled={disabled}
            onToggle={toggleEnableTrayIcon}
            title={enableTrayIcon ? 'Menu-bar tray icon is visible' : 'Menu-bar tray icon is hidden'}
            showError={isError}
          />
        </div>
      </section>
    </div>
  )
}

interface ToggleRowProps {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
  title: string
  showError: boolean
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onToggle,
  title,
  showError
}: ToggleRowProps): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1">
        <div className="text-[14px] font-medium text-[var(--color-text)]">{label}</div>
        <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
          {description}
        </div>
        {showError && (
          <div className="text-[13px] text-[var(--color-danger)] mt-1.5">
            Couldn’t load settings — try reopening this page.
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={onToggle}
        title={title}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  )
}
