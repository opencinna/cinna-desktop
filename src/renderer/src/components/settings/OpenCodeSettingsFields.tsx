import { useRef, useState } from 'react'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { useEngineBinary } from '../../hooks/useEngine'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsInfoTip, SettingsLabel, settingsControlRowClass, settingsInputClass } from './SettingsLayout'

/** OpenCode executable override in Local Development → Developer Tools. */
export function OpenCodeSettingsFields(): React.JSX.Element {
  const { data: appSettings } = useAppSettings()
  const setAppSetting = useSetAppSetting()
  const { data: binary } = useEngineBinary()
  const savedEnginePath = appSettings?.localAgentsEnginePath ?? ''
  // null follows the query. A draft, including an empty one, belongs to the user.
  const [draftPath, setDraftPath] = useState<string | null>(null)
  const enginePath = draftPath ?? savedEnginePath
  const [enginePathError, setEnginePathError] = useState<string | null>(null)
  /**
   * A saved path is not what the row above is describing yet.
   *
   * The resolution is memoised per configured path, so a change takes effect
   * the next time something asks — the next turn, or *Try again* — and until
   * then the row still names the binary that was found for the old path.
   * Saying so beats leaving the user to wonder why the version line did not
   * move. (Under the shared engine this also meant "the running process is
   * still the old one"; there is no shared process now, and each agent's child
   * is replaced on its next turn because the path feeds the launch spec's key.)
   */
  const enginePathPending =
    binary?.state === 'ready' &&
    (savedEnginePath !== ''
      ? savedEnginePath !== binary.path || binary.source !== 'configured'
      : binary.source === 'configured')

  /**
   * Set by Escape just before it blurs the field. `onBlur` runs `commitEnginePath`
   * synchronously, in the same closure — with the value the user was typing,
   * not the reset that React has only just scheduled — so
   * without this Escape *saved* the half-typed path it was meant to throw away.
   */
  const discardingRef = useRef(false)
  const commitEnginePath = (): void => {
    if (discardingRef.current) {
      discardingRef.current = false
      return
    }
    const next = enginePath.trim()
    if (next === savedEnginePath) {
      setDraftPath(null)
      return
    }
    setDraftPath(next)
    setEnginePathError(null)
    setAppSetting.mutate(
      { key: 'localAgentsEnginePath', value: next },
      {
        onSuccess: () => {
          setDraftPath((current) => current === next ? null : current)
        },
        onError: (err) => {
          setEnginePathError(unwrapIpcError(err, 'That engine path could not be saved.'))
        }
      }
    )
  }

  return (
    <div className="mt-3 border-t border-[var(--color-border)]">
      <div className="py-3">
        <div className={settingsControlRowClass}>
          <div className="flex items-center gap-1.5">
            <SettingsLabel htmlFor="local-agents-engine-path">OpenCode Path</SettingsLabel>
            <SettingsInfoTip label="About the OpenCode Path">
              <p>
                Point Cinna at a specific <code className="font-mono">opencode</code> executable.
                An absolute path, and it overrides both your <code className="font-mono">PATH</code>{' '}
                and the copy Cinna downloads. Leave it empty for the normal behaviour: Cinna uses an{' '}
                <code className="font-mono">opencode</code> on your PATH if you have one, and
                downloads a verified copy if you do not.
              </p>
              <p>
                Whether the file exists is checked the next time an agent runs, or when you retry
                a failed runtime in Settings → Agents → Runtime.
              </p>
            </SettingsInfoTip>
          </div>
          <input
            id="local-agents-engine-path"
            type="text"
            value={enginePath}
            spellCheck={false}
            placeholder="/usr/local/bin/opencode"
            onChange={(event) => {
              setDraftPath(event.target.value)
              setEnginePathError(null)
            }}
            onBlur={commitEnginePath}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setDraftPath(null)
                setEnginePathError(null)
                discardingRef.current = true
                event.currentTarget.blur()
              }
            }}
            className={`${settingsInputClass} font-mono`}
          />
        </div>
        {/* Every message this field can produce, below it and last in the
            card, rendered only while it exists: both are consequences of an
            action, so their arrival lengthens the card under the control and
            moves nothing above it. An always-present slot was empty in the
            healthy state, which is padding, not a reservation (ux_rules
            rules 1 and 12). */}
        {enginePathError ? (
          <p className="mt-1.5 text-[13px] text-[var(--color-danger)]">{enginePathError}</p>
        ) : enginePathPending ? (
          <p className="mt-1.5 text-[13px] text-[var(--color-warning)]">
            Used from the next agent run. The status above is still the old path.
          </p>
        ) : null}
      </div>
    </div>
  )
}
