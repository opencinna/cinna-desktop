import { useProviders } from '../../hooks/useProviders'
import { useSetAppSetting } from '../../hooks/useAppSettings'
import { useClaudeApiCredential } from '../../hooks/useClaudeApiCredential'
import { SettingsLabel, SettingsRow, settingsInputClass } from './SettingsLayout'

/** `settingsInputClass` without its `w-full`, which would beat `w-48` in the built CSS. */
const SELECT_IN_LINE = settingsInputClass.replace(/(^|\s)w-full(\s|$)/, ' ').trim()

export const NO_ANTHROPIC_CREDENTIAL = 'No Anthropic AI credential found'

/**
 * **How Claude Agent signs in on this machine**: the user's own `claude` login
 * (Subscription) or an Anthropic AI credential (API Token). Shown under the
 * Default runtime cards while Claude Agent is the selected runtime.
 *
 * Two lines of fixed height: the segmented control alone beside the label,
 * then the credential select (when there is a choice to make) with a one-line
 * status filled in every state, so picking a mode or a credential moves
 * nothing (ux_rules rules 1 and 12).
 *
 * No key crosses here: the renderer sees `hasApiKey` only, and main decrypts
 * the picked credential at launch (`claudeAuthService`).
 */
export function ClaudeAuthModeRow(): React.JSX.Element {
  const { data: providers } = useProviders()
  const setAppSetting = useSetAppSetting()
  const { mode, chosenId, usable, inForce, chosenGone } = useClaudeApiCredential()
  const all = providers ?? []
  const staleChosen = chosenGone ? (all.find((p) => p.id === chosenId) ?? null) : null
  // Until providers load, nothing is claimed either way.
  const noCredential = providers !== undefined && usable.length === 0
  const showSelect = mode === 'api_key' && (usable.length > 1 || chosenGone) && usable.length > 0

  const status: { text: string; warning: boolean } = mode === 'subscription'
    ? { text: 'Turns run on your own Claude login and its plan.', warning: false }
    : inForce
      ? { text: `Turns bill to the owner of “${inForce.name}”.`, warning: false }
      : chosenGone
        ? { text: 'The chosen credential is gone — Claude Agent turns will not run.', warning: true }
        : providers === undefined
          ? { text: '', warning: false }
          : { text: `${NO_ANTHROPIC_CREDENTIAL} — Claude Agent turns will not run.`, warning: true }

  const choose = (value: 'subscription' | 'api_key'): void => {
    if (value === mode) return
    setAppSetting.mutate({ key: 'claudeAuthMode', value })
  }

  return (
    <SettingsRow>
      <div className="flex items-center justify-between gap-3">
        <SettingsLabel
          info={
            <>
              <p>
                <strong>Subscription</strong> runs every Claude Agent turn on the account your own{' '}
                <code>claude</code> is logged in to, and its plan pays.
              </p>
              <p>
                <strong>API Token</strong> runs them on an Anthropic AI credential from Settings →
                AI Credentials instead, and the key&apos;s owner is billed per token — including a
                credential your organisation shares with you. No login is needed.
              </p>
              <p>
                A setting of this machine: it applies to agents, chats and AI functions running on
                Claude Agent, and never changes an agent&apos;s folder.
              </p>
            </>
          }
        >
          Claude Agent signs in with
        </SettingsLabel>
        {/* The segments alone on the label's line, so they never move. */}
        <div role="group" aria-label="Claude Agent signs in with" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
          {(['subscription', 'api_key'] as const).map((value) => {
            const disabled = value === 'api_key' && noCredential && mode !== 'api_key'
            const button = (
              <button
                key={value}
                type="button"
                disabled={disabled}
                aria-pressed={mode === value}
                onClick={() => choose(value)}
                className={`rounded px-2.5 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  mode === value
                    ? 'app-nav-active text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)] enabled:hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                {value === 'subscription' ? 'Subscription' : 'API Token'}
              </button>
            )
            // A disabled button gets no pointer events, so its tooltip is on
            // a wrapper the pointer can still reach.
            return disabled ? (
              <span key={value} title={NO_ANTHROPIC_CREDENTIAL} className="flex">
                {button}
              </span>
            ) : (
              button
            )
          })}
        </div>
      </div>
      {/* Second line, one fixed height in every state: the credential select
          (when there is a choice to make) and the status beside it. */}
      <div className="mt-2 flex h-8 items-center gap-3">
        {showSelect && (
          <select
            aria-label="Anthropic credential for Claude Agent"
            value={inForce?.id ?? chosenId}
            onChange={(event) => setAppSetting.mutate({ key: 'claudeApiCredentialId', value: event.target.value })}
            title={inForce?.name ?? staleChosen?.name ?? undefined}
            className={`${SELECT_IN_LINE} w-48 shrink-0 py-1`}
          >
            {chosenGone && (
              <option value={chosenId}>{staleChosen ? `${staleChosen.name} — unavailable` : 'Unavailable credential'}</option>
            )}
            {usable.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        )}
        <p
          className={`min-w-0 flex-1 truncate text-[13px] leading-relaxed ${
            status.warning ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'
          }`}
          title={status.text || undefined}
        >
          {status.text}
        </p>
      </div>
    </SettingsRow>
  )
}
