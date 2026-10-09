import { useId, useMemo, useState } from 'react'
import { ChevronLeft, Download, Loader2, RefreshCw, Search, Users } from 'lucide-react'
import type { LibraryAgentDto, LibraryListingDto } from '../../../../shared/agentSharing'
import { isUnsettledClick, useSettleGuard } from '../../hooks/useSettleGuard'
import { SHARE_UI_TEXT } from '../../utils/shareText'

/**
 * The Team library as a source of the catalog dialog: every agent shared with
 * the active Cinna profile's team, as tiles with a detail behind each.
 *
 * It owns no action. Get and Update run in the dialog's parent, so closing the
 * dialog mid-Get loses nothing and the parent lands the user on the new agent;
 * this panel only shows which tile is busy and the refusal that belongs to it,
 * last in that tile (ux_rules rules 1 and 6).
 */

const PRIMARY =
  'inline-flex min-w-[5.5rem] items-center justify-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium ' +
  'bg-[var(--color-accent)] text-white transition-colors hover:bg-[var(--color-accent-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40'
const SECONDARY =
  'inline-flex items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 ' +
  'text-[11px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'
const CHIP =
  'shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-px text-[10px] text-[var(--color-text-muted)]'

/** What is in flight and what was refused, per tile. Owned by the dialog's parent. */
export interface TeamLibraryActions {
  /** Repository whose Get is running. */
  gettingRepoId: string | null
  /** Local agent whose Update is running. */
  updatingAgentId: string | null
  /** The last refusal, and the tile it belongs to. */
  error: { repoId: string; message: string } | null
  onGet: (repoId: string) => void
  onUpdate: (agent: LibraryAgentDto) => void
  /** Open a local agent's page. */
  onOpenLocal: (agentId: string) => void
}

function maintainersOf(agent: LibraryAgentDto): string | null {
  const names = agent.maintainers.map((m) => m.displayName).filter(Boolean)
  return names.length > 0 ? names.join(', ') : null
}

function matches(agent: LibraryAgentDto, needle: string): boolean {
  if (needle === '') return true
  return [agent.name, agent.description, agent.slug, ...agent.maintainers.map((m) => m.displayName)].some((value) =>
    value?.toLowerCase().includes(needle)
  )
}

export function TeamLibraryPanel({
  listing,
  isLoading,
  isError,
  isFetching,
  onRetry,
  actions
}: {
  listing: LibraryListingDto | null | undefined
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  onRetry: () => void
  actions: TeamLibraryActions
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const detailSettled = useSettleGuard(selectedRepo)
  const agents = useMemo(() => listing?.agents ?? [], [listing])
  const needle = query.trim().toLowerCase()
  const filtered = useMemo(() => agents.filter((a) => matches(a, needle)), [agents, needle])
  const selected = selectedRepo ? (agents.find((a) => a.repoId === selectedRepo) ?? null) : null
  const errorFor = (agent: LibraryAgentDto): string | null =>
    actions.error?.repoId === agent.repoId ? actions.error.message : null

  const actionFor = (agent: LibraryAgentDto, settled = true): React.JSX.Element => (
    <LibraryAction agent={agent} actions={actions} settled={settled} />
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden={selected ? true : undefined}
        inert={selected ? true : undefined}
        className={`flex min-h-0 flex-1 flex-col ${selected ? 'invisible' : ''}`}
      >
        <div className="px-5 pb-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="text"
              aria-label="Search the Team library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents…"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
          {isLoading && !listing ? (
            <Empty text={SHARE_UI_TEXT.libraryLoading} />
          ) : isError && !listing ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]">
              <span>{SHARE_UI_TEXT.libraryError}</span>
              <button type="button" onClick={onRetry} disabled={isFetching} className={SECONDARY}>
                <RefreshCw size={10} className={isFetching ? 'animate-spin' : ''} />
                Retry
              </button>
            </div>
          ) : agents.length === 0 ? (
            <Empty text={SHARE_UI_TEXT.libraryEmpty} />
          ) : filtered.length === 0 ? (
            <Empty text="No agents match your search." />
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {filtered.map((agent) => (
                <LibraryTile
                  key={agent.repoId}
                  agent={agent}
                  action={actionFor(agent)}
                  error={errorFor(agent)}
                  onSelect={() => setSelectedRepo(agent.repoId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {selected && (
        <div className="absolute inset-0 space-y-3 overflow-y-auto bg-[var(--color-bg-secondary)] px-5 pb-5">
          <div className="flex items-start gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setSelectedRepo(null)}
              aria-label="Back to the Team library"
              title="Back to the Team library"
              className="-ml-1.5 mt-1.5 shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
              <Users size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="text-sm font-semibold text-[var(--color-text)]">{selected.name}</h3>
                {selected.engine && <span className={CHIP}>{selected.engine}</span>}
              </div>
              {maintainersOf(selected) && (
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {SHARE_UI_TEXT.maintainedBy(maintainersOf(selected) as string)}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">{actionFor(selected, detailSettled)}</div>
          </div>
          {errorFor(selected) && (
            <div role="alert" className="text-[10px] text-[var(--color-danger)]">
              {errorFor(selected)}
            </div>
          )}
          {selected.description && (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text-secondary)]">
              {selected.description}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <div className="flex h-40 items-center justify-center text-xs text-[var(--color-text-muted)]">{text}</div>
}

/** Get when it is not here; Update available, or Installed with Open, when it is. */
function LibraryAction({
  agent,
  actions,
  settled
}: {
  agent: LibraryAgentDto
  actions: TeamLibraryActions
  settled: boolean
}): React.JSX.Element {
  const localId = agent.localAgentId
  if (localId) {
    const updating = actions.updatingAgentId === localId
    return (
      <>
        {agent.updateAvailable ? (
          <button
            type="button"
            disabled={actions.updatingAgentId !== null}
            aria-busy={updating}
            onClick={(event) => {
              if (!isUnsettledClick(settled, event)) actions.onUpdate(agent)
            }}
            className={PRIMARY}
          >
            {updating ? (
              <>
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                {SHARE_UI_TEXT.updating}
              </>
            ) : (
              SHARE_UI_TEXT.updateAvailable
            )}
          </button>
        ) : (
          <span className="shrink-0 rounded bg-[var(--color-success)]/12 px-1.5 py-px text-[10px] font-medium text-[var(--color-success)]">
            {SHARE_UI_TEXT.installed}
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            if (!isUnsettledClick(settled, event)) actions.onOpenLocal(localId)
          }}
          className={SECONDARY}
        >
          {SHARE_UI_TEXT.open}
        </button>
      </>
    )
  }
  const getting = actions.gettingRepoId === agent.repoId
  return (
    <button
      type="button"
      disabled={actions.gettingRepoId !== null}
      aria-busy={getting}
      onClick={(event) => {
        if (!isUnsettledClick(settled, event)) actions.onGet(agent.repoId)
      }}
      className={PRIMARY}
    >
      {getting ? (
        <>
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          {SHARE_UI_TEXT.getting}
        </>
      ) : (
        <>
          <Download size={11} aria-hidden="true" />
          {SHARE_UI_TEXT.get}
        </>
      )}
    </button>
  )
}

/** One library agent in the grid, built like the catalog's bundle tile. */
function LibraryTile({
  agent,
  action,
  error,
  onSelect
}: {
  agent: LibraryAgentDto
  action: React.JSX.Element
  error: string | null
  onSelect: () => void
}): React.JSX.Element {
  const nameId = useId()
  const descriptionId = useId()
  const maintainers = maintainersOf(agent)
  return (
    <div
      role="group"
      aria-label={agent.name}
      className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 transition-colors hover:border-[var(--color-accent)]/30"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-labelledby={nameId}
        aria-describedby={agent.description ? descriptionId : undefined}
        className="flex flex-1 flex-col gap-1 rounded-t-lg p-3 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Users size={14} />
          </span>
          <span id={nameId} className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">
            {agent.name}
          </span>
          {agent.engine && <span className={CHIP}>{agent.engine}</span>}
        </span>
        {maintainers && (
          <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
            {SHARE_UI_TEXT.maintainedBy(maintainers)}
          </span>
        )}
        {agent.description && (
          <span id={descriptionId} className="line-clamp-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            {agent.description}
          </span>
        )}
      </button>
      <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-border)] px-3 py-2">{action}</div>
      {error && (
        <div role="alert" className="px-3 pb-2 text-[10px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
    </div>
  )
}
