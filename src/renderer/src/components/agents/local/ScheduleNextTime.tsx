import { useEffect, useState } from 'react'
import { unwrapIpcError } from '../../../utils/ipcError'

/** Review dialogs preview the future baseline in the explicitly saved zone. */
export function ScheduleNextTime({ cron, timezone }: { cron: string; timezone: string }) {
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)
  const key = `${cron}\n${timezone}`
  useEffect(() => {
    let active = true
    window.api.localSchedules.preview({ cron, timezone }).then(({ nextDueAt }) => {
      if (active) setPreview({ key, text: `Next scheduled time: ${new Date(nextDueAt).toLocaleString(undefined, { timeZone: timezone })} (${timezone})` })
    }).catch((cause) => {
      if (active) setPreview({ key, text: unwrapIpcError(cause, 'The next scheduled time could not be calculated.') })
    })
    return () => { active = false }
  }, [cron, timezone, key])
  return <p role="status" className="overflow-x-auto whitespace-nowrap text-[12px] text-[var(--color-text-secondary)]">{preview?.key === key ? preview.text : 'Checking the next scheduled time…'}</p>
}
