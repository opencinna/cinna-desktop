/**
 * What makes an AI credential *usable*, in one place.
 *
 * Every layer of this app used to answer that question with the same two-term
 * boolean — `hasApiKey && !unsupported` — written out by hand, in main and in
 * the renderer, wherever a credential had to be judged. (A deliberately vague
 * count: the literal two-term form appeared in eight places, but a dozen-odd
 * sites made some key-presence check, and picking a number here would just be a
 * claim that goes stale.) That was correct for exactly as long as every provider
 * was a cloud API behind a key.
 *
 * Ollama is not. It runs on the user's own machine, listens on loopback, and
 * has no key to store; a credential row for it carries a **host** and nothing
 * else. Under the old predicate such a row is unusable everywhere — invisible
 * in the chat-mode picker, filtered out of the Runs with panel, and skipped by
 * the engine config generator — which is the whole of what "keyless" has to
 * change.
 *
 * So the predicate moves here and gains one term. Both processes import it:
 * a rule about which credentials can run must not be able to differ between
 * the screen that offers them and the service that spends them.
 *
 * **This says nothing about reachability.** A keyless credential is *usable* in
 * the sense that the app may offer it and hand it to the engine; whether an
 * Ollama server is actually answering on that host right now is a live question
 * with a different answer every minute, and belongs to the detection probe
 * (`ollamaService`), not to a pure predicate that renders a list.
 */

/**
 * Provider types that authenticate with nothing.
 *
 * A `Set` of one today. It is a set rather than an `=== 'ollama'` because the
 * next local runtime — LM Studio, llama.cpp's server, vLLM — is the same shape,
 * and the point of routing every call site through {@link isCredentialUsable}
 * is that adding one is an edit to this line.
 */
export const KEYLESS_PROVIDER_TYPES: ReadonlySet<string> = Object.freeze(new Set(['ollama']))

/** Whether a credential of this type needs an API key to be worth anything. */
export function requiresApiKey(type: string): boolean {
  return !KEYLESS_PROVIDER_TYPES.has(type)
}

/** As much of a credential as {@link isCredentialUsable} needs. */
export interface UsableCredential {
  type: string
  hasApiKey: boolean
  /** Managed credential that cannot make API calls (an Anthropic OAuth token). */
  unsupported?: boolean
}

/**
 * Whether this credential can drive a model call at all.
 *
 * Deliberately **not** a test of `enabled`. Enablement is the user's on/off
 * switch and some callers legitimately ignore it (the Runs with panel lists a
 * disabled credential so an agent pointing at one can say so); mixing the two
 * into one predicate is what let the renderer's copy and `runtimeService`'s
 * drift apart in the first place. Callers that care about enablement say
 * {@link isCredentialActive}, which is that conjunction under a name — visibly
 * a different question, not a quietly stricter answer to this one.
 */
export function isCredentialUsable(provider: UsableCredential): boolean {
  if (provider.unsupported) return false
  return provider.hasApiKey || !requiresApiKey(provider.type)
}

/**
 * Whether this credential can run **right now**: the user's switch, and the key.
 *
 * The `provider.enabled && isCredentialUsable(provider)` above, given a name,
 * for the callers that mean *both*. It is a second function rather than a term
 * folded into {@link isCredentialUsable} because the callers that legitimately
 * ignore enablement are still there — the Runs with panel lists a disabled
 * credential so an agent pointing at one can say so — and merging the two is
 * what let the renderer's copy and `runtimeService`'s drift apart originally.
 *
 * Say `isCredentialActive` when an off credential must be treated as absent —
 * a sidebar status dot, a chat mode's badge, the pickers that offer a
 * credential to choose — and `isCredentialUsable` when the question really is
 * about the key alone. `collectEngineProviders` is the one place that spells
 * the two terms out separately rather than calling this, because each of its
 * `continue`s carries its own paragraph of reasoning and merging them would
 * bury the one that matters.
 */
export function isCredentialActive(provider: UsableCredential & { enabled: boolean }): boolean {
  return provider.enabled && isCredentialUsable(provider)
}

/** As much of a credential as {@link findCredentialByReference} needs. */
export interface ReferenceableCredential extends UsableCredential {
  id: string
  name: string
  enabled: boolean
}

/**
 * Resolve a credential **reference** — the thing a folder agent's runtime block
 * stores — against the credentials this machine has.
 *
 * Three shapes, most specific first: an id (what an older desktop might have
 * written), a name (what this one writes, because a name is the only form that
 * means anything in a file that travels), and a provider type (`anthropic`,
 * `openai` — what someone writing the manifest by hand would naturally put).
 * Name and type matching are case-insensitive.
 *
 * **The tie-break is the interesting part.** Two rows can answer one name — a
 * managed `Anthropic` from the account config beside the user's own — so the
 * ranking is: one that can run, then one that merely has a key, then whatever
 * matched. Picking a row with no key, or one the user switched off, would
 * strand an agent that has a working credential sitting next to it. The last
 * rung matters just as much: a reference that matches *only* unusable rows
 * still resolves, so the agent page can say why it cannot run instead of
 * claiming the credential is not configured on this machine.
 *
 * **It lives here because two processes resolve the same reference.**
 * `runtimeService.resolve` builds the engine's config from it and the "Runs
 * with" panel labels its pickers from it, and those two answering differently
 * is not a cosmetic bug: the panel then names a credential, a catalogue and a
 * model that the engine is not using, on the screen a user reads to find out
 * which key they are being billed for. That is the exact failure
 * `shared/runtimeDefaults.ts` and `shared/runtimeMessages.ts` were carved out
 * to end, and this function was the last piece of the resolution still written
 * twice.
 */
export function findCredentialByReference<T extends ReferenceableCredential>(
  providers: readonly T[],
  reference: string
): T | null {
  const byId = providers.find((provider) => provider.id === reference)
  if (byId) return byId

  const runnable = (matches: readonly T[]): T | null =>
    matches.find(isCredentialActive) ?? matches.find(isCredentialUsable) ?? matches[0] ?? null

  const needle = reference.trim().toLowerCase()
  const byName = providers.filter((provider) => provider.name.trim().toLowerCase() === needle)
  if (byName.length > 0) return runnable(byName)

  const byType = providers.filter((provider) => provider.type.toLowerCase() === needle)
  if (byType.length > 0) return runnable(byType)

  return null
}

/**
 * Where Ollama listens when nobody has said otherwise.
 *
 * `127.0.0.1` and not `localhost`: on a machine whose resolver answers `::1`
 * first, `localhost` reaches an Ollama bound only to IPv4 after a failed
 * connection and a retry, which turns a 30ms probe into a multi-second one.
 * Ollama binds `127.0.0.1:11434` by default, so this is the literal default.
 *
 * No trailing slash — every consumer appends a path beginning with one.
 */
export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434'

/**
 * Normalise a user-typed or environment-supplied Ollama host into an origin.
 *
 * `OLLAMA_HOST` is conventionally set **without** a scheme (`127.0.0.1:11434`,
 * or just a port `11434`), because that is the form Ollama's own CLI accepts.
 * A user typing into the Host field will just as often paste a full URL with a
 * trailing slash or a `/v1` already on the end. All of those mean one origin,
 * and every one of them reaches this app.
 *
 * Returns null when nothing sensible can be made of the value, so the caller
 * can fall back to {@link OLLAMA_DEFAULT_HOST} rather than probing gibberish.
 */
export function normaliseOllamaHost(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (raw === '') return null

  /**
   * An all-digit value is a **port**, and never anything else.
   *
   * The branch used to be `^\d{2,5}$`, and everything outside it fell through to
   * `new URL('http://' + raw)` — where WHATWG reads a bare integer as a *packed
   * IPv4 address*. So `1` became `http://0.0.0.1`, `0` became `http://0.0.0.0`
   * and `999999` became `http://0.15.66.63`: three plausible slips while editing
   * a port, each saving a green-dotted credential pointing at a machine that has
   * nothing to do with Ollama. The upper bound was missing too — `99999` was
   * accepted as a port that cannot exist.
   *
   * So: any run of digits is a port, valid iff it is a real one.
   */
  if (/^\d+$/.test(raw)) {
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return `http://127.0.0.1:${port}`
  }

  // A scheme we do not speak is rejected outright rather than prefixed. Without
  // this, `ftp://x:11434` became `http://ftp://x:11434` and normalised to the
  // nonsense host `http://ftp` — garbage in, plausible-looking garbage out,
  // which is worse than a refusal because something then tries to fetch it.
  //
  // The `//` in the test is load-bearing: `host:port` and `scheme:` are the same
  // shape to a regex, so matching a bare `scheme:` rejected `localhost:11434`.
  // A schemeless `javascript:alert(1)` still fails, one step later, on `new URL`.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`

  /**
   * The authority is checked **here**, not left to `new URL`, because the two
   * processes do not have the same `URL`.
   *
   * Chromium percent-encodes a space in a host (`http://not a url` parses, with
   * hostname `not%20a%20url`); Node throws on the same string. This function is
   * the shared predicate the renderer disables Save with *and* the main process
   * refuses a write with — so delegating validation to the ambient parser made
   * it answer differently on the two sides of the IPC boundary, which is exactly
   * the split this module exists to prevent. The user saw an enabled Save button
   * and a save that was then refused.
   *
   * Node is also not strict enough to lean on in the first place: it accepts
   * `http://!!!` as the host `!!!`, so that was being stored.
   *
   * The set is the characters an authority may contain — host, optional port,
   * optional userinfo, and the brackets of an IPv6 literal — and the trailing
   * test requires at least one alphanumeric, so `...` and `:::` are not hosts.
   */
  const authority = withScheme.slice(withScheme.indexOf('://') + 3).split(/[/?#]/)[0]
  if (!/^[A-Za-z0-9._~%:@[\]-]+$/.test(authority)) return null
  if (!/[A-Za-z0-9]/.test(authority)) return null

  /**
   * The same packed-IPv4 trap, reached with an explicit scheme.
   *
   * `http://2130706433` normalises to `http://127.0.0.1` — the digits are the
   * 32-bit form of that address. Checking `url.hostname` afterwards cannot catch
   * it, because by then it *is* a dotted quad. A hostname that is nothing but
   * digits is not something anyone means to type, so it is refused here.
   */
  const hostOnly = authority.split('@').pop()!.replace(/:\d*$/, '')
  if (/^\d+$/.test(hostOnly)) return null

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.hostname === '') return null
  // `localhost` collapses to `127.0.0.1`, for the reason on
  // {@link OLLAMA_DEFAULT_HOST} and one more: this function is also how two
  // hosts are compared for equality (does a credential already exist for the
  // server the probe just found?), and `localhost` vs `127.0.0.1` is one server
  // under two spellings, not grounds for a duplicate credential.
  if (url.hostname === 'localhost') {
    url.hostname = '127.0.0.1'
  }
  // `url.host` excludes userinfo, so a pasted `http://user:pass@host:11434`
  // loses the credential rather than storing it in a column that gets logged
  // and shown on screen. That is a property of `host` (not `hostname`, which
  // also drops the port), and it is asserted in the tests so a future switch to
  // string concatenation cannot quietly reintroduce it.
  //
  // The origin and nothing else: a pasted `…:11434/v1` or `…/api/tags` names
  // the same server, and every consumer here builds its own path.
  return `${url.protocol}//${url.host}`
}

/**
 * The host to *store* for a keyless credential, or null if it is not one.
 *
 * Normalising on read is not enough, and that gap was a real defect: the probe
 * normalised what it was handed while the save wrote the raw string through, so
 * Test and Save disagreed about what the host was. A user pasting
 * `http://127.0.0.1:11434/v1` — a form this module's own docstring calls
 * common — got a green "3 models available" from a probe of the origin, and a
 * stored value that then produced `…/v1/api/tags` for the adapter and
 * `…/v1/v1` for the engine. A scheme-less `127.0.0.1:11434`, the form Ollama's
 * own CLI teaches, lost its scheme entirely.
 *
 * So the write path normalises too, and this is the function both sides share.
 *
 * - **Empty means unspecified**, which has an obvious answer: the default host.
 * - **Non-empty and unparseable returns null**, for the caller to refuse. It is
 *   deliberately not defaulted: silently storing `127.0.0.1` for a credential
 *   whose field reads `my ollama box` is a screen that lies about what it saved.
 */
export function storableOllamaHost(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (raw === '') return OLLAMA_DEFAULT_HOST
  return normaliseOllamaHost(raw)
}

/**
 * The token stood in for an API key wherever one is structurally required.
 *
 * Two callers, both handing a keyless credential to something that insists on a
 * string: the OpenAI SDK, which throws on an absent `apiKey` before it makes a
 * request, and the OpenCode engine config, whose every provider entry names an
 * environment variable the session runner resolves a connection from.
 *
 * **It is not a secret and must never be treated as standing in for one.**
 * Ollama accepts any bearer token and validates none. A fixed literal is
 * deliberate: it is recognisable in a proxy log, and a random one would suggest
 * to a reader that it mattered.
 */
export const KEYLESS_PLACEHOLDER_KEY = 'keyless'

/**
 * Ollama's OpenAI-compatible endpoint, from a bare origin.
 *
 * Lives here rather than beside either caller because both need it and they sit
 * in different layers: the chat adapter points the OpenAI SDK at it, and the
 * engine config generator emits it as a custom provider entry's `baseURL`.
 *
 * The `/v1` matters, and the absence of a trailing slash matters: consumers
 * append `/chat/completions`, so a slash here yields `…/v1//chat/completions` —
 * which Ollama answers with a 404 that reads like a missing model.
 */
export function ollamaOpenAIBaseUrl(host: string): string {
  return `${host.replace(/\/+$/, '')}/v1`
}
