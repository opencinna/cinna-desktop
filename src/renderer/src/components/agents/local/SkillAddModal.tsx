import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Search, X } from 'lucide-react'
import { useAuthStore } from '../../../stores/auth.store'
import { useCatalogEntries } from '../../../hooks/useCatalogEntries'
import { useAddCatalogSkill, useCatalogSkillAdds } from '../../../hooks/useCatalogSkills'
import { CATALOG_SKILL_TEXT, CATALOG_TEXT, matchesCatalogQuery } from '../../../utils/catalogItems'
import { CatalogItemDetailView, CatalogItemTile, PRIMARY, SECONDARY, type CatalogEntryView } from '../CatalogItemViews'
import { CatalogListBody, CatalogRefreshFailure, useCatalogReauth } from '../CatalogBrowserParts'
import { CATALOG_POPOVER_ATTR } from '../CatalogSkillAddMenu'
import { MARKETPLACE_SKILL_TEXT } from '../../../utils/marketplaceSkills'
import { useMarketplaceSkillEntries } from '../../../hooks/useMarketplaceSkills'
import { useSkillAddSourceStore, type SkillSource } from '../../../stores/skillAddSource.store'
import { MarketplaceSkillsPane, SKILL_SEARCH_INPUT } from './MarketplaceSkillsPane'

const SOURCES: SkillSource[] = ['catalog', 'marketplaces']

/** What one opening of the modal knows about earlier adds, handed to every Add in it. */
interface Opening {
  /** Ids of the add mutations that had landed before this opening. */
  settledAtOpen: ReadonlySet<number>
  /** Catalog skills seen pinned to this agent in this opening. */
  seenPinned: Set<string>
}

/**
 * Add for one catalog skill into this agent, and its refusal. The add is keyed
 * by the package in the mutation cache, so it outlives the modal closing and a
 * reopened modal still shows `Adding…` or the refusal on this skill.
 */
function useSkillAdd(view: CatalogEntryView, agentId: string, opening: Opening): { action: React.JSX.Element; error: string | null } {
  const add = useAddCatalogSkill(view.item.uuid)
  const adds = useCatalogSkillAdds(view.item.uuid, CATALOG_SKILL_TEXT.addFailed)
  const state = adds.byAgent.get(agentId)
  const blocked = view.skillTargets.find((target) => target.agentId === agentId)?.blocked ?? null
  const adding = state?.status === 'pending'
  if (blocked === 'added') opening.seenPinned.add(view.item.uuid)
  // A landed add shows as Added before the rescan brings the pin in — only an
  // add made in this opening, and only until the pin has been seen: then the
  // pin alone says Added, so a skill removed since can be added again.
  const freshAdd = state?.status === 'added' && !opening.settledAtOpen.has(state.mutationId) && !opening.seenPinned.has(view.item.uuid)
  const added = blocked === 'added' || freshAdd
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
function SkillTile({ view, agentId, opening, onSelect }: { view: CatalogEntryView; agentId: string; opening: Opening; onSelect: () => void }): React.JSX.Element {
  const { action, error } = useSkillAdd(view, agentId, opening)
  return <CatalogItemTile view={view} action={action} error={error} onSelect={onSelect} />
}

/** One skill's detail, over the grid: the catalog's own detail, with Add. */
function SkillDetail({ view, agentId, opening, onBack }: { view: CatalogEntryView; agentId: string; opening: Opening; onBack: () => void }): React.JSX.Element {
  const { action, error } = useSkillAdd(view, agentId, opening)
  return <CatalogItemDetailView view={view} action={action} error={error} onBack={onBack} />
}

/**
 * Adds skills to one kit agent, from either source the header's switch picks:
 * **Catalog** — every skill the active Cinna account's catalog lists, the same
 * listing and the same add as the catalog's Add to agent…, from the agent's
 * side — or **Marketplaces** — every skill the skills marketplaces connected
 * to Cinna offer (`MarketplaceSkillsPane`). Either way Add pins the skill into
 * this agent's `cinna-agent.json`. The card keeps one size across sources and
 * states (ux_rules rule 1).
 *
 * Each skill is the catalog's own tile and detail (ux_rules rule 13), with
 * Add as its action. Adding keeps the modal open and turns Add into a disabled
 * "Added", as the connector picker does; the agent's Skills section is where
 * the pinned skill's download and credentials are shown. The source last
 * chosen is where the next opening starts, for this session (ux_rules rule 4).
 */
export function SkillAddModal({ open, agentId, pinnedEntries, onClose }: {
  open: boolean
  agentId: string
  /** Marketplace entry ids this agent already pins: their tiles say Added. */
  pinnedEntries?: readonly string[]
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null
  return <SkillAddModalBody agentId={agentId} pinnedEntries={pinnedEntries ?? []} onClose={onClose} />
}

/** Mounted only while open: the catalog is read again when the modal opens, as the catalog dialog does. */
function SkillAddModalBody({ agentId, pinnedEntries, onClose }: {
  agentId: string
  pinnedEntries: readonly string[]
  onClose: () => void
}): React.ReactPortal {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const { catalog, views } = useCatalogEntries({ refresh: true })
  const reauth = useCatalogReauth(catalog)
  const [query, setQuery] = useState('')
  const source = useSkillAddSourceStore((s) => s.source)
  const setSource = useSkillAddSourceStore((s) => s.setSource)
  // Mounted from the first time it is chosen, then only hidden: one read per opening, and its search kept.
  const [marketplacesShown, setMarketplacesShown] = useState(source === 'marketplaces')
  // The pane's list, read here too for the header's refresh-failure line.
  const marketplaceEntries = useMarketplaceSkillEntries(marketplacesShown && isCinnaUser)
  const marketplaceReauth = useCatalogReauth(marketplaceEntries)
  const marketplaceSearchRef = useRef<HTMLInputElement>(null)
  const pinned = useMemo(() => new Set(pinnedEntries.map((id) => id.toLowerCase())), [pinnedEntries])
  const queryClient = useQueryClient()
  // The adds that had landed before this opening: their "Added" is the pin's to say now.
  const [opening] = useState<Opening>(() => ({
    settledAtOpen: new Set(
      queryClient
        .getMutationCache()
        .getAll()
        .filter((mutation) => mutation.state.status === 'success')
        .map((mutation) => mutation.mutationId)
    ),
    seenPinned: new Set()
  }))
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null)
  // Read inside the window listener, which is bound once.
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedUuid ?? selectedEntry
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = window.setTimeout(() => (source === 'marketplaces' ? marketplaceSearchRef : inputRef).current?.focus(), 0)
    return () => window.clearTimeout(t)
    // The first focus only: a later switch focuses its own search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Escape steps back from a skill's detail first, as in the catalog.
      e.preventDefault()
      if (selectedRef.current) {
        setSelectedUuid(null)
        setSelectedEntry(null)
      } else onClose()
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
          <div className="shrink-0 text-sm font-semibold text-[var(--color-text)]">Add skill</div>
          <div role="radiogroup" aria-label={MARKETPLACE_SKILL_TEXT.sourceLabel} className="flex shrink-0 gap-0.5 rounded-md bg-[var(--color-bg)] p-0.5">
            {SOURCES.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={source === id}
                onClick={() => {
                  setSource(id)
                  setSelectedUuid(null)
                  setSelectedEntry(null)
                  if (id === 'marketplaces') setMarketplacesShown(true)
                  window.setTimeout(() => (id === 'marketplaces' ? marketplaceSearchRef : inputRef).current?.focus(), 0)
                }}
                className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  source === id
                    ? 'bg-[var(--color-bg-secondary)] text-[var(--color-text)] shadow-sm'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {id === 'catalog' ? MARKETPLACE_SKILL_TEXT.catalog : MARKETPLACE_SKILL_TEXT.marketplaces}
              </button>
            ))}
          </div>
          {/* In the header's one line: a failed refresh over a cached grid moves nothing below it (rule 1). */}
          <div className="min-w-0 flex-1">
            {isCinnaUser &&
              (source === 'catalog' ? (
                <CatalogRefreshFailure catalog={catalog} reauth={reauth} />
              ) : (
                <CatalogRefreshFailure catalog={marketplaceEntries} reauth={marketplaceReauth} />
              ))}
          </div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"><X size={14} /></button>
        </div>
        {!isCinnaUser ? (
          <div className="px-4 pb-4 flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">{CATALOG_TEXT.signedOut}</div>
        ) : <>
        {marketplacesShown && <div className={`relative flex-1 min-h-0 flex-col ${source === 'marketplaces' ? 'flex' : 'hidden'}`}>
          <MarketplaceSkillsPane
            agentId={agentId}
            pinnedEntries={pinned}
            searchRef={marketplaceSearchRef}
            selectedUuid={selectedEntry}
            onSelect={setSelectedEntry}
            settledAtOpen={opening.settledAtOpen}
          />
        </div>}
        {source === 'catalog' && <div className="relative flex-1 min-h-0 flex flex-col">
          <div className="px-4 pb-3">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" placeholder="Search skills…"
                className={SKILL_SEARCH_INPUT} />
            </div>
          </div>
          <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0">
            <CatalogListBody catalog={catalog} reauth={reauth} filter="skills" inFilterCount={skills.length} shownCount={shown.length}>
              <div className="grid grid-cols-2 gap-2">
                {shown.map((view) => (
                  <SkillTile key={view.item.uuid} view={view} agentId={agentId} opening={opening} onSelect={() => setSelectedUuid(view.item.uuid)} />
                ))}
              </div>
            </CatalogListBody>
          </div>
          {selected && <SkillDetail key={selected.item.uuid} view={selected} agentId={agentId} opening={opening} onBack={() => setSelectedUuid(null)} />}
        </div>}
        </>}
      </div>
    </div>,
    document.body
  )
}
