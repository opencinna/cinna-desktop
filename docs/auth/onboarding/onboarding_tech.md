# Onboarding — Technical Reference

Implementation companion to [onboarding.md](onboarding.md). All onboarding logic is renderer-only — no new main-process IPC handlers exist for this feature.

## File Locations

### Renderer — components
- `src/renderer/src/App.tsx` — `OnboardingGate` wrapper, mounted inside `AuthGate` and outside `Shell`
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — full-screen overlay with welcome / provider-type / provider-key / cinna-hosting / cinna-waiting steps
- `src/renderer/src/components/settings/DevelopmentSettingsSection.tsx` — Settings → Development → Testing toggle ("Enable onboarding on restart")

### Renderer — constants
- `src/renderer/src/constants/onboarding.ts` — localStorage key constants (module-private) plus `consumeForceOnboarding()`, `isForceOnboardingArmed()`, `setForceOnboarding()`, `isOnboardingDismissed()`, `markOnboardingDismissed()`
- `src/renderer/src/constants/selfHostedHistory.ts` — self-hosted URL history shared with `RegisterForm`: `readSelfHostedHistory()`, `writeSelfHostedHistory()`, `prependSelfHostedHistory()`, `SELFHOSTED_HISTORY_KEY`, `SELFHOSTED_HISTORY_LIMIT`

### Renderer — hooks (consumed, not added)
- `src/renderer/src/hooks/useProviders.ts` — `useProviders()`, `useUpsertProvider()`, `useTestProviderKey()`
- `src/renderer/src/hooks/useChatModes.ts` — `useUpsertChatMode()`
- `src/renderer/src/hooks/useAuth.ts` — `useRegister()`, `useCinnaOAuthAbort()`

### Main process (no new files)
The onboarding feature does not add any main-process files. It depends on the existing handlers:
- `src/main/ipc/provider.ipc.ts` — `provider:list`, `provider:test-key`, `provider:upsert`
- `src/main/ipc/chat.ipc.ts` — `chatmode:upsert`
- `src/main/ipc/auth.ipc.ts` — `auth:register`, `auth:cinna-oauth-abort`

## Database Schema

No schema changes. The feature only writes to existing tables via existing services:
- `llm_providers` — via `provider:upsert`
- `chat_modes` — via `chatmode:upsert` (relies on the single-default invariant enforced in `src/main/db/chatModes.ts`)
- `users`, `cinna_tokens` — via `auth:register` for the Cinna Server path

## IPC Channels (consumed)

| Channel | Purpose in onboarding |
|---------|----------------------|
| `provider:list` | Gate detection — `OnboardingGate` short-circuits when the list is non-empty |
| `provider:test-key` | Validate the user's API key by calling `adapter.listModels()` before persisting |
| `provider:upsert` | Persist the new LLM provider with encrypted API key |
| `chatmode:upsert` | Create the default chat mode bound to the new provider |
| `auth:register` | Cinna Server path — `accountType: 'cinna'`, triggers OAuth flow |
| `auth:cinna-oauth-abort` | Cancel button in the `cinna-waiting` step |

No new IPC channels are introduced.

## Services & Key Methods

The renderer-only feature delegates all server-side work through existing services:
- `src/main/services/providerService.ts` — `testKey()`, `upsert()`
- `src/main/services/authService.ts` — `registerCinna()`
- `src/main/db/chatModes.ts` — `upsert()` (via `chatmode:upsert` handler)

## Renderer Components

- `src/renderer/src/components/auth/OnboardingScreen.tsx` — state machine over `Step` union (`welcome | provider-type | provider-key | cinna-hosting | cinna-waiting`); owns `selectedProvider`, `apiKey`, `selectedModelId`, `cinnaHostingType`, `cinnaServerUrl`, `selfHostedHistory`; renders all step contents inline via `renderStep()`
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — `handleSaveAndFinish()` orchestrates the API-key save: blocking `upsertProvider`, then non-blocking `upsertChatMode`, then `onComplete()`
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — `connectSelfHosted()` mirrors `RegisterForm.tsx:connectSelfHosted()`; on success it calls `prependSelfHostedHistory()` and persists via `writeSelfHostedHistory()`
- `src/renderer/src/App.tsx` — `OnboardingGate` uses `useProviders()` + `useState` initializers seeded from `consumeForceOnboarding()` and `isOnboardingDismissed()`
- `src/renderer/src/components/settings/DevelopmentSettingsSection.tsx` — "Testing" subsection with a `role="switch"` toggle matching the styling used by `LLMProviderCard` and `AgentCard` (w-9 h-5 rounded pill, accent-colored when on)

## State & Persistence

| Storage | Key | Purpose | Accessed via |
|---------|-----|---------|--------------|
| `localStorage` | `cinna-onboarding-completed` | Dismissed flag (install-global) | `isOnboardingDismissed()` / `markOnboardingDismissed()` |
| `localStorage` | `cinna-onboarding-force-next-launch` | Force flag for re-triggering on next launch | `setForceOnboarding()` / `consumeForceOnboarding()` / `isForceOnboardingArmed()` |
| `localStorage` | `cinna-selfhosted-history` | Recent self-hosted Cinna server URLs (shared) | `readSelfHostedHistory()` / `writeSelfHostedHistory()` / `prependSelfHostedHistory()` |
| Module memo | `_forceConsumed` in `constants/onboarding.ts` | StrictMode-safe consume of the force flag | internal to `consumeForceOnboarding()` |

## Configuration

- Provider-themed colors mapped per type in `PROVIDER_OPTIONS` (`OnboardingScreen.tsx`): anthropic→amber, openai→emerald, gemini→sky. Reuses the existing `COLOR_PRESETS` ids from `src/renderer/src/constants/chatModeColors.ts`.
- Help link URLs (`pricingUrl`, `apiKeyUrl`) per provider option. Optional fields — leave undefined to hide.

## Security

- API key never persisted in renderer state beyond the input flow; passed to `provider:upsert` once and the local React state is dropped on unmount.
- `provider:upsert` encrypts the key via `src/main/security/keystore.ts` (`encryptApiKey()`) before persisting to SQLite.
- Cinna OAuth tokens follow the existing `safeStorage` path — see [Cinna Accounts](../cinna_accounts/cinna_accounts.md).
- External help links open via `target="_blank"` and Electron's `setWindowOpenHandler` (`src/main/index.ts`) routes them to `shell.openExternal()` so they open in the system browser, not the Electron window.
- localStorage flags hold no credentials — only booleans and URL strings.
