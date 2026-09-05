# Onboarding — Technical Reference

Implementation companion to [onboarding.md](onboarding.md). The onboarding logic itself is renderer-only — it adds no main-process IPC handlers. Two of its steps *read* main-process state owned by other features: `cinna-confirm` reads the buffered deep link (see [connect_link_tech.md](connect_link_tech.md)) and `localdev` reads the local-development reconciler's state (see [local_dev_tech.md](../../agents/local_dev/local_dev_tech.md)).

## File Locations

### Renderer — components
- `src/renderer/src/App.tsx` — `OnboardingGate` wrapper, mounted inside `AuthGate` and outside `Shell`
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — full-screen overlay with cinna-confirm / welcome / provider-type / provider-key / cinna-hosting / cinna-waiting / localdev steps
- `src/renderer/src/components/auth/ConnectIntentPanel.tsx` — rendered by the `cinna-confirm` step (and by `ConnectIntentModal` past first run)
- `src/renderer/src/components/localdev/LocalDevOnboardingStep.tsx` — rendered by the `localdev` step; wraps `LocalDevConsentPanel`
- `src/renderer/src/components/settings/DevelopmentSettingsSection.tsx` — Settings → Development → Testing toggle ("Enable onboarding on restart")

### Renderer — constants
- `src/renderer/src/constants/onboarding.ts` — localStorage key constants (module-private) plus `consumeForceOnboarding()`, `isForceOnboardingArmed()`, `setForceOnboarding()`, `isOnboardingDismissed()`, `markOnboardingDismissed()`
- `src/renderer/src/constants/selfHostedHistory.ts` — self-hosted URL history shared with `RegisterForm`: `readSelfHostedHistory()`, `writeSelfHostedHistory()`, `prependSelfHostedHistory()`, `SELFHOSTED_HISTORY_KEY`, `SELFHOSTED_HISTORY_LIMIT`

### Renderer — hooks (consumed, not added)
- `src/renderer/src/hooks/useProviders.ts` — `useProviders()`, `useUpsertProvider()`, `useTestProviderKey()`
- `src/renderer/src/hooks/useChatModes.ts` — `useUpsertChatMode()`
- `src/renderer/src/hooks/useAuth.ts` — `useRegister()`, `useLogin()`, `useCinnaOAuthAbort()`
- `src/renderer/src/hooks/useConnectIntent.ts` — `useConnectIntent()`, called by `OnboardingGate` so the gate (not the modal) decides which surface confirms a link
- `src/renderer/src/hooks/useLocalDev.ts` — `useLocalDev()`, read by the `localdev` step

### Main process (no new files)
The onboarding feature does not add any main-process files. It depends on the existing handlers:
- `src/main/ipc/provider.ipc.ts` — `provider:list`, `provider:test-key`, `provider:upsert`
- `src/main/ipc/chat.ipc.ts` — `chatmode:upsert`
- `src/main/ipc/auth.ipc.ts` — `auth:register`, `auth:login`, `auth:cinna-oauth-abort`
- `src/main/ipc/connect.ipc.ts` — `connect:get-pending`, `connect:consume` (the deep-link feature's; see [connect_link_tech.md](connect_link_tech.md))
- `src/main/ipc/localdev.ipc.ts` — `localdev:get-state`, `localdev:consent` (the local-development feature's; see [local_dev_tech.md](../../agents/local_dev/local_dev_tech.md))

## Database Schema

No schema changes. The feature only writes to existing tables via existing services:
- `llm_providers` — via `provider:upsert`
- `chat_modes` — via `chatmode:upsert` (relies on the single-default invariant enforced in `src/main/db/chatModes.ts`)
- `users`, `cinna_tokens` — via `auth:register` for the Cinna Server path

## IPC Channels (consumed)

| Channel | Purpose in onboarding |
|---------|----------------------|
| `provider:list` | Gate detection — read **once**, to decide the first-run session; a later refetch (sign-in calls `resetQueries()`) never re-opens or closes the gate |
| `provider:test-key` | Validate the user's API key by calling `adapter.listModels()` before persisting |
| `provider:upsert` | Persist the new LLM provider with encrypted API key |
| `chatmode:upsert` | Create the default chat mode bound to the new provider |
| `auth:register` | Cinna Server path — `accountType: 'cinna'`, triggers OAuth flow |
| `auth:cinna-oauth-abort` | Cancel button in the `cinna-waiting` step, and in `ConnectIntentPanel`'s waiting view |
| `auth:login` | `cinna-confirm`'s **Switch to it**, when a profile for the link's origin already exists |
| `connect:get-pending` / `connect:consume` / `connect:intent` | The buffered deep link that opens the screen on `cinna-confirm` |
| `localdev:get-state` / `localdev:consent` / `localdev:state` | The `localdev` step's state and the consent answer |
| `local-agent:roots-list` | The `localdev` step reads the Agents Home purely to name the folder in the consent copy |

Onboarding introduces no IPC channels of its own; the last three rows belong to the deep-link, local-development and local-agents features.

## Services & Key Methods

The renderer-only feature delegates all server-side work through existing services:
- `src/main/services/providerService.ts` — `testKey()`, `upsert()`
- `src/main/services/authService.ts` — `registerCinna()`
- `src/main/db/chatModes.ts` — `upsert()` (via `chatmode:upsert` handler)

## Renderer Components

- `src/renderer/src/components/auth/OnboardingScreen.tsx` — state machine over the `Step` union (`welcome | provider-type | provider-key | cinna-hosting | cinna-waiting | cinna-confirm | localdev`); owns `selectedProvider`, `apiKey`, `selectedModelId`, `cinnaHostingType`, `cinnaServerUrl`, `selfHostedHistory`; renders all step contents inline via `renderStep()`. The initial step is `connectIntent ? 'cinna-confirm' : 'welcome'`, and a `lastIntentAt` ref re-enters `cinna-confirm` only for an intent with a **new** `receivedAt` — so the intent the step just consumed cannot bounce a user who declined straight back into it
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — the `cinna-confirm` step's `onDone(outcome)`: `declined` → `welcome`, `connected` / `switched` → `localdev`. `onConnectIntentDone?.()` fires first, in every case
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — `connectSelfHosted()` ends on `setStep('localdev')` rather than `onComplete()`; only the `localdev` step calls `onComplete`
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — `handleSaveAndFinish()` orchestrates the API-key save: blocking `upsertProvider`, then non-blocking `upsertChatMode`, then `onComplete()`
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — `connectSelfHosted()` mirrors `RegisterForm.tsx:connectSelfHosted()`; on success it calls `prependSelfHostedHistory()` and persists via `writeSelfHostedHistory()`
- `src/renderer/src/App.tsx` — `OnboardingGate` uses `useProviders()` + `useState` initializers seeded from `consumeForceOnboarding()` and `isOnboardingDismissed()`, plus `useConnectIntent()` for the `connectIntent` / `onConnectIntentDone` props. The first-run answer is latched in a `useRef<boolean | null>` **assigned during render**, not in an effect — an effect runs a frame late and that frame is a flash of the wrong screen — and the blank div is shown only while it is still `null`. `onComplete` sets a `finished` state (a state, not the ref: ending first run has to re-render) instead of writing back to `dismissed`/`forced`, so a `resetQueries()` on sign-in cannot unmount the screen mid-flow
- `src/renderer/src/components/auth/OnboardingScreen.tsx` — the `Step` union carries the matching invariant: **every terminal step must call `onComplete`**. It is the contract the session change created, and the one thing a future step-adder has to know — nothing above the screen will end first run for them
- `src/renderer/src/App.tsx` — `<ConnectIntentModal />` and `<LocalDevConsentModal />` are mounted **inside** `OnboardingGate`, i.e. among the children it renders only once first run is over. During first run each question is a step of the screen instead, and two surfaces asking it at once would be two answers racing to be recorded
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
