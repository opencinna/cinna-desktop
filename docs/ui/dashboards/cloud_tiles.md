# Cloud Tiles

## Purpose

A component that lives in one of the user's **own cloud agents** — an agent in a cinna-core environment rather than a folder on this computer — can sit on a desktop dashboard beside local tiles. It renders, refreshes, takes params, answers a page's calls, receives the agent's highlights and feeds the dashboard's chat panel as a local tile does, with the cloud's own rules for when an environment is woken.

The rest of [Dashboards](dashboards.md) applies unless this page says otherwise. The implementation is [Cloud Tiles (tech)](cloud_tiles_tech.md).

## Core Concepts

- **Cloud agent** — A remote agent synced from the profile's Cinna server whose target is a core agent. Only an agent the profile **owns** (the same test as Develop: not a bundle install, not a foreign install, buildable) can have tiles; core's dashboard routes are owner-only.
- **Cloud tile** — A tile whose component is a cloud agent's. It is backed by an `agent_component` **block** on a core dashboard; core owns its stored params, its cached result, its 30-runs-a-minute budget, schedule consumption, page readiness for highlights and the chat session. The desktop owns where it sits (dashboard, position, size), its title and refresh choices, and a **mirror** of the last data so the tile draws at once and while offline.
- **Backing dashboard** — The core dashboard behind one desktop dashboard's cloud tiles: one per desktop dashboard and profile, made with the first cloud tile, recorded with the server it was made on. It is created with `origin: desktop`, so core's web app does not list it and it does not count toward the web's 10-dashboard limit. Core allows 50 desktop-owned dashboards and 20 blocks per dashboard.
- **Mark** — The one-line reason a cloud tile's data is not newer: it cannot reach the server, needs a sign-in, the environment is waking or not running, the agent is gone, and so on. A mark never removes the data under it.

## User Stories / Flows

### Adding a cloud component

1. The user opens their own cloud agent's page; **Settings** has a **Dashboards** tab beside Overview, Connection and Interface. It lists the agent's components as core reports them (reading the list never wakes the environment), built like a folder agent's Dashboards tab, with the component's name where a folder agent shows its `dashboards/<name>/` path. A card reads "<agent> in the cloud".
2. **Preview** runs the component once in the cloud; **Add to dashboard…** opens the usual dialog ("from <agent> in the cloud").
3. **Add** makes the backing dashboard if the desktop dashboard has none yet, adds a block for the component, and places the tile. If the add fails and it had made a new dashboard, both the desktop dashboard and the core one it made go again.

An agent the user does not own shows no Dashboards tab; its component cards say "Only <agent>'s owner can add its components to a dashboard." and offer no **Add**.

### Watching a cloud tile

1. The tile shows the mirrored data at once.
2. When it comes on screen the desktop reads core's cached data, which never wakes anything. Only when core says that data is stale does the desktop ask core to refresh it, which wakes a suspended environment; meanwhile the tile reads "Waking <agent>…" over the cached data.
3. Core's events arrive over a live connection: the agent changed the tile's params, or highlighted rows, and the tile follows within moments. Without that connection (offline, a proxy), every on-screen cloud tile re-reads its data every 30 seconds.

### Talking to a cloud tile's agent

The dashboard's chat panel works for a cloud tile too: the panel's chat is the dashboard chat core keeps for that dashboard and agent, continued over A2A. See [Dashboard Chat](dashboard_chat.md#cloud-agents).

## Business Rules

### Wake rules follow core

- **Looking never wakes, except when the data is stale.** A tile coming on screen reads core's cached data; only a `stale` answer leads to one refresh (`open` the first time in this app run, `reshow` after), which wakes the environment. A Manual tile that has data asks for nothing.
- **A page's frame wakes its environment.** Opening an html tile's frame mints it on core, and core starts the environment if it is asleep; until it runs, the tile says the environment is starting and offers **Retry**, and reopens by itself when the tile's next result arrives — at most once every 10 seconds, since each try wakes the environment.
- **A timer never wakes.** `while_open_every` asks core with reason `interval`; core skips it while the environment sleeps (and floors it at 60 seconds). The tile keeps its data and shows no error.
- **After a turn** of the agent in the panel, an on-screen cloud tile is asked again only where its effective refresh rule says `after_turn`, exactly as a local tile. Without that rule, every turn would spend the tile's budget on core and the owner's own filter changes would start being refused.
- **No launch warm-up** for cloud tiles; "When Cinna starts" is hidden in Edit tile. Schedule-fed tiles follow core's lazy rule: missed occurrences collapse into one recompute when the data is next read.
- **A component changed elsewhere follows within about a minute.** While a dashboard with a cloud tile is open, the app reads that agent's component list from core once a minute (never waking the environment), so a component broken, fixed or retitled through the CLI or the web updates the tile without reopening the dashboard.
- **Refresh** asks core with reason `manual`; a params change sends the whole set and core recomputes.
- **Changing the refresh rule wakes the environment.** Core re-checks a block's config on every change. A change core refuses because the environment is down, or never receives, is kept and sent again after the tile's next refresh core actually runs, up to three times.

### Params

- Core stores a cloud tile's params; the desktop's copy is a mirror. A filter change is sent whole, as for a local tile.
- `current` and `today` are resolved by core in the owner's server timezone. The tile, its filter row, the page and the dashboard context show core's resolved values; before core has computed any, the tile's own values are shown, resolved locally.

### Keeping core in step

- The backing dashboard's name follows the desktop dashboard's; a block's title follows the tile's title; a tile's refresh choices go to the block's config. Removing a tile deletes its block; deleting a dashboard deletes its backing dashboard. When the last cloud tile goes, the backing dashboard stays, because it holds the agent's chat.
- **A local change never waits on the network** and never fails because the server is unreachable: these are sent in the background. A name that drifted while offline is set again on the next add.
- When core refuses an add for its 20-block limit, blocks no desktop tile refers to (left by a remove that never reached core) are deleted and the add is tried once more. The owner sees "A dashboard holds at most 20 cloud tiles." only when it is really full.
- Nothing is ever sent to a server other than the one the backing dashboard was made on.

### Failure states

Cached data always stays; the mark says why, and nothing around the tile moves. The mark sits at the tile's foot and wraps to two lines on a small tile rather than cutting its reason off.

- **The server does not answer** — "Can't reach <server>." with **Retry**; an html tile cannot load its files then, so the sentence and **Retry** replace the frame. When the connection comes back, every on-screen cloud tile is read again and the mark clears by itself.
- **The session needs a sign-in** — "Sign in to <server> again." with **Open settings** (Settings → profile Agents, where Re-authenticate is). Nothing runs.
- **The agent is gone** (core no longer has it for this user, or it left the synced list) — "<agent> is no longer available." with **Remove**. Its filters, **Ask** and **Refresh** stay where they are, disabled. The Remove confirm says the data goes with the tile; it does not promise the component can be added again.
- **The environment is not running** — "Waking <agent>…" while a wake is in flight, else "<agent>'s environment isn't running."
- **The environment cannot run components** — core's own sentence (rebuild the environment).
- **A credential is missing** — "Needs the "<name>" credential." with **Open agent**; the data stays drawn.
- **Too many runs in a minute** — the same sentence as a local tile's.
- **Made on another server** — a dashboard whose backing dashboard is on a server the profile is no longer signed in to: "Not on this server." with **Remove**; nothing runs, and its controls are disabled. A profile that is signed out is not "another server": its tiles ask for a new sign-in instead.

A page only ever sees the page codes local tiles give it (`invalid_input`, `not_found`, `rate_limited`, `needs_credentials`, `call_failed`): a cloud-only reason reaches a page's call as `call_failed` with the mark's sentence.

### Frames

A cloud tile's page is served by the desktop, not framed from the server. Main mints the frame on core, keeps the frame's capability in memory only, fetches each file from core and serves it under the tile's own `dash-` path with **the desktop's own** sandbox, content policy and navigation rule, exactly as a local tile's page. None of core's response headers but the content type pass. The page carries core's bridge (the same file the desktop bundles), so nothing is added to it. The capability never reaches the renderer or a log. See [Cloud Tiles (tech)](cloud_tiles_tech.md#the-frame-relay).

When a window reloads, its renderer crashes or the window closes, every frame it held is released: a cloud page stops telling core it can draw highlights, so the agent is not told it can highlight a page nobody has open.

### References and cards

- A `bundle:` reference resolves to the chat's own agent first, then a local agent, then the user's own cloud agent with that bundle id.
- An `id:` or slug reference reaches a cloud agent only when it is the chat's own agent, and only when core says the reference names it (the desktop cannot read a cloud agent's manifest); otherwise it falls through to local agents.
- A cloud agent's card reads core's description of the component, which never wakes anything; **Preview** runs it in the cloud.
- A card for a server that does not answer says "Can't reach <server>." and can be tried again.

## Architecture Overview

```
Renderer: cloud agent page ─ Dashboards tab ─ cards, Add      Tile (marks, Retry)  ─ WebView ── cinna-preview://dash-<H>/<tile>/
        │ dashboards:* IPC (no core ids, caps or URLs)                                  │
        ▼                                                                               ▼
Main: dashboardService (cloud rows, states) ─ backingDashboards ─┐           dashboardFrameServer (remote branch)
      dashboardRefreshService ─ remoteTileSource (mirror, marks) ├─ coreDashboardsClient ─► cinna-core REST (block routes,
      panelChat (cloud branch) ─ a2a driver (metadata)           │                           agent component routes, chat)
      coreEvents (socket.io /ws) ◄── dashboard_tile_updated / _highlight      remoteFrames ─► core /d/v/<cap>/<path>
```

## Known Gaps

- **socket.io does not use the system proxy.** Behind one, core's events do not arrive and cloud tiles fall back to the 30-second re-read.
- **A title change made while offline is never sent again**; only the dashboard name is reconciled, on the next add.
- **A late agent params change can be undone** by a refresh change written at the same moment, when core's event for it arrives after the desktop's write.
- **An `id:` or slug reference to an agent whose environment is asleep** reads as not here: core cannot read the manifest without the environment.
- **Not shared across devices or with the web.** Each desktop profile makes its own backing dashboards; core's web app does not show them.
- **Not for agents the user does not own,** nor for a dashboard made on another server.

## Integration Points

- [Dashboards](dashboards.md): everything a local tile does; this page lists the differences.
- [Dashboard Chat](dashboard_chat.md#cloud-agents): the panel's chat with a cloud agent, and the context it receives over A2A.
- [Remote Agents](../../agents/remote_agents/remote_agents.md): the synced cloud agents and their page, which gains the Dashboards tab.
- [File Preview (tech)](../../chat/file_preview/file_preview_tech.md): the `dash-` host the relayed frames share.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md): the access token every core call, the socket and A2A use.
