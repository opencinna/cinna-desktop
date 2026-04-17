# Cinna Accounts

## Purpose

Cinna Accounts let users connect the desktop app to a remote Cinna server (cloud or self-hosted) via OAuth. This enables future access to hosted Cinna features (agents, shared resources) while keeping local data isolation and optional local password protection.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Cinna Account** | A user account (`type: cinna_user`) linked to a remote Cinna server via OAuth tokens |
| **Hosting Type** | Either `cloud` (hardcoded to `opencinna.io`) or `self_hosted` (user-provided URL) |
| **Instance Discovery** | The desktop app fetches `/.well-known/cinna-desktop` from the server to discover OAuth endpoints (RFC 8414-style metadata) |
| **Bootstrap Flow** | Combined browser-based flow: the server handles login + client registration + authorization in a single redirect, returning both `client_id` and `code` to the desktop callback |
| **Client ID** | Server-assigned identifier for this desktop device, received during the bootstrap flow and stored locally |
| **Token Rotation** | On each refresh, the server issues a new refresh token and invalidates the old one; replay of an old token triggers re-auth |
| **Local Password** | Optional password that locks the local session — independent of Cinna server authentication |

## User Stories / Flows

### Create Cinna Account (Cloud)
1. User opens user menu, clicks "Add Account"
2. Centered modal appears with two options: "Local Account" and "Cinna Account"
3. User selects "Cinna Account"
4. Hosting selection step: "Cloud (opencinna.io)" is pre-selected; user clicks "Connect"
5. Modal shows "Waiting for browser authorization..." spinner
6. Browser opens to the Cinna cloud server's combined bootstrap/authorize endpoint
7. User logs in on the web and authorizes the desktop app
8. Server redirects to `http://127.0.0.1:{port}/oauth/callback` with `code`, `state`, and `client_id`
9. Desktop exchanges code for access + refresh tokens (PKCE-protected)
10. Desktop fetches user profile (email, display name) from the server's userinfo endpoint
11. Account is created automatically using the OAuth email as username and the server-provided display name
12. Tokens are encrypted and stored; user is activated; modal closes
13. App is now connected to the Cinna server (user can set a local password later)

### Create Cinna Account (Self-Hosted)
1. Steps 1-3 same as cloud
2. Hosting selection step: user selects "Self-Hosted", enters their server URL (e.g. `https://cinna.mycompany.com`), clicks "Connect"
3. Steps 5-13 same as cloud, but against the self-hosted server

### OAuth Failure / Cancel
1. If user cancels during the "Waiting for authorization..." step, the OAuth flow is aborted
2. If OAuth fails (timeout, server error, state mismatch), the partially-created user row is deleted
3. User sees the error message and can retry from the form step

### App Restart with Cinna Account
1. Same as local account restart — if the Cinna user has a local password, login screen shown
2. After unlock, stored tokens are used for any future server communication
3. If tokens are expired, auto-refresh happens transparently using the stored refresh token

### Token Refresh
1. When accessing the server, if the access token is within 60 seconds of expiry, auto-refresh fires
2. Server returns new access + refresh tokens (rotation); both are stored
3. If the server detects replay (old refresh token reused), all tokens are cleared and the user must re-authenticate via OAuth

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
- If token refresh fails with replay detection, all tokens are wiped and the user is forced to re-authenticate

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

## Integration Points

- **[User Accounts](../user_accounts/user_accounts.md)** — Cinna accounts are a user type; same login/switch/delete flows, same data isolation
- **[Resource Activation](../../core/resource_activation/resource_activation.md)** — Cinna users go through the same activation gate; providers load on activate
- **[MCP Connections](../../mcp/connections/connections.md)** — Reuses `oauth-callback.ts` (local HTTP callback server + `findAvailablePort()`) for the OAuth redirect
- **Future: Cinna server features** — `getCinnaAccessToken()` provides the authenticated access token for any future API calls to the Cinna server
