# Settings Scope

## Purpose

Cross-cutting model that splits app data into two scopes: **Default** (shared across all profiles) and **Profile** (tied to the active account). Lets users build one local setup — providers, MCP servers, chat modes, local agents — and have it follow them into any account, while account-bound data (chats, remote agents) stays per profile.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Default Scope** | Storage under the built-in guest user id (`__default__`). Holds shared settings visible to every profile. |
| **Profile Scope** | Storage under the currently activated user id. Holds account-bound data and is hidden from other profiles. |
| **Shared Settings** | Settings that always live in Default scope: LLM providers, MCP providers, chat modes, locally-registered agents. |
| **Profile-Bound Data** | Data that stays in Profile scope: chats (with messages, trash), remote agents synced from Cinna, Cinna OAuth tokens, agent enable/disable overrides. |
| **Agent Override** | Per-profile boolean preference (`agent_overrides` table) that overlays the `enabled` flag of a sync-managed agent so the user's toggle survives subsequent syncs. |
| **Sidebar Groups** | The Settings sidebar shows two headed sections: "Default" and "Profile {name}" (only when the active profile has profile-scope settings to offer). |

## User Stories / Flows

### Configure Once, Use Everywhere

1. User signs in as the default guest, adds an Anthropic provider, an MCP server, and a chat mode bundling them.
2. User registers a new local profile or signs in to a Cinna account.
3. The Anthropic provider, MCP server, and chat mode all remain visible — they're served from Default scope.
4. Chats, however, switch to the new profile's empty history.

### Profile-Specific Extension (Cinna)

1. Cinna user activates → background sync upserts remote agents into Profile scope.
2. Settings sidebar gains a "Profile {displayName}" group with a single "Agents" entry showing those remote agents.
3. User signs out → the Profile group disappears; Default settings (providers, MCP, modes, local agents) stay untouched.

### Toggle a Remote Agent

1. User opens Settings → Profile → Agents and disables a synced agent.
2. The toggle moves immediately (optimistic UI) and writes a row to `agent_overrides` keyed by `(profileUserId, agentId)`.
3. Agent disappears from the chat agent selector.
4. Next background sync rewrites the agent's metadata but leaves the override untouched — the toggle stays off.

### Switch Profile

1. User opens the user menu and picks another profile.
2. Activation runs: chats reload for the new profile, remote-agent sync restarts for that profile.
3. Shared LLM adapters and MCP connections are reloaded from Default scope (same set as before; no Default-scope content changes).

### Stale Tab Guard

1. User is viewing Settings → Profile → Agents on a Cinna account.
2. User signs out / switches to a local profile that has no Profile group.
3. Sidebar snaps the selected tab back to "Chats" (Default) so no orphaned menu item is highlighted.

## Business Rules

- **Default scope is the only write target for shared settings.** Mutations to LLM providers, MCP providers, chat modes, and locally-registered agents always target `__default__` regardless of which profile is active.
- **Profile scope is the only read/write target for profile-bound data.** Chats, remote agents, agent overrides, and Cinna tokens always use the active profile's id.
- **Remote agents are not editable via the standard `agent:upsert` IPC.** Their metadata is owned by Cinna sync; only the enable/disable toggle is user-controlled (routed to `agent:set-enabled` → override table).
- **Agent enable/disable routing:**
  - Local agents (id without `remote:` prefix) → update `agents.enabled` in Default scope.
  - Remote agents (id starts with `remote:`) → upsert `(profileUserId, agentId, enabled)` in `agent_overrides`.
- **Override survives sync.** `agent_overrides` has no FK / no cascade against `agents.id` — if sync removes and re-adds the same remote agent, the override re-applies on the next list.
- **Override does NOT survive profile deletion.** `userRepo.deleteWithCascade` deletes all override rows owned by the user being removed.
- **Reload on activation loads Default-scope providers/MCP.** The adapter registry and `mcpManager` are populated from Default scope on every activation, so the set never depends on which profile is active.
- **Profile group visibility.** The sidebar only renders "Profile {name}" when the active profile is a Cinna user (only profile-scope settings shipped so far). When hidden, the renderer auto-resets `settingsTab` to a Default-scope tab.
- **The default guest user is treated as the only profile when active.** No "Profile" group is shown; the agent list collapses to Default-scope-only.
- **Theme is not scoped.** Stored in `localStorage` and shared across all profiles on the machine (unchanged from prior behavior).

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
  (chats, remote        │                              │
   agents, overrides)   │                              │
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
  ├─ Default  ──► chats / agents (local) / llm / mcp / accounts / development
  └─ Profile {name}  ──► agents (remote)   [Cinna users only]
```

## Integration Points

- [Resource Activation](../resource_activation/resource_activation.md) — activation now loads Default-scope providers/MCP, and starts remote sync for the Profile if applicable.
- [User Accounts](../../auth/user_accounts/user_accounts.md) — `userRepo.deleteWithCascade` cleans up both Profile-scope data and `agent_overrides`.
- [Settings](../../ui/settings/settings.md) — sidebar splits menu items into Default and Profile groups.
- [Chat Modes](../../chat/chat_modes/chat_modes.md), [Adapters](../../llm/adapters/adapters.md), [MCP Connections](../../mcp/connections/connections.md) — all live in Default scope and are mutated only via Default scope.
- [Agents](../../agents/agents/agents.md), [Remote Agents](../../agents/remote_agents/remote_agents.md) — local agents live in Default scope; remote agents live in Profile scope with overrides for enable/disable.
- [Messaging](../../chat/messaging/messaging.md) — chats remain Profile-scoped; switching profiles changes the chat history.
