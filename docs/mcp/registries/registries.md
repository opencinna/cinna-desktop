# MCP Registries

## Purpose

Let users browse public catalogs of MCP servers from the Settings UI and one-click "Connect" any of them — installing a remote MCP provider and triggering the standard connection flow (including OAuth where needed).

## Core Concepts

- **Registry** — A public catalog of MCP servers, addressed by a stable `id` and surfaced as a tab in the picker UI
- **Built-in registry** — Registries are hardcoded by the app developer (not user-configurable), because every registry has its own API shape and would require a custom adapter
- **Registry adapter** — Backend module that fetches a registry's native payload, filters out unusable entries, and normalizes the rest to a single shared shape (`McpRegistryEntry`)
- **Registry entry** — A single MCP server returned from a registry: name, optional title/description/version, optional `websiteUrl`, and one or more remote endpoints (`streamable-http` or `sse`)
- **Picker** — The renderer UI (search box, registry tabs, result rows with Connect button) shown when the user clicks "Add from Registry"

## User Stories / Flows

### Browsing and adding a server from a registry

1. User opens Settings → MCP Providers and clicks "Add from Registry"
2. Picker opens with the first registry's tab active (today: "MCP Official"); search input is empty by default and the latest entries are listed
3. User types a search query — results refresh from the registry API (cached 5 minutes per `(registry, query, limit)`)
4. User clicks "Connect" on a row
5. The picker creates a new MCP provider (using the row's first HTTP(S) remote, `enabled: true`) — the same `mcp:upsert` path the explicit Add forms use, so `mcpManager.connect()` runs immediately
6. Picker closes; the new MCP card appears in the providers list above with its live status indicator (`connected`, `awaiting-auth`, or `error`)
7. If the server requires OAuth, the OS browser opens for authorization — see [MCP Connections](../connections/connections.md) for the DCR flow

### Visiting a server's website / the registry homepage

- Clicking the server name opens the server's `websiteUrl` in the default browser (falls back to the GitHub repository URL when the registry exposes one)
- Clicking the "MCP Official" badge opens the registry's homepage
- Clicking the displayed remote URL opens that URL itself

All these links route through Electron's `setWindowOpenHandler`, which only forwards `http:`/`https:` URLs to `shell.openExternal`.

## Business Rules

- Registries are built-in; users cannot add or edit them from the UI
- Each registry has its own adapter module — adding a new one requires writing code and is a developer-only concern
- A registry entry is shown in the picker **only** if it has at least one remote endpoint whose URL parses as `http:` or `https:`; `stdio` entries are dropped (they can't be installed from a URL)
- The `websiteUrl` shown to the user is the server's `websiteUrl` if HTTP(S), otherwise its `repository.url` if HTTP(S), otherwise omitted — never a non-HTTP URL
- Search results are cached in main-process memory for 5 minutes per `(registryId, query, limit)`; the cache is cleared on app restart
- Search requests time out after 10 seconds and surface a typed error to the picker (`registry_unreachable` / `registry_unknown`)
- The `limit` parameter is clamped to `[1, 100]` before the wire request — renderer values outside that range are coerced
- The Connect button uses the row's **first** remote endpoint; entries with multiple endpoints are not currently exposed in the UI for selection
- After a successful Connect, the picker closes so the user sees the freshly-created card and its status

## Architecture Overview

```
Settings UI ("Add from Registry")
  -> MCPRegistryPicker (renderer)
    -> useMcpRegistries / useMcpRegistrySearch (TanStack Query)
      -> window.api.mcp.registryList / registrySearch
        -> mcp:registry-list / mcp:registry-search (IPC)
          -> mcpRegistryService.list() / .search()
            -> RegistryAdapter.search()  -- per-registry HTTP fetch
              -> Public registry API (e.g. registry.modelcontextprotocol.io)

  Click "Connect" on a row
    -> useUpsertMcpProvider (TanStack Query mutation)
      -> mcp:upsert with enabled:true (existing IPC)
        -> mcpService.upsert → mcpManager.connect (existing connection path)
```

## Built-in Registries

| Id | Label | Endpoint | Notes |
|-----|-------|----------|-------|
| `official` | MCP Official | `https://registry.modelcontextprotocol.io/v0/servers` | Uses `version=latest` and `search=` query param; no per-server detail page exists |

Adding another registry is a developer-only change — see [registries_tech.md](registries_tech.md) for the adapter contract.

## Integration Points

- [MCP Connections](../connections/connections.md) — the Connect button reuses the standard `mcp:upsert` → `mcpManager.connect` path, including OAuth DCR for servers that need it
- [Settings UI](../../ui/settings/settings.md) — the picker lives in the MCP Providers section of the Settings screen alongside the Add Custom and Add Local forms
