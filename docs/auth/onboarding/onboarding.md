# Onboarding

## Purpose

Greet a fresh install with a single guided choice — **API key** (bring-your-own-key) or **Cinna Server** (connect to a remote instance) — so the user reaches a working chat in one screen instead of hunting through Settings.

Two later steps join the same screen without changing that shape: a `cinna://connect` deep link opens it on a **confirm** step instead of the welcome card, and a connected Cinna account is followed by a **local development** step — which the confirm step's own opt-in checkbox usually answers ahead of time. Both are covered below and in their own docs — [The `cinna://connect` Link](connect_link.md) and [Local Development](../../agents/local_dev/local_dev.md).

## Core Concepts

| Term | Definition |
|------|-----------|
| **Onboarding Gate** | Renderer-side wrapper inside `AuthGate` that shows the onboarding screen while the active user has zero LLM providers and the dismissed flag is unset |
| **First-Run Session** | The gate's answer to "is this a first run", decided **once** from the force flag, the dismissed flag and the provider count, then held until the screen's own `onComplete` ends it. Not a value re-derived each render — see *First run is a session* |
| **Dismissed Flag** | `localStorage` key (`cinna-onboarding-completed`) set once any onboarding path finishes — success or skip. Prevents re-prompting on later launches. Module-private; accessed via `isOnboardingDismissed()` / `markOnboardingDismissed()` |
| **Force Flag** | `localStorage` key (`cinna-onboarding-force-next-launch`) — armed via the Development settings toggle; consumed on next app launch to re-show onboarding regardless of provider count or dismissed flag (QA/testing) |
| **API Key Path** | User picks a provider type, validates the key via `provider:test-key`, then the app creates the provider plus a default chat mode bound to it. Card label in the UI: "API key" |
| **Cinna Server Path** | Reuses the self-hosted OAuth flow from `RegisterForm` (URL input + history + bootstrap/authorize) — no LLM provider is created |
| **Self-Hosted History** | Shared URL history between onboarding and the in-app "Add Account" flow. Single source of truth in `constants/selfHostedHistory.ts` |
| **Confirm Step** (`cinna-confirm`) | The step a `cinna://connect` link opens the screen on. **Never reached by navigating — only by arriving.** Renders `ConnectIntentPanel`, the same component the past-first-run modal uses. Also carries the local-development opt-in, so that decision is a checkbox beside **Connect** rather than a step after it |
| **Local Dev Step** (`localdev`) | The last step of the Cinna path. Renders `LocalDevOnboardingStep`, which asks the per-host consent question — or gets out of the way when there is nothing to ask, including when the confirm step has already answered it |

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
6. **Not straight into the app**: the screen advances to the `localdev` step. The account is connected, and the one question left is whether to prepare this machine for building agents on it
7. Dismissed flag is set; onboarding screen unmounts; user lands in the app as the Cinna user

### Deep-Link Path (`cinna://connect`)
1. A landing page fires `cinna://connect?server=<origin>`; the main process validates and buffers it (see [The `cinna://connect` Link](connect_link.md))
2. `OnboardingGate` passes the intent down, and the screen **opens on `cinna-confirm`** rather than the welcome card — the user clicked a button that named a server, so asking them to choose between "API key" and "Cinna Server" first would be asking a question they have already answered
3. **Connect** runs the same self-hosted OAuth as the typed-URL path, against the link's origin. **Switch to it** appears instead when a profile for that exact origin already exists on this machine
4. The panel also carries **Enable local development** with a (?) explaining what that installs — ticked unless this machine already holds an answer for that host, so **Switch to it** cannot reverse a deliberate decline. The answer, either way, is recorded for that host as soon as the account exists
5. Either outcome advances to `localdev` — connecting (or switching into) a Cinna account *is* a finished first run, because the account's managed credentials and chat modes are what the rest of onboarding would otherwise be asking for. The step has nothing left to ask on this route, so it shows the install running or falls through
6. **Not now** falls back to the `welcome` step rather than closing the screen: a decline leaves the user needing the ordinary choices
7. A *new* link arriving while the user is already on the screen redirects them back to `cinna-confirm`. It is matched on `receivedAt`, so a declined intent cannot bounce them straight back in

### Local Development Step
1. Reached only from a connected Cinna account — from either the `cinna-waiting` path or `cinna-confirm`
2. It renders only when there is genuinely something to say. `unsupported` (this server does not offer local development, or this account lacks the role) and `declined` both mean *nothing to ask* and fall straight through to the app — as does a `consent` for a host the confirm step's checkbox has already answered, while main is still turning that answer into an install
3. On `consent` it shows what will be installed and where: the toolchain inside Cinna's own data folder, the account workspace under the Agents Home, and "Nothing is synced and no agent is downloaded"
4. **Set up** turns the same panel into the progress view. **Continue in the background** is always available — the reconciler runs in the main process and keeps going, and the sidebar picks the progress up
5. **Skip** records a remembered "no" for that host, so the question does not return every launch. Settings → Local Development can undo it
6. If the reconciler has not answered within **8 seconds** the step gives up and lets the user into the app. Local development is a courtesy, not a requirement, and a server that never answers must not leave a new user staring at a spinner on their first run

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

- **First run is a session, not a derived boolean.** The gate takes the decision once and holds it; only the screen's own `onComplete` ends it. Re-deriving it each render was wrong on exactly the path that matters most: signing in calls `queryClient.resetQueries()`, so the providers query returns to loading, the gate renders its blank div and the onboarding screen **unmounts**. A Cinna account's managed providers arrive asynchronously, so a moment later it mounts again — freshly, with the deep link already consumed — and lands back on the welcome card. The user, who had just finished authorizing in their browser, got half a second of "API key or Cinna Server?", and the local-development step that should have been on screen was lost with the unmount
- **Every terminal step must call `onComplete`.** That is the contract the session created: the gate no longer ends first run on its own — it used to end the moment a provider appeared — so a terminal step that does not report finishing strands the user on this screen. Every existing exit satisfies it, checked rather than assumed: Save & start, Skip for now, each branch of the local-dev panel, and `idle` / `unsupported` / `declined` / already-answered through the grace timer
- The gate is **purely renderer-side** for the two original paths: it composes the existing `provider:list`, `provider:test-key`, `provider:upsert`, `chatmode:upsert`, and `auth:register` IPCs. The two later steps do read main-process state — `connect:get-pending` for the link and `localdev:get-state` for the local-dev step — but neither adds a decision to the gate itself.
- **Two questions are never asked at once.** `ConnectIntentModal` and `LocalDevConsentModal` are both mounted *inside* `OnboardingGate`, so they render only once first run is over — which is exactly when a modal, rather than an onboarding step, is the right surface for each question. Outside the gate, each modal and its corresponding step would show the same question simultaneously.
- The `cinna-confirm` step is unreachable by navigation. There is no button anywhere that leads to it; it exists only for an intent that arrived.
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
          ├─ useConnectIntent()    ──► connect:get-pending / 'connect:intent'
          │
          ├─ session ← forced || !(dismissed || providers.length > 0)   decided ONCE
          │            (blank div only while it is still undecided)
          │
          ├─ if (finished || !session) → <Shell /> + <ConnectIntentModal />
          │                                        + <LocalDevConsentModal />
          └─ else → <OnboardingScreen onComplete=… connectIntent=… >
                     ├─ cinna-confirm   ──  ConnectIntentPanel   (only if an intent arrived)
                     │   useRegister    →  auth:register {accountType:'cinna'}
                     │   useLogin       →  auth:login            ("Switch to it")
                     ├─ welcome
                     ├─ provider-type   ┐
                     ├─ provider-key    │  API key path
                     │   useTestProviderKey →  provider:test-key
                     │   useUpsertProvider  →  provider:upsert
                     │   useUpsertChatMode  →  chatmode:upsert  (isDefault, non-blocking)
                     ├─ cinna-hosting   ┐
                     ├─ cinna-waiting   │  Cinna Server path
                     │   useRegister    →  auth:register {accountType:'cinna'}
                     │                      (switches activated user)
                     └─ localdev        ──  LocalDevOnboardingStep
                         useLocalDev    →  localdev:get-state / 'localdev:state'
                         consent        →  localdev:consent
```

Step reachability, since the union is no longer a single line:

```
(intent) ──► cinna-confirm ──┬─ connected / switched ─┐
                             └─ declined ─► welcome   │
welcome ──┬─ provider-type ─► provider-key ─► (app)   │
          └─ cinna-hosting ─► cinna-waiting ──────────┤
                                                      ▼
                                                  localdev ──► (app)
```

## Integration Points

- [User Accounts](../user_accounts/user_accounts.md) — onboarding starts as the default user; the Cinna Server path switches to a new Cinna user via the standard `auth:register` flow
- [Cinna Accounts](../cinna_accounts/cinna_accounts.md) — Cinna Server path is the same OAuth flow used by "Add Account" in the title bar menu; shares the same self-hosted URL history
- [LLM Adapters](../../llm/adapters/adapters.md) — API key path calls `provider:test-key` (validates by `listModels()`) before saving, then `provider:upsert` to persist
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — API key path creates a default chat mode that the new-chat screen auto-applies
- [App Shell](../../ui/app_shell/app_shell.md) — `OnboardingGate` sits inside `AuthGate` and short-circuits `Shell` rendering when active
- [The `cinna://connect` Link](connect_link.md) — supplies the `cinna-confirm` step's intent, and owns everything about how the link reaches the app
- [Local Development](../../agents/local_dev/local_dev.md) — owns the `localdev` step's state machine; onboarding only renders it
- [Settings](../../ui/settings/settings.md) — the Development section hosts the "Enable onboarding on restart" toggle
