# Agent Status

## Purpose

Surfaces the per-agent self-reported status (severity, summary, timestamps, markdown body) that the Cinna platform caches for every remote agent, so users can see at a glance which of their agents are healthy, which need attention, and can jump directly from a status tile into a chat with that agent.

## Core Concepts

- **Status snapshot** — The lightweight heartbeat an agent writes to `/app/workspace/docs/STATUS.md`. The backend parses and caches it on the `agent_environment` row and exposes it via REST + A2A. Desktop consumes the cached snapshot only — it never reads files directly.
- **Severity** — Normalized severity level for a snapshot: `ok` · `info` · `warning` · `error` · `unknown` · `null` (never published). Drives card tint, corner indicator, icon, and sort order.
- **Worst severity** — The highest-ranked severity across all of the user's agents. Shown as a small coloured dot on the status icon in the title bar.
- **Batch list** — The cache-only, poll-safe endpoint returning every agent the user owns. This is what the title-bar indicator and the overlay grid consume.
- **Force refresh** — Per-agent one-shot request that asks the backend to re-read `STATUS.md` from the running environment. Rate-limited to 1 call / 30 s per env by the backend; 429 responses are swallowed client-side.
- **Sentinel snapshot** — A row with both `severity == null` *and* `raw == null` — means the agent has never published a status. Hidden from the card grid per the integration spec.
- **Status overlay** — Full-window modal (frosted-glass panel) opened from the title-bar icon. Shows a responsive grid of agent cards; clicking a card opens a detail view with the full markdown body.

## User Stories / Flows

### Seeing at-a-glance agent health

1. User signs in with a Cinna account
2. A small activity icon appears in the title bar, left of the user menu
3. If any agent has published a status, the icon gains a coloured dot — red for `error`, amber for `warning`, sky for `info`, emerald for `ok`, muted for `unknown`. The dot reflects the **worst** severity across all of the user's agents
4. Hovering the icon shows a tooltip like *"Agent status — 3 agents · worst: warning"*
5. The background poll (every 45 s) keeps the indicator fresh; window-focus also triggers a refetch

### Opening the status overlay

1. User clicks the title-bar activity icon
2. The overlay fades in (350 ms) over the current screen, a frosted-glass panel sized to 5 vmin of inset on every side
3. Cards appear in a responsive grid sorted by severity (most urgent first, then by newest `reported_at`). Each card shows: bot icon + agent name, severity label + icon, status summary (≤ 3 lines), and a footer row with relative `reported_at` on the left and two circular action buttons (refresh, chat) on the right
4. Card border is tinted by severity (red/amber/sky/emerald/muted)
5. Clicking the card body opens the detail view; clicking "Refresh" or "Chat" triggers the corresponding action without opening details

### Inspecting details

1. User clicks a status card
2. Detail view replaces the grid with a header (back-arrow, bot avatar with severity dot, agent name, Refresh + Start Chat buttons)
3. Below the header: severity label, summary, `reported_at` + `fetched_at` relative timestamps (with absolute in parentheses), a `Changed from <prev_severity>` line if the severity transitioned within the last hour, and — if the agent's environment is not running — a muted "Environment is not running — showing last cached status" notice
4. The full `body` (STATUS.md with YAML frontmatter stripped) renders as GitHub-flavoured markdown
5. `Esc` returns to the grid; a second `Esc` (or click outside, or click the close button) closes the overlay

### Refreshing a single agent

1. User clicks the refresh button on a card or in the detail view
2. The button icon spins; the request calls the per-agent endpoint with `force_refresh=true`
3. If the backend returns 429 (rate-limited) the spin stops silently and the displayed status is unchanged
4. On success, the shared batch cache is patched in place — the card (and detail view, if open) update without a full re-poll

### Starting a chat from a status tile

1. User clicks the chat button on the card or the "Start Chat" button in the detail view
2. The overlay closes immediately; the app switches to the chat view with no active chat
3. The agent is preselected in the new-chat form and the chat input is focused — the user can start typing right away

### Keyboard & dismissal

1. `Esc` in the grid view closes the overlay; `Esc` in the detail view returns to the grid
2. Clicking the backdrop (anywhere outside the panel) closes the overlay
3. The close button sits at the top-right of the card (absolute, above both headers)
4. When the overlay closes while the user is on the chat view (new-chat form *or* active chat), focus is returned to the chat input on the next frame

## Business Rules

- **Cinna-only feature.** The title-bar icon is only rendered for `cinna_user` accounts; the batch hook runs with `enabled: false` for local users. A user who has a Cinna account but no remote agents yet sees no icon (dot only appears when there is at least one non-null severity).
- **Background polling** runs every **45 s** against the cache-only batch route. The query is marked stale after 15 s so mounting a new consumer (opening the overlay) reuses the cache. Focus events refetch.
- **Force refresh** is one-shot and user-triggered only — never auto-invoked. The backend enforces 1/30 s per environment; 429 responses are treated as a no-op.
- **Sentinel snapshots** (`severity == null && raw == null`) are filtered out client-side; they represent agents that have never published.
- **Local mapping.** The batch response returns backend agent UUIDs. Desktop maps them to local agent rows via `remoteTargetId` (added during `agent:sync-remote`). Any backend row without a local match is dropped — prevents surfacing statuses for agents the user just removed locally.
- **Severity rank** (highest → lowest urgency): `error`, `warning`, `info`, `ok`, `unknown`. `null` is ignored when computing worst severity.
- **Severity colouring** is theme-aware. Both dark and light themes define `--color-severity-{error,warning,info,ok,unknown}` plus a `-text` variant tuned for contrast. No hardcoded palette classes; border tints use `color-mix(... severity ... transparent)`.
- **Frosted-glass surfaces** are theme-aware. `--color-overlay-backdrop` / `--color-overlay-panel` use black-alpha in dark mode and white-alpha in light mode, so the modal never forces a dark wash onto a light UI.
- **Refresh cache patch.** The per-agent mutation's `onSuccess` writes the fresh row back into the batch query cache so the card + detail view update in place without a full poll.
- **Fade transition.** Open and close both animate opacity over **350 ms**. The component stays mounted through the close animation and then unmounts, so the card, headers, and backdrop fade together.
- **`reported_at` vs `fetched_at`.** `reported_at` is the agent's own timestamp (ground truth). `fetched_at` tells you when the platform last polled. Detail view shows both; if `reported_at_source == 'file_mtime'` an italic "from file modification time" note is appended.
- **Never-staleness colouring.** Update cadence is agent-specific (some publish every minute, some weekly) — we never colour a tile "stale". The user reads `reported_at` and judges.
- **Body safety.** `body` is rendered via `react-markdown` + `remark-gfm` only (no `rehype-raw`). Any raw HTML in STATUS.md is neutralized, matching the upstream convention that STATUS.md never contains secrets and is safe to render in any UI.
- **Start-chat path.** Every snapshot is guaranteed to map to a local agent (batch is filtered through `agentRepo.listRemote`), so the handler proceeds unconditionally: close overlay, switch to chat view, clear active chat, set `pendingAgentId`. `MainArea` consumes that one-shot flag to preselect the agent and focus the input.

## Architecture Overview

```
Main process
  agentStatusService
      ├── list(userId)            → GET /api/v1/agents/status                 [cache-only, safe to poll]
      └── get(userId, agentId)    → GET /api/v1/agents/{backend_uuid}/status  [force_refresh=true]
            │
            ▼
  Uses agentRepo.listRemote(userId) / agentRepo.getOwned(userId, agentId) — ownership enforced
  Maps backend UUID → local agent via `remoteTargetId`
  Throws AgentStatusError (not_found | forbidden | remote_unreachable | unknown) on failure
  Logs each outbound fetch with duration + status + counts

IPC
  agent-status:list   ← { success, items } | { success, code, error }
  agent-status:get    ← { success, item }  | { success, code, error }

Preload
  window.api.agentStatus.list()
  window.api.agentStatus.get({ agentId, forceRefresh? })

Renderer
  useAgentStatus()           ── React Query, 45 s poll, cinna_user-gated
  useForceRefreshAgentStatus ── Mutation, patches batch cache on success

  TitleBar
      └── Activity icon + severity dot (worst severity across agents)
              │ click
              ▼
  ui.store.agentStatusOpen = true

  AgentStatusOverlay (mounted under App, fades 350 ms)
      ├── Grid view           cards sorted by severity → freshness
      │       └── StatusCard  (refresh / chat circular icon buttons)
      └── Detail view         markdown body + reported_at / fetched_at / transition

  "Start chat" → setActiveView('chat') + setPendingAgentId(agentId)
                   │
                   ▼
  MainArea effect reacts to pendingAgentId: preselect agent + focus chat input
```

## Integration Points

- [Remote Agents](../remote_agents/remote_agents.md) — Status list is keyed by the `remoteTargetId` written on each `agents` row during `agent:sync-remote`. No new sync machinery; this feature piggybacks on the existing remote-agent pipeline.
- [Agents](../agents/agents.md) — The "Start Chat" action uses the existing `pendingAgentId` → `MainArea` → `AgentSelector` flow to preselect the agent and start an A2A chat.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — Authenticates via `getCinnaAccessToken()` for every request; a `reauth_required` code is surfaced as a re-auth hint in the overlay's error state.
- [UI — Settings / Theming](../../ui/settings/settings.md) — Severity and frosted-glass overlay tokens live in `src/renderer/src/assets/main.css` alongside the existing `--color-*` palette and adapt per theme.
- [Logger](../../development/logger/logger.md) — Each outbound request, response, non-OK status, and network error is logged via the `agent-status` scoped logger; visible in the in-app logger overlay.
