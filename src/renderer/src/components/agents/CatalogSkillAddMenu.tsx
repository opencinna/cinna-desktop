import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Loader2 } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { isUnsettledClick } from '../../hooks/useSettleGuard'
import { useAddCatalogSkill, useCatalogSkillAdds } from '../../hooks/useCatalogSkills'
import { CATALOG_SKILL_TEXT } from '../../utils/catalogItems'

/**
 * One of the user's kit agents as the picker lists it, and why it cannot take
 * the skill: it already has it (`added`), it is shared with the user to use
 * only or with access not known (`read_only` — its skills arrive with the
 * team's next version), or which it is has not been read yet (`checking`).
 * Decided from what the renderer already holds; main decides again on every
 * add.
 */
export interface CatalogSkillTarget {
  agentId: string
  name: string
  blocked: 'added' | 'read_only' | 'checking' | null
}

/**
 * Marks a surface portaled out of the catalog dialog that still belongs to it:
 * the dialog's outside-click close ignores a press inside one.
 */
export const CATALOG_POPOVER_ATTR = 'data-catalog-popover'

const TRIGGER =
  'inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium ' +
  'bg-[var(--color-accent)] text-white transition-colors hover:bg-[var(--color-accent-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40'
const ROW =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text)] ' +
  'transition-colors enabled:hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed'

/**
 * "Add to agent…" on a catalog skill: a menu of the user's kit agents, one
 * click to pin the skill's latest version into one of them.
 *
 * An agent that cannot take it is listed disabled with the reason in its row,
 * so the list says the same thing for every agent the user has. A pick runs
 * inline — that row reads `Adding…`, the others wait — and the menu closes on
 * success only; a refusal stays under the row it was for, in main's sentence
 * (ux_rules rule 6). A refusal landing after the menu was closed reopens it,
 * so no failure goes unsaid.
 *
 * Portaled (rule 8), so it is marked as part of the catalog dialog, and while
 * it is open Escape closes it rather than the dialog.
 */
export function CatalogSkillAddMenu({
  skillName,
  packageUuid,
  targets,
  settled
}: {
  skillName: string
  packageUuid: string
  targets: CatalogSkillTarget[]
  /** False right after the detail opened: a pointer click is then ignored. */
  settled: boolean
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const add = useAddCatalogSkill(packageUuid)
  // From the mutation cache, not local state: the tile and the detail each
  // mount a menu, and an add outlives the one that started it.
  const adds = useCatalogSkillAdds(packageUuid, CATALOG_SKILL_TEXT.addFailed)
  const { open, setOpen } = menu
  const pending = [...adds.byAgent.values()].filter((state) => state.status === 'pending')
  const addingIds = new Set(pending.map((state) => state.agentId))
  const busy = addingIds.size > 0

  // Escape closes the menu first; the dialog's own Escape (detail, then
  // dialog) listens on window in the bubble phase, after this.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      setOpen(false)
      menu.triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen, menu.triggerRef])

  // An add this menu saw in flight that has now landed: success closes the
  // menu, a refusal (re)opens it so no failure goes unsaid.
  const seenPending = useRef<Set<string>>(addingIds)
  const settledKey = [...adds.byAgent.values()].map((state) => `${state.agentId}:${state.status}:${state.submittedAt}`).join('|')
  useEffect(() => {
    let refused = false
    let added = false
    for (const agentId of seenPending.current) {
      const state = adds.byAgent.get(agentId)
      if (state?.status === 'refused') refused = true
      else if (state?.status === 'added') added = true
    }
    seenPending.current = new Set(addingIds)
    if (refused) setOpen(true)
    else if (added) setOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey])

  // A refusal belongs to one opening of the menu: closing it with nothing in
  // flight drops what landed.
  const { consume } = adds
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open && !busy) consume()
    wasOpen.current = open
  }, [open, busy, consume])

  const pick = (target: CatalogSkillTarget): void => {
    if (busy || target.blocked !== null) return
    add.mutate({ agentId: target.agentId, packageUuid })
  }

  const reasonText = (target: CatalogSkillTarget): string | null =>
    target.blocked === 'added'
      ? CATALOG_SKILL_TEXT.added
      : target.blocked === 'read_only'
        ? CATALOG_SKILL_TEXT.canUseOnly
        : target.blocked === 'checking'
          ? CATALOG_SKILL_TEXT.checkingAccess
          : null

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          if (!isUnsettledClick(settled, event)) setOpen(!open)
        }}
        className={TRIGGER}
      >
        {CATALOG_SKILL_TEXT.addToAgent}
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label={CATALOG_SKILL_TEXT.menuLabel(skillName)}
            {...{ [CATALOG_POPOVER_ATTR]: '' }}
            style={menu.style}
            className="app-popover-surface z-[60] max-h-72 w-64 overflow-y-auto rounded-lg border border-[var(--color-border)] p-1 shadow-xl"
          >
            {targets.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">{CATALOG_SKILL_TEXT.noAgents}</div>
            ) : (
              targets.map((target) => {
                const reason = reasonText(target)
                const adding = addingIds.has(target.agentId)
                const state = adds.byAgent.get(target.agentId)
                const rowError = !adding && state?.status === 'refused' ? state.message : null
                return (
                  <div key={target.agentId}>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={reason !== null || busy}
                      aria-disabled={reason !== null || busy}
                      aria-busy={adding}
                      title={
                        target.blocked === 'read_only'
                          ? `${target.name}: ${CATALOG_SKILL_TEXT.canUseOnlyTitle}`
                          : reason
                            ? `${target.name}: ${reason}`
                            : CATALOG_SKILL_TEXT.addTo(skillName, target.name)
                      }
                      onClick={() => pick(target)}
                      className={ROW}
                    >
                      <span className={`min-w-0 flex-1 truncate ${reason ? 'text-[var(--color-text-muted)]' : ''}`}>
                        {target.name}
                      </span>
                      {adding ? (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                          {CATALOG_SKILL_TEXT.adding}
                        </span>
                      ) : reason ? (
                        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{reason}</span>
                      ) : null}
                    </button>
                    {rowError && (
                      <div role="alert" className="px-2 pb-1.5 text-[10px] text-[var(--color-danger)]">
                        {rowError}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>,
          document.body
        )}
    </>
  )
}
