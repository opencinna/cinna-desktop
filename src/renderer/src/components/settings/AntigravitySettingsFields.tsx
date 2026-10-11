import { PINNED_ANTIGRAVITY_VERSION } from '../../../../shared/engine'
import { useAntigravityBinary } from '../../hooks/useEngine'
import { RuntimePathField } from './RuntimePathField'

/**
 * Antigravity server override in Local Development → Developer Tools, under the
 * Codex and Claude ones and built from the same field.
 *
 * As for Codex, the tip says the one thing a user needs before setting this:
 * the override is **unverified**. A configured server's version is never checked,
 * so nothing says which version a configured file is.
 */
export function AntigravitySettingsFields(): React.JSX.Element {
  const { data: binary } = useAntigravityBinary()
  return (
    <RuntimePathField
      id="local-agents-antigravity-path"
      settingKey="localAgentsAntigravityPath"
      label="Antigravity Path"
      tipLabel="About the Antigravity Path"
      placeholder="/opt/antigravity/agy_acp_server.par"
      binary={binary}
      saveErrorFallback="That Antigravity path could not be saved."
      stacked
      tip={
        <>
          <p>
            Leave this empty. Cinna downloads and verifies Google’s Antigravity server{' '}
            {PINNED_ANTIGRAVITY_VERSION}, the version it was tested against, and runs every
            Antigravity agent and chat on that copy.
          </p>
          <p>
            An absolute path to an <code className="font-mono">agy_acp_server.par</code> here
            replaces the managed copy and is <strong>not verified</strong>: its version isn’t
            checked, so whatever it is runs your agents. Its{' '}
            <code className="font-mono">localharness_external</code> must sit beside it. Your Google
            login is the same either way.
          </p>
        </>
      }
    />
  )
}
