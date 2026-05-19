import { useState } from 'react'
import { Search, Loader2 } from 'lucide-react'
import {
  useMcpRegistries,
  useMcpRegistrySearch,
  useUpsertMcpProvider
} from '../../hooks/useMcp'
import type { McpRegistryEntry, McpRegistryInfo } from '../../../../shared/mcpRegistries'

interface Props {
  onClose: () => void
}

export function MCPRegistryPicker({ onClose }: Props): React.JSX.Element {
  const { data: registries } = useMcpRegistries()
  const [activeRegistry, setActiveRegistry] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const upsertMcp = useUpsertMcpProvider()
  const [addingId, setAddingId] = useState<string | null>(null)

  // Pick the first registry once the list arrives
  const registryId =
    activeRegistry ?? (registries && registries.length > 0 ? registries[0].id : null)

  const search = useMcpRegistrySearch(registryId, query)
  const entries: McpRegistryEntry[] =
    search.data?.success ? search.data.entries : []

  const handleAdd = (entry: McpRegistryEntry): void => {
    const remote = entry.remotes[0]
    if (!remote) return
    setAddingId(entry.id)
    // mcp:upsert with enabled:true triggers the same mcpManager.connect()
    // path the explicit Connect button uses. Closing the picker on success
    // surfaces the freshly-created card (with its live status) right away.
    upsertMcp.mutate(
      {
        name: entry.title?.trim() || entry.name,
        transportType: remote.type,
        url: remote.url,
        enabled: true
      },
      {
        onSuccess: () => onClose(),
        onError: () => setAddingId(null)
      }
    )
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Browse MCP Registry</p>
        <button
          onClick={onClose}
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          Close
        </button>
      </div>

      {registries && registries.length > 1 && (
        <div className="flex gap-1 flex-wrap">
          {registries.map((r) => (
            <button
              key={r.id}
              onClick={() => setActiveRegistry(r.id)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                r.id === registryId
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

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

      <div className="max-h-80 overflow-y-auto -mx-1 px-1 space-y-1.5">
        {search.isLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-[var(--color-text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            Loading…
          </div>
        )}

        {!search.isLoading && search.data?.success === false && (
          <div className="text-[10px] text-[var(--color-danger)] py-3 px-1">
            {search.data.error}
          </div>
        )}

        {!search.isLoading && entries.length === 0 && search.data?.success !== false && (
          <div className="text-[10px] text-[var(--color-text-muted)] py-3 px-1">
            No servers found.
          </div>
        )}

        {entries.map((entry) => (
          <RegistryEntryRow
            key={`${entry.registryId}::${entry.id}::${entry.version ?? ''}`}
            entry={entry}
            registry={registries?.find((r) => r.id === entry.registryId)}
            onAdd={() => handleAdd(entry)}
            adding={addingId === entry.id && upsertMcp.isPending}
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
  adding
}: {
  entry: McpRegistryEntry
  registry: McpRegistryInfo | undefined
  onAdd: () => void
  adding: boolean
}): React.JSX.Element {
  const remote = entry.remotes[0]
  const displayName = entry.title?.trim() || entry.name
  const registryLabel = registry?.label ?? entry.registryId

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {entry.websiteUrl ? (
            <a
              href={entry.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium truncate text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline"
            >
              {displayName}
            </a>
          ) : (
            <span className="text-xs font-medium truncate">{displayName}</span>
          )}
          {registry?.homepage ? (
            <a
              href={registry.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="px-1.5 py-px rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)] text-[9px] font-medium shrink-0 hover:bg-[var(--color-accent)]/25"
            >
              {registryLabel}
            </a>
          ) : (
            <span className="px-1.5 py-px rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)] text-[9px] font-medium shrink-0">
              {registryLabel}
            </span>
          )}
          {entry.version && (
            <span className="text-[9px] text-[var(--color-text-muted)] shrink-0">
              v{entry.version}
            </span>
          )}
          {remote?.requiresAuth && (
            <span className="text-[9px] text-[var(--color-warning)] shrink-0">
              auth required
            </span>
          )}
        </div>
        {entry.description && (
          <p className="text-[10px] text-[var(--color-text-muted)] line-clamp-2">
            {entry.description}
          </p>
        )}
        {remote?.url && (
          <div className="mt-1 text-[9px]">
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
      </div>
      <button
        onClick={onAdd}
        disabled={adding || !remote}
        className="self-center px-2.5 py-1 rounded-md text-[10px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50 shrink-0"
      >
        {adding ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  )
}
