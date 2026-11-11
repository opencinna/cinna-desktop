import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { isCredentialActive } from '../../../../shared/credentials'
import { useAiFunctionsBackend, useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { useCapabilities } from '../../hooks/useCapabilities'
import type { AiFunctionsBackendStatus } from '../../../../shared/aiFunctions'
import { AI_SPENDING_LEVELS, AI_SPENDING_LEVEL_LABEL } from '../../../../shared/aiSpendingLevel'
import { useHintsStore, hasHintProgress } from '../../stores/hints.store'
import { useUIStore, type SidebarDocking, type ThemePreference } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { useSpeechStatus } from '../chat/voice/useSpeechStatus'
import { isVoiceCloudService, isVoiceCloudTranscription, type SpeechStatus, type VoiceCloudService, type VoiceCloudTranscription } from '../../../../shared/speech'
import { FinderQuickActionSection } from './FinderQuickActionSection'
import {
  SettingsButton,
  SettingsLabel,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusRow,
  SettingsToggleRow,
  settingsInputClass,
  settingsDropdownRowClass
} from './SettingsLayout'

/** Every fallback cause fits one line in the 428px box at an 800px window. */
const FALLBACK_TEXT: Record<Extract<AiFunctionsBackendStatus, { runsOn: 'runtime' }>['reason'], string> = {
  unset: 'Default runtime',
  missing: 'Default runtime — the chosen credential is missing',
  inactive: 'Default runtime — the chosen credential is inactive',
  no_model: 'Default runtime — the chosen credential has no model'
}

/** Main picks the credential and model; the name comes from the loaded model list, else the id. */
function describeRunsOn(status: AiFunctionsBackendStatus | undefined, models: readonly { id: string; name: string; providerId: string }[]): string {
  if (!status) return '—'
  if (status.runsOn === 'runtime') return FALLBACK_TEXT[status.reason]
  const modelName = models.find((model) => model.providerId === status.credentialId && model.id === status.modelId)?.name
  return `${status.credentialName} · ${modelName ?? status.modelId}`
}

/**
 * Short enough for the dropdown's third of the row at the narrowest window
 * (ux_rules rule 7); the (?) says what each means.
 */
const VOICE_CLOUD_LABEL: Record<VoiceCloudTranscription, string> = {
  off: 'Off',
  fallback: 'As a fallback',
  always: 'Always'
}

const ON_DEVICE_VOICE = "Speech is turned into text by macOS's own speech recognition, on this Mac: Cinna sends the recording nowhere. The transcription service is provided by Apple, the maker of your device and its operating system, not by Cinna."

/** The service labels of the Service select, short for the dropdown's third of the row (rule 7). */
const VOICE_SERVICE_LABEL = { core: 'Cinna server', gemini: 'My Gemini key' } as const

/**
 * The Cinna server in Settings copy. Never a name: Features is app-wide and the
 * server is the one of whichever account is signed in when a dictation starts
 * (ux_rules rule 21).
 */
const VOICE_SERVER = 'your Cinna server (the server of the account you are signed in to when you dictate)'
const VOICE_SERVER_CHECK = 'If that server does not offer transcription, the dictation says so.'

/** The Audio input row's (?) while nothing on this computer can transcribe. */
export const VOICE_INPUT_UNAVAILABLE = 'Shows the microphone button beside Send in the composer. There is no speech recognition on this computer: turn on Cloud transcription below to dictate.'
/** The same, with a cloud mode already on whose service cannot run (unset, or My Gemini key without a key). */
export const VOICE_INPUT_NO_CLOUD_SERVICE = 'Shows the microphone button beside Send in the composer. There is no speech recognition on this computer, and Cloud transcription below has no usable service yet: choose Cinna server, or add a Gemini key under AI Credentials.'

/**
 * "Audio input"'s promise follows where the audio actually goes: on this
 * Mac, to the Cinna server (which pays for it), or to Google under the user's
 * own Gemini key. It never says "on this Mac" for a dictation that is not.
 */
export function voiceInputDescription(speech: SpeechStatus): string {
  const lead = 'Shows the microphone button beside Send in the composer. Click it, or the headphone button, to dictate; double-click the headphone button to send.'
  const mode = speech.cloud.mode
  const viaCloud = mode === 'always' || (mode === 'fallback' && !speech.supported)
  // A mode on with no service saved: main runs no cloud dictation (never one implicitly).
  const unset = mode !== 'off' && speech.cloud.setting === ''
  if (unset) {
    const none = 'No cloud service is chosen yet: choose one under Cloud transcription › Service.'
    return viaCloud ? `${lead} ${none}` : `${lead} ${ON_DEVICE_VOICE} ${none}`
  }
  const service = speech.cloud.service
  if (viaCloud) {
    return service === 'core'
      ? `${lead} Speech is turned into text by ${VOICE_SERVER}: the recording is sent to it, and it pays for the transcription. ${VOICE_SERVER_CHECK} A cloud mark on the button shows while it is.`
      : `${lead} Speech is turned into text by Google Gemini: the recording is sent to Google under your own Gemini provider key and billed to it. A cloud mark on the button shows while it is.`
  }
  // On the device; a failure mid-dictation may be offered to the server, never taken.
  const offer = ' If it fails while you dictate and your Cinna server offers transcription, Cinna can offer to continue there; nothing is sent unless you agree.'
  if (mode === 'fallback') {
    const instead = service === 'core'
      ? `goes to ${VOICE_SERVER} instead, which pays for the transcription. ${VOICE_SERVER_CHECK}`
      : 'goes to Google Gemini instead, under your own Gemini provider key and billed to it.'
    return `${lead} ${ON_DEVICE_VOICE} If on-device recognition is unavailable when you start dictating, the recording ${instead}${offer}`
  }
  return `${lead} ${ON_DEVICE_VOICE}${offer}`
}

/**
 * Features tab — opt-in toggles grouped by domain:
 *   • Capabilities — optional sections of the app (Notes, Dashboards), off
 *     until turned on; each adds a sidebar tab and the actions that create
 *     content there (ux rule 15). First, because it decides what the rest of
 *     the app shows, and is two short rows above the long AI Functions list.
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
  const sidebarDocking = useUIStore((s) => s.sidebarDocking)
  const setSidebarDocking = useUIStore((s) => s.setSidebarDocking)
  const extraUIAnimation = useUIStore((s) => s.extraUIAnimation)
  const setExtraUIAnimation = useUIStore((s) => s.setExtraUIAnimation)
  const stickyTableHeaders = useUIStore((s) => s.stickyTableHeaders)
  const setStickyTableHeaders = useUIStore((s) => s.setStickyTableHeaders)
  const showTasksButton = useUIStore((s) => s.showTasksButton)
  const setShowTasksButton = useUIStore((s) => s.setShowTasksButton)
  const showVoiceInput = useUIStore((s) => s.showVoiceInput)
  const setShowVoiceInput = useUIStore((s) => s.setShowVoiceInput)
  const { notesEnabled, dashboardsEnabled } = useCapabilities()
  const speech = useSpeechStatus()
  const { data: settings, isLoading, isError } = useAppSettings()
  const setSetting = useSetAppSetting()
  const { data: providers } = useProviders()
  const { data: models } = useModels()
  const functionCredential = providers?.find((provider) => provider.id === settings?.aiFunctionsCredentialId)
  const functionModels = (models ?? []).filter((model) => model.providerId === settings?.aiFunctionsCredentialId)
  const { data: functionsBackend } = useAiFunctionsBackend()
  const runsOnText = describeRunsOn(functionsBackend, models ?? [])

  const disabled = isLoading || setSetting.isPending
  const saveError = setSetting.error ? unwrapIpcError(setSetting.error, 'Could not save this setting.') : null

  const autoChatTitles = settings?.autoChatTitles === true
  const enableTrayIcon = settings?.enableTrayIcon === true
  const desktopNotifications = settings?.desktopNotifications !== false
  const showHints = settings?.showHints === true
  const showAgentSidebarSections = settings?.showAgentSidebarSections !== false
  const showLocalDataInAllProfiles = settings?.showLocalDataInAllProfiles !== false
  const prioritizeAccountDefaults = settings?.prioritizeAccountDefaults === true
  const guidedFirstBuild = settings?.guidedFirstBuild !== false
  const serverBranding = settings?.serverBranding !== false
  const voiceCloudMode: VoiceCloudTranscription = isVoiceCloudTranscription(settings?.voiceCloudTranscription) ? settings.voiceCloudTranscription : 'off'
  const voiceCloudProviders = speech.cloud.providers
  // Main bills the chosen provider when it is usable, else the first one.
  const voiceCloudProvider = voiceCloudProviders.find((provider) => provider.id === settings?.voiceCloudProviderId) ?? voiceCloudProviders[0]
  const geminiUsable = voiceCloudProviders.length > 0
  // The saved service: this window's write at once (the settings cache is optimistic), else main's.
  const savedVoiceService: VoiceCloudService = isVoiceCloudService(settings?.voiceCloudService) ? settings.voiceCloudService : speech.cloud.setting
  // What the next cloud dictation uses; none saved shows as the Cinna server (main runs nothing for it).
  const voiceService: 'core' | 'gemini' = savedVoiceService === 'gemini' ? 'gemini' : 'core'
  // A mode on with no service saved: main runs nothing in the cloud until one is picked.
  const voiceServiceUnset = voiceCloudMode !== 'off' && savedVoiceService === ''
  // Settings never read the active account (ux_rules rule 21): the Service is
  // offered whenever a mode is on, and whether the server offers transcription
  // is said when a dictation starts.
  const showVoiceService = voiceCloudMode !== 'off'
  const voiceCloudMissing = !voiceServiceUnset && voiceService === 'gemini' && !geminiUsable && (voiceCloudMode !== 'off' || !speech.supported)
  /**
   * Turning a mode on from Off with no service saved saves the Cinna server
   * with it, first (never the billed key): a running mode always has an explicit service,
   * so none is ever chosen implicitly later. The mode is written only once the
   * service is: a failed service write stays the shown save error (the
   * mutation's state is its last call's) and leaves the mode Off.
   */
  const setVoiceCloudMode = (value: VoiceCloudTranscription): void => {
    if (voiceCloudMode === 'off' && value !== 'off' && savedVoiceService === '') {
      setSetting.mutateAsync({ key: 'voiceCloudService', value: 'core' })
        .then(() => setSetting.mutate({ key: 'voiceCloudTranscription', value }))
        .catch(() => {})
      return
    }
    setSetting.mutate({ key: 'voiceCloudTranscription', value })
  }
  const openAiCredentials = (): void => {
    useUIStore.getState().setSettingsMenu('llm')
    useUIStore.getState().setActiveView('settings')
  }

  // Hint retirement counters live in localStorage (renderer-local UI state),
  // not in `app_settings` — so resetting them is a store call, not a mutation.
  const hintProgress = useHintsStore((s) => s.progress)
  const resetHints = useHintsStore((s) => s.reset)
  const canResetHints = hasHintProgress(hintProgress)

  // Main's installation-global decision; turning one off leaves its tab
  // through the sidebar (`SidebarTabs`), which knows which chat to land on.
  const toggleCapability = (key: 'notesCapability' | 'dashboardsCapability', on: boolean): void => {
    if (!settings || disabled) return
    setSetting.mutate({ key, value: on ? 'off' : 'on' })
  }

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
      <SettingsSection title="Capabilities">
        <SettingsRows insetDividers>
          <SettingsToggleRow
            id="feature-notes"
            label="Notes"
            description="Adds a Notes tab to the sidebar, and Save to Notes to a message’s right-click menu. Turning it off hides them; your notes are kept."
            checked={notesEnabled}
            disabled={disabled}
            onToggle={() => toggleCapability('notesCapability', notesEnabled)}
            title={notesEnabled ? 'The Notes tab is in the sidebar' : 'The Notes tab is hidden'}
          />
          <SettingsToggleRow
            id="feature-dashboards"
            label="Dashboards"
            description="Adds a Dashboards tab to the sidebar, where components your agents build stay live as tiles, and Add to dashboard… on components in chats and on an agent’s page. Turning it off hides them; your dashboards are kept."
            checked={dashboardsEnabled}
            disabled={disabled}
            onToggle={() => toggleCapability('dashboardsCapability', dashboardsEnabled)}
            title={dashboardsEnabled ? 'The Dashboards tab is in the sidebar' : 'The Dashboards tab is hidden'}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="AI Functions">
        <SettingsRows insetDividers>
          <SettingsRow className="flex items-center justify-between gap-3">
            <SettingsLabel info="Choose who routes when a chat gains multiple agents. AI routes uses the first local agent or your default runtime as coordinator. Existing chats keep their routing.">Default multi-agent routing</SettingsLabel>
            <div role="group" aria-label="Default multi-agent routing" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
              {(['human', 'coordinator'] as const).map((value) => (
                <button key={value} type="button" disabled={disabled}
                  aria-pressed={(settings?.defaultMultiAgentRouting ?? 'human') === value}
                  onClick={() => { if (settings && !disabled) setSetting.mutate({ key: 'defaultMultiAgentRouting', value }) }}
                  className={`rounded px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 ${(settings?.defaultMultiAgentRouting ?? 'human') === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {value === 'human' ? 'You route' : 'AI routes'}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow className="flex items-center justify-between gap-3">
            <SettingsLabel info="The context a chat may fill before Cinna suggests a new chat or compacting: Eco 250K, Mid 350K, Greedy the full window. Lower on models with smaller windows.">AI spending level</SettingsLabel>
            <div role="group" aria-label="AI spending level" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
              {AI_SPENDING_LEVELS.map((value) => (
                <button key={value} type="button" disabled={disabled}
                  aria-pressed={(settings?.aiSpendingLevel ?? 'mid') === value}
                  onClick={() => { if (settings && !disabled) setSetting.mutate({ key: 'aiSpendingLevel', value }) }}
                  className={`rounded px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 ${(settings?.aiSpendingLevel ?? 'mid') === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {AI_SPENDING_LEVEL_LABEL[value]}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow>
            <div className={settingsDropdownRowClass}>
              <SettingsLabel htmlFor="ai-functions-credential" info="Credentials used only for titles and drafting. With none chosen, these functions run a one-shot session on your Default runtime.">AI Functions credentials</SettingsLabel>
              <select id="ai-functions-credential" className={settingsInputClass} disabled={disabled}
                value={settings?.aiFunctionsCredentialId ?? ''}
                onChange={(event) => setSetting.mutate({ key: 'aiFunctionsCredentialId', value: event.target.value })}>
                <option value="">Default runtime</option>
                {(providers ?? []).filter(isCredentialActive).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                {settings?.aiFunctionsCredentialId && !functionCredential && <option value={settings.aiFunctionsCredentialId}>Missing credential</option>}
                {functionCredential && !isCredentialActive(functionCredential) && <option value={functionCredential.id}>{functionCredential.name} (inactive)</option>}
              </select>
            </div>
            <div className={`mt-3 ${settingsDropdownRowClass}`}>
              <SettingsLabel htmlFor="ai-functions-model" info="The model used by the selected AI Functions credential. With no credential, the Default runtime chooses its model.">AI Functions model</SettingsLabel>
              <select id="ai-functions-model" className={settingsInputClass} disabled={disabled || !settings?.aiFunctionsCredentialId}
                value={settings?.aiFunctionsModelId ?? ''}
                onChange={(event) => setSetting.mutate({ key: 'aiFunctionsModelId', value: event.target.value })}>
                <option value="">Default model</option>
                {functionModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                {settings?.aiFunctionsModelId && !functionModels.some((model) => model.id === settings.aiFunctionsModelId) && <option value={settings.aiFunctionsModelId}>Choose a model for this credential</option>}
              </select>
            </div>
            {/* Main's answer, not ours: this line used to judge the binding in
                the renderer and named a credential main was falling back from.
                One line, fixed height, and the previous answer (or a dash on
                first load) while a refetch runs — it never empties (rule 1). */}
            <p className="mt-2 truncate text-[13px] text-[var(--color-text-muted)]" title={runsOnText} aria-busy={!functionsBackend}>
              Runs on: {runsOnText}
            </p>
          </SettingsRow>
          <SettingsToggleRow
            id="feature-auto-chat-titles"
            label="Auto-generate chat titles"
            description="Generates a short title from your first message in a new chat. Uses the AI Functions runtime selected above."
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
            id="feature-guided-first-build"
            label="Guide the first build of new agents"
            description="A blank local agent’s first chat asks a few questions about its job and suggests how to set it up, then starts building when you say so. Off: its first chat starts like any other, and it tries what you ask straight away."
            checked={guidedFirstBuild}
            disabled={disabled}
            onToggle={() => {
              if (!settings || disabled) return
              setSetting.mutate({ key: 'guidedFirstBuild', value: !guidedFirstBuild })
            }}
            title={guidedFirstBuild ? 'New agents start with a guided first build' : 'New agents start with an ordinary chat'}
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
          <SettingsRow className="flex items-center justify-between gap-3">
            <SettingsLabel info="Account Branded shows the colours, logo and background your Cinna server publishes for everyone signed in to it. Where the server publishes none, Cinna's own look shows either way. Cinna Original always shows Cinna's own look, on every profile.">Branding</SettingsLabel>
            <div role="group" aria-label="Branding" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
              {([[false, 'Cinna Original'], [true, 'Account Branded']] as const).map(([value, label]) => (
                <button key={label} type="button" aria-pressed={settings ? serverBranding === value : false}
                  disabled={!settings || disabled}
                  onClick={() => {
                    if (!settings || disabled || serverBranding === value) return
                    setSetting.mutate({ key: 'serverBranding', value })
                  }}
                  className={`rounded px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 ${settings && serverBranding === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {label}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow className="flex items-center justify-between gap-3">
            <SettingsLabel info="On Hover hides the sidebar and shows it over the chat when the pointer reaches the left edge of the window. Clicking the sidebar button docks it again; right-clicking the button switches the mode.">Sidebar docking</SettingsLabel>
            <div role="group" aria-label="Sidebar docking" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
              {([['fixed', 'Fixed'], ['hover', 'On Hover']] as const).map(([value, label]: readonly [SidebarDocking, string]) => (
                <button key={value} type="button" aria-pressed={sidebarDocking === value}
                  onClick={() => setSidebarDocking(value)}
                  className={`rounded px-2.5 py-1 text-[13px] transition-colors ${sidebarDocking === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {label}
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
            id="feature-sticky-table-headers"
            label="Sticky table headers"
            description="While you scroll through a long table in a chat, its header row stays at the top until the table’s last row passes. A table too wide for the message scrolls sideways, and its header scrolls with it."
            checked={stickyTableHeaders}
            onToggle={() => setStickyTableHeaders(!stickyTableHeaders)}
            title={stickyTableHeaders ? 'Table headers stay in view while you scroll' : 'Table headers scroll away with the table'}
          />
          <SettingsToggleRow
            id="feature-tasks-button"
            label="Tasks button"
            description="Shows the Tasks button in the top bar, which opens every task as a list or a board."
            checked={showTasksButton}
            onToggle={() => setShowTasksButton(!showTasksButton)}
            title={showTasksButton ? 'The Tasks button is in the top bar' : 'The Tasks button is hidden'}
          />
          {/* Always there, so a cloud mode chosen below never inserts a row
              above the pills under the pointer (ux_rules rule 1). Disabled
              while nothing can transcribe: no on-device engine and no cloud mode. */}
          <SettingsToggleRow
            id="feature-show-voice-input"
            label="Audio input"
            description={speech.available ? voiceInputDescription(speech) : voiceCloudMode === 'off' ? VOICE_INPUT_UNAVAILABLE : VOICE_INPUT_NO_CLOUD_SERVICE}
            checked={speech.available && showVoiceInput}
            disabled={!speech.available}
            onToggle={() => setShowVoiceInput(!showVoiceInput)}
            title={!speech.available
              ? voiceCloudMode === 'off'
                ? 'No speech recognition on this computer: turn on Cloud transcription below'
                : 'Cloud transcription below has no usable service yet'
              : showVoiceInput ? 'The audio input button is in the composer' : 'The audio input button is hidden'}
          />
          {/* Shown without an on-device engine too: on Linux and Windows it is the way in. */}
          <SettingsRow>
            <div className="flex items-center justify-between gap-3">
              <SettingsLabel info="Dictation in the cloud. Cinna server: the recording is sent to the Cinna server of the account you are signed in to when you dictate, which pays for it; if that server does not offer transcription, the dictation says so. My Gemini key: Google Gemini Live on your own Gemini provider key; the recording is sent to Google and billed to that key. Needs a Gemini credential with an API key, added under AI Credentials. As a fallback: only when on-device speech recognition is unavailable on this computer as a dictation starts (a permission you refused is not unavailable). Always: every dictation. Off: on the device only. A dictation never switches midway on its own: if on-device recognition fails while you dictate and your Cinna server offers transcription, Cinna asks before continuing there.">Cloud transcription</SettingsLabel>
              <div role="group" aria-label="Cloud transcription" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
                {(['off', 'fallback', 'always'] as const).map((mode) => (
                  <button key={mode} type="button" aria-pressed={voiceCloudMode === mode}
                    disabled={disabled}
                    onClick={() => { if (voiceCloudMode !== mode) setVoiceCloudMode(mode) }}
                    className={`rounded px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 ${voiceCloudMode === mode ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                    {VOICE_CLOUD_LABEL[mode]}
                  </button>
                ))}
              </div>
            </div>
            {showVoiceService && (
              <div className={`mt-3 ${settingsDropdownRowClass}`}>
                <SettingsLabel htmlFor="feature-voice-cloud-service" info={`Where cloud transcription sends the recording. Cinna server: to ${VOICE_SERVER}, which pays for it. ${VOICE_SERVER_CHECK} My Gemini key: to Google, billed to your own Gemini provider key. The one you pick is never swapped for the other.`}>Service</SettingsLabel>
                <select id="feature-voice-cloud-service" className={settingsInputClass} disabled={disabled}
                  value={voiceServiceUnset ? '' : voiceService}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === 'core' || value === 'gemini') setSetting.mutate({ key: 'voiceCloudService', value })
                  }}>
                  {voiceServiceUnset && <option value="" disabled>Choose…</option>}
                  {(['core', 'gemini'] as const).map((service) => <option key={service} value={service}>{VOICE_SERVICE_LABEL[service]}</option>)}
                </select>
              </div>
            )}
            {voiceService === 'gemini' && voiceCloudProviders.length > 1 && (
              <div className={`mt-3 ${settingsDropdownRowClass}`}>
                <SettingsLabel htmlFor="feature-voice-cloud-provider" info="The Gemini provider whose API key cloud transcription uses and bills.">Gemini provider</SettingsLabel>
                <select id="feature-voice-cloud-provider" className={settingsInputClass} disabled={disabled}
                  title={voiceCloudProvider?.name}
                  value={voiceCloudProvider?.id ?? ''}
                  onChange={(event) => setSetting.mutate({ key: 'voiceCloudProviderId', value: event.target.value })}>
                  {voiceCloudProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </div>
            )}
            {/* Only where it matters: a mode is on (then it is broken), or there is
                no on-device engine (it is the way in). With Off on a Mac it is in the (?). */}
            {voiceCloudMissing && (
              <div className="mt-3">
                <SettingsStatusRow
                  tone={voiceCloudMode === 'off' ? 'neutral' : 'warning'}
                  label="No Gemini credential"
                  action={<SettingsButton onClick={openAiCredentials}>Open AI Credentials</SettingsButton>}
                />
              </div>
            )}
          </SettingsRow>
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
            id="feature-desktop-notifications"
            label="Desktop notifications"
            description="Notify when a chat or task you started finishes, needs your input, or fails while Cinna is in the background."
            checked={desktopNotifications}
            disabled={disabled}
            onToggle={() => {
              if (!settings || disabled) return
              setSetting.mutate({ key: 'desktopNotifications', value: !desktopNotifications })
            }}
            title={desktopNotifications ? 'Desktop notifications are on' : 'Desktop notifications are off'}
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
            id="feature-local-data-all-profiles"
            label="Show local agents and chats in all profiles"
            description="On: chats made while signed out, or with local agents or chat modes, appear in every profile, so signing out keeps them. Off: each chat stays in the profile it was started in. Local agents are available in every profile either way."
            checked={showLocalDataInAllProfiles}
            disabled={disabled}
            onToggle={() => {
              if (!settings || disabled) return
              setSetting.mutate({ key: 'showLocalDataInAllProfiles', value: !showLocalDataInAllProfiles })
            }}
            title={showLocalDataInAllProfiles ? 'Local chats appear in every profile' : 'Chats stay in the profile they were started in'}
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

      {/* macOS only; renders nothing elsewhere. */}
      <FinderQuickActionSection />
    </div>
  )
}
