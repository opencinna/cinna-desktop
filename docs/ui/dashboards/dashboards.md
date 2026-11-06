# Dashboards

## Purpose

A dashboard is a grid of live tiles the user keeps open to watch something over time — open deals, today's notes, a revenue chart. Each tile shows a **component** an agent built in its own folder — or, for the user's own cloud agents, in their environment on the Cinna server ([Cloud Tiles](cloud_tiles.md)); the user decides which components go where, and Cinna keeps them fresh while they are looked at. An [artifact](../../chat/artifacts/artifacts.md) is a frozen copy to hand to people; a dashboard component is a view the owner keeps.

The chat beside a dashboard, and what the agent is told about the tile in front of the user, are [Dashboard Chat](dashboard_chat.md). Tiles of cloud agents are [Cloud Tiles](cloud_tiles.md). The implementation is [Dashboards (tech)](dashboards_tech.md).

## Core Concepts

- **Dashboard** — A named grid, per profile (up to 20 per profile, names up to 80 characters). Reached from the **Dashboards** tab in the sidebar. Deleting one removes its tiles and their cached data and nothing else: the components stay in their agents' folders, and the chats its panel started stay as ordinary chats.
- **Tile** — One placement of a component on a dashboard (up to 24 per dashboard). A tile **references** its component — the agent by its manifest id, the component by its folder name — and never copies it, so an agent that edits its component changes every tile showing it, and a moved or renamed agent folder keeps its tiles. It carries only the user's own choices: a title that replaces the component's, a size, its params, and a refresh override (any of the five refresh fields). A **cloud tile** references a cloud agent's component instead and is backed by a block on a core dashboard, which owns its params and data; see [Cloud Tiles](cloud_tiles.md).
- **Component** — A folder an agent keeps under `dashboards/<name>/` (or a skill ships under `<skill>/dashboards/<name>/`), whose `component.json` says what to show, where the data comes from, how big it is and how fresh it should be. The format is core's `dashboards/1` protocol, bundled with the [kit contract](../../agents/local_agents/kit_contract.md); the agent learns it from the `cinna-dashboards` skill.
- **View** — How a component draws: four native views — **markdown**, **table**, **list**, **metrics** — drawn in Cinna's own design from data of a shape the protocol defines, or **html**, the agent's own page in a sandboxed frame. A native view is preferred because it matches the app and costs nothing to host; a page is for what the four cannot draw (a chart).
- **Source** — Where a component's data comes from: an **endpoint** (a script in the component's `api/` folder, given the params as JSON and printing one JSON value) or a **file** (`.md`, `.json` or `.csv` under the agent's `app-data/` or `files/`).
- **Size** — One of five presets on a 12-column grid: Small (3×2), Medium (6×2), Large (6×4), Wide (12×2), Tall (3×4). The grid narrows to 6 columns below about 900 px and 3 below about 440; a preset is narrowed to fit, never grown.
- **Params** — The values a component declares it can be set by (`params` in `component.json`: `enum`, `month`, `date`, `date_range`, `number`, `boolean`, `text`). A tile stores them; the endpoint receives them. `current` (a month) and `today` (a date) are words the tile keeps and main turns into a value each time it runs, so "current" follows the calendar.
- **Refresh rule** — The component's `refresh`: `max_age` (default **15 minutes**) says how old data may be before a visible tile recomputes; `while_open_every` (at least 1 minute) recomputes it on a timer while it is on screen; `after_turn` and `on_app_start` are flags; `schedule` names the agent schedule that feeds it. A tile may override each of the first four, or choose **Manual**. The tile's override is laid over the component's field by field, and every place that decides when to run reads that one **effective** rule.
- **Component reference** — A line an agent prints to offer a component: `cinna://component/<agent>/<name>` or `…/<agent>/<skill>/<name>`, where `<agent>` is `id:<manifest id>`, `bundle:<bundle id>` or a bare slug. In a chat it is drawn as a **component card**.

## User Stories / Flows

### Turning Dashboards on

Dashboards is an optional [capability](../capabilities/capabilities.md): off for a new user, on for one with a dashboard in any profile. Off, there is no Dashboards tab, a component card and an agent's Dashboards tab list and preview components but offer no **Add to dashboard…**, the "From dashboard" pill and chat-row mark are hidden, and a card's dashboard names are plain text. Nothing runs in the background either: no launch warm-up, no `while_open_every` timer, no schedule-fed refresh. Placed tiles and their cached data are kept and come back when it is turned on again (timers re-arm at the next lease renewal, within about 20 s; warm-up waits for the next profile start). What the user or an agent asks for directly still runs.

### Getting a component onto a dashboard

1. The user asks an agent for something to keep — "a view of my open deals I can keep on a dashboard". The agent builds `dashboards/<name>/`, checks it with the skill's `check_component.py`, and prints the component's reference on a line of its own.
2. The reference appears in the chat as a card: title, view, the agent (and skill, when the component comes from one), and where it already sits. **Preview** runs the source once and draws it at a chosen size; **Add to dashboard…** opens the dialog.
3. In the dialog the user picks a dashboard (or **New dashboard…**, typed in the same slot; on a profile with no dashboard the name starts as "My dashboard"), a size, a title, and the refresh rule. **Add** places the tile.
4. The same two buttons are on the agent's **Dashboards** tab, which lists every component the agent has — its own, then each skill's under "From skill <name>" — whether or not it is placed. Listing runs nothing.

### Watching a dashboard

1. The user opens **Dashboards** in the sidebar tab strip. The tab comes back to the dashboard that was open, as Chats comes back to its chat; with none open it opens the first. **+** makes a dashboard; right-click renames or deletes one.
2. Each tile shows its last good data at once and recomputes behind it when stale. A tile just scrolled into view for the first time recomputes if it is stale, focused or not.
3. The tile's top strip is 34 px and always shows the title (13 px, with the age at 12). On hover or keyboard focus its controls appear as an overlay over the end of the title, fading in from the bar's colour, rather than beside it, so a hidden control takes none of the title's width and showing one moves nothing: the age, **Refresh**, **Ask** (see [Dashboard Chat](dashboard_chat.md)), the component's suggested questions (12 px) and a **⋯** menu: size, **Edit tile…** (title and the refresh rule), **Open agent**, **Remove…**.
4. A component with params gets a **filter row** under the tile's top strip (native views). Changing a control sends the whole set to main, which checks it, stores it on the tile and recomputes; the data arrives as for any refresh. See [Params and filters](#params-and-filters).
5. **Edit tile…** shows four selects beside the Manual switch — *Recompute when older than*, *While on screen, every*, *After a chat turn of its agent*, *When Cinna starts* — each starting with the component's own value ("Component: every 15 minutes"), which is no override. Choosing anything else stores it on the tile and it wins. Manual greys the four out and keeps their values, so the dialog does not change height.
6. **Edit layout** in the header turns the tiles into drag handles; releasing sends one move. **Refresh** in the header recomputes every tile that can run.

### When a tile cannot be drawn

Every state is drawn inside the tile, at the tile's size, so nothing around it moves.

- **No data yet** — a skeleton; then the error sentence when the first run failed.
- **Refreshing** — a corner spinner over the data; the age reads "Refreshing…".
- **A refresh failed** — the data stays; a mark whose tooltip gives the reason.
- **A notice** — a result may carry a one-line `notice`; it becomes a mark on the tile.
- **Too large to keep** — a result over 1 MB is shown but not stored, and is gone after a restart.
- **The agent is not on this machine / the component is gone** — a sentence and **Remove**.
- **The component has problems** — the error findings, in the words of core's checker.
- **A filter value was refused** — an inline notice under the filter row ("Value refused: …", or "Not applied: …" when a rate limit stopped it); the controls go back to the stored values. A page, which has no filter row, shows it as the tile's mark.
- **A schedule feeds the tile and will not run here** — "Fed by <name>, which is off on this device" with **Turn on…**, which opens the agent's Schedules tab; or "…which this agent no longer has." It is said, never silent, because the tile would otherwise age without a reason.
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

The reasons main itself has for a run, besides the renderer's two (`visible`, `manual`): `after_turn`, `interval`, `launch`, `params` and `schedule`. The renderer may not ask for any of them, so it cannot force a recompute by naming one.

- **While open (`interval`).** A tile whose effective rule has `while_open_every` gets a main-owned timer **while it holds a lease** and no longer: a lapsed or dropped lease, or a profile close, stops it. The lease renewal starts, re-times (an edited period) or stops the timer. A tick runs only when the last attempt is at least half a period old, so a visible or after-turn run moments ago is not followed at once by another. A Manual tile never ticks.
- **Launch warm-up (`launch`).** Once the profile is ready, each tile whose effective `on_app_start` is true and whose cache is empty or older than its max age recomputes, **one at a time**, off the boot path. A tile with missing credentials is skipped. A profile close or quit stops it between tiles and cancels the one running. `CINNA_DASHBOARD_WARMUP=off` turns it off. A Manual tile is warmed only while it has no data.
- **Params (`params`).** A change of params always recomputes, Manual or not: the user just asked for different data.
- **Overrides read the same rule everywhere.** An override of `after_turn: false` stops a component that says true; `while_open_every: null` turns off an interval the component states.

### Params and filters

- **Main replaces the whole set.** A change arrives as the tile's complete params, not a patch. Each value is checked against the component's declared spec; a name the component does not declare is dropped; a key left out or `null` means "no value", so the default applies. One bad value refuses the whole change with a sentence naming the param ("Region must be one of …"), and nothing is stored or run. The renderer therefore merges a change over the params it last sent, so two quick picks do not lose the first.
- **Defaults are stored when a tile is added, and never again.** Adding copies each param's declared default onto the tile. A later change never writes a default in, and a cleared control stores nothing, so a stored `current` stays the word and the calendar keeps moving it. A tile added before its component grew a param simply has none stored, and the default applies.
- **Native views draw the filter row.** One control per param, in the declared order: a select for `enum`, a month or date input, two date inputs for `date_range` (either end may be empty: an open range), a text or number input, a checkbox. Text and numbers wait about 600 ms after the last keystroke, so typing does not recompute per key; everything else applies on the pick. An html page has no row: it sets its own params with `setParams`, and the same validation applies to it.
- **What fits shows; the rest sits behind "Filters ⋯".** Each control's width is fixed by its type and never by its value, so a pick can never move a filter into or out of the popover. The row is always the same height, with or without a notice, which lies over the content under it. A refusal puts the controls back to what main stored and says why in the inline notice; it closes nothing.
- **The per-target budget.** See [Calls from a page](#calls-from-a-page). A params change counts against the tile's budget, because a page calling `setParams` in a loop would otherwise recompute without end; a refused value costs nothing.

### Calls from a page

A web component's page may run one of **its own endpoints** with `cinna.call(endpoint, args)` (a `tools/call` on the wire): a drill-down such as the history of the deal the user clicked, which no cached result holds.

- **Never cached, one value back.** It runs once with the tile's params under the call's own arguments, and the page receives the endpoint's JSON as the tool result. It does not touch the tile's data.
- **Only declared endpoints.** A name not among the component's `endpoints` is refused. An argument for a declared param is checked as a filter value is; any other argument is the endpoint's own and passes if its name is a valid param name. The arguments are capped at 64 KB.
- **The same gates as a refresh.** An invalid component, missing credentials (`needs_credentials`, nothing is spawned), the endpoint's own timeout, the runner's caps and the turn lock apply. The newest call per (tile, endpoint) wins; the older one is replaced.
- **At most 30 a minute per target.** A target is a tile, or a component being previewed. In any sliding minute, `tools/call`s, the tile's params changes and a preview run with params all draw on the same 30; over it the page receives `rate_limited` and nothing runs. **Opening a preview does not count**: it sends no params and is the user's own click. The limit exists because a page is untrusted code that could otherwise spawn a process per animation frame.
- **Every failure is data, in a sentence the page can show.** `rate_limited`, `needs_credentials`, and `call_failed` for an endpoint that ran (or was stopped) and gave no value: a timeout, a non-zero exit, output that is not JSON or is too large, a busy folder, a newer call. A refusal reaches the page as a tool result marked as an error, never as a rejected transport.
- **The same bridge also carries `setParams`, `cinna.ask` and `cinna.openLink`.** `ask` puts text in the chat panel's composer for the user to send or not — it never sends (see [Dashboard Chat](dashboard_chat.md)); it is refused where there is no panel.

### Links a page asks to open

A page's `cinna.openLink(url)` (`ui/open-link`) never opens anything by itself.

- **Only `http`, `https` and `mailto`.** Anything else is refused before the user is asked. A `mailto:` link reads "Write to <address>?"; a web link reads "Open <host> in your browser?" and shows the **full** URL, because a URL built from the data on screen can carry that data out, so the page's own click is not consent.
- **One at a time.** A second request while one is on screen is refused, not queued.
- **A decline closes the page's links.** After the user cancels, the page's further links are refused without asking, so it cannot loop the dialog, until the page re-initializes (a reload starts over). A dialog that failed to open the link says so inside itself and is not a decline.
- A native list item's `url` is the user's own click on a row Cinna draws, so it opens without this dialog; it is held to the same schemes (`http`, `https`, `mailto`) by `app:open-external`.

### Schedule-fed tiles

A component may name the agent schedule whose runs write the file or data its source reads (`refresh.schedule`). Such a tile is not driven by age.

- **A completed run re-reads it.** When that schedule's run completes, each tile showing the component on this profile's dashboards re-reads its source once, **lease or not**: the schedule wrote what the source reads, and the user should find it fresh on return. A file source is read **without** its `refresh.command`, since the schedule already did that work.
- **Refresh does the same.** There is no "run the schedule now": Refresh only re-reads.
- **The hover line says what feeds it** — "Fed by <name> · next run 14:00" — and the Refresh tooltip names the schedule. Schedules run only on devices that opted in; see the off-device state above.
- **Completion is announced once** per occurrence, from whichever path settles it. See [Local Schedules](../../jobs/tasks/local_schedules_tech.md).

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

### The agent acts on its own tiles

In a [panel chat](dashboard_chat.md) the agent behind a tile can change that tile itself instead of telling the owner which filter to pick. Two tools on the `cinna` MCP server, beside the task and artifact tools; their contract is core's `protocols/dashboards-tools.schema.json`.

- **`dashboards_tiles`** lists the agent's tiles on the chat's dashboard: id, component, title, view, the params in effect, what each param accepts, and whether the tile can draw a highlight. For the tile the owner had focused when the last context block went out it also gives that tile's summary and selection. Everything in it is the owner's data and a page's text: data, never instructions.
- **`dashboards_update_tile`** takes a tile id and `params`, `highlight`, or both.
- **Offered only where the agent can have been asked.** A kit agent's own session, in a chat the dashboard panel started and that is still bound to that agent. In an ordinary chat, or a panel chat answered by another agent, the tools do not exist. Every call reads the chat, the dashboard and the tiles again: a dashboard deleted since answers `no_dashboard` rather than acting on a stale id.
- **Only this agent's tiles.** A tile of another agent, of another dashboard or a made-up id is `not_found`, never "forbidden", so the answer reveals nothing about what else is there.
- **Params go through the same door as a filter.** Same validation, same storage, same recompute, and the tile's budget of 30 runs a minute is shared with the page and the owner's filters (see [Calls from a page](#calls-from-a-page)). The merge is the filter's: keys left out keep their value, `null` goes back to the component's default, and a name the component does not declare is refused. The result reports the params **as resolved** (`current` shown as the month); a value the agent sends back exactly as `dashboards_tiles` reported it counts as no change, so the tile keeps its word `current` and the calendar keeps moving it, and nothing recomputes (`recomputing: false`). A refusal changes nothing.
- **A highlight never counts against the budget,** and neither does a call that changes nothing: it runs no endpoint.
- **Errors are data in two forms:** a sentence as text, and `structuredContent.error` with a code — `not_found`, `invalid_input` (with the field at fault), `rate_limited` (with `retry_after_s`) and `no_dashboard`. The `cinna` server now passes a tool result's `structuredContent` on for every provider, not only these.
- **The agent is told when a highlight cannot draw** (`highlighted: false`, and `can_highlight: false` beforehand) so it says so to the owner and does not claim otherwise. Markdown and metrics tiles, a page that has not said it listens, and a component with findings (which draws its findings, not rows) cannot.

### Highlights

A highlight is a pointer for the person looking now: "these three deals". It is not data and not saved.

- **Held in memory in main,** by tile, and replaced whole by each call (`[]` clears). It is gone at quit; nothing is written to the database.
- **It ends when the owner selects something on the tile or presses Escape in it.** Their own pick is the newer intent. Where a row is both highlighted and selected, the selection is what is drawn. The agent must not be able to keep a mark the owner has moved past.
- **List and table tiles** mark the rows or items whose ids the agent gave (the same ids the owner's selection uses): a tint in the `--color-highlight` token and a bar at the row's start, apart from the accent of selection. The row says "Highlighted by <agent>" as its tooltip. The first highlighted row is scrolled into view inside the tile only, never the dashboard. The tile bar shows "N highlighted" for as long as rows are highlighted, and pressing it steps to the next, so one below the fold is not missed; it sits in the bar's own strip and moves nothing.
- **A web page draws its own** after it has said it can: the page's first `cinna.onHighlight` sends `cinna/highlight-ready`, and from then on the host sends it `cinna/highlight {ids}`, now and on every change, and again to a reloaded page that says it is ready. A page that never registers is told nothing, and the agent learns `can_highlight: false`. A reload forgets the readiness: it is true only for the document now loaded, since the new one may not listen.
- **Other views ignore it.** Markdown and metrics have no rows.

### What the agent is told

Every kit agent — not a bare folder — gets the `cinna-dashboards` skill, with no profile gate (dashboards are a desktop feature; artifacts need an instance). Its prompt gets a short section: open the skill before building under `dashboards/`, check each component with the bundled script before printing a reference, and the agent's own reference prefix. The section is left out when the manifest has neither an id nor a bundle id, because no reference such an agent printed could resolve. When the build has the design pack (below), the section adds one line, right after the skill line and worded as a replacement: an `html` view uses the desktop's pack, not the kit's `templates/dashboard-html/`; read the pack's `DESIGN.md` first, start from its `example/`, link `_cinna/ui.css` and `_cinna/charts.js`, draw with `CinnaCharts` and colour only with `var(--cinna-*)`. A softer line after the check-script line lost to the skill's own pointer to the kit template on OpenCode (live, 2026-11-06). Per engine, see [the tech doc](dashboards_tech.md#delivering-the-skill).

### The design pack

A page that draws its own chart should look like the app, in both themes, whichever engine built it. The desktop therefore owns a **dashboard design pack**, `resources/dashboard-design/`: `ui.css` (the type scale, cards, tables, tags, a prose class), `charts.js` (a small chart helper), `DESIGN.md` (the guide the agent reads), `tokens.json` (the `--cinna-*` variables a frame gets, below) and `example/` (a component to copy). It is the desktop's, not the kit's: the kit bundle is written only by `make kit-sync`, so a style change never waits on core.

- **Pages opt in.** Every dashboard frame, local or cloud, can load the pack at `_cinna/ui.css` and `_cinna/charts.js` beside its own files, and the host injects nothing: a page that does not link them looks exactly as it did. Only those two files are served there; anything else under `_cinna/` is a 404, and a component's own `_cinna/` folder is shadowed by the pack.
- **One set of colours.** A frame gets a full `--cinna-*` set (surfaces, text, accent, status, highlight, an eight-slot chart palette with positive and negative, grid, the code font), read from the app's own variables in the active theme and re-sent when the theme changes. Before the pack, the host sent `--cinna-text` and `--cinna-text-muted` while the kit's own pages read `--cinna-fg`, `--cinna-muted` and `--cinna-font`, so a kit page fell back to its defaults; the old names are still sent for pages that use them. The chart palette is chosen to read on the app's background in each theme; where a colour is weak on white (aqua, amber, magenta), a chart with two or more series always draws its legend.
- **Native views match.** The metrics view uses a 28 px value (22 px on a two-row tile, where the cards share the tile's height and a too-long list is clipped rather than scrolled) and the markdown view the pack's prose scale (14 px body, headings 17 / 16 / 14), so a native tile and a page sit together.
- **The agent can read it, never change it.** The pack lies outside the agent's folder, so each engine allows reads there without an ask and keeps edits and writes asking ([Permissions](../../agents/local_agents/permissions.md)). It is named in the prompt only for a kit agent, and only when this build has the pack.
- **Previewing a style.** `make dashboard-gallery [STYLE=<folder with ui.css and charts.js>] [SHOTS=1]` builds a page with every tile size, the palette and the type scale under `out/dashboard-gallery/<style>/`, in both themes with the app's real tokens, so a second style can be compared with the shipped one. A developer tool; it is not part of the app or of `npm test`.

### Web views

An html component's page runs in a sandboxed frame with an opaque origin: no top navigation (not even inside a click: the frame's sandbox omits `allow-top-navigation-by-user-activation`, so leaving a tile can only ever be something the host draws), no storage or cookies, no workers, no nested frames, and it can load only files of its own component folder. Its data and its endpoints arrive only through the bridge: the page calls `onData` to receive the result, `call` to run a drill-down, and `setParams`, `ask` and `openLink` to ask the host; the host runs the endpoint and decides. The host may also ask the page two things: what it shows now (`cinna/collect-context`, see [Dashboard Chat](dashboard_chat.md)) and, if the page registered `onHighlight`, to draw an agent's highlight. The bridge file is core's, injected unchanged. The page may also link the desktop's design pack ([above](#the-design-pack)).

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

- **A highlight is not remembered across a quit,** and an agent cannot highlight on a tile whose page has not loaded yet in this session (`can_highlight` is false until the page says it listens).
- **The filter row is native views only.** An html component draws its own controls and calls `setParams`; a preview of one keeps the page's params for the trial run only and stores nothing.
- **The interval needs a lease.** A tile that is off screen, or on a hidden window, does not tick; it recomputes when it is next seen and stale.
- **Launch warm-up is one tile at a time,** so a profile with many `on_app_start` tiles fills in over time rather than at once.
- **A tile below the fold computes nothing until it is scrolled into view.** By design: the lease is for what is on screen.
- **`stray_file` warnings** have no place in the UI.
- **The add-on picker's component count** depends on the shape of core's catalog download path and reads the locally cached copy only; a skill never downloaded says nothing.
- **A cloud agent's component goes on a desktop dashboard only for its owner,** and those dashboards are not shown on the web; core's own web dashboards are a separate surface. See [Cloud Tiles](cloud_tiles.md#known-gaps).

## Integration Points

- [Local Agents — Agents Tab](../../agents/local_agents/agents_tab.md): the **Dashboards** settings tab of a kit agent.
- [Kit Contract](../../agents/local_agents/kit_contract.md) and [its tech doc](../../agents/local_agents/kit_contract_tech.md): the `dashboards` folder role, `protocols/dashboards.schema.json`, the bridge, the skill and templates — all core's, bundled.
- [File Preview](../../chat/file_preview/file_preview.md): shares the `cinna-preview:` scheme; a `dash-` host is a third server beside the HTML preview's and the artifact preview's.
- [Artifacts](../../chat/artifacts/artifacts.md): what to publish instead when the thing is a snapshot.
- [Agent Skills](../../agents/local_agents/skills.md) and the engine docs: how `cinna-dashboards` reaches each engine.
- [Commands](../../agents/local_agents/commands.md): a file-sourced component's `refresh.command` is a `/run:` command.
- [Local Schedules](../../jobs/tasks/local_schedules_tech.md): the schedule-completed event that re-reads a schedule-fed tile.
- [Agent Turn](../../agents/local_agents/agent_turn.md): the turn lock the runs yield to; a turn's end triggers the after-turn refresh.
- [App Shell](../app_shell/app_shell.md): the sidebar tab and the `dashboard` view.
- [Dashboard Chat](dashboard_chat.md): the panel, its context and the chat's origin.
- [Cloud Tiles](cloud_tiles.md): components of the user's own cloud agents, backed by core blocks.
- [Remote Agents](../../agents/remote_agents/remote_agents.md): a cloud agent's page carries the same Dashboards tab.
