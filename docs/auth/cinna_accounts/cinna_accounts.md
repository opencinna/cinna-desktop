# Cinna Accounts

## Purpose

Cinna Accounts let users connect the desktop app to a remote Cinna server (cloud or self-hosted) via OAuth. This enables future access to hosted Cinna features (agents, shared resources) while keeping local data isolation and optional local password protection.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Cinna Account** | A user account (`type: cinna_user`) linked to a remote Cinna server via OAuth tokens |
| **Hosting Type** | Either `cloud` (hardcoded to `opencinna.io`, currently disabled — UI shows an "Under Development" notice and the Connect action is blocked) or `self_hosted` (user-provided URL) |
| **Self-Hosted History** | Renderer-only list of server URLs the user has successfully connected to from this device. Surfaced as a clickable list under the URL input; saved on successful connect only; each entry has an X-on-hover to remove it. Capped at 8 entries, most-recent-first. |
| **Instance Discovery** | The desktop app fetches `/.well-known/cinna-desktop` from the server to discover OAuth endpoints (RFC 8414-style metadata) |
| **Bootstrap Flow** | Combined browser-based flow: the server handles login + client registration + authorization in a single redirect, returning both `client_id` and `code` to the desktop callback |
| **Client ID** | Server-assigned identifier for this desktop device, received during the bootstrap flow and stored locally |
| **Token Rotation** | On each refresh, the server issues a new refresh token and invalidates the old one; replay of an old token triggers re-auth |
| **Local Password** | Optional password that locks the local session — independent of Cinna server authentication |

## User Stories / Flows

### Create Cinna Account (Cloud) — currently unavailable
1. User opens user menu, clicks "Add Account"
2. Centered modal appears with two options: "Local Account" and "Cinna Account"
3. User selects "Cinna Account"
4. Hosting selection step: Self-Hosted is pre-selected on the left; selecting Cloud (opencinna.io) on the right shows an inline "Under Development" notice and disables the Connect button
5. The full cloud bootstrap/authorize flow described below is implemented end-to-end in main process; only the UI entry point is blocked. When the notice is removed, steps 5–13 below execute against `https://opencinna.io`

### Create Cinna Account (Self-Hosted)
1. User opens user menu, clicks "Add Account"
2. Centered modal appears with two options: "Local Account" and "Cinna Account"
3. User selects "Cinna Account"
4. Hosting selection step: Self-Hosted is pre-selected. User enters a server URL (e.g. `https://cinna.mycompany.com`) — or clicks one of the "Recent servers" rows below the input to reuse a previously-successful URL — and clicks the centered "Connect" button. Each recent-server row has an X-on-hover to drop that entry from history without connecting
5. Modal shows "Waiting for browser authorization..." spinner; only this step retains a Cancel button (it actively aborts the OAuth flow via `auth:cinna-oauth-abort`)
6. Browser opens to the self-hosted server's combined bootstrap/authorize endpoint
7. User logs in on the web and authorizes the desktop app
8. Server redirects to `http://127.0.0.1:{port}/oauth/callback` with `code`, `state`, and `client_id`
9. Desktop exchanges code for access + refresh tokens (PKCE-protected)
10. Desktop fetches user profile (email, display name) from the server's userinfo endpoint
11. Account is created automatically using the OAuth email as username and the server-provided display name
12. Tokens are encrypted and stored; user is activated; modal closes
13. The successfully-connected URL is prepended to the self-hosted history (dedup, capped at 8)
14. App is now connected to the Cinna server (user can set a local password later)

### OAuth Failure / Cancel
1. If user cancels during the "Waiting for authorization..." step, the OAuth flow is aborted (only step that has a Cancel button — the earlier steps dismiss via click-outside)
2. If OAuth fails (timeout, server error, state mismatch), the partially-created user row is deleted and the failed URL is **not** saved to the self-hosted history
3. User sees the error message and can retry from the form step

### App Restart with Cinna Account
1. Same as local account restart — if the Cinna user has a local password, login screen shown
2. After unlock, stored tokens are used for any future server communication
3. If tokens are expired, auto-refresh happens transparently using the stored refresh token

### Token Refresh
1. When accessing the server, if the access token is within 60 seconds of expiry, auto-refresh fires
2. Server returns new access + refresh tokens (rotation); both are stored
3. If the server detects replay (old refresh token reused), all tokens are cleared and the user must re-authenticate via OAuth

### Re-authentication (Session Expired)
When tokens have been cleared (replay detection, manual revoke on the server, refresh token expired), the user can re-link the account in-place — no data loss. Four UI surfaces expose the action. See [Re-authentication](./reauthentication.md) for the full flow.

## Business Rules

- Cinna Accounts use OAuth 2.0 Authorization Code + PKCE — no client secrets stored on disk
- `client_id` is assigned by the server during the bootstrap flow, not hardcoded
- No username/display name/password is collected during Cinna account creation — profile info (email, display name) comes from the OAuth server's userinfo endpoint
- Users can optionally set a local password later to lock the session on their machine
- All data isolation rules from [User Accounts](../user_accounts/user_accounts.md) apply equally to Cinna accounts
- Tokens are encrypted at rest using `safeStorage` (OS keychain), same as API keys
- On user deletion, all Cinna tokens are cleared before cascade-deleting user data
- Discovery responses are cached per server URL for the session (cleared on app restart)
- Concurrent token refresh attempts are deduplicated (mutex) to prevent race conditions
- If token refresh fails with replay detection, all tokens are wiped and the user must re-authenticate. Re-auth is offered in-app and preserves all local data — see [Re-authentication](./reauthentication.md)
- The Cloud (opencinna.io) hosting option is currently gated behind an "Under Development" notice in the UI — the Connect button is disabled while Cloud is selected. Self-Hosted is the default and only-reachable path. The underlying OAuth + token machinery treats `cloud` and `self_hosted` identically; lifting the gate is a UI-only change
- Self-hosted history is stored in `localStorage` under `cinna-selfhosted-history` as a JSON array of URL strings. It is scoped to the renderer profile (shared across OS users of the desktop install — URLs only, no credentials)

## Architecture Overview

```
Account Creation (Cinna):
  Renderer                    Main Process                    Browser / Cinna Server
  ─────────                   ────────────                    ──────────────────────
  RegisterForm (modal)
  Step: type-select
  Step: cinna-hosting
  Click "Connect" ─────────→ auth:register (accountType=cinna)
  Step: cinna-waiting         discoverCinnaEndpoints()  ────→ GET /.well-known/cinna-desktop
                              startCinnaOAuthFlow()     ────→ shell.openExternal(authorizeUrl)
                                                             User logs in + authorizes
                              waitForOAuthCallback()   ←──── Redirect to localhost with code+client_id
                              Exchange code for tokens  ────→ POST /oauth/token
                              fetchCinnaUserInfo()      ────→ GET userinfo_endpoint
                              Insert user row (email as username, server display name)
                              storeCinnaTokens()
                              activate(userId)
  onSuccess → close modal  ←── { success, user }

Token Refresh (automatic):
  Any server call ──→ getCinnaAccessToken(userId)
                      Check expiry → if near, refreshCinnaTokens()
                      Store rotated tokens
                      Return valid access token
                      (On replay → clear tokens → throw CinnaReauthRequired)
```

In-place re-authentication (when the user clicks "Re-authenticate" in any of the four UI surfaces) reuses the same OAuth machinery but keeps the existing `users` row. See [Re-authentication](./reauthentication.md) for the full flow.

## Integration Points

- **[User Accounts](../user_accounts/user_accounts.md)** — Cinna accounts are a user type; same login/switch/delete flows, same data isolation
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Cinna users go through the same activation gate; providers load on activate
- **[MCP Connections](../../mcp/connections/connections.md)** — Reuses `oauth-callback.ts` (local HTTP callback server + `findAvailablePort()`) for the OAuth redirect
- **[Re-authentication](./reauthentication.md)** — In-place token swap when the session expires; preserves all local data
- **Future: Cinna server features** — `getCinnaAccessToken()` provides the authenticated access token for any future API calls to the Cinna server
