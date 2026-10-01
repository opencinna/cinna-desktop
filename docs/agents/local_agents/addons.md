# Agent Addons (MCP Connectors on a Folder Agent)

## Purpose

An agent page's **Addons** tab gives a folder agent — kit or bare — MCP connectors of its own. A connector attached there is offered to every session of that agent, whichever chat it runs in. Without addons, the user had to engage the same connectors again in each chat.

## Core Concepts

- **Addon** — something a folder agent runs *with* beyond its own folder. Today the only kind is an MCP connector. Catalog plugins and skills are expected to join as their own sections on the tab once they exist, and the tab shows no empty sections for them now
- **Attached connector** — a link between one folder agent and one connector from **Settings → MCP**. It is a link only: the connector is the same global record, and toggling, editing or reconnecting it on the Addons tab changes it everywhere. **Detach** removes the link and leaves the connector in place
- **Unattended connect** — a connect that nobody is watching, started because one of the agent's turns is starting. It never opens a browser
- **Needs the user** — the state of an OAuth connector whose server wants an interactive authorization. An unattended connect cannot do that, so it stops trying until the connector changes

## User Stories / Flows

### Attaching a connector

1. Agent page → **Settings** → **Addons** → **MCP Connectors** → **Attach** opens the **Attach MCP connector** dialog. It is a search field over a grid of every connector set up on this computer, with three ways to add a new one under it: **From Registry**, **Custom MCP** and **Local MCP**
2. **Attach** on an existing card stores the link. The card turns into a disabled **Attached** and the dialog stays open, so several can be attached in one visit. This is how the credential picker behaves too. A failed attach is shown on that card
3. A new connector made through one of the three forms is attached as soon as it exists, and **the dialog closes**. The row on the Addons tab is where its status is shown and its authorization is finished. Saving starts the ordinary connect (`mcp:upsert` with `enabled: true`), so an OAuth server opens the browser exactly as it does when added from Settings. If the connector was created but the attach failed, the dialog stays on the list and says "The connector was added to Settings → MCP but not attached", with the reason
4. While a form is open, Escape and a click outside close nothing. The header button reads **Back to connectors** and returns to the list. A form holds what the user typed, and only the form's own Cancel or that button leaves it

### Seeing what the agent has

1. Attached connectors are listed in attach order, each drawn with the **same card as Settings → MCP**. The card offers **Detach** where Settings offers Delete, and the rest of the card behaves the same
2. A connector that is not connected, is switched off or is waiting for the browser shows a warning glyph beside its name. The glyph's accessible name and tooltip give the reason in one sentence. The same glyph and sentence appear on the Settings card and on the attach dialog's cards
3. The **Addons** tab carries a count badge. It is muted when every attached connector is fine. It is warning-toned, titled "*k* of *n* connectors need attention", when any is not. The badge is the only place outside the tab that reports a broken addon, because those sessions are running without its tools
4. The section's (?) explains the scope: every session of the agent gets the tools (its own chats, scheduled jobs, task runs, and runs where another agent calls it); Cinna holds the sign-in and the agent's runtime never sees a token; a connector that is not connected when a session starts is left out of that session

### In a chat

1. In a chat bound to the agent, and on the new-chat screen while the agent is selected, the agent's addons appear in the chip strip under the composer, **locked** (no `×`), after the chat mode's baseline. The tooltip reads "comes with the agent *name* — change it on the agent's page"
2. The `[+]` picker shows them selected and locked, like the mode's baseline. Toggling one does nothing, because a toggle there would file an on-demand duplicate rather than detach anything. See [On-Demand MCP](../../mcp/on_demand/on_demand.md)

### Deleting a connector that an agent uses

1. Settings → MCP → a card's trash button opens **Delete MCP connector**. It names the agents that will lose it ("Used by *A*, *B* — it will be removed from them"). If that lookup failed, it says instead that any agent it is attached to loses it too
2. Deleting removes the link from every agent. Re-adding the same server creates a different connector, which nothing is attached to. See [MCP Connections](../../mcp/connections/connections.md)

## Business Rules

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
Addons tab ── AgentAddonsTab ── MCPProviderCard (detach) ── McpAttachModal ─┬─ existing connector → Attach
     │                                                                     └─ Registry / Custom / Local form → onCreated(id) → Attach, close
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
- [Bare Agents & External Roots](bare_agents.md): bare agents get the tab too. It is one of the tabs a bare folder can honestly fill, since nothing on it names a folder file
- [MCP Connections](../../mcp/connections/connections.md): the connector record, its card, the non-interactive connect, and the delete confirm that names the agents
- [On-Demand MCP](../../mcp/on_demand/on_demand.md): the chip strip and `[+]` picker, where addons are drawn locked beside the mode's baseline
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md): the Cinna MCP endpoint (conductor bridge) that serves addons, and the nested runs that now get an addons-only endpoint
- [MCP Registries](../../mcp/registries/registries.md): the **From Registry** path inside the attach dialog
- [UX Rules](../../development/ui_guidelines/ux_rules.md): rule 13 (one presentation for one record across lists, an open form is not replaced) and rule 5 (the delete confirm)

Sub-doc: [Technical Details](addons_tech.md)
