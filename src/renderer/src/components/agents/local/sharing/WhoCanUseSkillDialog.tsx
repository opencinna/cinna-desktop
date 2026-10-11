import { useEffect, useRef } from 'react'
import { useCatalogItems } from '../../../../hooks/useCatalog'
import { useItemPeople, useSetItemPeople } from '../../../../hooks/useSharing'
import { SKILL_SHARE_TEXT } from '../../../../utils/catalogItems'
import { SHARE_UI_TEXT } from '../../../../utils/shareText'
import { DialogShell, SECONDARY } from './ShareDialogs'
import { PeopleSection, usePeopleEditor } from './PeopleSection'

/**
 * Who can use a skill shared to the catalog, after its first share: the same
 * People list a shared desktop agent has on its Sharing tab (ux_rules rule
 * 13) — a row per grant with its access, Share with a person…, Share with
 * everyone — over the skill package's grants, addressed by its uuid.
 *
 * Opened from the Skills row of an authored skill the person maintains and
 * from the catalog's skill detail. The maintainers and the visibility come
 * from the catalog listing main keeps; a write re-lists it, so both surfaces
 * follow. The maintainers are named on a Maintainers line above the list, as
 * the Sharing tab's Where section names them: a co-maintainer has access
 * without a grant row, and would otherwise be nowhere.
 *
 * The dialog owns the write (hook-level, so its answer lands after a
 * re-render) and closes only on Close, Escape or an outside click — never on
 * a refusal, which shows beside the control it answered (rule 6), and not
 * while a write runs. Share with a person… replaces the list with its form
 * inside this dialog rather than stacking a second one; Escape there goes
 * back to the list. Top-aligned, so a list that grows moves only what is
 * below it.
 *
 * Escape is taken in the capture phase: opened from the catalog dialog, it
 * must not also step that dialog back from the detail. `overlayAttrs` marks
 * the backdrop as part of a surface that closes on an outside click.
 */
export function WhoCanUseSkillDialog({
  itemUuid,
  skillName,
  onClose,
  overlayAttrs
}: {
  /** The skill package's catalog uuid. */
  itemUuid: string
  skillName: string
  onClose: () => void
  overlayAttrs?: Record<string, string>
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const catalog = useCatalogItems()
  const uuid = itemUuid.toLowerCase()
  const item = catalog.data?.items.find((candidate) => candidate.kind === 'skill' && candidate.uuid.toLowerCase() === uuid) ?? null
  const people = useItemPeople(itemUuid, true)
  const editor = usePeopleEditor(SKILL_SHARE_TEXT.peopleNoAccess)
  const set = useSetItemPeople({ onResult: editor.onResult })
  const pending = set.isPending
  const { adding, setAdding } = editor

  const dismiss = (): void => {
    if (pending) return
    if (adding) setAdding(false)
    else onClose()
  }
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // An open list (the people search's answers) closes itself first.
      const target = event.target as HTMLElement | null
      if (target?.getAttribute?.('aria-expanded') === 'true') return
      event.stopImmediatePropagation()
      dismissRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const maintainers = (item?.maintainers ?? []).flatMap((m) =>
    m?.user_id ? [{ userId: m.user_id, displayName: m.display_name || m.user_id }] : []
  )
  return (
    <DialogShell
      title={SKILL_SHARE_TEXT.whoCanUseTitle(skillName)}
      pending={pending}
      onDismiss={dismiss}
      initialFocusRef={closeRef}
      width="w-[32rem]"
      align="top"
      overlayAttrs={overlayAttrs}
    >
      <div data-who-can-use className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-0.5">
        {maintainers.length > 0 && !adding && (
          <dl data-who-can-use-maintainers className="mb-4 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 text-[13px]">
            <dt className="text-[var(--color-text-muted)]">{SHARE_UI_TEXT.maintainersLabel}</dt>
            <dd className="min-w-0 truncate text-[var(--color-text)]" title={maintainers.map((m) => m.displayName).join(', ')}>
              {maintainers.map((m) => m.displayName).join(', ')}
            </dd>
          </dl>
        )}
        <PeopleSection
          people={people}
          maintainers={maintainers}
          visibility={item?.visibility ?? null}
          editor={editor}
          pending={pending}
          onSave={(next) => set.mutate({ itemUuid, people: next }, { onError: editor.onError })}
          inlineAdd
          maintainersShown={maintainers.length > 0}
        />
      </div>
      {!adding && (
        <div className="flex justify-end">
          <button ref={closeRef} type="button" onClick={onClose} disabled={pending} className={SECONDARY}>
            {SKILL_SHARE_TEXT.close}
          </button>
        </div>
      )}
    </DialogShell>
  )
}
