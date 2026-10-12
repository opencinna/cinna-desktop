import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, Search, X } from 'lucide-react'
import { useAuthStore } from '../../../stores/auth.store'
import { useCatalogEntries } from '../../../hooks/useCatalogEntries'
import { useAddCatalogSkill, useCatalogSkillAdds } from '../../../hooks/useCatalogSkills'
import { CATALOG_SKILL_TEXT, CATALOG_TEXT, matchesCatalogQuery } from '../../../utils/catalogItems'
import { CatalogItemDetailView, CatalogItemTile, PRIMARY, SECONDARY, type CatalogEntryView } from '../CatalogItemViews'
import { CatalogListBody, CatalogRefreshFailure, useCatalogReauth } from '../CatalogBrowserParts'
import { CATALOG_POPOVER_ATTR } from '../CatalogSkillAddMenu'

/**
 * Add for one catalog skill into this agent, and its refusal. The add is keyed
 * by the package in the mutation cache, so it outlives the modal closing and a
 * reopened modal still shows `Adding…` or the refusal on this skill.
 */
function useSkillAdd(view: CatalogEntryView, agentId: string): { action: React.JSX.Element; error: string | null } {
  const add = useAddCatalogSkill(view.item.uuid)
  const adds = useCatalogSkillAdds(view.item.uuid, CATALOG_SKILL_TEXT.addFailed)
  const state = adds.byAgent.get(agentId)
  const blocked = view.skillTargets.find((target) => target.agentId === agentId)?.blocked ?? null
  const adding = state?.status === 'pending'
  // A landed add shows as Added before the rescan brings the pin in.
  const added = blocked === 'added' || state?.status === 'added'
  const error = !adding && state?.status === 'refused' ? state.message : null
  const [label, ariaLabel] = added
    ? [CATALOG_SKILL_TEXT.added, `${view.name} added`]
    : adding
      ? [CATALOG_SKILL_TEXT.adding, `Adding ${view.name}…`]
      : blocked === 'checking'
        ? [CATALOG_SKILL_TEXT.checkingAccess, CATALOG_SKILL_TEXT.checkingAccess]
        : ['Add', CATALOG_SKILL_TEXT.addTo(view.name, 'this agent')]
  const action = (
    <button type="button" aria-label={ariaLabel} disabled={added || adding || blocked !== null}
      onClick={() => add.mutate({ agentId, packageUuid: view.item.uuid })}
      className={added ? SECONDARY : PRIMARY}>
      {added ? <Check size={11} aria-hidden /> : adding ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
      {label}
    </button>
  )
  return { action, error }
}

/** One skill in the grid: the catalog's own tile, with Add as its action. */
function SkillTile({ view, agentId, onSelect }: { view: CatalogEntryView; agentId: string; onSelect: () => void }): React.JSX.Element {
  const { action, error } = useSkillAdd(view, agentId)
  return <CatalogItemTile view={view} action={action} error={error} onSelect={onSelect} />
}

/** One skill's detail, over the grid: the catalog's own detail, with Add. */
function SkillDetail({ view, agentId, onBack }: { view: CatalogEntryView; agentId: string; onBack: () => void }): React.JSX.Element {
  const { action, error } = useSkillAdd(view, agentId)
  return <CatalogItemDetailView view={view} action={action} error={error} onBack={onBack} />
}

/**
 * Adds catalog skills to one kit agent: every skill the active Cinna account's
 * catalog lists, each pinned into this agent's `cinna-agent.json` with Add.
 * The same listing and the same add as the catalog's Add to agent…, from the
 * agent's side.
 *
 * Each skill is the catalog's own tile and detail (ux_rules rule 13), with
 * Add as its action. Adding keeps the modal open and turns Add into a disabled
 * "Added", as the connector picker does; the agent's Skills section is where
 * the pinned skill's download and credentials are shown.
 */
export function SkillAddModal({ open, agentId, onClose }: {
  open: boolean
  agentId: string
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null
  return <SkillAddModalBody agentId={agentId} onClose={onClose} />
}

/** Mounted only while open: the catalog is read again when the modal opens, as the catalog dialog does. */
function SkillAddModalBody({ agentId, onClose }: { agentId: string; onClose: () => void }): React.ReactPortal {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const { catalog, views } = useCatalogEntries({ refresh: true })
  const reauth = useCatalogReauth(catalog)
  const [query, setQuery] = useState('')
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
  // Read inside the window listener, which is bound once.
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedUuid
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Escape steps back from a skill's detail first, as in the catalog.
      e.preventDefault()
      if (selectedRef.current) setSelectedUuid(null)
      else onClose()
    }
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // A dialog the detail portaled out (a skill's People) is still this modal.
      if (target instanceof Element && target.closest(`[${CATALOG_POPOVER_ATTR}]`)) return
      if (cardRef.current && !cardRef.current.contains(target)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onMouseDown) }
  }, [onClose])

  const skills = useMemo(() => views.filter((view) => view.kind === 'skill'), [views])
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => skills.filter((view) => matchesCatalogQuery(view.item, needle)), [skills, needle])
  // Null once a refresh has dropped the skill, which falls back to the grid.
  const selected = selectedUuid ? (skills.find((view) => view.item.uuid === selectedUuid) ?? null) : null

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Add skill" className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div ref={cardRef} className="w-full max-w-[34rem] h-[32rem] rounded-xl shadow-2xl flex flex-col overflow-hidden
          bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/4
          backdrop-blur-xl
          border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12">
        <div className="flex items-center gap-3 px-4 pt-3.5 pb-2">
          <div className="shrink-0 text-sm font-semibold text-[var(--color-text)]">Add skill from the catalog</div>
          {/* In the header's one line: a failed refresh over a cached grid moves nothing below it (rule 1). */}
          <div className="min-w-0 flex-1">{isCinnaUser && <CatalogRefreshFailure catalog={catalog} reauth={reauth} />}</div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"><X size={14} /></button>
        </div>
        {!isCinnaUser ? (
          <div className="px-4 pb-4 flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">{CATALOG_TEXT.signedOut}</div>
        ) : <div className="relative flex-1 min-h-0 flex flex-col">
          <div className="px-4 pb-3">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" placeholder="Search skills…"
                className="w-full bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-accent)]/20 focus:border-[var(--color-accent)] focus:outline-none placeholder:text-[var(--color-text-muted)]" />
            </div>
          </div>
          <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0">
            <CatalogListBody catalog={catalog} reauth={reauth} filter="skills" inFilterCount={skills.length} shownCount={shown.length}>
              <div className="grid grid-cols-2 gap-2">
                {shown.map((view) => (
                  <SkillTile key={view.item.uuid} view={view} agentId={agentId} onSelect={() => setSelectedUuid(view.item.uuid)} />
                ))}
              </div>
            </CatalogListBody>
          </div>
          {selected && <SkillDetail key={selected.item.uuid} view={selected} agentId={agentId} onBack={() => setSelectedUuid(null)} />}
        </div>}
      </div>
    </div>,
    document.body
  )
}
