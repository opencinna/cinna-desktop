# Agent Status — Technical Details

## File Locations

### Main Process

| Purpose | File |
|---------|------|
| Service (batch + per-agent fetches, logging, error mapping) | `src/main/services/agentStatusService.ts` |
| IPC handlers (`agent-status:list`, `agent-status:get`) | `src/main/ipc/agent_status.ipc.ts` |
| IPC handler registration | `src/main/ipc/index.ts` — `registerAgentStatusHandlers()` |
| Remote-agent repository helpers | `src/main/db/agents.ts` — `agentRepo.listRemote(userId)`, `agentRepo.getOwned(userId, agentId)` |
| Typed domain error | `src/main/errors.ts` — `AgentStatusError`, `AgentStatusErrorCode` |
| Logger scope | `src/main/logger/logger.ts` — `createLogger('agent-status')` |
| Cinna JWT token | `src/main/auth/cinna-tokens.ts` — `getCinnaAccessToken(userId)` |
| Reauth signal | `src/main/auth/cinna-oauth.ts` — `CinnaReauthRequired` |

### Preload

| Purpose | File |
|---------|------|
| Bridge API | `src/preload/index.ts` — `api.agentStatus.list()`, `api.agentStatus.get({ agentId, forceRefresh? })` |
| Type | `src/preload/index.ts` — `AgentStatusSnapshot`, `AgentStatusSeverity` |

### Renderer

| Purpose | File |
|---------|------|
| Data hook (batch poll + cache) | `src/renderer/src/hooks/useAgentStatus.ts` — `useAgentStatus()` |
| Force-refresh mutation (patches batch cache on success) | `src/renderer/src/hooks/useAgentStatus.ts` — `useForceRefreshAgentStatus()` |
| Typed client-side error | `src/renderer/src/hooks/useAgentStatus.ts` — `AgentStatusRequestError` |
| Severity palette + `worstSeverity()` | `src/renderer/src/constants/agentSeverity.ts` |
| Title-bar icon with severity dot | `src/renderer/src/components/layout/TitleBar.tsx` |
| Modal / overlay (grid + detail view + cards) | `src/renderer/src/components/agents/AgentStatusOverlay.tsx` |
| Overlay mount point | `src/renderer/src/App.tsx` |
| UI state (`agentStatusOpen`, `pendingAgentId`) | `src/renderer/src/stores/ui.store.ts` |
| Pending-agent effect + focus-return effect | `src/renderer/src/components/layout/MainArea.tsx` |
| CSS tokens (severity + overlay) | `src/renderer/src/assets/main.css` |

## Database Schema

No schema changes. The feature reuses the existing `agents` table — specifically the `remoteTargetId` column populated by the remote-agent sync (see [Remote Agents — Technical Details](../remote_agents/remote_agents_tech.md)). The backend's per-agent UUIDs are matched against this column to map REST responses back to local agent rows.

## IPC Channels

| Channel | Type | Params | Returns |
|---------|------|--------|---------|
| `agent-status:list` | handle | — | `{ success: true, items: AgentStatusSnapshot[] }` or `{ success: false, code, error }` |
| `agent-status:get` | handle | `{ agentId: string, forceRefresh?: boolean }` | `{ success: true, item: AgentStatusSnapshot \| null }` or `{ success: false, code, error }` |

Error `code` values: `reauth_required` · `not_found` · `forbidden` · `remote_unreachable` · `unknown`.

## Backend Endpoints

| Endpoint | Used from | Notes |
|----------|-----------|-------|
| `GET /api/v1/agents/status` | `agentStatusService.list()` | Cache-only, safe to poll. Returns every agent the authenticated user owns. |
| `GET /api/v1/agents/{agent_id}/status?force_refresh=<bool>` | `agentStatusService.get()` | Rate-limited to 1/30 s per env when `force_refresh=true`; 429 swallowed (returns `null`). |

Both endpoints use the user's Cinna JWT via `Authorization: Bearer <token>` (resolved per request via `getCinnaAccessToken(userId)`).

## Services & Key Methods

| Method | File | Purpose |
|--------|------|---------|
| `agentStatusService.list(userId)` | `src/main/services/agentStatusService.ts` | Batch fetch; filters sentinel rows; maps backend UUID → local agent id via `agentRepo.listRemote`. |
| `agentStatusService.get(userId, agentId, forceRefresh)` | `src/main/services/agentStatusService.ts` | Per-agent fetch; 429 returns `null`; ownership enforced via `agentRepo.getOwned`. |
| `errorFromStatus(status, statusText, url)` | `src/main/services/agentStatusService.ts` | HTTP status → `AgentStatusError` with stable `code` (404 → `not_found`, 403 → `forbidden`, 5xx → `remote_unreachable`, else `unknown`). |
| `getCinnaContext(userId)` | `src/main/services/agentStatusService.ts` | Resolves `{ baseUrl, accessToken }`; returns `null` for non-`cinna_user` accounts so the service is a no-op there. |
| `agentRepo.listRemote(userId)` | `src/main/db/agents.ts` | `WHERE source='remote' AND remote_target_id IS NOT NULL` at SQL level. |

## Renderer Components

| Component / hook | File | Role |
|------------------|------|------|
| `useAgentStatus()` | `src/renderer/src/hooks/useAgentStatus.ts` | React Query for the batch list; `refetchInterval: 45_000`, `staleTime: 15_000`, `enabled: cinna_user`. Throws `AgentStatusRequestError` with typed `code` on failure. |
| `useForceRefreshAgentStatus()` | `src/renderer/src/hooks/useAgentStatus.ts` | Per-agent mutation; `onSuccess` patches the batch cache so consumers update in place. |
| `TitleBar` | `src/renderer/src/components/layout/TitleBar.tsx` | Renders the `Activity` icon + severity dot (via `worstSeverity()` + `SEVERITY_DOT`); only for `cinna_user`. |
| `AgentStatusOverlay` | `src/renderer/src/components/agents/AgentStatusOverlay.tsx` | Root of the modal; owns the fade state machine (`mounted` + `visible`), the single force-refresh mutation, and swaps between grid and detail views. |
| `StatusCard` (inner) | `src/renderer/src/components/agents/AgentStatusOverlay.tsx` | Grid tile — bot avatar, name, severity label, summary, timestamp row, circular Refresh + Chat buttons. Takes `refreshing` + `onRefresh` from the parent — no local mutation state. |
| `DetailView` (inner) | `src/renderer/src/components/agents/AgentStatusOverlay.tsx` | Header with agent avatar + severity dot + Refresh / Start Chat buttons; body renders markdown via `react-markdown` + `remark-gfm`. Reads live snapshot from the parent (no local cache). |
| `MainArea` | `src/renderer/src/components/layout/MainArea.tsx` | Two effects — one consumes `pendingAgentId` to preselect the agent and focus the input; another watches `agentStatusOpen` and re-focuses the input when the overlay closes on the chat view. |

## UI State

| Key | File | Notes |
|-----|------|-------|
| `agentStatusOpen: boolean` | `src/renderer/src/stores/ui.store.ts` | Drives overlay visibility. |
| `pendingAgentId: string \| null` | `src/renderer/src/stores/ui.store.ts` | One-shot: set by "Start Chat", consumed + cleared by `MainArea`. |
| Overlay-local `mounted` / `visible` / `detailAgentId` | `AgentStatusOverlay.tsx` | Fade state machine + currently-expanded detail card. |

## CSS Tokens

Defined in `src/renderer/src/assets/main.css` (dark + light variants):

| Token | Use |
|-------|-----|
| `--color-severity-{error,warning,info,ok,unknown}` | Solid fills (dots, pill backgrounds) |
| `--color-severity-{...}-text` | Foreground text — tuned lighter in dark theme, darker in light theme for contrast |
| `--color-overlay-backdrop` | Outer backdrop tint — black-alpha in dark, white-alpha in light |
| `--color-overlay-panel` | Inner panel + header tint — subtler alpha of the same base |

Consumed through the shared constants module:

| Export | File |
|--------|------|
| `SEVERITY_RANK`, `SEVERITY_LABEL`, `SEVERITY_DOT`, `SEVERITY_TEXT`, `SEVERITY_CARD_BORDER` | `src/renderer/src/constants/agentSeverity.ts` |
| `worstSeverity(items)` | `src/renderer/src/constants/agentSeverity.ts` — reused in `TitleBar` |

## Configuration

No user-facing settings. Hardcoded values worth knowing:

| Value | Location | Rationale |
|-------|----------|-----------|
| Poll interval: **45 000 ms** | `useAgentStatus.ts` — `refetchInterval` | Within the 30–60 s range recommended by the integration spec for the cache-only endpoint. |
| Stale time: **15 000 ms** | `useAgentStatus.ts` — `staleTime` | Lets the overlay reuse the cached value when mounted close to a background poll. |
| Fade duration: **350 ms** | `AgentStatusOverlay.tsx` — `FADE_MS` | Drives both the inline `transitionDuration` style and the post-close unmount timer. |
| Rate-limit on force refresh: **1 / 30 s / env** | Server-enforced | Desktop treats 429 as a silent no-op. |
| Severity-changed "recent" window: **60 min** | `DetailView` | Threshold for showing the `Changed from <prev_severity>` line. |

## Security

- **Cinna JWT** — Every request uses the bearer token resolved per-call by `getCinnaAccessToken(userId)`; refresh and replay detection are handled there. Tokens never cross the IPC boundary.
- **Ownership** — `agentRepo.getOwned(userId, agentId)` enforces row-level ownership for the per-agent path. The batch path is implicitly scoped because the backend filters by the JWT's user and we additionally drop any UUID without a local match.
- **Activation gate** — Both handlers call `userActivation.requireActivated()` before any service logic.
- **Markdown rendering** — `react-markdown` is used without `rehype-raw`; raw HTML from STATUS.md cannot be rendered as markup. Per the backend convention, STATUS.md never contains secrets.
- **Error shape** — `AgentStatusError` crosses the IPC boundary via `ipcHandle()`; the `code` survives serialization so the renderer can branch on it (e.g., display a re-auth CTA on `reauth_required`).

## Observability

Every outbound HTTP call is logged with the `agent-status` scope:

| Event | Level | Payload |
|-------|-------|---------|
| Pre-request | info | `url`, `agentId?`, `forceRefresh?` |
| Response OK | info | `url`, `status`, `durationMs`, `totalItems` / `localMatches` / `severity` |
| Non-OK response | warn | `url`, `status`, `statusText`, `durationMs`, `agentId?` |
| Network error | error | `url`, `durationMs`, `error`, `agentId?` |
| 429 (force refresh) | info | `agentId`, `durationMs` — path continues silently, returns `null` |

All entries are visible in the in-app logger overlay (Cmd+`). See [Logger](../../development/logger/logger.md).
