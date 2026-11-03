# Dashboards

## Purpose

A dashboard is a grid of live tiles the user keeps open to watch something over time — open deals, today's notes, a revenue chart. Each tile shows a **component** an agent built in its own folder; the user decides which components go where, and Cinna keeps them fresh while they are looked at. An [artifact](../../chat/artifacts/artifacts.md) is a frozen copy to hand to people; a dashboard component is a view the owner keeps.

The chat beside a dashboard, and what the agent is told about the tile in front of the user, are [Dashboard Chat](dashboard_chat.md). The implementation is [Dashboards (tech)](dashboards_tech.md).

## Core Concepts

- **Dashboard** — A named grid, per profile (up to 20 per profile, names up to 80 characters). Reached from the **Dashboards** tab in the sidebar. Deleting one removes its tiles and their cached data and nothing else: the components stay in their agents' folders, and the chats its panel started stay as ordinary chats.
- **Tile** — One placement of a component on a dashboard (up to 24 per dashboard). A tile **references** its component — the agent by its manifest id, the component by its folder name — and never copies it, so an agent that edits its component changes every tile showing it, and a moved or renamed agent folder keeps its tiles. It carries only the user's own choices: a title that replaces the component's, a size, its params, and a refresh override.
- **Component** — A folder an agent keeps under `dashboards/<name>/` (or a skill ships under `<skill>/dashboards/<name>/`), whose `component.json` says what to show, where the data comes from, how big it is and how fresh it should be. The format is core's `dashboards/1` protocol, bundled with the [kit contract](../../agents/local_agents/kit_contract.md); the agent learns it from the `cinna-dashboards` skill.
- **View** — How a component draws: four native views — **markdown**, **table**, **list**, **metrics** — drawn in Cinna's own design from data of a shape the protocol defines, or **html**, the agent's own page in a sandboxed frame. A native view is preferred because it matches the app and costs nothing to host; a page is for what the four cannot draw (a chart).
- **Source** — Where a component's data comes from: an **endpoint** (a script in the component's `api/` folder, given the params as JSON and printing one JSON value) or a **file** (`.md`, `.json` or `.csv` under the agent's `app-data/` or `files/`).
- **Size** — One of five presets on a 12-column grid: Small (3×2), Medium (6×2), Large (6×4), Wide (12×2), Tall (3×4). The grid narrows to 6 columns below about 900 px and 3 below about 440; a preset is narrowed to fit, never grown.
- **Refresh rule** — `refresh.max_age` (default **15 minutes**) says how old data may be before a visible tile recomputes. A tile may override it with another max age, or **Manual**.
- **Component reference** — A line an agent prints to offer a component: `cinna://component/<agent>/<name>` or `…/<agent>/<skill>/<name>`, where `<agent>` is `id:<manifest id>`, `bundle:<bundle id>` or a bare slug. In a chat it is drawn as a **component card**.

## User Stories / Flows

### Getting a component onto a dashboard

1. The user asks an agent for something to keep — "a view of my open deals I can keep on a dashboard". The agent builds `dashboards/<name>/`, checks it with the skill's `check_component.py`, and prints the component's reference on a line of its own.
2. The reference appears in the chat as a card: title, view, the agent (and skill, when the component comes from one), and where it already sits. **Preview** runs the source once and draws it at a chosen size; **Add to dashboard…** opens the dialog.
3. In the dialog the user picks a dashboard (or **New dashboard…**, typed in the same slot; on a profile with no dashboard the name starts as "My dashboard"), a size, a title, and the refresh rule. **Add** places the tile.
4. The same two buttons are on the agent's **Dashboards** tab, which lists every component the agent has — its own, then each skill's under "From skill <name>" — whether or not it is placed. Listing runs nothing.

### Watching a dashboard

1. The user opens **Dashboards** in the sidebar tab strip. The tab comes back to the dashboard that was open, as Chats comes back to its chat; with none open it opens the first. **+** makes a dashboard; right-click renames or deletes one.
2. Each tile shows its last good data at once and recomputes behind it when stale. A tile just scrolled into view for the first time recomputes if it is stale, focused or not.
3. On hover a tile's top strip shows its age, **Refresh**, **Ask** (see [Dashboard Chat](dashboard_chat.md)), the component's suggested questions and a **⋯** menu: size, **Edit tile…** (title and refresh rule), **Open agent**, **Remove…**.
4. **Edit layout** in the header turns the tiles into drag handles; releasing sends one move. **Refresh** in the header recomputes every tile that can run.

### When a tile cannot be drawn

Every state is drawn inside the tile, at the tile's size, so nothing around it moves.

- **No data yet** — a skeleton; then the error sentence when the first run failed.
- **Refreshing** — a corner spinner over the data; the age reads "Refreshing…".
- **A refresh failed** — the data stays; a mark whose tooltip gives the reason.
- **A notice** — a result may carry a one-line `notice`; it becomes a mark on the tile.
- **Too large to keep** — a result over 1 MB is shown but not stored, and is gone after a restart.
- **The agent is not on this machine / the component is gone** — a sentence and **Remove**.
- **The component has problems** — the error findings, in the words of core's checker.
- **A credential is missing** — "This needs the “crm” credential, which is not set up for this agent yet." with a link to the agent's Credentials tab; nothing runs.

## Business Rules

### Freshness belongs to main

The renderer never decides when to recompute. It says "these tiles are on screen" and "Refresh was pressed"; main decides what that means.

- **Stale while revalidating.** The last good result per tile and param set is cached and shown at once.
- **Visible.** A tile that is on screen and whose last attempt is older than its max age recomputes. The *last attempt*, good or failed: a script that keeps failing is retried once per max age, not on every renewal.
- **The visibility lease.** While the window is shown and focused, the dashboard tells main every 20 seconds which tiles are on screen, and each renewal re-checks them. A lease not renewed within 30 seconds is gone, so a hidden or reloaded window stops costing recomputes within one lease. Hiding the window, losing focus or leaving the dashboard drops it; focus moving into a tile's own frame does not count as losing it.
- **Manual.** A tile set to Manual recomputes only on **Refresh** once it has data — and when it has none yet.
- **After a turn.** When a turn of an agent ends, each of its tiles that holds a live lease is asked again. A plain file source (no `refresh.command`) is simply re-read, which costs nothing; anything that would run a script recomputes only where the component says `refresh.after_turn: true`. A Manual tile that has data, and a tile nobody is looking at, run nothing. The renderer cannot ask for this reason itself.
- **On profile close and app quit,** every run is cancelled and every lease forgotten. Quitting waits for the processes to end.
- **A failure keeps the data** and stores the error beside it until a run succeeds.
- **A busy agent skips the tick.** While the agent's folder is being written by an editor save, a sharing step or a credential write, a refresh is not run and the tile keeps its data, with no error. Dashboards yield to those writes — see [the turn lock in the tech doc](dashboards_tech.md#the-turn-lock).
- **Same params join, new params supersede.** A second request for a run in flight with the same params gets the running one; a newer call for the same tile and endpoint cancels the older.
- **Output is data.** Anything a script prints is parsed first and then has credential values redacted from its strings before it is cached or shown.

What the schema also defines — `refresh.while_open_every`, `on_app_start`, a `schedule` feeding a tile — is **read and validated but not acted on yet** (see Known gaps).

### Components are read on demand, never cached

A component is a handful of small files; every read is fresh, which is what makes "a tile references, never copies" true. The folder watcher announces a change and the renderer reads again. At most 100 components are read per agent. Reading runs nothing: only **Preview**, **Add**, a visible tile and **Refresh** run a source, and text in a chat never does.

### Findings are core's

A component is checked by the same rules, and reported with the same codes, as core's `check_component.py`: a finding is a `(path, code, field)` with a severity. An **error** makes the component invalid — no Preview, no Add, and a placed tile says why; a **warning** is shown and changes nothing. Because the desktop applies the rules itself rather than running the script, a card and the agent's own check never disagree. Only the script's `--run` checks are not repeated: the desktop runs a source when the user asks, never to validate. A card's **Ask to fix** puts a request naming the component in the chat's composer; it never sends.

### Components from skills

A skill may ship components in its own `dashboards/<name>/`. A component is named by (agent, skill, name) everywhere — tile, card, reference. Its script runs from the skill's folder (which may be a read-only catalog or marketplace copy), with the agent's folder as working directory and the agent's credentials. A skill that is gone reads as a component that is gone. In the add-on picker a skill that ships components says "Includes 2 dashboard components".

### Credentials

A component's `requires_credentials` names credential slots the agent must have ready. An optional slot counts as filled only when something is actually attached or present in `.env`. With any missing, nothing is spawned: the card and tile name the credential and link to the Credentials tab, and the cached data stays beside the sentence.

### Component references and cards

- **Grammar.** The prefix is always written; a form is never guessed from its shape, so a dotted segment without `bundle:` is not a reference. Anything that does not parse strictly is plain text. A bundle id or manifest id form survives a rename; a slug is the friendliest and the weakest.
- **Where they become cards.** A line that is exactly one reference — bare, an angle autolink, or `[text](cinna://component/…)` inside a paragraph, list item or quote — is removed and becomes a card; the link text becomes the subtitle. A reference link inside prose stays as text and its card joins the list. A reply still streaming holds its last line back, so `deals` does not flash as a card on its way to `deals-pipeline`. Code spans and blocks never make cards. <!-- nocheck -->
- **One list per message, one card per component,** at the place of the first reference.
- **The reference resolves for the chat's own agent first.** When a slug or bundle matches two agents, the agent whose message it is wins; with no such agent the card says two agents match.
- **A card that cannot find its component says why, in one sentence, and links where the fix is** — never a broken link. The reasons: its agent is not on this machine; its bundle is not installed (named from the catalog when the profile can see it, with **Open in catalog**); two agents match; the component is not in the agent (**Open agent**); it is not in the user's copy of a bundle install (**Open Sharing**); the agent is a plain folder and components need a kit agent.
- **Copy reference** writes the canonical form: the bundle form when the agent has a bundle id (the manifest's, else the shared-agent record's), otherwise the id form.
- **Every card is the same three lines tall** — title and actions; who; where — and its skeleton is the same box, so a card arriving moves nothing.
- **An agent that has no id** cannot have tiles: **Add** is disabled with "This agent needs an id first" and a link to the Folder tab.

### What the agent is told

Every kit agent — not a bare folder — gets the `cinna-dashboards` skill, with no profile gate (dashboards are a desktop feature; artifacts need an instance). Its prompt gets a short section: open the skill before building under `dashboards/`, check each component with the bundled script before printing a reference, and the agent's own reference prefix. The section is left out when the manifest has neither an id nor a bundle id, because no reference such an agent printed could resolve. Per engine, see [the tech doc](dashboards_tech.md#delivering-the-skill).

### Web views

An html component's page runs in a sandboxed frame with an opaque origin: no top navigation (not even inside a click: the frame's sandbox omits `allow-top-navigation-by-user-activation`, so leaving a tile can only ever be something the host draws), no storage or cookies, no workers, no nested frames, and it can load only files of its own component folder. Its data and its endpoints arrive only through the bridge: the page calls `onData` to receive the result, and the host runs the endpoint. The bridge file is core's, injected unchanged.

## Architecture Overview

```
Agent folder: dashboards/<name>/component.json + api/ + page files
        │  read fresh on every request (componentScanner)
        ▼
Main: dashboardService (CRUD, resolve tile → component)
      dashboardRefreshService (lease, max age, after_turn, cache) ──► endpointRunner ──► shell child (turn lock, yielding)
        │  dashboards:* IPC, dashboards:tile-changed push
        ▼
Renderer: Dashboards tab ─ DashboardView ─ Tile ─ native view | WebView ──cinna-preview://dash-<H>/<tile>/──► dashboardFrameServer
                                                          └─ postMessage bridge ◄── core's dashboards-bridge.js in the page
Chat: ComponentCard (reference → dashboards:resolve-reference)  ·  DashboardChatPanel (see Dashboard Chat)
```

## Known Gaps

- **No fallback for a web view that never calls `setContext`.** The chat panel then gets an empty summary and selection for that tile. A host-side fallback (reading the page's microdata) needs a bridge method, and the bridge is core's file.
- **Bridge methods not built:** `tools/call` (a page's `cinna.call`), `cinna/params-changed` (`setParams`, dropped), `ui/open-link` and `ui/message`. Each gets a JSON-RPC error, so `cinna.call` rejects. The endpoint-from-a-page path, storing `setParams`, and the open-link confirm are the next phase.
- **Schedule-fed tiles and the other refresh fields** (`while_open_every`, `on_app_start`, `schedule`) are accepted and validated, not acted on.
- **A tile below the fold computes nothing until it is scrolled into view.** By design: the lease is for what is on screen.
- **`stray_file` warnings** have no place in the UI.
- **The add-on picker's component count** depends on the shape of core's catalog download path and reads the locally cached copy only; a skill never downloaded says nothing.
- **Cloud agents have no dashboards** — only Cinna Desktop shows components; the `artifacts_publish` description says so, so an agent there uses an artifact.

## Integration Points

- [Local Agents — Agents Tab](../../agents/local_agents/agents_tab.md): the **Dashboards** settings tab of a kit agent.
- [Kit Contract](../../agents/local_agents/kit_contract.md) and [its tech doc](../../agents/local_agents/kit_contract_tech.md): the `dashboards` folder role, `protocols/dashboards.schema.json`, the bridge, the skill and templates — all core's, bundled.
- [File Preview](../../chat/file_preview/file_preview.md): shares the `cinna-preview:` scheme; a `dash-` host is a third server beside the HTML preview's and the artifact preview's.
- [Artifacts](../../chat/artifacts/artifacts.md): what to publish instead when the thing is a snapshot.
- [Agent Skills](../../agents/local_agents/skills.md) and the engine docs: how `cinna-dashboards` reaches each engine.
- [Commands](../../agents/local_agents/commands.md): a file-sourced component's `refresh.command` is a `/run:` command.
- [Agent Turn](../../agents/local_agents/agent_turn.md): the turn lock the runs yield to; a turn's end triggers the after-turn refresh.
- [App Shell](../app_shell/app_shell.md): the sidebar tab and the `dashboard` view.
- [Dashboard Chat](dashboard_chat.md): the panel, its context and the chat's origin.
