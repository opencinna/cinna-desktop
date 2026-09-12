import { useState } from 'react'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsCard, SettingsLabel, settingsInputClass } from './SettingsLayout'

export function TaskConcurrencySetting(): React.JSX.Element {
  const settings = useAppSettings()
  const save = useSetAppSetting()
  const [error, setError] = useState<string | null>(null)
  // A failure to read or to save is the only thing under the control, and it is
  // rendered only while it exists, last in the card: a slot reserved for it was
  // empty in the healthy state, which is padding rather than a reservation
  // (ux_rules rules 1 and 12).
  const message = error ?? (settings.isError ? 'The current limit could not be read.' : null)
  return <SettingsCard>
    <SettingsLabel
      htmlFor="task-runner-concurrency"
      info={<p>Limit how many tasks and agent turns can run at once on this device. A busy agent waits until its current turn finishes.</p>}
    >
      Autonomous task concurrency
    </SettingsLabel>
    <select id="task-runner-concurrency" className={`${settingsInputClass} mt-1.5`}
      disabled={!settings.data || settings.isError || save.isPending} value={settings.data?.taskRunnerConcurrency ?? 2}
      onChange={(event) => {
        setError(null)
        void save.mutateAsync({ key: 'taskRunnerConcurrency', value: Number(event.target.value) })
          .catch((cause) => setError(unwrapIpcError(cause, 'The limit could not be saved.')))
      }}>
      {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
    </select>
    {message && (
      <div role="alert" className="mt-1.5 text-[13px] text-[var(--color-danger)]">{message}</div>
    )}
  </SettingsCard>
}
