import { useEngineBinary } from '../../hooks/useEngine'
import { RuntimePathField } from './RuntimePathField'

/** OpenCode executable override in Local Development → Developer Tools. */
export function OpenCodeSettingsFields(): React.JSX.Element {
  const { data: binary } = useEngineBinary()
  return (
    <RuntimePathField
      id="local-agents-engine-path"
      settingKey="localAgentsEnginePath"
      label="OpenCode Path"
      tipLabel="About the OpenCode Path"
      placeholder="/usr/local/bin/opencode"
      binary={binary}
      saveErrorFallback="That engine path could not be saved."
      tip={
        <>
          <p>
            Point Cinna at a specific <code className="font-mono">opencode</code> executable.
            An absolute path, and it overrides both your <code className="font-mono">PATH</code>{' '}
            and the copy Cinna downloads. Leave it empty for the normal behaviour: Cinna uses an{' '}
            <code className="font-mono">opencode</code> on your PATH if you have one, and
            downloads a verified copy if you do not.
          </p>
          <p>Cinna checks the file as soon as you save the path.</p>
        </>
      }
    />
  )
}
