# Onboarding

## Purpose

Greet a fresh install with a single guided choice — **API key** (bring-your-own-key) or **Cinna Server** (connect to a remote instance) — so the user reaches a working chat in one screen instead of hunting through Settings.

## Core Concepts

| Term | Definition |
|------|-----------|
| **Onboarding Gate** | Renderer-side wrapper inside `AuthGate` that shows the onboarding screen while the active user has zero LLM providers and the dismissed flag is unset |
| **Dismissed Flag** | `localStorage` key (`cinna-onboarding-completed`) set once any onboarding path finishes — success or skip. Prevents re-prompting on later launches. Module-private; accessed via `isOnboardingDismissed()` / `markOnboardingDismissed()` |
| **Force Flag** | `localStorage` key (`cinna-onboarding-force-next-launch`) — armed via the Development settings toggle; consumed on next app launch to re-show onboarding regardless of provider count or dismissed flag (QA/testing) |
| **API Key Path** | User picks a provider type, validates the key via `provider:test-key`, then the app creates the provider plus a default chat mode bound to it. Card label in the UI: "API key" |
| **Cinna Server Path** | Reuses the self-hosted OAuth flow from `RegisterForm` (URL input + history + bootstrap/authorize) — no LLM provider is created |
| **Self-Hosted History** | Shared URL history between onboarding and the in-app "Add Account" flow. Single source of truth in `constants/selfHostedHistory.ts` |

## User Stories / Flows

### First Launch (zero providers, never onboarded)
1. App boots as the default user; `AuthGate` finishes activation
2. `OnboardingGate` sees `providers.length === 0` and no dismissed flag — renders the onboarding screen
3. User sees the welcome card: title "Welcome to Cinna", subtitle "Pick how you want to start chatting / You can always configure that later", two large buttons ("API key" / "Cinna Server"), and a "Skip for now" link

### API Key Path
1. User clicks "API key"
2. Picks a provider type (Anthropic / OpenAI / Google Gemini) from a list
3. Provider-key step opens with the provider's name as the title, plus two muted help links: "Where to create an API key?" and "See current model prices at …" — each pointing at the provider's documented URL
4. User pastes an API key. Clicking **Test** calls `provider:test-key`:
   - On success: green check + model count + a "Default model" dropdown (defaults to first available, uses real model names returned by the SDK)
   - On failure: red error message inline; **Save & start** stays disabled until a successful test
5. Editing the API key clears any stale test result so a previous ✓ can't slip through
6. User clicks **Save & start**:
   - App creates the provider (enabled, with chosen default model) — blocking step
   - App creates a chat mode named "Default" bound to that provider, marked `isDefault: true`, with a provider-themed color preset (Anthropic→amber, OpenAI→emerald, Gemini→sky) — non-blocking step
7. Dismissed flag is set; onboarding screen unmounts; the new-chat screen renders with the default mode pre-applied (existing mode auto-apply behavior — see [Chat Modes](../../chat/chat_modes/chat_modes.md))

### Cinna Server Path
1. User clicks "Cinna Server"
2. Hosting picker: Self-Hosted is pre-selected (Cloud shows the "Under Development" notice and disables Connect — same gate as [Cinna Accounts](../cinna_accounts/cinna_accounts.md))
3. User enters a URL or clicks a "Recent servers" entry (history shared with `RegisterForm` via the same `selfHostedHistory` module)
4. Connect → "Waiting for browser authorization…" spinner with a single Cancel button (calls `auth:cinna-oauth-abort`)
5. Browser-based bootstrap + authorize completes; the new Cinna user is created and activated (existing flow)
6. Dismissed flag is set; onboarding screen unmounts; user lands in the app as the Cinna user

### Skip
1. User clicks "Skip for now" on the welcome card
2. Dismissed flag is set; onboarding screen unmounts; user lands on the empty new-chat screen
3. They can configure providers later in Settings → LLM Providers; the empty new-chat send raises the existing "can't determine destination" banner until they do

### Invalid API Key
1. `provider:test-key` returns `{ success: false, error }` — error shown inline. For Gemini, the REST listing error is routed through `parseError()` so the user sees the same friendly copy as the chat-stream path ("Invalid API key" / "Rate limit exceeded — retry in Xs" / etc.)
2. **Save & start** stays disabled; user can edit the key and re-test
3. The provider row is never created on an invalid key (no rollback needed)

### Partial Save Failure
1. Provider creation succeeds but chat-mode creation fails (e.g., transient IPC error)
2. The user is **not** stranded on the onboarding screen — `onComplete()` still fires, the dismissed flag is set, and the user lands in the app with the provider configured
3. They can create or pick a chat mode from Settings; the failure is logged via `console.warn`

### Returning User
1. Once the dismissed flag is present, onboarding never shows again — even if the user deletes all providers later
2. If the user wants to see it again they can flip the **Enable onboarding on restart** toggle in Settings → Development → Testing (see below), or clear the localStorage key from devtools

### Re-triggering Onboarding for Testing
1. User goes to Settings → Development → Testing
2. Flips the **Enable onboarding on restart** toggle — sets the force flag in localStorage
3. User restarts the app
4. On startup, `OnboardingGate` consumes the force flag: removes both the force key and the completed key, then renders the onboarding screen regardless of how many providers exist
5. Completing or skipping sets the completed flag again — next launch is normal
6. The force flag is "one-time" — it is consumed exactly once on the first render of `OnboardingGate` per app launch (memoized in the constants module so React StrictMode's double-invocation of `useState` initializers doesn't double-clear)

## Business Rules

- The gate is **purely renderer-side**: it composes the existing `provider:list`, `provider:test-key`, `provider:upsert`, `chatmode:upsert`, and `auth:register` IPCs. No new main-process surface.
- Detection uses **provider count, not user type** — Cinna users start with zero providers too (providers are default-scoped, see [Settings Scope](../../core/settings_scope/settings_scope.md)), so a freshly created Cinna user would re-trigger the gate. The dismissed flag prevents that re-prompt because it's set when the Cinna path completes.
- A successful API-key path **attempts** to create a default chat mode but doesn't block on it. The provider is the load-bearing step; the chat mode is convenience and a failure is non-fatal.
- The chat mode's `colorPreset` is chosen per provider type for visual distinction; the name is hard-coded as "Default" and the MCP list is empty.
- The API key must pass `provider:test-key` before **Save & start** enables — no "save anyway" escape hatch. Editing the key clears the previous test result.
- Model names in the "Default model" dropdown are the **canonical names** returned by each provider's SDK (Anthropic `display_name`, Gemini `displayName`, OpenAI humanized from the id). No version-stripping transforms are applied to real model data; only static marketing copy on the provider-pick cards uses version-less labels.
- The Cinna-server step's URL history is shared with `RegisterForm` via the same constants module so onboarding and the in-app "Add Account" flow stay in sync.
- The dismissed flag is **global** to the install, not per-user — once any user dismisses, the screen never reappears for any user.
- Skipping is non-destructive: no provider, no chat mode, no user changes — the user is still the default guest.
- All external help links (key creation, pricing) open in the system browser via Electron's `setWindowOpenHandler` — none open inside the app window.

## Architecture Overview

```
AuthGate (App.tsx)
  └─ user activated
      └─ OnboardingGate
          ├─ useProviders()        ──► provider:list (default scope)
          ├─ consumeForceOnboarding() / isOnboardingDismissed()
          │
          ├─ if (dismissed || providers.length > 0) → <Shell />
          └─ else → <OnboardingScreen onComplete=…>
                     ├─ welcome
                     ├─ provider-type   ┐
                     ├─ provider-key    │  API key path
                     │   useTestProviderKey →  provider:test-key
                     │   useUpsertProvider  →  provider:upsert
                     │   useUpsertChatMode  →  chatmode:upsert  (isDefault, non-blocking)
                     ├─ cinna-hosting   ┐
                     └─ cinna-waiting   │  Cinna Server path
                         useRegister    →  auth:register {accountType:'cinna'}
                                            (switches activated user)
```

## Integration Points

- [User Accounts](../user_accounts/user_accounts.md) — onboarding starts as the default user; the Cinna Server path switches to a new Cinna user via the standard `auth:register` flow
- [Cinna Accounts](../cinna_accounts/cinna_accounts.md) — Cinna Server path is the same OAuth flow used by "Add Account" in the title bar menu; shares the same self-hosted URL history
- [LLM Adapters](../../llm/adapters/adapters.md) — API key path calls `provider:test-key` (validates by `listModels()`) before saving, then `provider:upsert` to persist
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — API key path creates a default chat mode that the new-chat screen auto-applies
- [App Shell](../../ui/app_shell/app_shell.md) — `OnboardingGate` sits inside `AuthGate` and short-circuits `Shell` rendering when active
- [Settings](../../ui/settings/settings.md) — the Development section hosts the "Enable onboarding on restart" toggle
