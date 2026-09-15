import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { useHintsStore, hasHintProgress } from '../../stores/hints.store'
import { useUIStore, type ThemePreference } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  SettingsButton,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow
} from './SettingsLayout'

/**
 * Features tab — opt-in toggles grouped by domain:
 *   • AI Functions — features that consume LLM tokens alongside the normal
 *     chat flow (chat-title autogen, future chat-summary, etc.)
 *   • Interface — chrome toggles (tray icon, future window/menu prefs)
 *
 * Service settings live in `app_settings`; appearance preferences live in
 * the renderer's persistent UI store alongside the sidebar theme shortcut.
 *
 * **One `SettingsRows` list per section, one line per toggle.** Each toggle
 * was its own bordered card with a paragraph under its label; a row that is
 * only a label and a switch is a one-liner, and the paragraph is standing
 * explanation, which lives behind the `(?)` beside the label rather than on
 * the surface (ux_rules rule 12).
 */
export function FeaturesSettingsSection(): React.JSX.Element {
  const themePreference = useUIStore((s) => s.themePreference)
  const setThemePreference = useUIStore((s) => s.setThemePreference)
  const extraUIAnimation = useUIStore((s) => s.extraUIAnimation)
  const setExtraUIAnimation = useUIStore((s) => s.setExtraUIAnimation)
  const { data: settings, isLoading, isError } = useAppSettings()
  const setSetting = useSetAppSetting()

  const disabled = isLoading || setSetting.isPending
  const saveError = setSetting.error ? unwrapIpcError(setSetting.error, 'Could not save this setting.') : null

  const autoChatTitles = settings?.autoChatTitles === true
  const enableTrayIcon = settings?.enableTrayIcon === true
  const showHints = settings?.showHints === true
  const showAgentSidebarSections = settings?.showAgentSidebarSections !== false
  const prioritizeAccountDefaults = settings?.prioritizeAccountDefaults === true

  // Hint retirement counters live in localStorage (renderer-local UI state),
  // not in `app_settings` — so resetting them is a store call, not a mutation.
  const hintProgress = useHintsStore((s) => s.progress)
  const resetHints = useHintsStore((s) => s.reset)
  const canResetHints = hasHintProgress(hintProgress)

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

  const toggleShowHints = (): void => {
    if (!settings || disabled) return
    setSetting.mutate({ key: 'showHints', value: !settings.showHints })
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="AI Functions">
        <SettingsRows insetDividers>
          <SettingsToggleRow
            id="feature-auto-chat-titles"
            label="Auto-generate chat titles"
            description="Generates a short title from your first message in a new chat. Uses your default chat mode’s AI credentials — consumes tokens."
            checked={autoChatTitles}
            disabled={disabled}
            onToggle={toggleAutoChatTitles}
            title={
              autoChatTitles
                ? 'New chats will get a generated title from your first message'
                : 'Chats will keep the default "New Chat" name'
            }
          />
          <SettingsToggleRow
            id="feature-prioritize-account-defaults"
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
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Interface">
        <SettingsRows insetDividers>
          <SettingsRow className="flex items-center justify-between gap-3">
            <label id="feature-theme-label" className="text-[14px] font-medium text-[var(--color-text)]">Theme</label>
            <div role="group" aria-labelledby="feature-theme-label" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
              {(['system', 'dark', 'light'] as const).map((value: ThemePreference) => (
                <button key={value} type="button" aria-pressed={themePreference === value}
                  onClick={() => setThemePreference(value)}
                  className={`rounded px-2.5 py-1 text-[13px] transition-colors ${themePreference === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsToggleRow
            id="feature-extra-ui-animation"
            label="Extra UI animation"
            description="Add quick fading curtain transitions between chats, a new-chat logo that draws itself in and out when clicked, occasional grid pulses, border glows on inputs, the sidebar and secondary buttons, and a gentle background wave across header buttons. Turn off to stop all these effects. Respects your system’s reduced-motion setting."
            checked={extraUIAnimation}
            onToggle={() => setExtraUIAnimation(!extraUIAnimation)}
            title={extraUIAnimation ? 'Extra UI animation is enabled' : 'Extra UI animation is disabled'}
          />
          <SettingsToggleRow
            id="feature-enable-tray-icon"
            label="Enable Tray Icon"
            description="Show the menu-bar icon for agent status at a glance. Turn off to hide it without quitting the app."
            checked={enableTrayIcon}
            disabled={disabled}
            onToggle={toggleEnableTrayIcon}
            title={
              enableTrayIcon ? 'Menu-bar tray icon is visible' : 'Menu-bar tray icon is hidden'
            }
          />
          <SettingsToggleRow
            id="feature-agent-sidebar-sections"
            label="Show sections in Agents sidebar"
            description="Group agents by their folder or connection. Turn off to show a flat list in the same order."
            checked={showAgentSidebarSections}
            disabled={disabled}
            onToggle={() => {
              if (!settings || disabled) return
              setSetting.mutate({ key: 'showAgentSidebarSections', value: !showAgentSidebarSections })
            }}
            title={showAgentSidebarSections ? 'Agents are shown in sections' : 'Agents are shown in a flat list'}
          />
          <SettingsToggleRow
            id="feature-show-hints"
            label="Show hints"
            description="Display rotating tips about shortcuts at the bottom of the new-chat screen. Tips you’ve clearly learned stop appearing on their own; turn this off once you know your way around."
            checked={showHints}
            disabled={disabled}
            onToggle={toggleShowHints}
            title={showHints ? 'Hints are shown on the new-chat screen' : 'Hints are hidden'}
          />
          {/* A row of its own under Show hints, in the same list: it is the one
              verb the toggle above gives the user, and it only exists while
              hints are on. */}
          {showHints && (
            <SettingsRow className="flex items-center justify-between gap-3">
              {/* One line at 800px in both states: the longer sentence wrapped,
                  and clicking Reset un-wrapped it and moved the button (rule 1). */}
              <div className="min-w-0 text-[13px] text-[var(--color-text-muted)]">
                {canResetHints ? 'Some hints are retired.' : 'No hints retired yet.'}
              </div>
              <SettingsButton onClick={resetHints} disabled={!canResetHints}>
                Reset hints
              </SettingsButton>
            </SettingsRow>
          )}
          {/*
            One failure, said once. Every switch on this tab reads the same
            query, so the read error is one fact, and it is rendered only while
            it is true, as the last row of the last list: a copy under each of
            the four labels moved every centred switch down when it arrived
            (ux_rules rule 1). Being last, this row lengthens the list and moves
            nothing above it.
          */}
          {isError && (
            <SettingsRow className="text-[13px] text-[var(--color-danger)]">
              Couldn’t load settings — try reopening this page.
            </SettingsRow>
          )}
          {saveError && (
            <SettingsRow className="text-[13px] text-[var(--color-danger)]">
              <p role="alert">{saveError.startsWith('Unknown app setting:')
                ? 'This running version does not recognize the setting. Restart Cinna Desktop to load the updated app, then try again.'
                : `Couldn’t save the setting: ${saveError}`}</p>
            </SettingsRow>
          )}
        </SettingsRows>
      </SettingsSection>
    </div>
  )
}
