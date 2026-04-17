# Cinna Accounts — Technical Details

## File Locations

### Main Process

| Layer | File | Purpose |
|-------|------|---------|
| Schema | `src/main/db/schema.ts` | 6 Cinna columns on `users` table |
| Migration | `src/main/db/migrations/users.ts` | ALTER TABLE for Cinna columns with `hasColumn` guards |
| OAuth | `src/main/auth/cinna-oauth.ts` | Discovery, PKCE flow, token exchange, refresh, abort |
| Tokens | `src/main/auth/cinna-tokens.ts` | Encrypted token storage, auto-refresh, rotation handling |
| IPC | `src/main/ipc/auth.ipc.ts` | Modified `auth:register`, new `auth:cinna-oauth-abort`, updated `UserInfo` |
| Keystore | `src/main/security/keystore.ts` | `encryptApiKey`/`decryptApiKey` — reused for Cinna tokens |
| Callback | `src/main/mcp/oauth-callback.ts` | Reused `findAvailablePort()` + `waitForOAuthCallback()` — extended with `params` map |

### Preload

| File | Purpose |
|------|---------|
| `src/preload/index.ts` | `UserData` extended with Cinna fields; `register()` accepts new params; `cinnaOAuthAbort()` added |

### Renderer

| Layer | File | Purpose |
|-------|------|---------|
| Store | `src/renderer/src/stores/auth.store.ts` | `AuthUser` extended with `cinnaHostingType`, `cinnaServerUrl`, `hasCinnaTokens` |
| Hook | `src/renderer/src/hooks/useAuth.ts` | `useRegister` updated params; `useCinnaOAuthAbort` added; `toAuthUser` helper |
| RegisterForm | `src/renderer/src/components/auth/RegisterForm.tsx` | Multi-step modal: type → hosting → form → waiting |
| UserMenu | `src/renderer/src/components/auth/UserMenu.tsx` | Cloud icon badge for Cinna users; RegisterForm rendered as centered modal |

## Database Schema

### Cinna columns on `users` table

| Column | Type | Purpose |
|--------|------|---------|
| `cinna_server_url` | TEXT | Server URL (e.g. `https://opencinna.io` or custom) |
| `cinna_hosting_type` | TEXT | `cloud` or `self_hosted`; NULL for local users |
| `cinna_client_id` | TEXT | Server-assigned OAuth client ID for this device |
| `cinna_access_token_enc` | BLOB | Encrypted access token via `safeStorage` |
| `cinna_refresh_token_enc` | BLOB | Encrypted refresh token via `safeStorage` |
| `cinna_token_expires_at` | INTEGER | Unix ms when access token expires |

All columns are nullable — NULL for `local_user` accounts. Migration uses `hasColumn` guards for safe upgrades.

## IPC Channels

| Channel | Signature | Purpose |
|---------|-----------|---------|
| `auth:register` | `({ username?, displayName?, password?, accountType, cinnaHostingType?, cinnaServerUrl? }) → { success, user?, error? }` | Create local or Cinna account; Cinna triggers OAuth flow (username/displayName come from OAuth for Cinna) |
| `auth:cinna-oauth-abort` | `() → { success }` | Abort an in-progress Cinna OAuth flow |

### Modified channels

| Channel | Change |
|---------|--------|
| `auth:list-users` | Returns `cinnaHostingType`, `cinnaServerUrl`, `hasCinnaTokens` for Cinna users |
| `auth:get-current` | Same — includes Cinna fields |
| `auth:get-startup` | Same — includes Cinna fields |
| `auth:login` | Same — includes Cinna fields in response |
| `auth:delete-user` | Now calls `clearCinnaTokens()` before cascade delete |

## Services & Key Methods

### `src/main/auth/cinna-oauth.ts`

- `CINNA_CLOUD_URL` — `'https://opencinna.io'`
- `discoverCinnaEndpoints(serverUrl)` — GET `{serverUrl}/.well-known/cinna-desktop`, returns `{ authorization_endpoint, token_endpoint, userinfo_endpoint }`, cached per server URL
- `startCinnaOAuthFlow(serverUrl)` — Full PKCE flow: discover → port → verifier/challenge → state → open browser → await callback → exchange code → fetch userinfo → return `{ clientId, accessToken, refreshToken, expiresIn, profile: { email, displayName } }`
- `abortCinnaOAuthFlow()` — Aborts active OAuth callback server
- `refreshCinnaTokens(serverUrl, clientId, refreshToken)` — POST to token endpoint with `grant_type=refresh_token`; throws `CinnaReauthRequired` on replay detection (`invalid_grant`, `token_reuse_detected`)
- `clearEndpointCache()` — Clears session-scoped discovery cache

### `src/main/auth/cinna-tokens.ts`

- `storeCinnaTokens(userId, { clientId, accessToken, refreshToken, expiresIn })` — Encrypts and writes to user row
- `getCinnaAccessToken(userId)` — Decrypts access token; auto-refreshes if within 60s of expiry; mutex prevents concurrent refresh; throws `CinnaReauthRequired` on failure
- `clearCinnaTokens(userId)` — Nulls all Cinna token/client columns
- `hasCinnaTokens(userId)` — Boolean check

### `src/main/ipc/auth.ipc.ts`

- `toUserInfo(userRow)` — Helper that builds `UserInfo` including Cinna fields for `cinna_user` type
- `auth:register` handler — Branches on `accountType`: local creates user directly; cinna creates user → runs OAuth → stores tokens on success, deletes user on failure

## Renderer Components

### `RegisterForm` in `src/renderer/src/components/auth/RegisterForm.tsx`

Multi-step form with state machine:

| Step | UI | Transitions |
|------|----|-------------|
| `type-select` | Two cards: Local / Cinna | Local → `local-form`; Cinna → `cinna-hosting` |
| `cinna-hosting` | Cloud / Self-Hosted radio + URL input + "Connect" | Connect → `cinna-waiting`; Back → `type-select` |
| `local-form` | Username, Display Name, Password (all optional except username) | Create → success; Back → `type-select` |
| `cinna-waiting` | Spinner + cancel button | Cancel → abort + `cinna-hosting`; Success → `onSuccess` |

For Cinna accounts, there is no form step — username and display name are received from the OAuth server's userinfo endpoint after authentication. Password can be set later.

Rendered as a centered modal overlay (fixed inset, `bg-black/50` backdrop) instead of inside the dropdown.

### `UserMenu` in `src/renderer/src/components/auth/UserMenu.tsx`

- "Add Account" closes dropdown, opens RegisterForm modal
- Cloud icon (`lucide-react:Cloud`) shown next to `cinna_user` entries in the profile list

## Security

- **PKCE**: code verifier (32 random bytes, base64url) + SHA-256 challenge — prevents authorization code interception
- **State parameter**: 16 random bytes hex — prevents CSRF
- **Localhost-only redirect**: callback server binds to `127.0.0.1` on a random available port
- **Token encryption**: access and refresh tokens encrypted via `safeStorage` (OS keychain) before SQLite storage
- **Token rotation**: server issues new refresh token on each refresh; old token invalidated; replay detection triggers full re-auth and local token wipe
- **Refresh mutex**: concurrent refresh attempts deduplicated via promise — prevents race conditions that could trigger false replay detection
- **No secrets on disk**: `client_id` is public (per OAuth spec for native apps); no client secret stored
- **Cleanup on failure**: if OAuth fails mid-flow, the partially-created user row is deleted — no orphaned records
