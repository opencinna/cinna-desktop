import { useEffect, useRef } from 'react'
import { useFinderQuickActionStatus, useSetFinderQuickAction } from '../../hooks/useFinderQuickAction'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsButton, SettingsRow, SettingsRows, SettingsSection, SettingsToggleRow } from './SettingsLayout'

/**
 * Features → Finder (macOS only): the "Mention in Cinna" Quick Action, which
 * sends files and folders selected in Finder to the new-chat composer as
 * reference chips. The switch is whether the workflow is installed in
 * `~/Library/Services`.
 *
 * A failure, and an installed copy that is out of date, are rows of their own
 * under the switch, rendered only while true: they lengthen the list and move
 * nothing above them (ux_rules rule 1).
 */
export function FinderQuickActionSection(): React.JSX.Element | null {
  const status = useFinderQuickActionStatus()
  const setInstalled = useSetFinderQuickAction()
  const errorRef = useRef<HTMLParagraphElement>(null)

  const busy = setInstalled.isPending
  const failure = setInstalled.data && !setInstalled.data.success ? setInstalled.data.error : null
  const thrown = setInstalled.error ? unwrapIpcError(setInstalled.error, 'Could not change the Quick Action.') : null
  const error = failure ?? thrown

  // The last section of the tab: at the default window size a new error row
  // renders below the window edge, where nobody would see the switch's answer.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [error])

  if (!status?.supported) return null

  return (
    <SettingsSection title="Finder">
      <SettingsRows insetDividers>
        <SettingsToggleRow
          id="feature-finder-mention"
          label="Mention in Cinna"
          description="Right-click a file or folder in Finder → Quick Actions or Services → Mention in Cinna."
          checked={status.installed}
          disabled={busy}
          onToggle={() => { if (!busy) setInstalled.mutate(!status.installed) }}
          title={status.installed ? 'Mention in Cinna is in Finder’s Quick Actions' : 'Mention in Cinna is not installed'}
        />
        {status.installed && status.outdated && (
          <SettingsRow className="flex items-center justify-between gap-3">
            <div className="min-w-0 truncate text-[13px] text-[var(--color-text-muted)]">
              Installed from an older Cinna.
            </div>
            <SettingsButton onClick={() => setInstalled.mutate(true)} disabled={busy}>
              {busy && setInstalled.variables === true ? 'Updating…' : 'Update'}
            </SettingsButton>
          </SettingsRow>
        )}
        {error && (
          <SettingsRow className="text-[13px] text-[var(--color-danger)]">
            <p ref={errorRef} role="alert">{error}</p>
          </SettingsRow>
        )}
      </SettingsRows>
    </SettingsSection>
  )
}
