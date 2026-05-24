import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'

/**
 * Features tab — opt-in toggles for AI Functions that run alongside the
 * normal chat flow (chat-title autogen, future chat-summary, etc.). All
 * settings live in the installation-global `app_settings` KV store and are
 * read by the corresponding main-process feature service.
 */
export function FeaturesSettingsSection(): React.JSX.Element {
  const { data: settings, isLoading, isError } = useAppSettings()
  const setSetting = useSetAppSetting()

  const checked = settings?.autoChatTitles === true
  const disabled = isLoading || setSetting.isPending

  const toggleAutoChatTitles = (): void => {
    if (!settings || disabled) return
    setSetting.mutate({ key: 'autoChatTitles', value: !settings.autoChatTitles })
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          AI Functions
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--color-text)]">
                Auto-generate chat titles
              </div>
              <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                Generates a short title from your first message in a new chat.
                Uses your default chat mode’s LLM provider — consumes tokens.
              </div>
              {isError && (
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
              onClick={toggleAutoChatTitles}
              title={
                checked
                  ? 'New chats will get a generated title from your first message'
                  : 'Chats will keep the default "New Chat" name'
              }
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
        </div>
      </section>
    </div>
  )
}
