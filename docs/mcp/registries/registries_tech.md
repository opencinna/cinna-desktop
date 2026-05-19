# MCP Registries — Technical Details

## File Locations

**Shared types**
- `src/shared/mcpRegistries.ts` — `McpRegistryInfo`, `McpRegistryEntry`, `McpRegistrySearchResult`, `McpRegistrySearchAllResult` (importable from both processes; type-only)

**Main process**
- `src/main/services/mcpRegistryService.ts` — adapter registry, search cache, public `mcpRegistryService.list()` / `.search()` / `.searchAll()`
- `src/main/ipc/mcp.ipc.ts` — registers `mcp:registry-list` and `mcp:registry-search-all` alongside existing MCP handlers
- `src/main/errors.ts` — `McpErrorCode` includes `registry_unknown` and `registry_unreachable`
- `src/main/index.ts` — `setWindowOpenHandler` enforces `http:`/`https:` scheme before forwarding to `shell.openExternal` (defense-in-depth for untrusted registry URLs)

**Preload**
- `src/preload/index.ts` — `window.api.mcp.registryList()` and `window.api.mcp.registrySearchAll(...)`

**Renderer**
- `src/renderer/src/hooks/useMcp.ts` — `useMcpRegistries()`, `useMcpRegistrySearchAll(query)`
- `src/renderer/src/components/settings/MCPRegistryPicker.tsx` — picker UI: single search input, unified result list with per-row registry badge, inline per-registry warning when one registry fails, Connect button per row
- `src/renderer/src/components/settings/MCPSettingsSection.tsx` — hosts the "Add from Registry" entry point and mounts the picker
- `src/renderer/src/components/settings/AddCustomMcpForm.tsx` — sibling form (referenced for the Custom MCP entry point only; not part of registries)
- `src/renderer/src/components/settings/AddLocalMcpForm.tsx` — sibling form (Local MCP entry point only; not part of registries)

## Database Schema

No schema additions. Registry browsing is read-only against external APIs; once the user clicks Connect, the standard `mcp_providers` table is written via the existing `mcp:upsert` path — see [MCP Connections — Tech](../connections/connections_tech.md).

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `mcp:registry-list` | invoke | Returns the list of built-in registries (`McpRegistryInfo[]`) |
| `mcp:registry-search-all` | invoke | Aggregated search across every built-in registry — input `{ query?, limit? }`, returns `{ entries, errors }` (`McpRegistrySearchAllResult`). Always resolves; per-registry failures are reported in `errors`, not by rejecting the call |

Connect actions reuse the existing `mcp:upsert` channel; there is no registry-specific "install" channel.

## Services & Key Methods

- `src/main/services/mcpRegistryService.ts`
  - `mcpRegistryService.list()` — projects the internal `adapters` map to `McpRegistryInfo[]` in insertion order (controls merged-result ordering in `searchAll`)
  - `mcpRegistryService.searchAll(query, limit?)` — runs `search()` for every registry in parallel via `Promise.allSettled`, concatenates fulfilled entries in adapter insertion order, and collects rejection reasons into the `errors` array via `ipcErrorShape`; never throws
  - `mcpRegistryService.search(registryId, query, limit?)` — clamps `limit` to `[1, 100]`, checks the in-memory cache, otherwise dispatches to the adapter's `search()` and caches the result for 5 minutes
  - `clampLimit(limit)` — defensive clamp on values coming from the renderer
  - `cacheKey(registryId, query, limit)` — `(registry::limit::query.toLowerCase().trim())`
  - `isHttpUrl(raw)` — local guard used to drop non-HTTP(S) URLs from registry payloads
  - `cinnaOfficialAdapter.search()` — adapter for the Cinna-curated registry; calls `loadCinnaOfficialEntries()` (which fetches `https://opencinna.io/.well-known/mcp_registry/index.json` and caches the parsed entries for 5 min), then filters by query against `name` / `title` / `description` in-memory before slicing to `limit`
  - `officialAdapter.search()` — adapter for `registry.modelcontextprotocol.io`; uses `net.fetch` with `AbortSignal.timeout(10_000)` and throws `McpError('registry_unreachable', ...)` on transport failure or non-2xx response

To add a new registry: implement `RegistryAdapter` (interface extends `McpRegistryInfo` and adds `search(query, limit): Promise<McpRegistryEntry[]>`), then insert it into the `adapters` map by id. The picker UI surfaces it as a tab automatically; map insertion order determines which tab is active by default.

### Cinna Official JSON shape

Served from `cinna-web/public/.well-known/mcp_registry/index.json`. The desktop adapter consumes this shape; non-conforming entries are dropped silently.

```jsonc
{
  "version": 1,
  "name": "Cinna Official",
  "homepage": "https://opencinna.io/",
  "updatedAt": "YYYY-MM-DD",
  "servers": [
    {
      "id": "granola",                   // stable, kebab-case
      "name": "Granola",                 // display name
      "title": "Granola",                // optional, falls back to name
      "description": "...",              // 1–2 sentences
      "websiteUrl": "https://...",       // optional; HTTP(S) only
      "remotes": [
        {
          "type": "streamable-http",     // or "sse"
          "url": "https://...",          // HTTP(S) only
          "requiresAuth": true            // optional; surfaces "auth required" badge
        }
      ]
    }
  ]
}
```

To add/remove a server: edit the JSON in `cinna-web`, redeploy. Desktop clients pick up the change at next search (subject to the in-memory 5-min cache).

## Renderer Components

- `MCPRegistryPicker.tsx`
  - Single-pane picker; tracks `query` and `addingId` in local state. No active-registry state — every registry's entries appear in one merged list
  - `addingId` is a composite `${registryId}::${id}` key so the "Connecting…" spinner targets the right row even when two registries surface the same server name
  - `registriesById` is a `Map` built from the `useMcpRegistries()` result and used to resolve each row's badge label / homepage from `entry.registryId`
  - Per-registry failures from `searchAll` render as inline `AlertTriangle` warnings above the result list — results from healthy registries still show below
  - Subcomponent `RegistryEntryRow` renders one server row: clickable server name (links to `entry.websiteUrl` when available), clickable registry badge (links to the registry's homepage), clickable remote URL, and the Connect button
  - On Connect: calls `useUpsertMcpProvider` with `enabled: true`, then closes the picker via `onClose` on success
- `MCPSettingsSection.tsx`
  - Renders three entry buttons ("Add from Registry", "Add Custom MCP", "Add Local MCP") and mounts the appropriate panel based on local `panel` state

## Renderer Hooks

- `useMcpRegistries()` — `useQuery(['mcp-registries'])`, `staleTime: Infinity` (registries are static config); only used to resolve per-row badge labels/homepages
- `useMcpRegistrySearchAll(query)` — `useQuery(['mcp-registry-search-all', query.trim()])`, `staleTime: 5 * 60 * 1000` (aligned with the main-process cache TTL); always enabled — initial empty-query load populates the list

## Configuration

No env vars or settings. Registry endpoints are hardcoded in `mcpRegistryService.ts`. The cache TTL (`CACHE_TTL_MS`), fetch timeout (`FETCH_TIMEOUT_MS`), and limit bounds (`MIN_LIMIT` / `MAX_LIMIT` / `DEFAULT_LIMIT`) are module-level constants.

## Security

- **Untrusted URL handling** — registry responses are untrusted; the service drops any remote whose URL isn't `http:`/`https:`, and similarly for `websiteUrl` / `repository.url`. `setWindowOpenHandler` re-checks the scheme before calling `shell.openExternal`, so even if a tainted URL slipped through it could not be opened
- **No credentials stored** — registry calls are anonymous; nothing is persisted from the registry side. OAuth/auth handling happens only after the user clicks Connect and the standard MCP connection flow takes over
- **Renderer sandbox unchanged** — registry fetches happen in main process (`net.fetch`); the renderer cannot make external HTTP calls (CSP `default-src 'self'`)
- **Activation gate** — both IPC handlers call `userActivation.requireActivated()` so unauthenticated sessions can't enumerate registries
