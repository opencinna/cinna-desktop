# Agent Addons (Skills and MCP Connectors on a Folder Agent)

## Purpose

An agent page's **Addons** tab is one list of what a folder agent — kit or bare — runs with beyond its own instructions: MCP connectors and, for a kit agent, skills, with **one Add** over every source the user may use. A connector added there is offered to every session of that agent, whichever chat it runs in. Without addons, the user had to engage the same connectors again in each chat. Skills are documented in [Agent Skills](skills.md) (pin, update, re-fetch, remove, share); this doc covers the list, the picker, the directory behind it and the connectors.

## Core Concepts

- **Addon** — something a folder agent runs *with* beyond its own instructions. Two kinds today, drawn in the same row shell: an MCP connector, and a kit agent's skills, from its `skills/` folder or pinned from the catalog or a marketplace ([Agent Skills](skills.md)). Plugins have a kind and a place in the model but are shown as blocked ("Plugins arrive in a later update") and nothing installs them
- **Addon directory** — everything the agent could add, from every source, normalised in main into one entry shape (`DirectoryEntry`) and annotated with where it stands for *this* agent. The renderer never sees catalogs, marketplaces or registries as separate APIs. The failure it replaces: a skill picker and a connector picker side by side, each with its own idea of "added", search and error
- **Directory provider** — one source behind the directory: **Cinna** (the catalog's skills and the skills marketplaces, signed-in account only), **On this computer** (the connectors already in Settings → MCP), **MCP registries** (the Cinna Official index, listed whole, and the public MCP Official registry, searched only). A provider that fails is reported as that source's error and the others still answer
- **Entry state** (per agent) — `added`, `addable`, `addable_with_setup` (Add works, then a sign-in, a key or env values follow), `preparing` (core is still snapshotting it), `blocked` (with the reason), plus `partly_compatible` / `incompatible`, which exist in the model for engine compatibility and are not produced yet
- **Attached connector** — a link between one folder agent and one connector from **Settings → MCP**. It is a link only: the connector is the same global record, and toggling, editing or reconnecting it on the Addons tab changes it everywhere. **Detach** removes the link and leaves the connector in place
- **Registry ref** — the `{source, id}` of the directory entry a connector was created from (`mcp_providers.registry_ref`). It is what lets the directory show a connector once (below)
- **Unattended connect** — a connect that nobody is watching, started because one of the agent's turns is starting. It never opens a browser
- **Needs the user** — the state of an OAuth connector whose server wants an interactive authorization. An unattended connect cannot do that, so it stops trying until the connector changes

## User Stories / Flows

### Adding to the agent

1. Agent page → **Settings** → **Addons** → **Add** (one button for skills and connectors alike) opens the dialog **Addons for *agent name***. It is a fixed-size dialog, so nothing in it resizes while the user types, filters or opens an entry. It holds a search field ("Search skills and connectors…"), a **Source** select (All sources, then the providers that answered), **Kind** chips (All / Skills / Connectors, a kind with no entry is not offered), and a grid of tiles: kind, title, one line of summary, where it is from and its version, and a line for its state ("Added", the reason it is blocked, what it still needs)
2. Typing filters the list locally per keystroke. After a pause of 300 ms, and only for a query of at least two characters, the public MCP registry is also asked, and its hits appear under the results in **More from the public MCP registry**, dimmed while the next answer is asked. The registry is never asked per keystroke, and a registry hit that is already a connector on this computer shows as that connector. If that registry is off for the account (policy), the section is absent
3. A tile opens the entry's detail over the grid; the grid stays laid out underneath, so **Back** finds the search, the filters and the scroll where they were. The detail names the source (with a link to the repository or homepage), what the entry contains, and **Runs code on this computer** when it does. Its primary button is **Add to *agent name***; an entry that cannot be added shows the reason instead
4. **Add** pins a skill (catalog or marketplace: downloaded and checked first, see [Agent Skills](skills.md)) or attaches a connector. The dialog **stays open** and the detail turns to **Ready in the next chat** and a **Done** button, so several can be added in one visit. A refusal is main's sentence beside the button; it closes nothing
5. A connector that is not connected yet carries the **next step in place**, after the add and again whenever the entry is opened while it is still needed: **sign in** (Connect opens the browser, the step waits for the connector to say it is connected), **an access token** (pasted, stored in main), **settings filled in** (env), **Connect / Try again** when the connect failed for a reason that is not auth (a sentence, with main's raw error behind a (?)), or **Turn on** when the connector is switched off on this computer. **Not now** puts a step off; the connector stays added and says what it needs ("Added — needs you to sign in") until it is dealt with. While a step holds typed input, Escape, a click outside and the header button close nothing (the header button is disabled, "Save or cancel first")
6. An added entry offers **Remove**, which asks inside the card first. For a connector it says it stays on this computer, in Settings → MCP; for a skill it says it can be added again from here
7. **Custom connector…** (footer; hidden when the account's policy forbids custom MCP) opens the same forms Settings → MCP uses: **Remote server (URL)** and, when policy allows local-process servers, **Local command**. A connector created there is attached as soon as it exists and the dialog stays on the list. If it was created but the attach failed, the footer says "The connector was added to Settings → MCP but not attached", with the reason. The header button reads **Back to addons** while a form is open, and Escape and a click outside close nothing
8. A source that failed reads once, quietly, in the footer (a warning glyph and a sentence); the others still answer. An expired Cinna session offers signing in again instead. The directory is re-read past the sources' caches once per opening, with the last answer showing meanwhile

### Seeing what the agent has

1. The tab lists connectors and skills together, each in the same row shell (kind icon and word, title, source, status glyph, actions), **needing attention first and then by name**. The order is decided when the tab opens and when an add or remove changes what is listed, never while the user works a row: a toggle, an update or a connect does not move the row from under the pointer. Past eight rows, kind chips filter the list
2. A connector row is the **same card as Settings → MCP**. It offers **Detach** where Settings offers Delete, and Detach asks first, inside the card ("Detach *name* from this agent? The connector stays in Settings → MCP, and other agents keep it."), as a skill's Remove does. The rest of the card behaves the same
3. A connector shows the shared status glyph beside its name: a check when connected, a red cross when its connect failed, a warning triangle for anything else that keeps its tools out of sessions (switched off, not connected, waiting for the browser). The glyph's accessible name and tooltip give the reason in one sentence. The same mapping draws it on the Settings card, so one connector never wears two colours
4. The **Addons** tab carries a count badge over everything the tab lists, connectors and skills. It shows the muted total when every attached connector is connected and no skill has an issue (a pinned skill's "Not on this computer yet." does not count; a failed download does) or a credential slot nothing fills (counted only on a deliverable skill). When any is not, it shows how many need attention, warning-toned, titled "*k* of *n* connectors need attention" (skills, or addons, when the total is not only connectors). The badge is the only place outside the tab that reports a broken addon, because those sessions are running without its tools. An unfilled skill slot is announced here and by the row's **Finish setup**, never by a readiness banner: the agent still runs ([Agent Skills](skills.md#credentials-a-skill-declares))
5. The section's (?) explains the scope: every session of the agent gets the tools (its own chats, scheduled jobs, task runs, and runs where another agent calls it); Cinna holds the sign-in and the agent's runtime never sees a token; a connector that is not connected when a session starts is left out of that session

### In a chat

1. In a chat bound to the agent, and on the new-chat screen while the agent is selected, the agent's addons appear in the chip strip under the composer, **locked** (no `×`), after the chat mode's baseline. The tooltip reads "comes with the agent *name* — change it on the agent's page"
2. The `[+]` picker shows them selected and locked, like the mode's baseline. Toggling one does nothing, because a toggle there would file an on-demand duplicate rather than detach anything. See [On-Demand MCP](../../mcp/on_demand/on_demand.md)

### Deleting a connector that an agent uses

1. Settings → MCP → a card's trash button opens **Delete MCP connector**. It names the agents that will lose it ("Used by *A*, *B* — it will be removed from them"). If that lookup failed, it says instead that any agent it is attached to loses it too
2. Deleting removes the link from every agent. Re-adding the same server creates a different connector, which nothing is attached to. See [MCP Connections](../../mcp/connections/connections.md)

## Business Rules

- **The directory only lists and routes; it adds nothing of its own.** Add and Remove go through the paths each kind already had — the catalog and marketplace skill pins ([Agent Skills](skills.md)) and the connector attach below — so every rule of those paths (a downloaded and checked revision, the team-agent read-only rule, the scope checks) holds from the picker too. The picker does not decide whether an add is allowed: main does, and answers
- **Every answer is data.** A refusal is `{ok: false, code, message}`, never a thrown error, because a thrown error's code does not survive IPC (see [Skills — Technical Details](skills_tech.md)); the picker shows main's sentence beside the control that asked
- **A connector is listed once.** A connector created from a directory entry records that entry's ref, and the directory shows the two as one, under **On this computer**, with the entry's metadata. Without it, a registry server the user had already connected appeared twice: once as the registry entry (Add creating a duplicate) and once as the connector. This is the only de-duplication: two sources that list the same name show twice. A connector the user set up by hand has no ref and is its own entry. The ref is written when the connector is created and never moved by an edit, so a connector stays the entry it came from
- **Adding a connector from a directory entry connects it, but never in front of the user's eyes.** The connector is created enabled and its first connect is non-interactive. A server that wants a sign-in does not open a browser from the add; the picker offers the sign-in as the next step. A server the registry says takes an access token is not connected at all until the token is pasted, and a failed connect that is not a sign-in is offered as Connect, never turned into a token prompt — otherwise a server that was merely down would have become a bearer server. If the attach fails after the connector was created for this add, the connector is deleted again: nothing the user asked for is left behind. Adding an entry whose connector already exists attaches that one
- **Blocked is a state with a reason, not a hidden tile.** A skill on a bare agent says it needs a `cinna-agent.json` (connectors work there); a skill on a team agent shared to use only says its skills come with the team's version; a plugin says plugins arrive later; an entry core could not prepare says so, and one still being prepared reads as preparing. What the account's admin forbids (public registries, custom MCP URLs, local-process servers) is switched off by an account policy (`AddonPolicy`: external directories, custom MCP, plugin hooks, local-process MCP). The directory carries the policy and the picker honours it, but the Cinna provider does not read it from core yet, so today everything is allowed
- **Folder agents only.** Only folder agents (kit or bare) can take addons, because only their sessions are served by the Cinna MCP endpoint. Attach and detach refuse any other agent id as `not_found`. A list for any other id is **empty rather than an error**, because an agent-bound chat asks about whatever agent it is bound to
- **Every session of the agent, in any chat.** In the agent's own chat (and in a chat whose router is `human`) the addons are offered beside that chat's baseline and on-demand connectors, de-duplicated by connector. In a chat bound to another agent, the agent gets its addons and nothing else from that chat. A chat conductor whose tool policy is **No tools** gets nothing, addons included
- **Nested runs get addons and only addons.** An agent called as a tool inside another agent's turn — a coordinator's specialist, or a delegated task run — used to receive no Cinna endpoint at all. With addons it now gets an endpoint of its own carrying only those connectors: no chat connectors, no coordinator controls, no handovers, no agent tools. The last omission is what still rules out recursive delegation. A nested run of an agent with no addons is unchanged and gets no endpoint. See [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md)
- **A nested call's tool rows stay inside the specialist's block.** They reach the transcript through the child's sub-thread events. Writing them as top-level tool rows would put them in the parent's transcript as if the conductor had made them
- **A nested session never replaces the agent's own session in that chat.** On an engine that fixes its tool list when a session is created (Codex), the nested session is built with the addons-only list. Saving it in the chat's (chat, agent) session slot would make the agent's next direct turn there load it under a matching digest, without its own transcript. So it is kept in its own in-memory slot, with its own digest, and both are dropped when the chat's sessions are forgotten. Engines that re-read their tools mid-session reuse sessions as before
- **Connects before a turn are best-effort, bounded, never interactive and never a failure.** When a turn starts for an agent with addons, Cinna brings up the attached connectors that can come up with nobody there. Those are a local process, a server with a bearer token, or an OAuth server whose tokens are on file (they may be refreshed). It never opens a browser. A connector that is switched off, already connected or mid-authorization (`awaiting-auth`) is left alone, because a connect would replace the attempt the user is in the middle of. A connect started from Settings that is already running is waited for rather than restarted, for the same reason
- **The turn waits only for a connector's first try**, at most 5 seconds, and stops waiting the moment the turn is stopped. Turns starting together share one attempt. A connector that lands later still reaches the session, which re-lists its tools when the connector's tools change
- **Later failures back off, and are retried by the turns that start, not by a timer.** After a failed try, a starting turn launches the next one in the background without waiting for it, no sooner than 1 minute after the failure. The interval doubles per failure up to 15 minutes. A connector that has to be authorized by the user is not retried at all until its configuration or stored credentials change. Without these rules, every turn of an agent with one dead connector would pay the full wait
- **The retry memory is per app run and per connector version.** A version is the connector's configuration revision plus its stored credentials. Editing it, reconnecting it with new tokens, or restarting the app starts over with a fresh first try. A successful connect from anywhere clears it, and so does a turn's attempt being replaced by the user's own connect from Settings: that outcome is the user's, not a failure to back off from. Tokens that the failed attempt itself refreshed do not count as a new version
- **Attaching or detaching takes effect in live sessions.** Every live session of that agent, in every chat, re-lists its tools. Attaching a connector that is already attached changes nothing and refreshes nothing
- **The link follows the agent's identity.** Stamping a legacy folder's identity re-keys the agent's row, and the links move with it (`rekeyFolderRow`). A rescan of the same folder keeps them. Pruning the agent's row (folder removed or trashed) or deleting the connector cascades them away
- **Scope.** Folder agents and the MCP list both live in the settings scope ([Settings Scope](../../core/settings_scope/settings_scope.md)), and every read filters links by the connector's owner, so a link never offers another scope's connector

## Architecture Overview

```
Addons tab ── AgentAddonsTab ── AddonRow (skill) / MCPProviderCard (connector, Detach)
     │        └─ Add ──► AddonPicker ── AddonPickerDetail (Add · setup step · Remove) ── Custom connector… forms
     ▼
useAddonDirectory / useAddonSearch / useAddAddon / useRemoveAddon
     ▼
addons:directory | :search | :add | :remove ──► addonDirectory (main)
     │   providers: cinna-core (catalog + marketplace skills) · this-computer (mcp_providers) · mcp-registries
     │   merge (registry_ref) → state per agent → Add/Remove dispatch to the existing paths:
     │        catalogSkillService / marketplaceSkillService (pins) · agentMcpService.attach/detach · mcpService.createFromDirectory
     ▼
Addons tab ── AgentAddonsTab ── AddonRow (SkillRow · MCPProviderCard with detach) ── Add → AddonPicker ─┬─ directory entry → addons:add
     │                                                                                                 └─ Custom connector… → Custom / Local form → onCreated(id) → Attach
     ▼
useAgentMcpProviders / useAttachAgentMcp / useDetachAgentMcp
     ▼
local-agent:mcp-list | :mcp-attach | :mcp-detach        mcp:agents-using (delete confirm)
     ▼
agentMcpService ── agentMcpRepo ── agent_mcp_providers (agent_id, mcp_provider_id)
     │   attach/detach ──► conductorBridge.refreshAgent(agentId) ──► live sessions re-list
     ▼
turn starts ──► conductorBridge.prepare ──► agentMcpService.ensureConnected (≤5 s, first try only)
                     │                         └─ mcpManager.connect(config, { interactive: false })
                     ├─ direct:  chat MCPs ∪ on-demand ∪ addons (+ controls, handovers, agent tools)
                     └─ nested:  addons only, own endpoint key, own in-memory session slot
                                      ▼
                         Cinna MCP endpoint ──► ACP runtime (Claude / Codex / OpenCode)
```

## Integration Points

- [Agents Tab & Agent Page](agents_tab.md): the page that hosts the tab, its badge and the tab order
- [Bare Agents & External Roots](bare_agents.md): bare agents get the tab too. It is one of the tabs a bare folder can honestly fill, since nothing on it names a folder file. The Skills section is left off for them, since it would name `skills/`
- [Agent Skills](skills.md): a kit agent's own `skills/<name>/SKILL.md` and pinned catalog and marketplace skills, their row actions, and how each engine gets them
- [MCP Connections](../../mcp/connections/connections.md): the connector record, its card, the non-interactive connect, and the delete confirm that names the agents
- [On-Demand MCP](../../mcp/on_demand/on_demand.md): the chip strip and `[+]` picker, where addons are drawn locked beside the mode's baseline
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md): the Cinna MCP endpoint (conductor bridge) that serves addons, and the nested runs that now get an addons-only endpoint
- [MCP Registries](../../mcp/registries/registries.md): the registries are the directory's **MCP registries** provider — the Cinna Official index is listed in the picker, the public MCP Official registry is searched from it — and a connector made from one records its `registry_ref`
- [UX Rules](../../development/ui_guidelines/ux_rules.md): rule 13 (one presentation for one record across lists, an open form is not replaced) and rule 5 (the delete confirm)

Sub-doc: [Technical Details](addons_tech.md)
