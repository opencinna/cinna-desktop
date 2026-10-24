# Chat Modes

## Purpose

Let users define named presets that bundle a runtime engine, credential/model, instructions, tool policy, MCP servers and a color scheme — so they can start new chats for different workflows in one click instead of manually configuring each time.

## Core Concepts

- **Chat Mode** — A saved configuration preset with a name, optional engine/credential/model, instructions, tool policy and a set of MCP providers, and a color from 10 presets
- **Default Chat Mode** — At most one mode per user can be flagged `isDefault`. The new-chat screen auto-applies it whenever the user lands there without an explicit choice — this is the only implicit fallback when routing a message; there is no longer a "default LLM provider" concept
- **Runtime Mode** — One of four chat modes the app creates itself, one per agent runtime: Claude Agent, Codex, Antigravity, OpenCode. Each stands for a chat-owned session on that runtime with its own file and shell tools in a folder of the chat's own. They are the first group in Settings > Chats and the **Runtimes** group in the composer. Everything else is a saved mode
- **Workspace** — The tool policy runtime modes are created with (Tools: Workspace, beside Connected tools and No tools): Cinna's tools and the chat's MCP servers *plus* the runtime's own file and shell tools, working in the chat's folder. See [Workspace tool policy](#workspace-tool-policy)
- **Effort** — Low / Medium / High, the work tier a runtime resolves its model or reasoning level from. Every mode has it; an explicit model wins over it
- **Color Preset** — One of 10 named color themes (slate, indigo, violet, rose, amber, emerald, cyan, sky, orange, fuchsia) that visually distinguish modes in the UI
- **Mode Selection** — Choosing a mode from the **Chat mode** sub-menu of the left-side `[+]` composer menu (`ComposerPlusMenu`), or via the `~` sole-character keyboard shortcut; available on both the new-chat screen and active chats that were created with a mode. (The standalone `ChatConfigMenu` `+` button was retired — its modes list now lives inside the unified `[+]` menu.)

## User Stories / Flows

### Creating a chat mode

1. User navigates to Settings > Chats (first tab)
2. User clicks "Add Chat Mode"
3. Inline form shows Name and Runtime, plus AI Credentials for OpenCode. More options contains color, Effort, model override, Tools (Workspace, Connected tools, No tools), Instructions, and MCP providers.
4. User clicks "Create Mode" or presses Enter in Name — mode is saved immediately
5. Mode appears as a card in the list; all further edits auto-save

### Editing a chat mode

1. User expands a mode card in Settings > Chats
2. Any change (color, provider, model, MCP toggles) saves automatically
3. Name saves on blur or Enter key press; instructions and explicit model IDs save on blur. Rapid edits preserve each other while saves run in order.
4. Claude, Codex and Antigravity modes allow runtime, effort, model, tool policy and instruction edits without an AI credential. Runtime installation, login and policy compatibility are checked when the chat starts; saving a mode does not start a CLI.

### Starting a chat with a mode

1. User is on the new-chat screen ("What can I help with?")
2. User clicks the `[+]` button below the chat input and chooses **Chat mode**
3. The sub-menu shows the modes as colored rows with name, model, and MCP summary. When a runtime can start a chat, its runtime mode comes first under a **Runtimes** heading, the saved modes below under **Saved modes**; without a ready runtime there are no headings. The `~` popup groups the same way
4. Hover highlights the card with the mode's color tint and a left border accent
5. User clicks a mode — popup closes, the input border and background tint to the mode's color
6. User types a message and sends — chat is created with the mode's provider, model, and MCP configuration
7. Mode resets after the chat is created

### Deselecting a mode (new-chat screen)

1. User reopens the `[+]` → **Chat mode** sub-menu and clicks the already-selected mode
2. Mode deselects — input returns to default styling. Without a mode or selected agent, the next send uses a chat-owned Default runtime; installation/login and policy requirements still apply

### Switching mode on an active chat

1. User is in a chat that was created with a mode — the input border/background and the `[+]` button show the mode's color
2. User opens the `[+]` → **Chat mode** sub-menu and selects a different mode
3. The chat's provider, model, and MCP configuration update to match the new mode
4. Input styling changes to the new mode's color
5. Subsequent messages use the new mode's configuration

### Deselecting a mode on an active chat

1. User opens the `[+]` → **Chat mode** sub-menu and clicks the currently active mode
2. Mode clears — `modeId` is removed from the chat, input returns to default styling
3. The chat keeps the baseline MCP set it had — the user's tools do not vanish because the preset was detached — still shown as locked chips below the composer. There is no per-chat model picker or MCP toggle strip to fall back to

## Business Rules

- Engine, credential and model are optional. A plain chat binds the Default runtime instead of requiring an API provider. Claude/Codex engines use their CLI login and Antigravity the user's Google login; OpenCode uses the selected AI credential, else the machine's default credential or the default chat mode's, else the first credential that can run — the one that made OpenCode's runtime mode Ready (its card's select reads `Automatic`). Effort picks that credential's model from its catalogue, or its own default model when the catalogue lists nothing for the tier. Codex is selectable, including through an inherited machine default. Its restricted chat profile requires the exact verified CLI version on POSIX and a model in that CLI’s bundled catalog; unsupported configurations fail at launch with a remedy. See [Codex chat policy](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy). Antigravity is selectable too. Outside the Workspace policy its chat sessions keep one built-in, `view_file`, to read Cinna's tool schemas, and that tool can read the saved conversations of the user's other chats sharing the same process (same user, profile and mode) — an accepted limit. See [The Antigravity Engine](../../agents/local_agents/antigravity_engine.md#cinnas-tools-and-the-chat-mode-policy).
- **A mode inherits its credential's state, and says so before the user finds out.** Switching the AI credential off makes its OpenCode runtime unavailable rather than silently selecting another key. The mode's card therefore carries an `Inactive` badge and a **visible** short cause — `credential switched off`, `no API key`, `credential missing` — with the whole sentence and its remedy in the expanded card. The cause is not left to a tooltip: the collapsed list is the state the tab opens in, and one word covering three situations is unambiguous only to someone who thought to hover. Account-provisioned modes use the same wording and styling as the user's own, so two lists of chat modes one settings group apart cannot report the same state differently — and it matters most there, whose header carries the mode's *own* on/off switch, where an unqualified `Inactive` would be a second meaning of "off" one control away
- **A mode with no credential is not inactive.** It runs on the default, which is what its own select already says ("None (use default)"); badging it would put a warning on the most ordinary chat mode there is. Nothing is badged while the credential list is still loading either, so a card cannot flash `Inactive` and un-flash
- **The credential select never claims "None (use default)" over a mode that names a credential.** A `<select>` whose value matches no option displays the first one, so a mode bound to a switched-off credential read as unset — wrong, and unrecoverable, because the card never admitted what it was set to. The bound row is added as a synthetic option suffixed `— inactive`; a credential that has left the machine, where only its id survives, gets a plain `Missing credential`
- A chat mode's MCP list is the chat's **complete** baseline MCP set. An empty list means the chat starts with **no** MCP servers — there is no "fall back to every enabled provider" rule (it used to exist and silently attached every connector the user owned, tool schemas included, to chats whose mode selected none). Extra servers are added per chat via [On-Demand MCP](../../mcp/on_demand/on_demand.md) (`@`-mention or the `[+]` picker); that is the only per-chat way to change a chat's MCP servers
- Switching modes on an active chat replaces the baseline with the new mode's list verbatim — switching to a mode with no MCPs clears it. On-demand engagements live in their own table and survive the switch
- **A chat mode is the only way to choose a chat's model or change its baseline MCP set.** There is no per-chat model picker or baseline toggle strip: every plain chat is answered by a runtime, not by a model the chat picks, so a picker beside the composer would describe nothing that runs. (One existed, `ChatControls`, from when a mode-less chat was answered by a provider model directly.) The baseline MCP servers of every chat, moded or not, are surfaced as **locked chips** below the composer (and as locked selections in the `[+]` picker) — visible, but managed on the mode itself. See [On-Demand MCP](../../mcp/on_demand/on_demand.md)
- At most one mode per user is `isDefault`. Marking a mode as default in Settings clears the flag on any previously default mode (single-default invariant, enforced in the same transaction)
- **Settings is not the only thing that sets the default.** Onboarding's API-key path creates one, and *Use Claude* / *Use ChatGPT* on the [detected desktop apps](../../agents/local_agents/desktop_app_offer.md) offer stars the matching runtime mode (Claude Agent / Codex) when the effective default names a different engine explicitly. A default that names no engine already follows the Default runtime and is not touched, nor is an account default that wins by precedence. The move is needed because a chat runs on its mode's engine before the Default runtime: changing only the runtime would leave chats spending the onboarding key. Modes an earlier version of the offer created ("Claude", "Codex") are the user's now and are left as they are
- The default chat mode applies until the user explicitly chooses or deselects a mode. That choice stays with the dashboard or agent-page draft across navigation. Confirmed send dispatch resets unchanged mode intent to the current default; a different selection made during preparation remains in the source draft
- Mode selection is available on the new-chat screen and on active chats that were created with a mode
- Switching modes on an active chat updates its provider, model, and MCP configuration immediately
- Deselecting a mode on an active chat clears `modeId` and leaves the baseline MCP set as it was
- The `mode_id` is persisted on the chat record so the app knows which mode was used to create it
- Color presets are fixed (10 options) — they are not user-definable
- Mode name must be non-empty
- Deleting a mode does not affect existing chats that were created with it

## Runtime modes

- **Every runtime is a chat mode, whether or not it is set up.** The four rows are created at startup and by `chatmode:list` where missing (idempotent, safe under concurrent calls: one per user and engine). Creating them for all four regardless of readiness keeps a chat's `modeId` valid while a runtime is installed, removed and installed again. Readiness only decides where they show. They are never starred on creation
- **A runtime mode is fixed in what it is and open in how it behaves.** It cannot be deleted, renamed or moved to another engine, and the CLI runtimes cannot bind an AI credential (OpenCode can: it runs on one). Everything else is editable: Effort, model override, Tools, Instructions, MCP servers, color, star. **Reset to defaults** restores name, effort (Medium), tools (Workspace), empty instructions and color, and clears model, credential and MCP servers; the star is kept. The card asks first, naming what will be cleared and restored, and a mode already at its defaults has nothing to reset. Settings has no Name or Runtime field on these cards. The name follows the runtime's current name, so a renamed runtime never leaves a row behind the name guard
- **A runtime mode is drawn as a terminal glyph in its color, a saved or account mode as a dot** — in Settings, the composer menu, the `~` popup, and on the chat's runtime chip (which otherwise shows the generic bot). Settings calls the group **Runtimes**
- **Readiness is read, never caused.** The list carries each runtime mode's availability: ready, not installed, installing, install failed, not logged in, or (OpenCode) needs an AI credential. Computing it never downloads, never starts a login and never runs a login probe; "not logged in" appears only when a probe another surface already ran said so. Looking for a binary may run one `--version` on the user's own copy of the CLI. Opening Settings or the composer must not start work the user did not ask for
- **A collapsed runtime card shows its status in a fixed place.** A not-ready card shows the same chip as the matching Agents runtime card (Install, Retry, Log in, Add credential) and drives the same setup run, so installing here is the install on the Agents tab. The chip does not resize the card, and the state is a status, not a banner
- **The composer offers a runtime only when it can start a chat.** Not-ready runtimes are absent rather than disabled: their fix is in Settings, and a disabled row would leave nothing to do. "Not logged in" still counts as startable, since login is checked when a chat starts, as for every chat. A chat whose runtime later became unavailable keeps its mode; its next turn fails at start with the usual remedy
- **Effort is for every mode.** Saved modes have it too, so the two lists do not drift; "No preference" exists only on saved modes. An empty model then reads "From effort" instead of "Runtime default"

## Workspace tool policy

- **The chat folder is a working directory, not a sandbox.** A Workspace chat runs in `chat-conductors/<chat id>` under the app's data folder, but a shell started there can reach any path the user can. What protects the user is the **permission ask**, not the folder. Do not describe it as isolation
- **Codex is the exception, and the difference matters.** Its `workspace-write` sandbox lets edits and commands *inside* the chat folder run **without an ask**, refuses writes outside it, and asks only when the model escalates. On the other engines even an edit inside the folder asks
- **Each action asks, and "Always allow" belongs to the chat.** Grants are kept per chat, in the same store local agents use, and are deleted with the chat — never user-global. The block says "remembered for this chat". In the other policies a chat runtime may be asked about Cinna's own tools alone, and nothing is remembered. See [Permissions](../../agents/local_agents/permissions.md)
- **Claude Workspace chats load the user's own `~/.claude`**: settings, hooks, skills and MCP servers. That is acceptable for a chat that is not an agent; agents keep their clean profile. Two consequences: a user allow list or default mode there can pre-approve actions Cinna would otherwise ask about, because Cinna sees only the asks the CLI forwards; and the settings' `model` would override the mode's, so the desktop re-asserts the model after every new/load
- **Codex Workspace chats load the user's `~/.codex/config.toml`**, MCP servers included, and run only on the verified CLI version; otherwise the chat refuses to start with a remedy
- **Antigravity Workspace chats share one process and one home per user, profile and mode.** Its native tools can therefore read and change *other chats' folders* and that home's saved conversations; each action asks. The home sits in a separate `~workspace-homes` folder, because the server takes the first entry of its sorted workspace list as the command directory and a home beside the process folder made one chat in six run commands in a folder that did not exist
- **OpenCode judges folder access per session**, against each session's own folder, even with a shared process, and its catch-all is *ask*: a pattern that misses asks instead of allowing
- **Instructions never live in a Workspace folder.** A model that can write there could edit its own prompt, or leave an `AGENTS.md` the next session loads. `AGENTS.md` and `CLAUDE.md` are removed from the folder before every Workspace session, and the instructions travel on each engine's own prompt channel instead. When a mode's instructions are empty, a Workspace chat gets its own default prompt (one that says it works in its folder), not the plain-chat one that denies having files
- **Attachments are copied into the chat folder** (`attachments/`) and listed by path, instead of being inlined as text, because the file tools can open them
- **Open Chat Folder** appears in the `[+]` Actions menu of a chat whose runtime captured Workspace. It creates nothing: a chat whose runtime never started has no folder and says so
- **The folder follows the chat's lifecycle.** Trash keeps the folder and its grants, so Restore finds the work; permanent delete and Empty Trash remove both
- **A Tools change on a mode reaches existing chats on their next turn** (the one exception to a chat capturing its mode's choices): the chat's runtime row is refreshed and its sessions released. A mid-turn chat picks it up on the following turn. Instructions, model, effort and credential stay captured per chat
- **Message "Run" commands are refused in a Workspace chat** (`not_local`): the chat's runtime is not a local agent with a folder the commands belong to
- **Availability of Workspace per engine** is a list of engines whose policy is verified by contract entries; the Tools option is disabled, with the reason on the option, for an engine outside it. All four are on it now. The Default runtime is allowed while every engine is

## Architecture Overview

```
Settings UI (ChatModesSection -> RuntimeModesSection (runtime modes) + ChatModeCard / ChatModeForm (saved modes))
  -> window.api.chatModes.upsert/delete/list
  -> IPC chatmode:* handlers
  -> SQLite chat_modes table

New Chat Screen (ChatWorkspace -> ChatInput -> ComposerPlusMenu "Chat mode" sub-menu)
  -> User selects mode from the sub-menu (or via the `~` shortcut popup)
  -> Mode's provider/model/MCPs are applied to the new chat
  -> Chat input border/bg + `[+]` button tint to mode color
  -> On send: chat created with mode_id, provider, model, MCPs

Active Chat (ChatWorkspace -> ChatInput -> ComposerPlusMenu "Chat mode" sub-menu)
  -> Chat has mode_id -> "Chat mode" sub-menu offered
  -> Chat without mode_id -> no "Chat mode" item; no per-chat model/MCP controls
  -> User switches mode -> chat's provider/model/MCPs updated
  -> Chat input border/bg tint to active mode color
  -> Deselecting mode -> modeId cleared, baseline MCPs kept (locked chips)
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Chat creation flow applies mode's provider/model/MCPs to the new chat
- [LLM Adapters](../../llm/adapters/adapters.md) — Mode references a provider ID and model ID from the LLM provider system
- [Switching an AI Credential Off](../../llm/adapters/credential_enablement.md) — what the `Inactive` badge means, and the confirm that names the modes a credential's off switch will stop
- [MCP Connections](../../mcp/connections/connections.md) — Mode stores a list of MCP provider IDs to enable for the chat
- [Settings](../../ui/settings/settings.md) — "Chats" tab in settings is the management UI for modes
- [Detected Desktop Apps](../../agents/local_agents/desktop_app_offer.md) — connecting Claude Desktop or ChatGPT may star the Claude Agent / Codex runtime mode
- [Permissions](../../agents/local_agents/permissions.md) — the asks a Workspace chat raises, and per-chat grants
- [Chat Routing](../chat_routing/chat_routing.md) — a chat with a mode and no agent is answered by its own runtime
- [Local-agent runtimes](../../agents/local_agents/agents_tab.md) — the runtime cards the runtime modes mirror, and the setup run they share

## Runtime profile rules

- The **No tools** and **Connected tools** profiles exclude native file and shell tools; **Workspace** opens them in the chat's folder behind the engine's asks (see above). No tools additionally hides all connected tools; Connected tools permits the attached agents/MCPs. A No tools profile cannot start an autonomous task because it cannot invoke finish or ask_user.
- Instructions initialize the chat-owned runtime folder. Existing chats capture their runtime; changing the machine default alone does not rewrite them. An explicit mode change refreshes the synthetic profile and causes a fresh session when its descriptor/config hash changes.
- Claude/Codex model choices use the last catalog advertised by an actual session in this profile. Before discovery, Claude aliases and explicit model entry are fallbacks, not evidence that the CLI supports a model. The in-memory catalog resets at app restart. OpenCode retains credential model selection.
- Existing credential-backed modes are migrated to OpenCode; engine-less modes inherit the Default runtime. Existing modes keep their Tools value; only the four runtime modes are created with Workspace. Managed provider-backed modes retain their existing account-owned shape and resolve through OpenCode.
- Chat token/cost metadata is suppressed; ACP session usage is not presented as an API bill.
