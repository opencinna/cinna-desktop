# Switching an AI Credential Off

## Purpose

An AI credential's on/off switch is a statement about **spending**, not about cataloguing. Switching one off stops everything that would have spent it — chats, chat modes, and the folder agents running on the local engine — and every surface that named that credential says what stopped and how to undo it.

## Core Concepts

- **`enabled`** — the user's own switch on a credential row (`llm_providers.enabled`), flipped from the credential's card in Settings → AI Credentials. Not a fact about the credential's health
- **Usable** (`isCredentialUsable`) — a structural fact about the row: it is not flagged `unsupported`, and it either holds a key or is of a [keyless type](../local_models/local_models.md) that needs none. Says nothing about `enabled`
- **Active** (`isCredentialActive`) — `enabled && usable`. The conjunction under a name, for the callers that mean both
- **Dependent** — a chat mode pinned to the credential, or a folder agent whose runtime resolves to it. What the confirm dialog names and the card counts
- **Credential binding** — which credential one folder agent's runtime resolves to, answered by main (`local-agent:credential-bindings`) because the chain is three deep

## User Stories / Flows

### Switching one off

1. The user presses the switch on a credential's card in Settings → AI Credentials
2. If nothing depends on it, it switches off immediately — one click, no dialog
3. If chat modes or folder agents depend on it, a confirm dialog opens. It leads with the recoverable half ("Nothing is deleted, and nothing is re-pointed at another credential"), then **names** the chat modes and the agents that stop
4. Confirming writes the change; a refused write leaves the dialog open with the reason in it, rather than closing over a switch that did not move
5. For as long as the credential is off, its card carries a standing marker **in its header** — "*N* chat modes and *M* agents inactive" — beside the sub-line that names the host or type. In the header rather than the expanded body because these cards are collapsed until someone opens one, and inline on an existing line so that a card going inactive changes no heights

### Finding out later why something stopped

1. **Agents sidebar** — the agent's dot turns red and its sub-line reads `AI credential switched off`
2. **Agent page, "Runs with"** — the status line reads "This credential is switched off. Turn it back on in Settings → AI Credentials."
3. **Settings → Chats** — the chat mode's card shows an `Inactive` badge and a short cause (`credential switched off`); expanding it repeats the whole sentence under the credential select
4. **Settings → Local Agents** — a pinned agent default that has been switched off says so, and a switched-off credential is no longer offered in that picker

### Switching it back on

One click, always. There is no confirm on the way in: nothing is at risk, and everything named above returns to the state it was in — the dialog's promise, kept by the fact that nothing was re-pointed while it was off.

## Business Rules

### The off switch means off, including for the engine

`collectEngineProviders` skips a credential that is not `enabled`. This is what makes the rest of the feature true rather than cosmetic.

The check was missing for as long as the collector existed, and it was worst where it mattered most: a **canonical** type (`anthropic`, `openai`) carries a real, decryptable key into the generated config, so a folder agent pinned to a credential the user had switched off in Settings kept running — and kept billing — after they turned it off. A **custom** entry (a gateway, Gemini, Ollama) was inert by accident rather than by design: `providerService.upsert` unregisters the adapter on disable and the config's model map is built from the registry, so the entry existed and could address nothing.

**The alternative position was considered and rejected.** The engine config is otherwise a *catalogue of what can be addressed*, with the runner deciding what actually runs — which is exactly why an **agent**'s own `enabled` is still not consulted when the config is generated (see [The Local Engine](../../agents/local_agents/engine.md)). That argument does not carry over to credentials: a user who switches a credential off has said something about **spending**, and there is no runner gate anywhere that would honour it. An agent left with no credential is emitted as a *skip* with a reason, so the "Runs with" panel can say why rather than the agent silently vanishing.

### Usable and active are two questions, and stay two functions

`isCredentialUsable` is deliberately not a test of `enabled`, because some callers legitimately ignore enablement — the "Runs with" panel lists a switched-off credential precisely so an agent pointing at one can say so, and a picker that hid it would leave the user unable to see what their agent is set to. `isCredentialActive` is the `enabled && usable` conjunction under a name, so a caller that means *both* says so visibly instead of merging a second term into the first predicate. Merging them is what let two copies of the rule drift apart the first time.

Call `isCredentialActive` where an off credential must be treated as absent: the chat-mode pickers, the pinned agent default, the attach-destination check, the sidebar's status join. Call `isCredentialUsable` where the question really is about the key alone. `collectEngineProviders` spells the two terms out separately rather than calling the conjunction, because each of its refusals carries its own reasoning.

### A credential reference is resolved in one place, by both processes

A folder agent's runtime stores a credential **reference** — an id, a name, or a provider type — and two things resolve it: the main process, building the engine config, and the renderer's "Runs with" panel, labelling its pickers. `findCredentialByReference` in `src/shared/credentials.ts` is the single implementation both call.

It had been written twice. The copies drifted the moment main's tie-break learned to prefer a credential that is switched **on**: with two rows named `Anthropic`, one of them off, the engine ran one and the panel described the other — the wrong key, the wrong catalogue and a spurious warning, on the one screen a user reads to find out which key they are billed for.

The tie-break itself is the interesting part. Two rows can answer one name — a managed `Anthropic` from the account config beside the user's own — so the ranking is **active, then merely usable, then whatever matched**. Picking a row that cannot run would strand an agent with a working credential sitting next to it. The last rung matters as much as the first: a reference that matches only unusable rows still resolves, so the agent page can say *why* it cannot run instead of claiming the credential is not on this machine. An id names exactly one row, so it is never a preference question.

### A switched-off credential and a keyless one want different sentences

Both stop the agent, and telling the user the wrong one sends them looking for a key they already have. The two facts travel separately (`credentialUsable` and `credentialEnabled` on `RuntimeFacts`) because they want different remedies: "add a key" and "turn it back on".

Ranking in the status ladder: **no key outranks switched off**, because a credential with no key is not made runnable by switching it on; **switched off outranks everything about a model**, because a disabled credential is not handed to the engine at all, so no model choice under it can run.

The switched-off sentence is the one message in that ladder that does **not** name the credential. It is the longest line there and the panel renders the ladder into a single truncating line; at the app's 800px minimum window with a long credential name, what fell off the end was the remedy. The credential is named by the select two rows above, so the name was the redundant half.

### The Default runtime says so too

Both branches of `resolveDefault` — this machine's pinned agent credential, and the user's default chat mode — used to report only a *missing key*. So an agent on the Default runtime, which is every agent that declares no credential of its own, said **nothing** when that credential was switched off: the panel claimed it was fine and the first turn failed. `defaultCredentialProblem` now covers both, and the sentence names whichever setting chose the credential, so the user knows whether they are being told about a machine-wide pin or about their default chat mode.

The pinned credential is still reported *as* the runtime rather than falling through to the chat mode. Silently re-pointing an agent at another key is the billing surprise this module exists to refuse.

### The confirm dialog is earned by consequence, not by destructiveness

Switching a credential off deletes nothing and is undone by the same switch, so the general "destructive actions confirm" rule does not by itself ask for a dialog — which is why a credential nothing depends on is a single click. What earns the confirm is that **the consequence is somewhere else**: agents stop on the Agents tab, chat modes stop on the Chats tab, on screens the user is not looking at.

- It **names** the dependents rather than counting them. A count is a number the user has to go and decode; the names are the whole reason to interrupt them
- Focus lands on Cancel, so Enter on arrival is the recoverable choice
- The card owns the mutation, not the dialog: a `mutate`-level callback is dropped when its caller unmounts, and closing the dialog *is* the unmount
- The dependent lists are read from queries that may not have landed. An undefined list counts as "nothing depends on it" — a confirm that appears a beat after the click, over a switch that has already moved, is worse than the switch simply working
- The switch's own `aria-label` reads **Switch on / Switch off**, the words the dialog and its button use. It previously read *Disable*, so a screen-reader user pressed an action that nothing the dialog said ever mentioned
- **A refused switch is reported in whichever of the two places the user is looking.** The dialog shows it while it is open; otherwise the card's own message row does, and the card **expands** to show it — the switch lives in the header and that row lives in the collapsed body, so on an unopened card the reason would have landed somewhere invisible. Writing it only where the dialog could render it meant a failed switch-*on*, the path with no dialog, moved nothing and said nothing

### The standing line outlives the dialog

The dialog names the dependents once, at the moment of the click, and is then gone. A user returning the next day would find a switched-off credential and no way to learn what it stopped — so the card keeps a line, for as long as the credential is off, counting what is inactive. Counted rather than listed: the dialog interrupts and can afford names, the card is a resting surface and can afford a number. Both come from one helper, so they cannot disagree about what a dependent is.

### A chat mode inherits its credential's state

A chat mode is a preset over a credential, so switching the credential off stops every mode pinned to it. It does not degrade gracefully: the adapter is unregistered on disable, so the stream fails with "Provider adapter not available" rather than falling back to anything. The `Inactive` badge is the sentence that says so before the user finds out that way.

- **A mode with no credential is not inactive.** It runs on the default, which is what its own select already says ("None (use default)"), and calling that a problem would badge the most ordinary chat mode there is
- The badge is followed by a **visible** short cause — `credential switched off`, `no API key`, `credential missing` — not a tooltip. The collapsed list is the state the tab opens in, so it is the state that has to be legible, and one word covering three situations is unambiguous only to someone who thought to hover
- It matters most on the account-provisioned card, whose header carries the mode's **own** on/off switch: an unqualified `Inactive` beside an enabled toggle is two meanings of "off" one control away
- The user's own modes and the account-provisioned ones share one function for both the wording and the styling, so two lists of chat modes one settings group apart cannot report the same state differently
- Nothing renders while the provider list is still loading, so a card cannot flash `Inactive` on its first render and un-flash on its second

### A select never claims "None" over a mode that names a credential

A `<select>` whose value matches no option falls back to displaying the first one. A chat mode bound to a switched-off credential therefore read as **None (use default)** — wrong, and unrecoverable, because the card never admitted what it was set to. Two synthetic options fix it: the bound credential itself, labelled `— inactive`, when it is not one the user may pick; and a plain `Missing credential` when the row is gone from this machine and only its id survives.

The same suffix is used by every settings select that can list a credential that cannot run — the chat mode's, the pinned agent default, and "Runs with". They had each solved it differently (one marker, one bare name, one silence), so the same credential was described three ways across three screens reached from the same settings list. It is a wording fix and not a colour one because an `<option>` cannot be styled portably.

### One meaning of "credentials" per line

In the agents sidebar, `AI credential switched off` ranks **above** the folder's own `credentials needed` readiness label. Two different meanings of one word collided: an agent that was both showed a red dot — which the AI credential owns — over a sub-line pointing the user at the folder's `credentials/.env`, two screens away from the switch that actually stopped it.

It stays **below** the `invalid` folder's own reason and below whatever the agent last said about itself. A folder that does not validate is never handed to the engine at all, so its credential is not yet the problem.

The dot is red rather than amber, because amber on that row means "missing something optional and still runs", and this agent does not run at all.

### What this deliberately does not do

- **It does not re-point anything.** No chat mode is moved to another credential, no agent is quietly floored onto the default. That is the promise the dialog makes, and it is what makes "turn it back on" a complete remedy
- **It does not gate an agent's own `enabled`.** That is a separate, still-open obligation on the runner — see [The Local Engine](../../agents/local_agents/engine.md)
- **It does not decide reachability.** Whether a host or an API is answering is a different question with a different answer every minute; see [Local Models & Keyless Credentials](../local_models/local_models.md)
- **It does not add a confirm to an account-provisioned credential.** A managed provider row is always written `enabled: true` and has no local off switch of its own; the local preference for account-provisioned resources lives on the managed *chat mode*. A managed mode's card can therefore reach `Inactive` through an unsupported credential (an Anthropic OAuth token) or a missing one, but not through this switch

## Architecture Overview

```
Settings → AI Credentials
  LLMProviderCard switch
    ├─ useChatModes()                     modes.providerId === id
    └─ useAgentCredentialBindings()       local-agent:credential-bindings
        └─ runtimeService.resolve(agent.runtime, providers)
    → dependents? → DisableCredentialDialog (names them)
    → provider:upsert {enabled:false}
        → providerService.upsert → unregisterAdapter
        → invalidate ['providers'], ['models'], bindings

Engine config build
  collectEngineProviders()   skip !enabled, then isCredentialUsable
  runtimeService.resolve()   findCredentialByReference (shared)
                             → RuntimeFacts.credentialEnabled
                             → describeCredential ladder

Renderer surfaces
  LocalAgentsList   bindings ⨝ providers → red dot + sub-line
  RuntimePanel      findCredentialByReference + describeCredential
  ChatModeCard      chatModeInactiveReason → badge + cause + detail
  ManagedChatModeCard   the same function
  LocalAgentsSettingsSection   isCredentialActive picker + pin warning
```

## Where the pieces live

Only what this aspect added or moved; the surrounding machinery is in the tech docs linked below.

- `src/shared/credentials.ts` — `isCredentialActive(provider)`, `findCredentialByReference(providers, reference)` and its `ReferenceableCredential` shape
- `src/shared/runtimeMessages.ts` — `RuntimeFacts.credentialEnabled`, and the branch in `describeCredential`
- `src/shared/localAgents.ts` — `AgentCredentialBinding`
- `src/main/engine/engineConfigSource.ts` — the `!dto.enabled` skip in `collectEngineProviders()`
- `src/main/services/localAgents/runtimeService.ts` — `defaultCredentialProblem()`; `findCredential()` is now a delegate to the shared resolver
- `src/main/ipc/local_agent.ipc.ts` — `local-agent:credential-bindings`
- `src/renderer/src/hooks/useLocalAgents.ts` — `useAgentCredentialBindings()`, `AGENT_CREDENTIAL_BINDINGS_KEY`
- `src/renderer/src/utils/chatModeStatus.ts` — `chatModeInactiveReason()`, `INACTIVE_BADGE_CLASS`, `INACTIVE_CAUSE_CLASS`
- `src/renderer/src/utils/credentialLabel.ts` — `credentialOptionLabel()`
- `src/renderer/src/components/settings/DisableCredentialDialog.tsx` — the dialog and `describeDependents()`
- `src/renderer/src/utils/localAgents.ts` — `agentSubline(agent, credentialInactive)`

The bindings query is invalidated wherever the runtime chain can move: a credential write or delete (`useProviders`), an account-config sync (`useProviders`, `useChatModes`), any chat-mode write or the managed-mode enable toggle (`useChatModes`), an app-setting write (`useAppSettings`, for the pinned agent default), and every `local-agent:changed` push.

## Integration Points

- [Adapters](adapters.md) — the registry lifecycle `enabled` drives, and where the adapter is unregistered
- [Local Models & Keyless Credentials](../local_models/local_models.md) — `isCredentialUsable`, and why enablement was kept out of it
- [The Local Engine](../../agents/local_agents/engine.md) — the config's admission rules, runtime resolution, and the still-open agent-`enabled` obligation
- [Agents Tab & Agent Page](../../agents/local_agents/agents_tab.md) — the sidebar sub-line order and the "Runs with" panel
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — what a mode binds to
- [Account-Provisioned Providers & Chat Modes](../account_provisioning/account_provisioning.md) — managed credentials, and where their local preference lives
- [Settings](../../ui/settings/settings.md) — the AI Credentials tab the card and dialog live in
