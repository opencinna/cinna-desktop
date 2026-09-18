import { useRef, useState } from 'react'
import type { EngineBinaryState } from '../../../../shared/engine'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsInfoTip, SettingsLabel, settingsControlRowClass, settingsInputClass } from './SettingsLayout'

/** The two settings that name an executable a runtime is run from. */
type RuntimePathKey = 'localAgentsEnginePath' | 'localAgentsCodexPath'

/**
 * An "explicit executable path" field for one runtime.
 *
 * Extracted from the OpenCode Path field when Codex gained the same override,
 * because the part worth having once is not the markup — it is the draft /
 * blur / Escape handling, where Escape used to *save* the half-typed path it
 * was meant to throw away. Two copies of that is two places to reintroduce it.
 *
 * Behaviour, unchanged from the original: the value is committed on blur or
 * Enter and discarded on Escape; nothing validates per keystroke; and the only
 * messages are consequences of an action, rendered below the control and last
 * in the card, so their arrival moves nothing above them (ux_rules rules 1, 6
 * and 12).
 */
export function RuntimePathField({
  id,
  settingKey,
  label,
  tipLabel,
  tip,
  placeholder,
  binary,
  saveErrorFallback,
  pendingMessage,
  stacked = false
}: {
  id: string
  settingKey: RuntimePathKey
  label: string
  tipLabel: string
  tip: React.ReactNode
  placeholder: string
  /** The resolved binary state the status row elsewhere is describing. */
  binary: EngineBinaryState | undefined
  saveErrorFallback: string
  /**
   * Shown while the saved path is not yet what the status row describes.
   * Omitted by a field whose runtime is re-resolved the moment its path is
   * saved (Codex): there is no such interval to describe, and a line that
   * appeared for one frame between the save and main's push would lengthen the
   * card and take it back (ux_rules rule 1).
   */
  pendingMessage?: string
  /**
   * Directly under another path field. The first field's `mt-3` separates it
   * from the table above; repeated on a second field it would put 24px above
   * that field's divider and 12px below it.
   */
  stacked?: boolean
}): React.JSX.Element {
  const { data: appSettings } = useAppSettings()
  const setAppSetting = useSetAppSetting()
  const savedPath = appSettings?.[settingKey] ?? ''
  // null follows the query. A draft, including an empty one, belongs to the user.
  const [draftPath, setDraftPath] = useState<string | null>(null)
  const path = draftPath ?? savedPath
  const [pathError, setPathError] = useState<string | null>(null)
  /**
   * A saved path is not what the status row is describing yet.
   *
   * For OpenCode the resolution is memoised per configured path and nothing
   * re-resolves on save, so a change takes effect the next time a turn asks —
   * and until then the row still names the binary that was found for the old
   * path. Saying so beats leaving the user to wonder why the version line did
   * not move. (Not *Try again*: that action exists only on a **failed** row,
   * and this message only on a **ready** one, so it is never reachable from
   * here.) Each agent's child is replaced on its next turn, because the path
   * feeds the launch spec's key.
   *
   * Codex passes no `pendingMessage`: main re-resolves when its path is saved
   * (`engine.ipc.ts`), so the status row follows the save by itself — out of a
   * failed install's red included — and there is nothing pending to announce.
   */
  const pathPending =
    pendingMessage !== undefined &&
    binary?.state === 'ready' &&
    (savedPath !== ''
      ? savedPath !== binary.path || binary.source !== 'configured'
      : binary.source === 'configured')

  /**
   * Set by Escape just before it blurs the field. `onBlur` runs `commitPath`
   * synchronously, in the same closure — with the value the user was typing,
   * not the reset that React has only just scheduled — so without this Escape
   * *saved* the half-typed path it was meant to throw away.
   */
  const discardingRef = useRef(false)
  const commitPath = (): void => {
    if (discardingRef.current) {
      discardingRef.current = false
      return
    }
    const next = path.trim()
    if (next === savedPath) {
      setDraftPath(null)
      return
    }
    setDraftPath(next)
    setPathError(null)
    setAppSetting.mutate(
      { key: settingKey, value: next },
      {
        onSuccess: () => {
          setDraftPath((current) => (current === next ? null : current))
        },
        onError: (err) => {
          setPathError(unwrapIpcError(err, saveErrorFallback))
        }
      }
    )
  }

  return (
    <div className={`${stacked ? '' : 'mt-3 '}border-t border-[var(--color-border)]`}>
      <div className="py-3">
        <div className={settingsControlRowClass}>
          <div className="flex items-center gap-1.5">
            <SettingsLabel htmlFor={id}>{label}</SettingsLabel>
            <SettingsInfoTip label={tipLabel}>{tip}</SettingsInfoTip>
          </div>
          <input
            id={id}
            type="text"
            value={path}
            spellCheck={false}
            placeholder={placeholder}
            onChange={(event) => {
              setDraftPath(event.target.value)
              setPathError(null)
            }}
            onBlur={commitPath}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setDraftPath(null)
                setPathError(null)
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
        {pathError ? (
          <p className="mt-1.5 text-[13px] text-[var(--color-danger)]">{pathError}</p>
        ) : pathPending ? (
          <p className="mt-1.5 text-[13px] text-[var(--color-warning)]">{pendingMessage}</p>
        ) : null}
      </div>
    </div>
  )
}
