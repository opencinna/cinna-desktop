# MCP Registries

## Purpose

Let users browse public catalogs of MCP servers from the Settings UI and one-click "Connect" any of them — installing a remote MCP provider and triggering the standard connection flow (including OAuth where needed).

## Core Concepts

- **Registry** — A public catalog of MCP servers, addressed by a stable `id`. Each entry shown in the picker keeps a badge identifying which registry it came from
- **Built-in registry** — Registries are hardcoded by the app developer (not user-configurable), because every registry has its own API shape and would require a custom adapter
- **Registry adapter** — Backend module that fetches a registry's native payload, filters out unusable entries, and normalizes the rest to a single shared shape (`McpRegistryEntry`)
- **Registry entry** — A single MCP server returned from a registry: name, optional title/description/version, optional `websiteUrl`, and one or more remote endpoints (`streamable-http` or `sse`)
- **Picker** — The renderer UI (single search box, unified result list with a per-row registry badge, Connect button) shown when the user clicks "Add from Registry"

## User Stories / Flows

### Browsing and adding a server from a registry

1. User opens Settings → MCP Providers and clicks "Add from Registry"
2. Picker opens with an empty search input and a unified list of servers from every built-in registry; Cinna-curated entries appear first (insertion order of the adapters map), followed by entries from the MCP Official registry
3. User types a search query — results refresh from every registry in parallel (each is cached 5 minutes per `(registry, query, limit)` in main process)
4. If a single registry fails (network error, 5xx), the picker still renders results from the others and shows a small inline warning naming the failed registry
5. User clicks "Connect" on a row
6. The picker creates a new MCP provider (using the row's first HTTP(S) remote, `enabled: true`) — the same `mcp:upsert` path the explicit Add forms use, so `mcpManager.connect()` runs immediately
7. The new connector records the registry entry it was made from (`registry_ref`, see below). Picker closes; the new MCP card appears in the providers list above with its live status indicator (`connected`, `awaiting-auth`, or `error`)
8. If the server requires OAuth, the OS browser opens for authorization — see [MCP Connections](../connections/connections.md) for the DCR flow

### Visiting a server's website / the registry homepage

- Clicking the server name opens the server's `websiteUrl` in the default browser (falls back to the GitHub repository URL when the registry exposes one)
- Clicking the per-row registry badge ("Cinna Official", "MCP Official", …) opens that registry's homepage
- Clicking the displayed remote URL opens that URL itself

All these links route through Electron's `setWindowOpenHandler`, which only forwards `http:`/`https:` URLs to `shell.openExternal`.

## Business Rules

- Registries are built-in; users cannot add or edit them from the UI
- Each registry has its own adapter module — adding a new one requires writing code and is a developer-only concern
- The picker shows a single merged list across every built-in registry; there is no per-registry tab or filter
- Merged-result ordering is determined by the adapters' insertion order in `mcpRegistryService.ts` (Cinna Official first today) — entries within each registry preserve that registry's natural order
- A registry entry is shown in the picker **only** if it has at least one remote endpoint whose URL parses as `http:` or `https:`; `stdio` entries are dropped (they can't be installed from a URL)
- The `websiteUrl` shown to the user is the server's `websiteUrl` if HTTP(S), otherwise its `repository.url` if HTTP(S), otherwise omitted — never a non-HTTP URL
- Per-registry results are cached in main-process memory for 5 minutes per `(registryId, query, limit)`; the cache is cleared on app restart. `searchAll` reuses these caches, so a previously-cached registry doesn't refetch on the next query
- `searchAll` is fault-isolated: a failing registry surfaces a per-registry error in the result `errors` array while every other registry's results still render
- Search requests time out after 10 seconds and surface a typed error (`registry_unreachable` / `registry_unknown`)
- The `limit` parameter is clamped to `[1, 100]` before the wire request — renderer values outside that range are coerced
- The Connect button uses the row's **first** remote endpoint; entries with multiple endpoints are not currently exposed in the UI for selection
- After a successful Connect, the picker closes so the user sees the freshly-created card and its status

### Reaching an agent through the addon picker

The same registries are also a source of the agent's **Add** ([Agent Addons](../../agents/local_agents/addons.md)), not only of Settings → MCP. The addon directory's **MCP registries** provider lists the Cinna Official index whole and searches the MCP Official registry only (after a 300 ms pause and at least two characters, since it holds thousands of servers). Adding an entry there creates the connector and attaches it to the agent in one step, and the connector carries the entry's `registry_ref` (`mcp-registry:<registryId>` plus the server id) — the Settings picker records the same ref. The ref is what keeps the connector from being listed twice afterwards, as the registry entry and as a connector on this computer; a connector that came from a registry shows once, under "On this computer". Only entries with an HTTP(S) remote are offered, as here, and a registry that is switched off by the account's policy (public directories) is not offered at all.

**Core's MCP directory is the third source, and replaces the Cinna Official listing when it answers.** The addon directory's Cinna provider reads core's unified `/addons/directory`, whose MCP directory is seeded from the Cinna Official index and also lists servers that run locally from a package (npm, PyPI or an OCI image), which these registries' adapters drop because they accept only HTTP(S) remotes. Listing both would show every Cinna Official server twice, so when core's directory has answered **and holds MCP entries** the registries provider does **not** list the Cinna Official index (an index with none leaves it listed); it still resolves its refs, so a connector made from it earlier keeps its entry; and a connector already on this computer that is the same server as a core entry (same URL or package) shows as that connector. Settings' Add from Registry is hidden while the admin turns public directories off. Against an older core that has no such endpoint, the index is listed as before. The public MCP Official registry is unaffected and stays search-only. A connector made from one of core's entries records its `registry_ref` like any other and installs as described in [Agent Addons](../../agents/local_agents/addons.md#local-servers-from-cores-mcp-directory). Apart from that policy, Settings' own picker is unchanged: it still lists the built-in registries' remote servers.

The picker's add differs from Settings' in one respect: its first connect is non-interactive, so a server needing a sign-in never opens a browser from the add; the picker offers the sign-in as the next step. Settings' Connect still opens the browser at once.

## Architecture Overview

```
Settings UI ("Add from Registry")
  -> MCPRegistryPicker (renderer)
    -> useMcpRegistries / useMcpRegistrySearchAll (TanStack Query)
      -> window.api.mcp.registryList / registrySearchAll
        -> mcp:registry-list / mcp:registry-search-all (IPC)
          -> mcpRegistryService.list() / .searchAll()
            -> Promise.allSettled over every RegistryAdapter.search()
              -> Public registry APIs in parallel
                (Cinna Official static JSON, registry.modelcontextprotocol.io, …)

  Click "Connect" on a row
    -> useUpsertMcpProvider (TanStack Query mutation)
      -> mcp:upsert with enabled:true (existing IPC)
        -> mcpService.upsert → mcpManager.connect (existing connection path)
```

## Built-in Registries

| Id | Label | Endpoint | Notes |
|-----|-------|----------|-------|
| `cinna-official` | Cinna Official | `https://opencinna.io/.well-known/mcp_registry/index.json` | Static JSON curated by the Cinna team and served from the OpenCinna website. Filtering happens client-side (in main process) since the list is fully loaded. See [cinna_official.md](cinna_official.md) for the maintenance workflow |
| `official` | MCP Official | `https://registry.modelcontextprotocol.io/v0/servers` | Uses `version=latest` and `search=` query param; no per-server detail page exists |

Adding another registry is a developer-only change — see [registries_tech.md](registries_tech.md) for the adapter contract. Adding/removing a server from the Cinna Official registry only requires editing the JSON file in the `cinna-web` repo and re-deploying the website — see [cinna_official.md](cinna_official.md).

## Integration Points

- [MCP Connections](../connections/connections.md) — the Connect button reuses the standard `mcp:upsert` → `mcpManager.connect` path, including OAuth DCR for servers that need it
- [Agent Addons](../../agents/local_agents/addons.md) — the addon picker lists and searches the registries and records `registry_ref` on what it creates
- [Settings UI](../../ui/settings/settings.md) — the picker lives in the MCP Providers section of the Settings screen alongside the Add Custom and Add Local forms
