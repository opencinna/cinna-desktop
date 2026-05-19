# Cinna Official Registry

Aspect of [MCP Registries](registries.md). Documents the Cinna-curated catalog: where it lives, how to add/remove servers, and how desktop clients consume it.

## Purpose

A small, hand-picked catalog of remote MCP servers the Cinna team recommends. Shown as the first entries in the registry picker so users have a smoother discovery path than scanning the larger MCP Official catalog. Maintenance is a JSON edit + website redeploy — no desktop release is needed to add or remove a server.

## Core Concepts

- **Catalog** — a single static JSON file served from `cinna-web`. Lives at the well-known path `/.well-known/mcp_registry/index.json` on `opencinna.io`
- **Curated entry** — one MCP server we recommend, with display metadata and one remote endpoint. Entries are vetted by the Cinna team (working OAuth flow, reasonable tool surface, stable host)
- **Adapter** — `cinnaOfficialAdapter` in the desktop app, fetches the JSON, normalizes it to the shared `McpRegistryEntry` shape, filters search results in-memory

## Where It Lives

| Side | Path | Notes |
|------|------|-------|
| Source | `cinna-web/public/.well-known/mcp_registry/index.json` | Edited in the `cinna-web` repo |
| Hosted URL | `https://opencinna.io/.well-known/mcp_registry/index.json` | What desktop clients fetch |
| Adapter | `src/main/services/mcpRegistryService.ts` (`cinnaOfficialAdapter`) | See [registries_tech.md](registries_tech.md) for the parsing details |
| Schema definition | `docs/mcp/registries/registries_tech.md` → "Cinna Official JSON shape" | The canonical schema reference |

## Maintenance Flow

### Adding a server

1. Open the upstream server's docs and confirm: it has a remote endpoint (HTTP(S), `streamable-http` or `sse`); the server is stable; the auth model is clear
2. In `cinna-web`, edit `public/.well-known/mcp_registry/index.json` and append a new entry to the `servers` array. Required fields: `id` (kebab-case, stable), `name` (display), `remotes[0].type`, `remotes[0].url`. Recommended: `title`, `description` (1–2 sentences), `websiteUrl`, `requiresAuth` (true if the server enforces auth — surfaces an "auth required" badge in the picker)
3. Bump the top-level `updatedAt` to today's date
4. Build and preview locally (`npm run build && npm run preview` in `cinna-web`) — the file should appear at `http://127.0.0.1:5187/.well-known/mcp_registry/index.json`
5. Deploy `cinna-web` to its static host
6. Verify in any desktop client: open Settings → MCP Providers → Add from Registry. The new entry should appear under the "Cinna Official" badge (cache TTL: 5 min on each desktop client, so a freshly-relaunched app or a wait will see it immediately)

### Removing a server

1. Delete its entry from the JSON, bump `updatedAt`, redeploy
2. Existing users who already connected to that server keep their working provider — only the picker entry disappears. They can still manage/remove the provider through Settings as usual

### Versioning

- The top-level `version` field (currently `1`) is the JSON schema version. Bump it only if the file format changes in a way the desktop adapter has to handle. Today's adapter ignores the field (forward-compat best-effort), but treat any version change as also requiring a desktop release

## Business Rules

- Entries must have at least one HTTP(S) remote — `stdio` entries can't be installed from a URL and would be silently dropped by the adapter anyway
- The Cinna team is the curator; this is not user-configurable. Users wanting other servers use "Add Custom MCP" or the MCP Official catalog
- The catalog is a recommendation, not a trust anchor. Each user still goes through the server's own OAuth flow on first Connect — see [MCP Connections](../connections/connections.md). The curated list's only stronger trust signal vs. an arbitrary URL is "the Cinna team thinks this server works"
- All URLs (`websiteUrl`, `remotes[].url`) must be HTTPS. The adapter drops non-HTTP(S) URLs defensively but the JSON should never ship plain `http:` URLs in the first place
- The `id` is stable across versions. Don't rename — if a server changes brand, prefer keeping the old `id` and updating `name`/`title`

## Architecture Overview

```
cinna-web (static site)
  └── public/.well-known/mcp_registry/index.json
        │   (edited, committed, deployed)
        ▼
  opencinna.io/.well-known/mcp_registry/index.json
        │
        │  (net.fetch, 5-min in-memory cache per client)
        ▼
cinna-desktop main process
  └── mcpRegistryService → cinnaOfficialAdapter
        │   (filters by query, normalizes to McpRegistryEntry)
        ▼
  searchAll merges with MCP Official → picker UI
```

## Integration Points

- [MCP Registries](registries.md) — the parent feature; defines the picker UI, adapter interface, and merging behavior. Cinna Official is one adapter among (currently) two
- [MCP Connections](../connections/connections.md) — what the "Connect" button kicks off; OAuth DCR flow for the `requiresAuth: true` servers in the catalog
- `cinna-web` repository — the source of truth for the JSON. Build pipeline copies `public/.well-known/` into `dist/` verbatim; deployment serves it under `/.well-known/...`

## Deployment Caveat

The catalog lives under a dotfile-prefixed path (`.well-known/`). Verify the static host serves `/.well-known/...` — most do (Cloudflare Pages, Vercel, Netlify, GitHub Pages all serve dotfile-prefixed directories out of the box), but a misconfigured nginx or non-standard host could 404 the path. Symptom on desktop: every search shows a "Cinna Official: registry_unreachable" warning chip in the picker.
