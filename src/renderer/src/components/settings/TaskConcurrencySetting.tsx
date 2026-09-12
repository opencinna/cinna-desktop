import { useState } from 'react'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsCard, SettingsHint, SettingsLabel, settingsInputClass } from './SettingsLayout'

export function TaskConcurrencySetting(): React.JSX.Element {
  const settings = useAppSettings()
  const save = useSetAppSetting()
  const [error, setError] = useState<string | null>(null)
  return <SettingsCard>
    <SettingsLabel>Autonomous task concurrency</SettingsLabel>
    <SettingsHint>Limit how many tasks and agent turns can run at once on this device. A busy agent waits until its current turn finishes.</SettingsHint>
    <select aria-label="Autonomous task concurrency" className={`${settingsInputClass} mt-2`}
      disabled={!settings.data || settings.isError || save.isPending} value={settings.data?.taskRunnerConcurrency ?? 2}
      onChange={(event) => {
        setError(null)
        void save.mutateAsync({ key: 'taskRunnerConcurrency', value: Number(event.target.value) })
          .catch((cause) => setError(unwrapIpcError(cause, 'The limit could not be saved.')))
      }}>
      {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
    </select>
    <div role="alert" className="min-h-[1.125rem] mt-1 text-[13px] text-[var(--color-danger)]">
      {error ?? (settings.isError ? 'The current limit could not be read.' : null)}
    </div>
  </SettingsCard>
}
