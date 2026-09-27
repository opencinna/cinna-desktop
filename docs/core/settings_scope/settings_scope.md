# Settings Scope

## Purpose

Cross-cutting model that splits app data into two scopes: **Default** (shared across all profiles) and **Profile** (tied to the active account). Lets users build one local setup — providers, MCP servers, chat modes, local agents — and have it follow them into any account, while account-bound data (remote agents, and chats made with them) stays per profile. By default, chats that belong to the computer rather than the account are shared too (see [Shared local chats](#shared-local-chats)).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Default Scope** | Storage under the built-in guest user id (`__default__`). Holds shared settings visible to every profile. |
| **Profile Scope** | Storage under the currently activated user id. Holds account-bound data and is hidden from other profiles. |
| **Shared Settings** | Settings that always live in Default scope: LLM providers, MCP providers, chat modes, locally-registered agents. |
| **Profile-Bound Data** | Data that stays in Profile scope: chats made with account resources (with messages, trash), remote agents synced from Cinna, Cinna OAuth tokens, agent enable/disable overrides, and every task, delegation, handover and Inbox row — even one started from a shared chat. |
| **Chat Owner** | The user id a chat row belongs to (`chats.user_id`). Not always the active profile: a shared local chat is owned by `__default__` while a signed-in profile uses it. |
| **Shared Local Chat** | A chat owned by the default profile, listed and usable in every profile while `showLocalDataInAllProfiles` is on (the default): chats made while signed out, and new chats whose runtime is entirely local. |
| **Agent Override** | Per-profile boolean preference (`agent_overrides` table) that overlays the `enabled` flag of a sync-managed agent so the user's toggle survives subsequent syncs. |
| **Sidebar Groups** | The Settings sidebar shows two headed sections: "Default" and "Profile {name}" (only when the active profile has profile-scope settings to offer). |

## User Stories / Flows

### Configure Once, Use Everywhere

1. User signs in as the default guest, adds an Anthropic provider, an MCP server, and a chat mode bundling them.
2. User registers a new local profile or signs in to a Cinna account.
3. The Anthropic provider, MCP server, and chat mode all remain visible — they're served from Default scope.
4. Chats switch to the new profile's history — which, with **Show local agents and chats in all profiles** on, already contains the chats made as the guest.

### Profile-Specific Extension (Cinna)

1. Cinna user activates → background sync upserts remote agents into Profile scope.
2. Settings sidebar gains a "Profile {displayName}" group. Its Agents entry shows only Cinna-synced agents, including hidden ones; the group also offers account Chats, Local Development, AI Credentials, Catalog and Cloud Sync. Default → Agents configures this installation's folders, runtimes and Open in tools. Direct A2A connections are added through Agents → Add an agent and configured on their own agent pages.
3. User signs out → the Profile group disappears; Default settings (providers, MCP, modes, local agents) stay untouched.

### Toggle a Remote Agent

1. User opens Settings → Profile → Agents and hides a synced agent, or chooses Disable in Desktop App in that agent page's header menu.
2. The toggle moves immediately (optimistic UI) and writes a row to `agent_overrides` keyed by `(profileUserId, agentId)`.
3. Agent disappears from the chat agent selector, Agents sidebar and status listing. A toast names Settings → Profile → Agents as the recovery location. If its page was open, successful completion selects the preceding available agent (or another agent, then an empty new-chat screen when none remain), guarded against profile/selection changes during the request.
4. Next background sync rewrites the agent's metadata but leaves the override untouched — the toggle stays off.

### Switch Profile

1. User opens the user menu and picks another profile.
2. Activation runs: chats reload for the new profile, remote-agent sync restarts for that profile.
3. Shared LLM adapters and MCP connections are reloaded from Default scope (same set as before; no Default-scope content changes).

### Stale Tab Guard

1. User is viewing Settings → Profile → Agents on a Cinna account.
2. User signs out / switches to a local profile that has no Profile group.
3. Sidebar snaps the selected tab back to "Chats" (Default) so no orphaned menu item is highlighted.

### Shared local chats

1. With **Show local agents and chats in all profiles** on (Settings → Features → Interface, the default), a signed-in profile's Chats list, trash, Pinned block and open chats include the chats the default profile owns, merged into one list by recency. The default profile still sees only its own.
2. The user opens one and works in it exactly as in the profile's own chats: send, queue, rename, pin, drag, attach, trash, restore, empty trash. Every write goes to the chat's owner, so the chat stays the computer's.
3. A new chat started in a signed-in profile is created in the profile and gets its owner when its agent, chat mode or routing is first set while it is still empty (the new-chat flow does this before the first send). Machine-local runtime makes it the default profile's; anything of the account keeps it in the profile. See the rules below.
4. Signing out, or deleting the account, removes the profile's own chats; the shared ones stay, because they were never the profile's.
5. With the switch off, each profile sees exactly the chats it owns and new chats never change owner — the behaviour from before the setting existed. Chats already shared stay owned by the default profile and reappear when it is turned back on; nothing is moved either way.

## Business Rules

- **Default scope is the only write target for shared settings.** Mutations to LLM providers, MCP providers, chat modes, and locally-registered agents always target `__default__` regardless of which profile is active.
- **Profile scope is the only read/write target for profile-bound data.** Remote agents, agent overrides, Cinna tokens, tasks, delegations, handovers and Inbox rows always use the active profile's id. Chats use their owner, which is the active profile except for a shared local chat.
- **Only the chat is shared, never the work started from it.** A task, delegation, handover or Inbox row made from a shared chat is keyed to the active profile, and the turn resolves agents and credentials as that profile. A check that asks "is this still the same profile" compares profiles, never chat owners; comparing the chat owner would make every shared chat look like it had moved to the guest mid-turn. A handover found from a shared chat is therefore the active profile's to take in and pay for, not dropped as foreign.
- **What a chat is attached to follows its owner.** Its conductor runtime, local attachment files (`files/<owner>/<chatId>`), live-run subscription key, pending-message queue and Managed-agent checkpoint are stored under the chat owner, so every profile that sees the chat finds the same ones.
- **A new chat's owner is decided once, while it is empty.** At a chat update that sets its agent, chat mode or routing, a chat with no messages and no files is given to the default profile only if everything it would run on is machine-local: every bound or attached agent is a local agent (not `remote:`, not a development agent, and resolvable), its chat mode is a local unmanaged one, its credential a local unmanaged one, and — for a chat the model answers with neither mode nor credential named — the effective default chat mode is local. A human-routed chat with no agents counts as local. Anything else keeps it in the profile. Once something is said or attached the owner never changes: messages, files and runs are keyed by it, and moving them would be a migration, not a binding. While still empty, rebinding may move it either way; its conductor runtime moves with it in the same transaction.
- **Never in the default profile, never with the switch off.** The default profile owns everything it makes anyway; with `showLocalDataInAllProfiles` off every new chat stays where it was started.
- **Local agents are visible in every profile regardless of the switch.** They live in Default scope; the switch governs chats only, despite its label naming agents too.
- **Remote agents are not editable via the standard `agent:upsert` IPC.** Their metadata is owned by Cinna sync. Desktop visibility uses `agent:set-enabled` → override table. They cannot be deleted from the desktop at all — that happens on the server, reached from **Open on the server**; consumer bundles use uninstall in Settings → Catalog. See [Remote Agents](../../agents/remote_agents/remote_agents.md).
- **UI lifecycle actions follow ownership.** Cinna agents have a reversible Desktop visibility toggle; direct connections offer deletion instead. Previously disabled direct connections have an enable-only recovery action. The underlying enablement IPC still supports local rows.
- **Agent enable/disable routing:**
  - Local agents (id without `remote:` prefix) → update `agents.enabled` in Default scope.
  - Remote agents (id starts with `remote:`) → upsert `(profileUserId, agentId, enabled)` in `agent_overrides`.
- **Override survives sync.** `agent_overrides` has no FK / no cascade against `agents.id` — if sync removes and re-adds the same remote agent, the override re-applies on the next list.
- **Override does NOT survive profile deletion.** `userRepo.deleteWithCascade` deletes all override rows owned by the user being removed.
- **Reload on activation loads Default-scope providers/MCP.** The adapter registry and `mcpManager` are populated from Default scope on every activation, so the set never depends on which profile is active.
- **Profile group visibility.** The sidebar only renders "Profile {name}" when the active profile is a Cinna user (only profile-scope settings shipped so far). When hidden, the renderer auto-resets `settingsTab` to a Default-scope tab.
- **The default guest user is treated as the only profile when active.** No "Profile" group is shown; the agent list collapses to Default-scope-only.
- **Sharing local chats is installation-wide.** `showLocalDataInAllProfiles` is a boolean in `app_settings`, defaults to true, and is read on every chat lookup, so toggling it takes effect at once; the renderer re-fetches the chat list, trash and open chat when it changes.
- **Sidebar section headings are installation-wide.** `showAgentSidebarSections` is a boolean in `app_settings`, defaults to true, and is edited under Settings → Features → Interface. It changes labels/spacing without changing scope or group ordering.
- **Theme is not scoped.** Stored in `localStorage` and shared across all profiles on the machine (unchanged from prior behavior).
- **Window and sidebar layout are not scoped either.** The main window's saved bounds live in main's `window-state.json` and the sidebar's open state in `localStorage`; both belong to the machine. See [App Shell → Across launches](../../ui/app_shell/app_shell.md#across-launches).

## Architecture Overview

```
                        ┌──────────────────────────────┐
                        │  IPC Handlers                │
                        │                              │
  Shared settings ───►  │  getSettingsScopeUserId()    │  ──► always '__default__'
  (LLM, MCP,            │                              │
   modes, local         │                              │
   agents)              │                              │
                        │                              │
  Profile data ─────►   │  getProfileScopeUserId()     │  ──► getCurrentUserId()
  (remote agents,       │                              │
   overrides, tasks,    │                              │
   Inbox, handovers)    │                              │
                        │                              │
  Chats ────────────►   │  visibleChat(profile, id)    │  ──► own chat, or a
                        │  chatScopesFor(profile)      │       __default__ one while
                        │                              │       showLocalDataInAllProfiles
                        └──────────────┬───────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────────┐
                        │  Service / Repo layer        │
                        │                              │
                        │  agentService.listMerged()   │  ──► local (Default) +
                        │  agentService.findAgent()    │       remote (Profile),
                        │  agentService.setEnabled()   │       overlay overrides
                        └──────────────────────────────┘

Sidebar (Settings view)
  ├─ Default ──► Chats / Agents (folders and runtime) / Local Development / AI Credentials / MCP Providers / User Accounts / Features / Development
  └─ Profile {name} ──► Chats / Agents (Cinna visibility) / AI Credentials / Catalog / Cloud Sync [Cinna users only]
```

## Integration Points

- [Resource Activation](../resource_activation/resource_activation.md) — activation now loads Default-scope providers/MCP, and starts remote sync for the Profile if applicable.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — `userRepo.deleteWithCascade` cleans up both Profile-scope data and `agent_overrides`.
- [Settings](../../ui/settings/settings.md) — sidebar splits menu items into Default and Profile groups.
- [Chat Modes](../../chat/chat_modes/chat_modes.md), [Adapters](../../llm/adapters/adapters.md), [MCP Connections](../../mcp/connections/connections.md) — all live in Default scope and are mutated only via Default scope.
- [Agents](../../agents/agents/agents.md), [Remote Agents](../../agents/remote_agents/remote_agents.md) — local agents live in Default scope; remote agents live in Profile scope with overrides for enable/disable.
- [Messaging](../../chat/messaging/messaging.md) — switching profiles changes the chat history, except for shared local chats.
- [Chats List Order](../../chat/chat_list_order/chat_list_order.md) — Pinned ranks span every owner in the merged list.
- [Handover Bus](../../jobs/tasks/handover_bus.md) — a handover from a shared chat belongs to the active profile.

## Local Development settings

Default → Local Development owns the shared desktop toolchain readout, terminal PATH integration and detected developer tools. The managed CLI can be inspected and linked to PATH even when the active account has no local-development workspace; the read is ungated, while linking still requires an activated session. OpenCode Path is an installation-wide override on this page.

Profile → Local Development owns workspace status, setup/repair, opening the account workspace and resetting its server's consent. Consent is still keyed by server host: accounts on the same server share the answer. The profile page remounts on account changes. Every activation synchronously retires the old workspace state before loading the new profile, including local/default activation and logout; only a winning Cinna activation reconciles. Running work drains without publishing old results or starting later account steps. There is no per-user consent migration. See [Local Development](../../agents/local_dev/local_dev.md).
