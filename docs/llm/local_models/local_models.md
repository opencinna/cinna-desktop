# Local Models & Keyless Credentials

## Purpose

Run models that live on the user's own machine — Ollama today — as an ordinary AI credential: selectable in a chat mode, usable by AI functions, and able to run a local folder agent through the OpenCode engine. The machinery that makes that possible is **keyless credentials**: a credential row with no API key at all, identified by a **host** instead.

## Core Concepts

- **Keyless credential** — A credential type that authenticates with nothing. An Ollama row stores a host and no key; `KEYLESS_PROVIDER_TYPES` in `src/shared/credentials.ts` is the list, a set of one today because the next local runtime (LM Studio, llama.cpp's server, vLLM) is the same shape
- **`isCredentialUsable`** — The one predicate for "can this credential drive a model call". Imported by both processes; every layer calls it and none restates it. Its sibling **`isCredentialActive`** adds the user's own on/off switch (`enabled && usable`) for the callers that mean both
- **Host** — Where a keyless credential's requests go. Stored in the existing `llm_providers.base_url` column, the same one an `openai_compatible` gateway uses, so the feature added no column and needed no migration. Normalised to a bare origin (`http://127.0.0.1:11434`)
- **Detection probe** — `provider:detect-ollama`: does something answer on a host, what version is it, and what has it pulled. Answers `{running, host, version, models, alreadyConfigured}` and nothing else
- **Keyless placeholder** — The literal `keyless` handed to anything that structurally insists on a key string: the OpenAI SDK, which throws on an absent `apiKey`, and the engine config, whose every provider entry names an environment variable. Not a secret and never a stand-in for one — Ollama accepts any bearer token and validates none
- **Parameter-count tier** — How a local model's Work Complexity is decided: by its size (`:3b`, `:8x7b`, `:70b`), not by a product name

## User Stories / Flows

### The one-click offer

1. User opens Settings → AI Credentials (Default scope). The section probes for a local Ollama on mount
2. If one answers and no credential exists for that host, an offer row appears **below** the Add button: "Ollama is running on this machine", with the host and how many models it has, and an **Add Ollama** button
3. Pressing it creates the credential with the detected host, enabled, no default model. The row leaves the screen as soon as the card arrives

### Adding it by hand

1. User presses **Add AI Credentials** and picks **Ollama** from the type list, which is always present whether or not one is running
2. The form shows a **Host** field instead of an API Key field, pre-filled from the probe (`OLLAMA_HOST` if the environment names one, else `http://127.0.0.1:11434`) and left alone from then on if the user edits it
3. A status line under the field says what was found: the version and model count, "Nothing answered there — is Ollama running?", "Ollama is running but has no models pulled yet", or "This host already has a credential"
4. **Test** re-probes the host as typed. **Save** stores it — including when nothing answered, because a user who has not started Ollama yet is entitled to add the credential now and start it later

One of those states has been reasoned about rather than seen: **"Ollama is running but has no models pulled yet"** is handled in both the form's status line and the offer row's sub-line, but it has not been driven on a real install, since reaching it means removing every model from a working one.

### Editing the host later

1. The credential's card shows **Host** where a keyed credential shows API Key, seeded with the stored value rather than blank: it is not a secret, so it can be edited rather than retyped
2. **Test Connection** reports what the host says now; a failure gets its own full-width line under the controls rather than a truncated one beside them

### Running a folder agent on a local model

1. The agent's "Runs with" panel offers the Ollama credential like any other, and its models like any other catalogue
2. The engine config gets a custom provider entry pointed at the host's `/v1`, declaring exactly the models `ollama list` reports
3. A turn runs against the local server. Tools work — see the note on `capabilities.tools` below

## Business Rules

### One predicate decides what is usable, in one file

`isCredentialUsable(provider)` is `!unsupported && (hasApiKey || the type needs no key)`. It replaced a `hasApiKey && !unsupported` written out by hand at every call site that asked the question — a dozen-odd of them, in main and renderer alike. The rule about which credentials can run must not be able to differ between the screen that offers one and the service that spends it: the copies had already drifted once, and the keyless case is precisely where a stale copy is invisible — the chat-mode picker, the "Runs with" panel and the engine generator would each have silently ignored a perfectly working Ollama.

It is deliberately **not** a test of `enabled`. Some callers legitimately ignore enablement — the "Runs with" panel lists a disabled credential so an agent pinned to one can say so, and a picker that hid it would leave the user unable to see what their agent is set to. Callers that care say **`isCredentialActive`**, which is `enabled && isCredentialUsable` under a name: visibly a different question, not a quietly stricter answer to this one. Two functions rather than one term folded into the first, because merging them is what let two copies of the rule drift apart before. See [Switching an AI Credential Off](../adapters/credential_enablement.md).

It also says nothing about **reachability**. Usable means "the app may offer this and hand it to the engine"; whether an Ollama is answering right now has a different answer every minute and belongs to the detection probe.

### A keyless credential is its host

- Empty means unspecified, which resolves to the default host. Non-empty and unparseable is **refused**, not defaulted: silently storing `127.0.0.1` for a credential whose field reads `my ollama box` is a screen that lies about what it saved
- Normalisation happens on the **write** path as well as the probe path, through the same function. It used to happen only on the probe, so Test and Save disagreed: a pasted `http://127.0.0.1:11434/v1` probed green against the origin and stored verbatim, which then produced `…/v1/api/tags` for the adapter and `…/v1/v1` for the engine
- Everything that means one origin normalises to one origin: a bare port (`11434`), a scheme-less `127.0.0.1:11434` (the form Ollama's own CLI teaches), a trailing slash, a pasted `/v1` or `/api/tags`. `localhost` collapses to `127.0.0.1`, both because a resolver that answers `::1` first turns a 30 ms probe into a multi-second one and because this same function is how two hosts are compared for equality
- An all-digit value is a **port** and never anything else, and a hostname that is all digits is refused. WHATWG `URL` reads a bare integer as a packed IPv4 address, so `1` became `http://0.0.0.1` and `2130706433` became `http://127.0.0.1` — plausible slips while editing a port, each saving a green-dotted credential pointing at a machine with nothing to do with Ollama
- The authority is validated by this module rather than left to the ambient `URL`, because the two processes do not have the same one: Chromium percent-encodes a space in a host where Node throws, and Node accepts `http://!!!`. The renderer disables Save with this predicate and the main process refuses a write with it, so a parser that answers differently on the two sides produced an enabled Save button and a save that was then refused

### The probe reaches any http(s) host the renderer names, and that is inherent

`detect(host)` takes an explicit host because a user's Ollama may legitimately be a box on their LAN. There is no allow-list to check against without removing the case the parameter exists for. What bounds it is the shape of the answer and the cost of asking, not a filter — the same structure as [the `cinna://connect` link](../../auth/onboarding/connect_link.md), where the confirm step is the security boundary and the URL validation is not:

- The reply is `{running, host, version, models, alreadyConfigured}` and nothing else. No status code, no response body, no headers, no timing detail — nothing that would make it a readable port scanner
- No retry, and short ceilings: 5 s for `/api/version`, 1.5 s for the `/api/tags` listing that follows a host that answered
- **Nothing probes on app start, and nothing probes on a timer.** A probe happens because the user opened the Default-scope AI Credentials section, chose Ollama in the Add form, pressed Test — or returned to the window with one of those surfaces already open. That last one is the single exception to this app's global `refetchOnWindowFocus: false`, and it is deliberate: "is Ollama running" changes *out of band*, in a terminal, while the user is looking at another window, so coming back to Settings and finding the offer present is the behaviour, while having to leave and re-enter is not. It stays bounded by the same two things — the query is `enabled` only on the screens that ask for it, and the only thing a fresh answer can move is the offer row, which sits below everything. A probe on the startup path would buy nothing and is how a launch becomes two seconds long on a machine where something is firewalled
- `normaliseOllamaHost` admits only `http:` and `https:`, and drops userinfo, so a pasted link cannot smuggle a credential into a stored `base_url` that is later logged and rendered on screen
- The automatic search is `OLLAMA_HOST` (if set) then the default host, deduped. **No port scan and no LAN sweep**: a process listening on an unexpected port is indistinguishable from anything else listening there, and probing a user's network on their behalf is not something a chat client should do unasked

### `baseUrl` is accepted only for a keyless type

`provider:upsert` and `provider:test-key` both drop a renderer-supplied `baseUrl` for any type that has an API key, and only the keyless types keep it. This is a security boundary, not tidiness:

- On the **upsert** path, pointing a row that holds a real key at an arbitrary URL is key exfiltration with extra steps — the main process would decrypt the key and send it to an address the renderer chose, which is exactly what "API keys never leave the main process" exists to prevent
- On the **test-key** path nothing stored is exfiltrated (the key there is renderer-supplied too), but forwarding an arbitrary `baseUrl` would make the main process fetch any http(s) address and hand back either a model list or the endpoint's own error text — a loopback and LAN port probe with a readable answer, and a primitive that did not exist before this feature: a keyed type could previously only reach a fixed set of vendor endpoints
- A keyed credential's one legitimate base URL — an `openai_compatible` gateway — is written by [account-config sync](../account_provisioning/account_provisioning.md), which goes through the repository directly and is untouched by this rule
- A dropped `baseUrl` is logged rather than refused. A guard that has to tell a legitimate value from a hostile one is a guard reasoning about intent, which is how guards come to be wrong; but a silent drop would leave no trace of the attempt at all

### A credential's type is fixed at creation

`upsert` refuses a write that changes an existing row's `type`, with its own error code (`type_immutable`) rather than the routine `read_only`, so a security guard's log line is not indistinguishable from noise that occurs normally.

This is the other half of the boundary above. The repository writes `type` unconditionally on update and **preserves** the stored encrypted key when no new one is supplied, so without the check a renderer could re-type an Anthropic row while it kept the Anthropic key — and the key would then be spent under another type's transport and endpoint. No caller legitimately does this: a card always sends its own row's type, and the Add form only creates.

### Ollama speaks two protocols and both are used

- **Generation** goes over the OpenAI-compatible `/v1` surface, and `stream()` is the OpenAI adapter's, delegated to verbatim. It already carries streaming and tool calls in the shape the whole app handles, and a second copy of that conversion would be a second place for a tool-call bug to live
- **Listing** goes over the native `/api/tags`, because `/v1/models` returns bare ids while `/api/tags` returns the family, the parameter size and the quantisation. The parameter size is what Work Complexity classifies a local model by, and it is not recoverable from the tag: `deepseek-r1:latest` is a 7B and says so nowhere in its name
- **Embedding models are filtered out of the listing.** The shared chat-capability filter looks for `embedding`, and almost no Ollama embedding model is spelled that way — `nomic-embed-text`, `mxbai-embed-large`, `all-minilm`, `bge-m3`. Every one of them would otherwise have been offered as something to chat with and answered the first turn with a 400
- **A failure here usually means "it isn't running", not "you're unauthorised"** — a different sentence with a different fix. `parseError` names the two local failures (server not started, model never pulled), and `providerService.test`/`testKey` now route their errors through the adapter's `parseError` instead of rethrowing raw, because the sentence that helps was reachable from no path a user could take while the screen said `fetch failed`
- **Vision support is matched by family, loosely**, because an Ollama tag is user-controlled — the same weights can be `llava:13b`, `llava:latest` or whatever a `Modelfile` called them. Version ranges rather than pinned majors, on the bet that once a line goes multimodal it stays multimodal
- **A tighter attachment envelope than the cloud adapters'** (8 MB, 5 files). Nothing local is billed, so the instinct is to be generous; the binding constraint is the other one — a local context window is commonly 4k–32k tokens and an extracted attachment is inlined whole, so an oversized file silently truncates the conversation rather than costing money

### A local model's tier is its parameter count

Work Complexity (`simple` / `medium` / `complex`) is resolved by model *family* against the live catalogue. The cloud rules classify by product name because a vendor's line-up is a product decision — Haiku is the cheap one because Anthropic says so. Ollama has no line-up: it has whatever the user pulled, from every vendor at once, tagged `name:size`. `qwen2.5-coder:1.5b` and `qwen2.5-coder:32b` are the same product and belong in different tiers, which no name-based rule can express.

- Boundaries: under 5B is Simple, 5–19B Medium, 20B and up Complex — a statement about *time* on the user's machine, which is the same axis Work Complexity means by "fastest" and "slowest", paid in seconds rather than tokens. A size in millions (`smollm2:135m`) is Simple whatever the figure
- The size must **start** a number, not continue one. Without that rule `deepseek-r1:1.5b` matched the Medium pattern on its `.5b` tail and a 1.5B model was filed as mid-size
- **An unsized tag resolves to Medium, not to nothing.** `deepseek-r1:latest` is the common case for a user who pulled the default, and Ollama's default tag is almost always the 7–8B build. Classifying it as null would be worse than a guess: a tier resolves against the credential's catalogue, so a machine holding only `:latest` tags would have every tier come up empty and every agent on it left with no model
- That catch-all is the one rule an **unrecognised** provider type is not matched against. A gateway is matched against every rule because a proxied id is the only evidence there is — and a rule that matches everything is not evidence. The sized rules do still apply to a gateway: `meta-llama/Llama-3.3-70B-Instruct` now classifies as Complex where it used to classify as nothing, because `70B` is evidence stated outright
- `ollama` counts as a **known** type, so the cloud rules never touch it. Reading `mistral-small3.2:24b` as a Mistral product tier rather than as a 24B would be exactly wrong

### Two Ollama hosts are two catalogues

`ollama` joins `openai_compatible` in `PER_ROW_CATALOGUE`: a model id is not lent between two rows of these types, and a model listed only by another row of the same type is treated as belonging elsewhere. For a gateway that is because two gateways merely share a wire format; for Ollama it is sharper still — a catalogue there is literally the set of models pulled onto one machine, so a colleague's box on the LAN shares nothing with the user's laptop beyond the protocol.

### In the engine config: a custom entry with a public placeholder

- **Always a custom entry, never the canonical `ollama` key.** models.dev does publish one, but its model list is the fixed catalogue of what Ollama offers for *download*, not what this machine has pulled — a canonical entry would list dozens of models that 404 on first use. The custom entry declares exactly the tags `ollama list` reports
- **The entry's `baseURL` is the host plus `/v1`.** The credential stores the bare origin, because the native listing and the probe need it; the conversion to the OpenAI-compatible path happens in the generator, so the database holds one spelling of the host and one place knows about the suffix
- **A keyless credential still names an environment variable**, carrying the placeholder rather than a key. This does **not** contradict [Invariant 4](../../agents/local_agents/engine.md#a-key-is-never-written-into-the-config) — no API key is in the config, and the placeholder is public by construction. It is emitted rather than omitted because `env: ["CINNA_ENGINE_KEY_…"]` is what becomes an integration with a live connection, which is the branch of the engine's availability filter every working entry takes; an entry with no `env` would fall through to a branch the contract records as transiently false for ~160 ms. Verified on a live engine: the entry is available, and Ollama receives `Authorization: Bearer keyless` and ignores it, as it ignores every token
- **Its models are declared with a `{context: 32768, output: 4096}` ceiling**, like every custom entry, so `max_tokens` is never zero. This is the one row where the cautious direction is genuinely ambiguous: an oversized `max_tokens` is rejected loudly, but claiming a 128k context on a model serving 4k makes Ollama silently truncate instead. So the figure is small enough to be true almost everywhere rather than large enough to be useful somewhere. The real number *is* available here — `/api/show` returns the per-model context length — which is why Ollama is the provider where threading true windows through `listModels()` would pay off first
- **`capabilities.tools` is `false` for our entry, and it does not matter.** A custom entry's models report it as false in `GET /api/model` — ours is the only entry in a 32-model catalogue that does — and the obvious conclusion is that a folder agent on one gets no tools. Measured on 8 Sep 2026 against opencode 1.18.27 and a real Ollama, with a logging proxy between the two: the session runner sent the agent's full set of **12 tools** regardless. It is catalogue metadata, not a gate. Declaring `tool_call: true` to "fix" it would change nothing for tool use while asserting tool-calling about every model of every custom entry, including small local models that genuinely cannot do it — turning a graceful degradation into a 400

### The engine re-asks the local credentials on every reconcile

A reconcile still does not re-ask the cloud providers; it does re-ask the local ones, and both halves of the rule matter:

- A local catalogue is not a vendor's stable line-up. It is the set of models on this machine, which the user changes with `ollama pull` between one turn and the next, and which is **empty whenever the local server was not running at the moment the engine started**. Without the local refresh, starting Cinna before Ollama meant every folder agent on it hung on its first turn until the desktop's own twenty-minute ceiling expired — a custom entry with an empty `models` map can address nothing, and the resulting failure reaches no engine event at all. A loopback listing costs about a millisecond, which is why this does not reintroduce the cost the cloud exclusion exists to avoid
- **A refresh never shrinks a provider to nothing.** `getAllModels` swallows a per-adapter failure and simply omits that provider, so "the server was down for this one call" and "this credential has no models" arrive identically. A provider that reported nothing keeps what it last reported: the cost of being wrong that way is a declared model that has since been `ollama rm`-ed, which fails loudly the first time it is used, against the silent hang above. A provider that *did* answer is replaced outright, so a removed model still disappears
- **Deletion is the exception, and it needs positive knowledge.** The merge is also handed the live credential ids, because "keep what a silent provider last said" cannot tell silence from a deleted credential — and the cache is not only a lookup table, it is read as a global ownership index when deciding whether a model belongs to another credential, so a ghost row is an owner. An **empty** live list evicts nothing: it comes from the credential database while the models come from the adapter registry, and the two legitimately disagree for a moment before a profile's scopes resolve. Treating that as "everything was deleted" would empty every custom entry at once, which is the hang this rule exists to prevent

### What the UI must not do

- **The status dot never goes red for a keyless credential.** Red means "this cannot be used", which for a keyed row is a missing key and for a keyless one is never true. Whether Ollama is *running* is a live fact reported by Test Connection, not asserted by a dot that would turn red every time the user quit Ollama
- **Ollama is listed in the Add form unconditionally**, not only when one is detected. A dropdown whose entries appear as a background probe lands reflows under the pointer, and a user who has not started Ollama would be told nothing about why the option is missing
- **Nothing arrives above a control the user is about to press.** The Add form's status line lives in a fixed-height slot (and is `aria-live="polite"`, since it is the only place a Test result is reported); the **Default Model row is present from the moment a type is chosen, for every provider type**, and only its contents change — a probe that came back empty used to unmount it and lift the Cancel/Test/Save row 64 px, putting Save exactly where the pointer had just pressed Test, and the keyed half of the same form did the same thing on a *successful* test a second after the click; save errors moved *below* the buttons on both the form and the card; the offer row sits last in the section, below the Add button, which is what makes it safe for it to appear asynchronously at all
- **The default model that gets saved is derived from the list on screen, not remembered beside it.** Pick a model, replace the key, let the test fail, and a stored selection would still be written while the select showed its empty placeholder — the screen saying no model was chosen and the row saying otherwise. The raw selection is still kept, so a list that comes back *with* it (a re-test on the same key, a local server restarting) restores the user's choice rather than discarding it
- **A card's type sub-line appears only when it says something the name does not.** Every credential created from the picker takes the provider's display name, so the sub-line rendered "Ollama Ollama"; it still earns its place on a renamed credential ("Work key" · Anthropic)
- **A failed connection gets a full-width line rather than a truncated one.** The old 200 px clamp was survivable while the message was `fetch failed`; it would now clip away the half of "Ollama isn't answering at … — start it with 'ollama serve'" that tells the user what to do
- **The same host is never offered twice — and suppression is by host, not by type.** The Add form disables Save and the offer row hides itself on the probe's `alreadyConfigured`, which compares normalised origins in main. There was briefly a second, type-wide check ("the user has any Ollama credential at all"), added because the probe is cached for 15 s and the row lingered for a moment after its own button had worked; the cache is now invalidated when a credential is written, and the type-wide check is gone because it answered a wronger question — a credential once saved against a mistyped port would have permanently hidden the offer that would have found the real server. Two rows for one host would still be worth preventing: wherever a manifest names a credential by name, two rows named "Ollama" are resolved by list order

### What this feature deliberately does not do

- **It does not install, start, update or manage Ollama**, and it does not pull models. It finds one that is already there
- **It does not scan for one.** Two candidate hosts, both named: the environment's and the default
- **It does not decide reachability for anything else.** `isCredentialUsable` stays a pure predicate; "is it answering" lives only in the probe and in Test Connection
- **It adds no database column and no migration.** The host rides in `base_url`, which already existed for gateways — a credential row that points somewhere is one concept, not two

## Architecture Overview

```
Settings → AI Credentials (mount)
  → provider:detect-ollama → ollamaService.detect()
      → probeOllama(host)      GET /api/version   (5s)
      → fetchOllamaTags(host)  GET /api/tags      (1.5s)
      → {running, host, version, models, alreadyConfigured}

Add / edit / one-click offer
  → provider:upsert {type:'ollama', baseUrl}
      → providerService: type-immutable check → keyless-only baseUrl → storableOllamaHost
      → llm_providers.base_url                (no api_key_enc)
      → registerAdapter(OllamaAdapter(host))  (enabled alone, no key to wait for)

Chat / AI functions
  → getAdapter(providerId) → OllamaAdapter
      → listModels()  native /api/tags
      → stream()      delegated to OpenAIAdapter on <host>/v1

Folder agent
  → collectEngineProviders()  enabled, isCredentialUsable, apiKey ''
  → buildEngineConfig()       custom entry, baseURL <host>/v1,
                              env CINNA_ENGINE_KEY_… = 'keyless', model limits
  → opencode → <host>/v1/chat/completions
```

## Integration Points

- [Adapters](../adapters/adapters.md) — the `LLMAdapter` contract Ollama implements, and the registry lifecycle it joins
- [Provider Integration](../adapters/provider_integration.md) — the per-provider translation matrix, where Ollama's row is "the OpenAI one, on a different host"
- [Local Models — Technical Details](./local_models_tech.md) — file paths, IPC channels, methods
- [The Local Engine](../../agents/local_agents/engine.md) — custom provider entries, model limits, runtime resolution and the model-cache refresh rules
- [Account-Provisioned Providers & Chat Modes](../account_provisioning/account_provisioning.md) — the other user of `base_url`, and the sync path the keyless-only rule deliberately does not touch
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — where a keyless credential is picked for chat
- [Switching an AI Credential Off](../adapters/credential_enablement.md) — the `enabled` half this predicate deliberately leaves out, and what consults it instead
- [Settings](../../ui/settings/settings.md) — the AI Credentials tab the card, form and offer row live in
