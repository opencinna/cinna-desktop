# Cinna Re-authentication

## Purpose

When a Cinna account's stored OAuth tokens become unusable — token replay detected by the server, refresh token revoked or expired, server-side session revocation — the user must obtain fresh tokens. Re-authentication is an **in-place** flow that keeps the existing local profile (chats, providers, MCP servers, agents, notes, settings, jobs) intact and only swaps the encrypted access/refresh pair. Deleting and recreating the account is *not* required, and would cascade-destroy all local data.

## Core Concepts

| Term | Definition |
|------|-----------|
| **In-place re-auth** | Re-runs the OAuth Authorization Code + PKCE flow against the user's stored `cinnaServerUrl`, then writes the resulting tokens back to the **same** `users` row — no row insert, no cascade delete |
| **Reauth required** | The state in which the desktop must obtain a fresh OAuth grant. Detected three ways: (1) `getCinnaAccessToken()` throws `CinnaReauthRequired` because no tokens are stored or refresh failed with `invalid_grant` / `token_reuse_detected` / `unauthorized`; (2) the Cinna server returns 401/403 on the agent-card fetch — the desktop's locally-stored token still looks valid but the server has revoked it; (3) the A2A stream RPC fails mid-turn with 401/403 |
| **Cinna-token-backed agent** | An agent with `source === 'remote'` — its access token comes from `getCinnaAccessToken()` (the user's Cinna JWT). 401/403 from such an agent is treated as reauth-required. Manually-added local A2A agents (`source === 'local'`) authenticate with a user-supplied static token; their 401s remain plain "token rejected" errors with no in-app reauth flow |
| **Identity match check** | Guard that compares the OAuth-returned `profile.email` to the existing row's `username`. Mismatch is rejected with `identity_mismatch` so a user cannot accidentally re-link the local profile to a different server identity |
| **Reauth-required error code** | Typed discriminator (`cinna_reauth_required`) shipped on `AgentErrorEvent` and persisted on error message rows — drives the dedicated reauth bubble in the chat without substring-matching the user-facing copy |
| **Reauth bubble swap** | The dedicated chat bubble owns two visual states keyed off local component state: pre-reauth (danger, `AlertTriangle`, expired copy, "Re-authenticate" button) and post-reauth (success, `CheckCircle`, "Authenticated — you can resend your message now."). Replacing the entire bubble — rather than appending a success note under the now-stale danger headline — avoids the visual contradiction of a red "expired" banner immediately after the user has fixed the session |
| **Global reauth modal** | App-level modal (`ReauthModal`, mounted in `App.tsx`, `z-[100]` so it sits over every other overlay) raised whenever a reauth-required code surfaces, regardless of which feature triggered it. **Primary trigger:** the IPC wrapper (`ipc/_wrap.ts`) — the one path every handler shares — calls `broadcastReauthRequired` (`auth/reauth-notify.ts`) whenever a handler *throws* `reauth_required`/`cinna_reauth_required` (e.g. `catalog:list`) **or returns** an `{ success: false, code: 'reauth_required' }` shape (e.g. `agent-status:list`, which catches internally). The broadcast resolves the active profile and ships `{ account, serverUrl, source }` so the modal names which connection failed. **Secondary trigger:** the renderer QueryClient's `queryCache`/`mutationCache` `onError` → `flagReauthFromError` (no details), covering anything that bypasses an IPC reject. Visibility is held in `useReauthStore`, gated to `cinna_user`. Dismissing sets a session `dismissed` flag so the next failed poll doesn't re-pop it; a successful re-auth anywhere clears it via the shared `useCinnaReauth` `onSuccess`. The pre-existing inline surfaces (catalog banner, User Accounts card re-auth button, agent-status panel, chat bubble) still work independently |

## User Stories / Flows

### Trigger: agent send fails in chat
1. User sends a message to a remote agent. Main process resolves the agent's access token → `getCinnaAccessToken()` throws `CinnaReauthRequired` (token replay / expired / revoked), or the Cinna server returns 401/403 on the agent-card fetch / stream RPC
2. The IPC handler posts an error event with `code: 'cinna_reauth_required'` and persists an error message row with the same code
3. The chat surfaces a dedicated **reauth error bubble** (danger-styled, `AlertTriangle` icon, "Cinna session expired — please re-authenticate." copy) with an inline "Re-authenticate" button — no navigation needed
4. User clicks the button → browser opens → user logs in on the server → desktop receives the callback → tokens are written back against the same user
5. The same bubble swaps to a **success state** (success-styled, `CheckCircle` icon, "Authenticated — you can resend your message now."). The button drops away; the now-stale "expired" copy is gone. The user re-submits the message manually

### Trigger: remote agents fail to sync
1. The periodic remote-agent sync (or a manual Sync click) hits `getCinnaAccessToken()` which throws `CinnaReauthRequired`
2. Settings → Agents (profile group) renders a banner: *"Cinna session expired. Re-authenticate to resume remote agent sync — your chats and settings will be preserved."*
3. User clicks "Re-authenticate" → OAuth flow runs → on success the renderer immediately kicks off a fresh `agent:sync-remote` so the previously-known agents reappear

### Trigger: Agent Status overlay fails to load
1. Opening the agent-status overlay hits `getCinnaAccessToken()` which throws `CinnaReauthRequired`
2. Overlay replaces its body with a centered call-to-action panel + "Re-authenticate" button
3. On success the overlay refetches and the status grid renders normally

### Trigger: any Cinna request fails app-wide (global modal)
1. Any IPC handler hits a dead session — `catalog:list` *throws* `CinnaApiError('reauth_required')`, `agent-status:list` *returns* `{ success: false, code: 'reauth_required' }` after catching internally, remote sync hits `cinna_reauth_required`, etc.
2. `ipc/_wrap.ts` sees the code on either the thrown error or the returned shape and calls `broadcastReauthRequired(channel)`, which resolves the active profile (`getProfileScopeUserId` → `userRepo`) and sends `{ account, serverUrl, source }` to the renderer
3. `ReauthModal` (app root, `z-[100]`) flips `useReauthStore` via the broadcast listener and pops a centered "Cinna session expired" prompt that **names the account + server** ("The connection to *Full Name* on *host* was lost while loading agent status …") with "Re-authenticate" and "Not now" buttons — visible on any screen
4. "Re-authenticate" runs the same OAuth flow. On success `useCinnaReauth.onSuccess` clears the store and the modal invalidates every query so the surfaces that failed while the session was dead recover; "Not now" (or Escape / backdrop click) sets the session `dismissed` flag so the next failed poll doesn't re-open it

### Trigger: discoverability via Settings → User Accounts
1. Any Cinna account's expandable card in **Settings → User Accounts** renders a "Re-authenticate" row inside its Cinna Server Details block (description on the left, button on the right). This replaces the former standalone Profile → Connection tab, which has been removed
2. When the user has no tokens (`hasCinnaTokens === false`), the row shows the "session expired" copy and the button is rendered in the accent colour to draw attention; otherwise it's a neutral outline button
3. Clicking it runs the same OAuth flow (`useCinnaReauth`). On failure, an inline error is shown under the description so the user can retry

### Identity mismatch path
1. User clicks Re-authenticate → browser opens → user accidentally signs in to the Cinna server as a different account
2. After the OAuth round-trip, the desktop compares the returned `profile.email` to the existing user's `username`
3. They differ → `AuthError('identity_mismatch', ...)` is raised → no tokens are written
4. The surface that initiated the flow shows the error: *"Signed in as B, but this account is A. Sign in with the matching account on the Cinna server."*
5. User can retry. Local data and the previous token state (still cleared) are untouched

## Business Rules

- Re-auth always operates on the **active profile** (`getProfileScopeUserId()`) resolved main-side. The renderer never supplies a userId — closes the confused-deputy gap where a renderer bug could target a non-active account
- The flow is only available for users where `type === 'cinna_user'` and `cinnaServerUrl` is non-null. Non-Cinna users see no entry
- The OAuth round-trip uses the user's **stored** `cinnaServerUrl` — the server URL is not user-editable at re-auth time; switching servers requires creating a new account
- Identity is verified by exact-match between `profile.email` (server response) and `users.username` (local row). Case sensitivity follows whatever the server returns — emails are not normalised
- On success, only the four `cinna_*` token columns (`cinnaClientId`, `cinnaAccessTokenEnc`, `cinnaRefreshTokenEnc`, `cinnaTokenExpiresAt`) are rewritten. No other row data is touched. No migration or cascade runs
- On failure (`oauth_failed`, `identity_mismatch`, network error during browser flow), the existing token state is unchanged. If tokens were already cleared before the click, they remain cleared
- Cache invalidation after success: `['users']`, `['auth', 'current']`, `['agents']`, and the remote-sync status cache. Every banner that depends on `hasCinnaTokens` or sync state refreshes automatically — no manual reload
- The reauth chip in the chat error bubble only appears when `currentUser.type === 'cinna_user'`. Non-Cinna users would have no way to act on the chip even if the code were set
- In-chat stream errors (both LLM and A2A) render **only** as the persisted error bubble inside the conversation — the transient "send error" banner above the composer is no longer populated from stream-port `'error'` events. The persisted bubble carries the reauth chip and the typed `code`, so duplicating it as a banner would just show the same text twice without the action button. The transient banner is still used for the new-chat-flow case where no chat row exists yet to host a bubble

## Architecture Overview

```
Renderer                                Main Process                     Browser / Cinna Server
─────────                               ────────────                     ──────────────────────
Trigger:
- "Re-authenticate" on the account's card in Settings → User Accounts
- Settings banner button
- Agent Status panel button       ───→  auth:cinna-reauth (no args)
- Chat error chip (cinna_reauth_required)
- Global ReauthModal (any handler throwing/returning
  reauth_required → ipc/_wrap.ts → broadcastReauthRequired → useReauthStore)
                                        reauthCinna(getProfileScopeUserId()):
                                          row = userRepo.get(userId)
                                          assert row.type === 'cinna_user'
                                          startCinnaOAuthFlow(row.cinnaServerUrl)  ──→ shell.openExternal
                                                                                  User authorizes
                                                                              ←── localhost callback
                                          Exchange code, fetch profile
                                          IF profile.email !== row.username:
                                            throw AuthError('identity_mismatch')
                                          ELSE:
                                            storeCinnaTokens(SAME userId, …)        # in-place
                                        ←─ { success, user }
React Query invalidate:
  ['users'], ['auth','current'], ['agents']
  REMOTE_SYNC_STATUS_KEY (cleared)
→ all "session expired" banners
  disappear; pending remote sync retried
```

## Integration Points

- **[Cinna Accounts](./cinna_accounts.md)** — Parent feature. Re-auth reuses the same `cinna-oauth.ts` PKCE machinery and the same `cinna-tokens.ts` encrypted-token storage
- **[Agents](../../agents/agents/agents.md)** — Remote agent sync's `reauth_required` failure state hosts one of the four re-auth entry points
- **[Agent Status](../../agents/agent_status/agent_status.md)** — The agent-status overlay surfaces its own re-auth panel when the status fetch fails
- **[Messaging](../../chat/messaging/messaging.md)** — The agent-send IPC path emits the `cinna_reauth_required` code on both the live stream port and the persisted error row, driving the chat error bubble's inline chip
