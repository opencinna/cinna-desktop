import { PINNED_CLAUDE_VERSION } from '../../../../shared/engine'
import { useClaudeBinary } from '../../hooks/useEngine'
import { RuntimePathField } from './RuntimePathField'

/**
 * Claude Code executable override in Local Development → Developer Tools, under
 * the OpenCode and Codex ones and built from the same field.
 *
 * The tip carries the one thing a user needs before setting this: the override
 * is **unverified**. Cinna normally runs every Claude session on the version it
 * was tested against; a path here is run as-is.
 */
export function ClaudeSettingsFields(): React.JSX.Element {
  const { data: binary } = useClaudeBinary()
  return (
    <RuntimePathField
      id="local-agents-claude-path"
      settingKey="localAgentsClaudePath"
      label="Claude Path"
      tipLabel="About the Claude Path"
      placeholder="/usr/local/bin/claude"
      binary={binary}
      saveErrorFallback="That Claude path could not be saved."
      stacked
      tip={
        <>
          <p>
            Leave this empty. Cinna runs every Claude agent and chat on Claude Code{' '}
            {PINNED_CLAUDE_VERSION}, the version it was tested against: your own install when it is
            exactly that version, otherwise a copy Cinna downloads and verifies. Any other{' '}
            <code className="font-mono">claude</code> on your <code className="font-mono">PATH</code>{' '}
            is only what “Open in Claude Code” launches.
          </p>
          <p>
            An absolute path here replaces that and is <strong>not verified</strong>: whatever
            version it is runs your agents. Use it on a platform Cinna has no build for, or to try
            a newer Claude Code. Your Claude login is the same either way.
          </p>
        </>
      }
    />
  )
}
