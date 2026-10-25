# Marketplace Plugins on a Local Agent

## Purpose

A kit agent can add a **plugin** from a plugin marketplace connected to Cinna's server: a bundle of skills, slash commands, sub-agents, hooks, language servers and MCP servers that someone else wrote. The desktop pins an exact snapshot of it in the agent's `cinna-agent.json`, unpacks it into a read-only cache, and hands each part to the engines that can use it — it never runs the bundle as a whole. It appears on the Addons tab as one expandable row, added from the same picker as skills and connectors ([Agent Addons](addons.md)).

## Core Concepts

- **Plugin** — a Claude- or Codex-format marketplace entry (skills-format entries are [marketplace skills](skills.md)). Core describes it in the directory (`components`); the real files are read from the snapshot the pin names, because the description says what a plugin claims and the bytes say what it does
- **Plugin pin** — an element of `marketplace_plugins[]` (contract 1.17.0, [Kit Contract](kit_contract.md#marketplace-plugins-and-mcp-requirements-1170)): `entry_uuid`, `marketplace_uuid`, `marketplace_name`, `name`, `archive_sha256`, optional `version`, and an optional `disabled` (`hooks`, `mcp_servers[]`, `skills[]`). One pin per `name`
- **Snapshot** — what the pin's digest names. Core keeps only the newest snapshot of a plugin, so a pin left behind cannot be downloaded again, but keeps working from the cache and reads "Update available"
- **Plugin cache** — `<userData>/marketplace-plugins/<instance>/<entry_uuid>/<archive_sha256>/<name>/`, shared by every agent, read-only, complete-or-absent, content-addressed. The same machinery as the catalog and marketplace skill caches; the plugin's scripts and servers run from it (`${CLAUDE_PLUGIN_ROOT}` is this folder)
- **Part** — one thing a plugin carries: skills, MCP servers, commands, agents, hooks, language servers. Each engine takes some parts and leaves others (the matrix below)
- **Wrapper plugin** — Claude's share of a pinned plugin: a folder of Cinna's own that links to the plugin's commands, agents and hooks (below)
- **Managed connector** — an `mcp_providers` row a plugin snapshot owns for one of its MCP servers ([MCP Connections](../../mcp/connections/connections.md#managed-connectors))
- **Compatibility** — `compatible`, `partly_compatible` ("Skills and connectors only on Codex") or `incompatible` ("Not for Codex"), judged by one shared matrix against the agent's engine

## User Stories / Flows

### Adding a plugin

1. Agent page → **Settings** → **Addons** → **Add**. A plugin is a tile of kind Plugin. Its detail lists what it adds ("1 connector: ledger (Node.js)", skills, commands, agents, hooks), a **Works with** line per engine (the agent's own first, each marking what that engine uses and what it leaves out), what it needs on this computer, and the marketplace it came from
2. The primary button reads **Add — runs code on this computer** when the plugin has anything that runs (scripts, hooks, servers). That button is the consent: there is no second dialog, because the sentence on the button is the one place the user is certain to read
3. Add downloads the snapshot, checks it, pins it, and creates the connectors for its MCP servers. A connector that still needs a value carries the **next step in place** in the detail: **settings filled in** (one field per name), or **an access token**; **Not now** puts it off
4. The tab shows the plugin as **one row**: title, version, a marketplace badge and a status glyph, with a line saying what it carries ("1 skill · 1 connector · 1 command"). Its connectors are inside the row, never rows of their own and never listed under Settings → MCP as ordinary connectors
5. Expanded, the row lists skills, connectors and hooks each with its **own switch**, and commands and agents without one. A switch writes the pin's `disabled`, so it is that agent's choice: the same plugin on another agent keeps its own. A connector line carries its state and, for a value, a key or a switched-off connector, the form in place (the input outlives a collapse)
6. **Update** (when the marketplace holds a newer snapshot), **Show the files** (the cached copy in the file manager) and **Remove** are icon actions on the row. Remove asks first, inside the row
7. A plugin that needs Node.js or Docker and finds none on this computer is **blocked with the reason** ("Needs Node.js — install it from nodejs.org"), and the detail offers **Check again**, which looks again without a restart

### What the user sees when it is not fine

- **No longer available to you** — the entry left its marketplace or the person lost access to it. Nothing is removed; the cached copy keeps being delivered
- **Update available** — the marketplace has a newer snapshot. Nothing changes until the user asks
- **The cached copy was changed on disk — Update to restore it** — the files no longer match what was unpacked. The plugin is not delivered and its servers are not started until Update downloads it again
- **Blocked by your admin** — against hooks and local servers when the account's policy forbids them ([Agent Addons](addons.md#the-admins-policy))
- **Hooks run on Claude only, not on *engine*** — a muted fact of the engine, not a problem: partly compatible is healthy and does not count toward the tab's badge

## Business Rules

### What each engine is given

| Part | Claude | OpenCode | Codex | Antigravity |
|---|---|---|---|---|
| Skills | the agent's skills plugin | `skills.paths` | prompt listing with paths | prompt listing with paths |
| MCP servers | Cinna MCP provider | Cinna MCP provider | Cinna MCP provider | Cinna MCP provider |
| Commands | wrapper plugin | expanded by Cinna into a prompt (and `command` in the generated config) | expanded by Cinna | expanded by Cinna |
| Agents | wrapper plugin | — | — | — |
| Hooks | wrapper plugin | — | — | — |
| Language servers | wrapper plugin | — | — | — |

- **The matrix is one table, in one place** (`src/shared/addons/engineSupport.ts`). The directory computes an entry's compatibility with it and the picker lists it per engine, so the two cannot disagree about whether a plugin works on an engine
- **MCP is never the reason a plugin is incompatible.** Every local engine is an ACP launch the conductor bridge reaches, and a plugin's servers are delivered as Cinna MCP providers. Agents are Claude-only because OpenCode's agent format does not map from Claude's `agents/*.md`
- **A plugin's MCP servers are never loaded from its `.mcp.json`.** They are managed Cinna providers, so every engine gets one delivery path, one permission ask and one credential form — and a server never starts twice. The Claude wrapper deliberately does not link `.mcp.json`
- **Skills join the agent's own skill delivery**, and a clash is decided there: the agent's own, catalog, marketplace and platform skills win a name over a plugin's, and the first of two plugins' skills wins ([Agent Skills](skills.md#plugin-skills)). The loser is not delivered and the row says why. A skill turned off on the pin is not delivered
- **Claude gets a wrapper, not the plugin.** The wrapper's manifest is Cinna's own (name, description, version and nothing else from the plugin's), so no inline `mcpServers` or `hooks` ride along; it links every other top-level entry of the cached folder, which is what makes `${CLAUDE_PLUGIN_ROOT}` resolve whichever way Claude resolves it. `hooks/` is left out when the user turned the plugin's hooks off or the admin forbids plugin hooks. A wrapper exists only when it carries something for Claude
- **OpenCode's commands are bound to the agent.** The generated config is one for every agent, so a command is written as `<agent key>/<plugin>:<command>` with that agent attached: two agents pinning the same plugin each get their own, from their own snapshot, run by themselves. The config entry stays, but a chat message no longer reaches OpenCode as that command (next rule)
- **Off Claude, Cinna expands a plugin's command itself.** A chat message that starts with `/<plugin>:<command>` (on OpenCode also `/<agent key>/<plugin>:<command>`) naming a command of one of the agent's pinned plugins is sent to OpenCode, Codex and Antigravity as the command's template with `$ARGUMENTS` and `$1`…`$9` filled in, as an ordinary prompt: "The user ran the command /<plugin>:<command>. Follow its instructions:" and the template. Claude is not touched: it runs the command natively through the wrapper. It exists because OpenCode 2.0.27 runs a prompt that is one of its commands detached — the turn ended in about 80 ms with nothing streamed while the command ran on unseen, so the chat showed an empty turn and a commit nobody could follow. Codex and Antigravity took no plugin commands at all. An expanded prompt streams, shows its tool calls and asks, and ends when the agent is done
- **A `` !`cmd` `` line is never run by Cinna.** It becomes a marker ("[run `cmd` and use its output here]") under one sentence telling the model to run those commands first, so the command runs as a visible, permissioned tool call of the engine. Running it in Cinna would execute plugin-authored shell outside the engine's ask, which is the thing the permission model exists to prevent. Arguments are substituted inside a marker with their backticks turned into quotes, and arguments are never read as a shell line or a placeholder themselves
- **Anything else stays as typed.** Another slash text (`/goal`, an engine's own command, a name no pinned plugin has, OpenCode's keyed form on Codex) goes to the engine unchanged. An expanded command is no longer a slash command, so the turn context goes in front of it like any message ([Turn Completion](../../chat/messaging/turn_completion.md)). The prompt the launcher may refuse (Antigravity's `/logout`) is checked on the typed text before expansion, and again on what goes on the wire
- **Known limits of the expansion.** A plugin command typed while a turn is running (a steer) goes out unexpanded, as typed. A plugin literally named `run` collides with Cinna's `/run:` catalog commands ([Local Agent Commands](commands.md)). Plugins have no Commands switch: only hooks, connectors and skills can be turned off on the pin. Not proven live on Codex or Antigravity (unit-tested only)

### Pins, not copies

- **The bytes must equal two digests before anything is unpacked**: the server's `X-Archive-Sha256` and the pin's `archive_sha256`. A mismatch keeps nothing. The plugin archive is read by the safe archive reader (one root folder `<name>/`, links refused, size capped at 16 MB), which is why a downloaded plugin cannot write outside its folder
- **Add checks everything before it pins anything.** The agent is a kit agent, the person may change it, the snapshot is ready, the plugin is not pinned yet (nor another marketplace's plugin of the same name), the servers' runtimes exist and the policy allows them, and the managed uv installs for a Python server. The runtimes are judged by the real commands in the snapshot's `.mcp.json`, not by core's description of them
- **The tree is verified at install and again at every launch.** Each file's digest is recorded in the cache's marker when it is unpacked. Before a plugin's server starts, or its parts are delivered, the folder must still hold exactly those files with those digests (no file added or removed, no link). A tree that was edited on disk is not delivered and not launched: the folder is the thing the user consented to run, and an edit would make the consent worthless. After the first check of a session a file is re-hashed only when its size, times or inode moved
- **Who may change pins is the catalog's rule.** A team agent shared to use only keeps the team's plugins; the row hides Update and Remove and the directory says why
- **Update moves the pin to the entry's current snapshot and keeps its name**, because the wrapper and the commands are called by it. Already current, it does nothing — unless the cached copy was changed on disk, in which case it downloads it again. A managed connector of the new snapshot starts with the values the user gave the same server of the previous one, so an Update asks nothing again
- **Remove takes the pin and its connectors away; the cached files stay until the next app start**, which sweeps every snapshot no registered agent pins. Never right after a Remove, so a session still reading the folder is not pulled from under
- **Missing plugins arrive on their own.** A plugin pinned on a computer that does not have it (a team Get or Update, or a manifest from elsewhere) is fetched in the background when a session is built for the agent (once per pin set per app session) and after a team Get, Update or Use. A session never waits for it: it goes without the plugin and the next gets it. Unlike the skill pins, plugins are **not** swept when a profile becomes ready, so a plugin that failed to download for a lapsed sign-in is retried by the next session built after the sign-in, not by the sign-in itself

### Managed MCP servers

- **One connector per snapshot, shared by the agents on it.** Two agents pinning the same snapshot share a row; agents on different snapshots have a row each, so one agent's Update never re-points or disconnects the other's server. The row is deleted only when no agent uses it and no pin anywhere references its snapshot
- **A server that is off or blocked is detached, never deleted.** The connector and the values the user typed stay for when it comes back
- **The user's values are secret.** Every `${VAR}` placeholder in a server's command, args, URL, env or headers is a *slot* the user fills in; the values are stored encrypted and read in main at launch only. The plugin's own literals are never overwritten by what the user types, and the renderer learns only the names and whether each has a value. `Authorization: Bearer ${X}` makes the connector a bearer one whose token is asked in its step
- **The plugin owns what it runs.** On the connector's card the name, transport, command, args and URL are read-only, and there is no delete (it goes with its plugin, from the Addons tab); only the values, the token, sign-in and the on/off switch are the user's. Settings → MCP draws it with a "From *plugin*" badge
- **Python runs through the managed uv; Node and Docker must be installed.** `uvx`, `uv` and `python` are rewritten to the app's pinned uv, installed on Add, so a Python server works on a bare Mac and is never a reason to block. `node`, `npx` and `docker` are looked up on the login-shell PATH once per app session; a missing one blocks the Add with its sentence. **Check again** re-reads the login shell's PATH first. Anything else (a binary of the plugin's own) is run as written
- **A server never writes into the cache.** A `uv run` of a project with a `uv.lock` is made `--frozen`, and the project environment goes to `<userData>/plugin-envs/<entry>/<sha>/<server>`. A project with no lock, and a `uvx --from <folder>`, would make uv or setuptools write into the read-only cache, so they run from a writable **working copy** of the snapshot, **one per server** (`<userData>/plugin-work/<entry>/<sha>/<server>`, so two servers of one snapshot never share what they write), copied from the verified cache. The copy is checked and made *in the connect*, after the server's old process has stopped, never while its config is built: an unchanged copy (size and mtime as recorded at copy; a file that still matches is not hashed again) is used as it is, and a changed one is copied again from the cache — the cache is the source of truth. But a copy a connected server still runs from is never deleted or copied again underneath it: that launch is refused with "The cached copy was changed on disk — Update to restore it" instead. What the server itself writes (its lock, environments, caches, build output) is never checked. The managed uv runs with `UV_PYTHON_PREFERENCE=only-managed`, so it uses only the Python it installed itself and never probes the system `python3` — on a Mac without the Command Line Tools that stub raises the install dialog
- **A server is not launched when its files changed or the policy forbids local servers, and one already running stops when the policy turns local servers off.** The connection's error is the reason. Nothing is deleted for it: it runs again when the files are restored or the policy allows
- **App start connects only what can run with nobody asking.** A plugin's connector starts at launch only when an agent has it, every value it needs is given, the policy and its files allow it and its Node or Docker is there (a plain directory connector, by contrast, needs only its settings). The rest connect on use, as any addon connector does ([Agent Addons](addons.md)). One exception is held back by a launch block alone (the policy forbids local servers, or its files changed) while an agent has it and every value is given: app start still hands it to the MCP manager, which refuses it before anything spawns, so its card reads the sentence ("Blocked by your admin", "The cached copy was changed on disk — Update to restore it") and not a bare disconnected. A card refused by the policy offers no Reconnect while the policy still forbids local servers, because it could only repeat the refusal; a missing Node.js or Docker keeps Reconnect, as the retry once it is installed. The plugin's row says the modified-files sentence once, on the plugin's own line, and does not repeat it as a connector failure

## Architecture Overview

```
Add (picker) ──► addons:add (core-marketplace-plugin ref) ──► marketplacePluginService.addToAgent
                      │ download → 2 digests → safe unpack → cache (marker with file digests)
                      │ readyToPin: tree verified · runtimes · policy · managed uv
                      ├─► pin written through the manifest guard (marketplace_plugins[])
                      └─► syncServers ──► managed mcp_providers (managed_by plugin:<entry>@<sha>) ─► attached to the agent

a session is built for the agent
  ├─ skills            ──► deliveredSkillRows (own + catalog + marketplace + plugin) ─► Claude plugin / OpenCode skills.paths / prompt
  ├─ Claude            ──► agentPluginWrappers (commands · agents · hooks · LSP) ─► session `plugins[]`
  ├─ OpenCode          ──► generated config `command` (<agent key>/<plugin>:<command>)
  ├─ OpenCode · Codex · Antigravity ──► the slash message expanded by Cinna into a plain prompt (acpDriver.expandPluginCommandInput)
  └─ MCP servers       ──► Cinna MCP endpoint (conductor bridge) ──► every engine
```

## Integration Points

- [Agent Addons](addons.md): the picker, the directory, the per-agent states, the admin policy and the `mcp_servers[]` requirements
- [Agent Skills](skills.md): the plugin's skills are delivered with the agent's own, and one name space decides clashes
- [Kit Contract](kit_contract.md): `marketplace_plugins[]` and `mcp_servers[]`, contract 1.17.0
- [MCP Connections](../../mcp/connections/connections.md): managed connectors, their card and their launch gating
- [The Claude Engine](claude_engine.md) and [OpenCode Interface Contract](contracts/opencode_interface.md): where the wrapper plugins and the commands enter a session
- [Team Sharing](team_sharing.md): a pin travels with the agent; its files and values do not

Sub-doc: [Technical Details](plugins_tech.md)
