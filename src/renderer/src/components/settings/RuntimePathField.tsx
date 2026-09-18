import { useRef, useState } from 'react'
import type { EngineBinaryState } from '../../../../shared/engine'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsInfoTip, SettingsLabel, settingsControlRowClass, settingsInputClass } from './SettingsLayout'

/** The settings that name an executable a runtime is run from. */
type RuntimePathKey = 'localAgentsEnginePath' | 'localAgentsCodexPath' | 'localAgentsClaudePath'

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
  /*
   * No "still the old path" note: main re-resolves every runtime the moment its
   * path is saved (`engine.ipc.ts`), so the status row follows the save by
   * itself, and a line shown for the one frame in between would lengthen the
   * card and take it back (ux_rules rule 1).
   */

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
        {/* Every message this field can produce, below it and last in its
            block, rendered only while it exists: each is a consequence of an
            action, so their arrival lengthens the card under the control and
            moves nothing above it. An always-present slot was empty in the
            healthy state, which is padding, not a reservation (ux_rules
            rules 1 and 12). */}
        {pathError ? (
          <p className="mt-1.5 text-[13px] text-[var(--color-danger)]">{pathError}</p>
        ) : binary?.state === 'failed' ? (
          // This runtime's failure, under the field that is the way out of it.
          // The three used to be stacked as unlabelled red paragraphs *above*
          // all three fields, where pressing Enter on a bad path moved the field
          // being edited down a line. One line, the whole sentence in `title`:
          // main's copy names the tool itself, so nothing here labels it again.
          // `pathError` where main has one: the shared `error` ends by sending
          // the user to Local Development, which is where this field is.
          <p className="mt-1.5 truncate text-[13px] text-[var(--color-danger)]" title={binary.pathError ?? binary.error}>
            {binary.pathError ?? binary.error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
