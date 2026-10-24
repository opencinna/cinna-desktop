import { useState } from 'react'
import { Search, Loader2, AlertTriangle } from 'lucide-react'
import {
  useMcpRegistries,
  useMcpRegistrySearchAll,
  useUpsertMcpProvider
} from '../../hooks/useMcp'
import type { McpRegistryEntry, McpRegistryInfo } from '../../../../shared/mcpRegistries'
import { mcpRegistryRef } from '../../../../shared/addons/directory'

interface Props {
  onClose: () => void
  /** Called with the new connector's id once it is saved, before `onClose`. */
  onCreated?: (id: string) => void
  /** The dismiss button's label: "Back" where it returns to a list rather than closing. */
  closeLabel?: string
}

export function MCPRegistryPicker({ onClose, onCreated, closeLabel = 'Close' }: Props): React.JSX.Element {
  const { data: registries } = useMcpRegistries()
  const [query, setQuery] = useState('')
  const upsertMcp = useUpsertMcpProvider()
  const [addingId, setAddingId] = useState<string | null>(null)
  // A refused add (the admin's policy, a bad entry) stays on the row it was asked from.
  const [addError, setAddError] = useState<{ id: string; message: string } | null>(null)

  const search = useMcpRegistrySearchAll(query)
  const entries: McpRegistryEntry[] = search.data?.entries ?? []
  const errors = search.data?.errors ?? []
  const registriesById = new Map((registries ?? []).map((r) => [r.id, r]))

  const handleAdd = (entry: McpRegistryEntry): void => {
    const remote = entry.remotes[0]
    if (!remote) return
    // Composite id avoids cross-registry collisions in the spinner state when
    // the same server name appears in more than one registry.
    setAddingId(`${entry.registryId}::${entry.id}`)
    setAddError(null)
    // mcp:upsert with enabled:true triggers the same mcpManager.connect()
    // path the explicit Connect button uses. Closing the picker on success
    // surfaces the freshly-created card (with its live status) right away.
    // The promise, not mutate-level callbacks: TanStack drops those when the
    // form unmounts, and a connector created for an agent must still reach it.
    upsertMcp.mutateAsync(
      {
        name: entry.title?.trim() || entry.name,
        transportType: remote.type,
        url: remote.url,
        enabled: true,
        // The registry entry it is made from: the agent's addon picker then shows it once, as this connector.
        registryRef: mcpRegistryRef(entry.registryId, entry.id)
      }
    ).then(
      (result) => { onCreated?.(result.id); onClose() },
      (err: unknown) => {
        setAddingId(null)
        setAddError({
          id: `${entry.registryId}::${entry.id}`,
          message: err instanceof Error ? err.message : 'That connector could not be added.'
        })
      }
    )
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[14px] font-medium">Browse MCP Registry</p>
        <button
          onClick={onClose}
          className="text-[14px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          {closeLabel}
        </button>
      </div>

      <div className="relative">
        <Search
          size={12}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search servers..."
          className={inputClass}
          autoFocus
        />
      </div>

      {errors.length > 0 && (
        <div className="space-y-1">
          {errors.map((err) => {
            const label = registriesById.get(err.registryId)?.label ?? err.registryId
            return (
              <div
                key={err.registryId}
                className="flex items-center gap-1.5 text-[12px] text-[var(--color-warning)]"
              >
                <AlertTriangle size={10} className="shrink-0" />
                <span>
                  {label}: {err.error}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="max-h-80 overflow-y-auto -mx-1 px-1 space-y-1.5">
        {search.isLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-[var(--color-text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            Loading…
          </div>
        )}

        {!search.isLoading && entries.length === 0 && errors.length === 0 && (
          <div className="text-[12px] text-[var(--color-text-muted)] py-3 px-1">
            No servers found.
          </div>
        )}

        {entries.map((entry) => (
          <RegistryEntryRow
            key={`${entry.registryId}::${entry.id}::${entry.version ?? ''}`}
            entry={entry}
            registry={registriesById.get(entry.registryId)}
            onAdd={() => handleAdd(entry)}
            adding={
              addingId === `${entry.registryId}::${entry.id}` && upsertMcp.isPending
            }
            error={addError?.id === `${entry.registryId}::${entry.id}` ? addError.message : null}
          />
        ))}
      </div>
    </div>
  )
}

function RegistryEntryRow({
  entry,
  registry,
  onAdd,
  adding,
  error
}: {
  entry: McpRegistryEntry
  registry: McpRegistryInfo | undefined
  onAdd: () => void
  adding: boolean
  error: string | null
}): React.JSX.Element {
  const remote = entry.remotes[0]
  const displayName = entry.title?.trim() || entry.name
  const registryLabel = registry?.label ?? entry.registryId

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {entry.websiteUrl ? (
            <a
              href={entry.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] font-medium truncate text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline"
            >
              {displayName}
            </a>
          ) : (
            <span className="text-[14px] font-medium truncate">{displayName}</span>
          )}
          {registry?.homepage ? (
            <a
              href={registry.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="px-1.5 py-px rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)] text-[11px] font-medium shrink-0 hover:bg-[var(--color-accent)]/25"
            >
              {registryLabel}
            </a>
          ) : (
            <span className="px-1.5 py-px rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)] text-[11px] font-medium shrink-0">
              {registryLabel}
            </span>
          )}
          {entry.version && (
            <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">
              v{entry.version}
            </span>
          )}
          {remote?.requiresAuth && (
            <span className="text-[11px] text-[var(--color-warning)] shrink-0">
              auth required
            </span>
          )}
        </div>
        {entry.description && (
          <p className="text-[12px] text-[var(--color-text-muted)] line-clamp-2">
            {entry.description}
          </p>
        )}
        {remote?.url && (
          <div className="mt-1 text-[11px]">
            <a
              href={remote.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:underline truncate inline-block max-w-full align-bottom"
            >
              {remote.url}
            </a>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-1 text-[12px] text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>
      <button
        onClick={onAdd}
        disabled={adding || !remote}
        // Top-aligned: a refusal under the description grows the row without moving Connect from under the pointer.
        className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50 shrink-0"
      >
        {adding ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  )
}
