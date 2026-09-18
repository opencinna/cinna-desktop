import { PINNED_CODEX_VERSION } from '../../../../shared/engine'
import { useCodexBinary } from '../../hooks/useEngine'
import { RuntimePathField } from './RuntimePathField'

/**
 * Codex executable override in Local Development → Developer Tools, beside the
 * OpenCode one and built from the same field.
 *
 * The tip carries the one thing a user needs before setting this: the override
 * is **unverified**. Cinna normally runs every Codex session on the version it
 * was tested against; a path here is run as-is, and the restricted plain-chat
 * and AI-function sessions refuse any version but the pinned one.
 */
export function CodexSettingsFields(): React.JSX.Element {
  const { data: binary } = useCodexBinary()
  return (
    <RuntimePathField
      id="local-agents-codex-path"
      settingKey="localAgentsCodexPath"
      label="Codex Path"
      tipLabel="About the Codex Path"
      placeholder="/usr/local/bin/codex"
      binary={binary}
      saveErrorFallback="That Codex path could not be saved."
      stacked
      tip={
        <>
          <p>
            Leave this empty. Cinna downloads and verifies Codex {PINNED_CODEX_VERSION}, the version
            it was tested against, and runs every Codex agent and chat on that copy. The{' '}
            <code className="font-mono">codex</code> on your <code className="font-mono">PATH</code>{' '}
            is only what “Open in Codex” launches.
          </p>
          <p>
            An absolute path here replaces the managed copy and is <strong>not verified</strong>:
            whatever version it is runs your folder agents, while plain Codex chats and AI
            functions refuse any version but {PINNED_CODEX_VERSION}. Use it on a platform Cinna has
            no build for, or to try a newer Codex. Your Codex login is the same either way.
          </p>
        </>
      }
    />
  )
}
