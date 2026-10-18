import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { AlertTriangle, Check, ChevronLeft, ExternalLink, Loader2, RefreshCw, Search, SquareTerminal } from 'lucide-react'
import type { MarketplaceSkillEntry } from '../../../../../shared/marketplaceSkills'
import { useAddMarketplaceSkill, useMarketplaceSkillAdds, useMarketplaceSkillEntries } from '../../../hooks/useMarketplaceSkills'
import { CATALOG_SKILL_TEXT, CATALOG_TEXT } from '../../../utils/catalogItems'
import { MARKETPLACE_SKILL_TEXT, unsupportedSentence } from '../../../utils/marketplaceSkills'
import { CHIP, KindIcon, PRIMARY, SECONDARY } from '../CatalogItemViews'
import { useCatalogReauth } from '../CatalogBrowserParts'
import { sizedButton, useCatalogType } from '../catalogSurface'

/** The search box's look, the same in both sources of the modal: switching sources moves nothing (rule 1). */
export const SKILL_SEARCH_INPUT =
  'w-full bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-accent)]/20 focus:border-[var(--color-accent)] focus:outline-none placeholder:text-[var(--color-text-muted)]'

/** Whether an entry matches the search: its name, description, marketplace or owner. */
export function matchesMarketplaceQuery(entry: MarketplaceSkillEntry, needle: string): boolean {
  if (!needle) return true
  return [entry.name, entry.description, entry.marketplaceName, entry.marketplaceOwner ?? ''].some((text) =>
    text.toLowerCase().includes(needle)
  )
}

/** The marketplaces the entries come from, by id, in name order — the filter's options. */
export function marketplacesOf(entries: readonly MarketplaceSkillEntry[]): { id: string; name: string }[] {
  const byId = new Map<string, string>()
  for (const entry of entries) if (entry.marketplaceUuid && !byId.has(entry.marketplaceUuid)) byId.set(entry.marketplaceUuid, entry.marketplaceName || entry.marketplaceUuid)
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The source link, bordered like the tile's other secondary actions and as
 * tall as the Add beside it (ux_rules rule 11): a bare muted icon reads as
 * decoration.
 */
const SOURCE_BUTTON = `${SECONDARY.replace('px-2.5', 'px-1.5')} self-stretch`

/** The catalog's kind badge, worn by a marketplace skill as its marketplace's name. */
function MarketplaceBadge({ entry }: { entry: MarketplaceSkillEntry }): React.JSX.Element {
  const type = useCatalogType()
  const text = MARKETPLACE_SKILL_TEXT.badge(entry.marketplaceName)
  return (
    <span
      title={MARKETPLACE_SKILL_TEXT.badgeTitle(entry.marketplaceName)}
      className={`inline-flex min-w-0 max-w-full shrink items-center truncate rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px ${type.meta} font-medium text-[var(--color-text-secondary)]`}
    >
      <span className="truncate">{text}</span>
    </span>
  )
}

function SourceLink({ entry }: { entry: MarketplaceSkillEntry }): React.JSX.Element | null {
  if (!entry.repositoryUrl) return null
  const url = entry.repositoryUrl
  return (
    <button
      type="button"
      onClick={() => void window.api.system.openExternal(url)}
      title={MARKETPLACE_SKILL_TEXT.openRepository}
      aria-label={MARKETPLACE_SKILL_TEXT.openRepositoryLabel(entry.name)}
      className={SOURCE_BUTTON}
    >
      <ExternalLink size={12} aria-hidden="true" />
    </button>
  )
}

/** What one entry's Add says and does for this agent, on its tile and in its detail. */
interface MarketplaceAdd {
  action: React.JSX.Element
  /** The refusal, under the tile or the detail's header. */
  error: string | null
  /** The unsupported reason as a sentence; null for an addable entry. */
  reason: string | null
  state: 'added' | 'adding' | 'unsupported' | 'refused' | 'addable'
}

/**
 * Add for one marketplace entry into this agent. The add is keyed by the
 * entry in the mutation cache, so it outlives the modal closing and a
 * reopened modal still shows `Adding…` or the refusal. A landed add shows as
 * Added before the rescan brings the pin in — but only an add made in this
 * opening (`settledAtOpen` holds the ones that had landed before it) and
 * only until the pin has been seen: after that the pin alone says Added, so
 * a skill removed since is addable again.
 */
function useMarketplaceAdd(
  entry: MarketplaceSkillEntry,
  agentId: string,
  pinned: boolean,
  pinSeen: boolean,
  settledAtOpen: ReadonlySet<number>
): MarketplaceAdd {
  const add = useAddMarketplaceSkill(entry.entryUuid)
  const adds = useMarketplaceSkillAdds(entry.entryUuid, MARKETPLACE_SKILL_TEXT.addFailed)
  const state = adds.byAgent.get(agentId)
  const adding = state?.status === 'pending'
  const freshAdd = state?.status === 'added' && !settledAtOpen.has(state.mutationId) && !pinSeen
  const added = pinned || freshAdd
  const addable = entry.supported && entry.archiveSha256 !== null
  const error = !adding && !added && state?.status === 'refused' ? state.message : null
  const reason = addable ? null : unsupportedSentence(entry.unsupportedReason)
  const [label, ariaLabel] = added
    ? [CATALOG_SKILL_TEXT.added, `${entry.name} added`]
    : adding
      ? [CATALOG_SKILL_TEXT.adding, `Adding ${entry.name}…`]
      : ['Add', CATALOG_SKILL_TEXT.addTo(entry.name, 'this agent')]
  const action = (
    <button
      type="button"
      aria-label={ariaLabel}
      title={reason ?? undefined}
      disabled={added || adding || !addable}
      onClick={() => add.mutate({ agentId, entryUuid: entry.entryUuid })}
      className={added ? SECONDARY : PRIMARY}
    >
      {added ? <Check size={11} aria-hidden /> : adding ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
      {label}
    </button>
  )
  const stateName = added ? 'added' : adding ? 'adding' : !addable ? 'unsupported' : error ? 'refused' : 'addable'
  return { action, error, reason, state: stateName }
}

interface EntryProps {
  entry: MarketplaceSkillEntry
  agentId: string
  pinned: boolean
  pinSeen: boolean
  settledAtOpen: ReadonlySet<number>
}

/**
 * One marketplace skill in the grid, in the catalog skill tile's shell
 * (ux_rules rule 13): the name, the marketplace as the badge where the
 * catalog says Skill, the version chip, "by" its owner, what it is for, a
 * mark when it ships scripts, and why it cannot be added. The body opens the
 * detail; the source link and Add are its footer, and a refusal its last line.
 */
function MarketplaceSkillTile({ onSelect, ...props }: EntryProps & { onSelect: () => void }): React.JSX.Element {
  const { entry } = props
  const nameId = useId()
  const descriptionId = useId()
  const type = useCatalogType()
  const { action, error, reason, state } = useMarketplaceAdd(entry, props.agentId, props.pinned, props.pinSeen, props.settledAtOpen)
  return (
    <div
      role="group"
      aria-label={entry.name}
      data-marketplace-skill={entry.entryUuid}
      data-marketplace-skill-state={state}
      className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 transition-colors hover:border-[var(--color-accent)]/30"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-labelledby={nameId}
        aria-describedby={entry.description ? descriptionId : undefined}
        className="flex flex-1 flex-col gap-1 rounded-t-lg p-3 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <KindIcon kind="skill" size="tile" />
          <span id={nameId} title={entry.name} className={`min-w-0 flex-1 truncate ${type.name} font-medium text-[var(--color-text)]`}>
            {entry.name}
          </span>
          {entry.hasScripts && (
            <span title={MARKETPLACE_SKILL_TEXT.hasScripts} aria-label={MARKETPLACE_SKILL_TEXT.hasScripts} role="img" className="shrink-0 text-[var(--color-text-muted)]">
              <SquareTerminal size={13} aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
          <MarketplaceBadge entry={entry} />
          {entry.version && <span className={`${CHIP} ${type.meta}`}>{entry.version}</span>}
        </span>
        {entry.marketplaceOwner && (
          <span className={`block w-full truncate ${type.meta} text-[var(--color-text-muted)]`} title={CATALOG_TEXT.by(entry.marketplaceOwner)}>
            {CATALOG_TEXT.by(entry.marketplaceOwner)}
          </span>
        )}
        {entry.description && (
          <span id={descriptionId} className={`line-clamp-3 ${type.body} leading-relaxed text-[var(--color-text-secondary)]`}>
            {entry.description}
          </span>
        )}
        {reason && <span className={`${type.meta} text-[var(--color-text-muted)]`}>{reason}</span>}
      </button>
      <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-border)] px-3 py-2">
        {entry.repositoryUrl && (
          <span className="mr-auto flex self-stretch">
            <SourceLink entry={entry} />
          </span>
        )}
        {action}
      </div>
      {error && (
        <div role="alert" className={`px-3 pb-2 ${type.meta} text-[var(--color-danger)]`}>
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * One marketplace skill's detail, a layer over the grid in the catalog
 * detail's shell: the description at full length, its marketplace, owner,
 * version and whether it ships scripts, and the source link beside the same
 * Add. Back and Escape return to the grid.
 */
function MarketplaceSkillDetail({ onBack, ...props }: EntryProps & { onBack: () => void }): React.JSX.Element {
  const { entry } = props
  const type = useCatalogType()
  const { action, error, reason } = useMarketplaceAdd(entry, props.agentId, props.pinned, props.pinSeen, props.settledAtOpen)
  return (
    <div
      data-marketplace-skill-detail={entry.entryUuid}
      className="absolute inset-0 space-y-3 overflow-y-auto bg-[var(--color-bg-secondary)] px-5 pb-5"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          autoFocus
          onClick={onBack}
          aria-label={MARKETPLACE_SKILL_TEXT.back}
          title={MARKETPLACE_SKILL_TEXT.back}
          className="-ml-1.5 mt-1.5 shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={16} />
        </button>
        <KindIcon kind="skill" size="detail" />
        <div className="min-w-0 flex-1">
          <h3 className={`break-words ${type.heading} font-semibold text-[var(--color-text)]`}>{entry.name}</h3>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <MarketplaceBadge entry={entry} />
            {entry.version && <span className={`${CHIP} ${type.meta}`}>{entry.version}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-stretch gap-1.5">
          <SourceLink entry={entry} />
          {action}
        </div>
      </div>
      {error && (
        <div role="alert" className={`${type.meta} text-[var(--color-danger)]`}>
          {error}
        </div>
      )}
      {reason && <div className={`${type.body} text-[var(--color-text-muted)]`}>{reason}</div>}
      {entry.description && (
        <p className={`whitespace-pre-wrap ${type.text} leading-relaxed text-[var(--color-text-secondary)]`}>{entry.description}</p>
      )}
      <dl className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 ${type.body}`}>
        <dt className="text-[var(--color-text-muted)]">{MARKETPLACE_SKILL_TEXT.marketplaceLabel}</dt>
        <dd className="min-w-0 break-words text-[var(--color-text)]">{MARKETPLACE_SKILL_TEXT.badge(entry.marketplaceName)}</dd>
        {entry.marketplaceOwner && (
          <>
            <dt className="text-[var(--color-text-muted)]">{MARKETPLACE_SKILL_TEXT.ownerLabel}</dt>
            <dd className="min-w-0 break-words text-[var(--color-text)]">{entry.marketplaceOwner}</dd>
          </>
        )}
        {entry.version && (
          <>
            <dt className="text-[var(--color-text-muted)]">{MARKETPLACE_SKILL_TEXT.versionLabel}</dt>
            <dd className="min-w-0 break-words text-[var(--color-text)]">{entry.version}</dd>
          </>
        )}
        <dt className="text-[var(--color-text-muted)]">{MARKETPLACE_SKILL_TEXT.scriptsLabel}</dt>
        <dd className="min-w-0 text-[var(--color-text)]">{entry.hasScripts ? MARKETPLACE_SKILL_TEXT.hasScripts : MARKETPLACE_SKILL_TEXT.noScripts}</dd>
      </dl>
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  const type = useCatalogType()
  return <div className={`flex h-40 items-center justify-center px-6 text-center ${type.text} text-[var(--color-text-muted)]`}>{text}</div>
}

/**
 * The Add skill modal's Marketplaces source: every skill the skills
 * marketplaces connected to Cinna offer this person, read once per opening
 * and filtered here by the search and the marketplace choice — nothing is
 * asked per keystroke, and nothing above the list moves (rule 1). Loading,
 * a failure (with Re-authenticate for an expired session) and the one empty
 * state stay inside the list's area while there is nothing to show; a failed
 * refresh over entries already read keeps them, and the modal's header says
 * so (`CatalogRefreshFailure`). A tile opens its detail over the grid; the
 * modal owns which one, so its Escape steps back first.
 */
export function MarketplaceSkillsPane({
  agentId,
  pinnedEntries,
  searchRef,
  selectedUuid,
  onSelect,
  settledAtOpen
}: {
  agentId: string
  /** Entry ids this agent already pins (lowercase). */
  pinnedEntries: ReadonlySet<string>
  searchRef?: RefObject<HTMLInputElement | null>
  /** The entry whose detail is open, or null for the grid. */
  selectedUuid: string | null
  onSelect: (entryUuid: string | null) => void
  /** Ids of the add mutations that had landed before this opening of the modal. */
  settledAtOpen: ReadonlySet<number>
}): React.JSX.Element {
  const type = useCatalogType()
  const entries = useMarketplaceSkillEntries(true)
  const reauth = useCatalogReauth(entries)
  const [query, setQuery] = useState('')
  const [marketplace, setMarketplace] = useState('')
  // One fresh read per opening: an earlier opening's list shows meanwhile.
  const refreshed = useRef(false)
  useEffect(() => {
    if (refreshed.current) return
    refreshed.current = true
    if (entries.data !== undefined && !entries.isFetching) void entries.refetch()
  }, [entries])
  // Every entry seen pinned in this opening: from then on the pin alone says Added.
  const seenPinned = useRef(new Set<string>())
  for (const id of pinnedEntries) seenPinned.current.add(id)

  const list = useMemo(() => entries.data ?? [], [entries.data])
  const marketplaces = useMemo(() => marketplacesOf(list), [list])
  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () => list.filter((entry) => (!marketplace || entry.marketplaceUuid === marketplace) && matchesMarketplaceQuery(entry, needle)),
    [list, marketplace, needle]
  )
  // Null once a refresh has dropped the entry, which falls back to the grid.
  const selected = selectedUuid ? (list.find((entry) => entry.entryUuid === selectedUuid) ?? null) : null
  const entryProps = (entry: MarketplaceSkillEntry): EntryProps => {
    const id = entry.entryUuid.toLowerCase()
    return { entry, agentId, pinned: pinnedEntries.has(id), pinSeen: seenPinned.current.has(id), settledAtOpen }
  }

  const failed = entries.error !== null && !entries.isFetching
  const errorCode = (entries.error as { code?: string } | null)?.code
  let body: React.JSX.Element
  if (entries.data === undefined) {
    body = !failed
      ? <EmptyState text={MARKETPLACE_SKILL_TEXT.loading} />
      : errorCode === 'no_account'
        ? <EmptyState text={CATALOG_TEXT.signedOut} />
        : failure(errorCode === 'reauth_required')
  } else if (list.length === 0) {
    body = <EmptyState text={MARKETPLACE_SKILL_TEXT.empty} />
  } else if (shown.length === 0) {
    body = <EmptyState text={MARKETPLACE_SKILL_TEXT.noMatch} />
  } else {
    body = (
      <div className="grid grid-cols-2 gap-2">
        {shown.map((entry) => (
          <MarketplaceSkillTile key={entry.entryUuid} {...entryProps(entry)} onSelect={() => onSelect(entry.entryUuid)} />
        ))}
      </div>
    )
  }

  function failure(expired: boolean): React.JSX.Element {
    return (
      <div className={`flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-2 ${type.body} text-[var(--color-text-secondary)]`}>
        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          <div>{expired ? MARKETPLACE_SKILL_TEXT.reauth : MARKETPLACE_SKILL_TEXT.loadFailed}</div>
          {expired ? (
            <button type="button" onClick={() => void reauth.run()} disabled={reauth.pending} className={`${sizedButton(PRIMARY, type)} mt-1.5`}>
              <RefreshCw size={10} className={reauth.pending ? 'animate-spin' : ''} />
              {CATALOG_TEXT.reauthenticate}
            </button>
          ) : (
            <button type="button" onClick={() => void entries.refetch()} disabled={entries.isFetching} className={`${sizedButton(SECONDARY, type)} mt-1.5`}>
              {CATALOG_TEXT.retry}
            </button>
          )}
          {reauth.error && <div className={`mt-1.5 ${type.meta} text-[var(--color-danger)]`}>{reauth.error}</div>}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="px-4 pb-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={MARKETPLACE_SKILL_TEXT.searchLabel}
              placeholder={MARKETPLACE_SKILL_TEXT.searchPlaceholder}
              className={SKILL_SEARCH_INPUT}
            />
          </div>
          {/* Always drawn, so the row never changes shape as the list arrives. */}
          <select
            value={marketplace}
            onChange={(e) => setMarketplace(e.target.value)}
            aria-label={MARKETPLACE_SKILL_TEXT.filterLabel}
            className="w-40 shrink-0 truncate rounded-md border border-[var(--color-accent)]/20 bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 px-2 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="">{MARKETPLACE_SKILL_TEXT.allMarketplaces}</option>
            {marketplaces.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0" data-marketplace-skills-list>
        {body}
      </div>
      {selected && <MarketplaceSkillDetail key={selected.entryUuid} {...entryProps(selected)} onBack={() => onSelect(null)} />}
    </>
  )
}
