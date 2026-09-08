import { describe, expect, it } from 'vitest'
import {
  isCredentialUsable,
  normaliseOllamaHost,
  ollamaOpenAIBaseUrl,
  requiresApiKey,
  storableOllamaHost,
  OLLAMA_DEFAULT_HOST
} from './credentials'

describe('requiresApiKey', () => {
  it.each(['anthropic', 'openai', 'gemini', 'openai_compatible'])('%s needs a key', (type) => {
    expect(requiresApiKey(type)).toBe(true)
  })

  it('ollama does not', () => {
    expect(requiresApiKey('ollama')).toBe(false)
  })

  /**
   * An unknown type is treated as needing a key. Keyless is the exception and
   * has to be declared: defaulting the other way would make a typo in a type
   * string ("olama") into a credential the app quietly considers complete.
   */
  it('treats a type it has never heard of as needing one', () => {
    expect(requiresApiKey('some-future-provider')).toBe(true)
  })
})

describe('isCredentialUsable', () => {
  it('a keyed credential is usable exactly when it has its key', () => {
    expect(isCredentialUsable({ type: 'anthropic', hasApiKey: true })).toBe(true)
    expect(isCredentialUsable({ type: 'anthropic', hasApiKey: false })).toBe(false)
  })

  it('a keyless credential is usable with no key at all', () => {
    expect(isCredentialUsable({ type: 'ollama', hasApiKey: false })).toBe(true)
  })

  /**
   * `unsupported` outranks everything. It marks a managed credential the app
   * cannot call at all (an Anthropic OAuth token), and a keyless type must not
   * become a way around that flag.
   */
  it('unsupported wins over both', () => {
    expect(isCredentialUsable({ type: 'ollama', hasApiKey: false, unsupported: true })).toBe(false)
    expect(isCredentialUsable({ type: 'anthropic', hasApiKey: true, unsupported: true })).toBe(
      false
    )
  })

  /** Enablement is deliberately not part of this — see the function's own note. */
  it('says nothing about whether the credential is enabled', () => {
    expect(isCredentialUsable({ type: 'ollama', hasApiKey: false })).toBe(true)
  })
})

describe('normaliseOllamaHost', () => {
  const cases: [input: string, expected: string | null][] = [
    // The shapes `OLLAMA_HOST` is actually set to.
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['11434', 'http://127.0.0.1:11434'],
    ['0.0.0.0:11434', 'http://0.0.0.0:11434'],
    // The shapes a user pastes.
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434'],
    ['  http://127.0.0.1:11434  ', 'http://127.0.0.1:11434'],
    // One server, two spellings — which is what makes the duplicate check work.
    ['localhost:11434', 'http://127.0.0.1:11434'],
    ['http://localhost:11434', 'http://127.0.0.1:11434'],
    // A box on the LAN, and a remote one behind TLS.
    ['192.168.1.40:11434', 'http://192.168.1.40:11434'],
    ['https://ollama.example.com', 'https://ollama.example.com'],
    // Userinfo is dropped rather than stored — `baseUrl` is a column that gets
    // logged and rendered, and a password does not belong in it.
    ['http://user:pass@127.0.0.1:11434', 'http://127.0.0.1:11434'],
    // A scheme we do not speak is refused, not coerced. Without the check,
    // `ftp://x:11434` normalised to the plausible-looking nonsense `http://ftp`,
    // which something then tries to fetch.
    ['ftp://x:11434', null],
    ['file:///etc/passwd', null],
    ['ws://127.0.0.1:11434', null],
    ['javascript:alert(1)', null],
    // …but `host:port` has the same shape as `scheme:` to a regex, so the check
    // requires the `//`. This case is why.
    ['localhost:11434', 'http://127.0.0.1:11434'],
    /*
     * The authority is validated here rather than by `new URL`, because the two
     * processes do not have the same one: Chromium percent-encodes a space in a
     * host and Node throws, so this function — the shared predicate that
     * disables Save in the renderer *and* refuses the write in main — answered
     * differently on the two sides of the IPC boundary. The user got an enabled
     * Save button and a save that was then refused.
     *
     * Node is also not strict enough to lean on: it accepts `http://!!!` as the
     * host `!!!`, so that was being stored.
     *
     * **These tests run in Node, so they cannot see the split itself.** Node
     * throws on `not a url` either way, and jsdom uses the same parser — only a
     * real Chromium disagrees. What they do guard is that validation no longer
     * *depends* on the parser: `!!!`, `...` and `:::` all parse cleanly in Node
     * and are rejected only by the explicit authority check, so removing that
     * check fails here. The renderer half was verified by driving the built app.
     */
    ['not a url', null],
    ['http://not a url', null],
    ['!!!', null],
    ['http://!!!', null],
    ['...', null],
    [':::', null],
    // An IPv6 literal keeps its brackets, and is not collateral damage.
    ['[::1]:11434', 'http://[::1]:11434'],
    // Nothing usable.
    ['', null],
    ['   ', null],
    ['http://', null]
  ]

  it.each(cases)('%s → %s', (input, expected) => {
    expect(normaliseOllamaHost(input)).toBe(expected)
  })

  it('treats null and undefined as nothing said', () => {
    expect(normaliseOllamaHost(null)).toBeNull()
    expect(normaliseOllamaHost(undefined)).toBeNull()
  })

  it('is idempotent, so a stored value re-normalises to itself', () => {
    const once = normaliseOllamaHost('localhost:11434/v1')
    expect(once).toBe(OLLAMA_DEFAULT_HOST)
    expect(normaliseOllamaHost(once)).toBe(once)
  })
})

describe('ollamaOpenAIBaseUrl', () => {
  /**
   * The trailing slash is the whole point: the AI SDK and the OpenAI client
   * both append `/chat/completions`, and `…/v1//chat/completions` is a 404 that
   * reads like a missing model rather than a malformed URL.
   */
  it('appends exactly one /v1, whatever the host ends with', () => {
    expect(ollamaOpenAIBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1')
    expect(ollamaOpenAIBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434/v1')
    expect(ollamaOpenAIBaseUrl('http://127.0.0.1:11434///')).toBe('http://127.0.0.1:11434/v1')
  })
})

/**
 * The write path, which used to not exist — the probe normalised and the save
 * did not, so Test and Save disagreed about what the host was.
 */
describe('storableOllamaHost', () => {
  it('unspecified resolves to the default rather than failing', () => {
    expect(storableOllamaHost('')).toBe(OLLAMA_DEFAULT_HOST)
    expect(storableOllamaHost('   ')).toBe(OLLAMA_DEFAULT_HOST)
    expect(storableOllamaHost(null)).toBe(OLLAMA_DEFAULT_HOST)
    expect(storableOllamaHost(undefined)).toBe(OLLAMA_DEFAULT_HOST)
  })

  /**
   * The two shapes that were actually broken. A stored `…:11434/v1` made the
   * adapter fetch `…/v1/api/tags` and the engine emit `…/v1/v1`; a stored
   * `127.0.0.1:11434` reached the engine with no scheme at all.
   */
  it('strips a pasted /v1 so it cannot be appended twice', () => {
    expect(storableOllamaHost('http://127.0.0.1:11434/v1')).toBe(OLLAMA_DEFAULT_HOST)
    expect(ollamaOpenAIBaseUrl(storableOllamaHost('http://127.0.0.1:11434/v1')!)).toBe(
      'http://127.0.0.1:11434/v1'
    )
  })

  it('adds the scheme a bare host:port is missing', () => {
    expect(storableOllamaHost('127.0.0.1:11434')).toBe(OLLAMA_DEFAULT_HOST)
    expect(storableOllamaHost('192.168.1.40:11434')).toBe('http://192.168.1.40:11434')
  })

  /**
   * Null, not the default. Storing `127.0.0.1` for a field that reads
   * "my ollama box" is a screen that lies about what it saved; the caller
   * refuses instead.
   */
  it('returns null for something non-empty it cannot parse', () => {
    expect(storableOllamaHost('my ollama box')).toBeNull()
    expect(storableOllamaHost('http://')).toBeNull()
  })

  it('is idempotent, so re-saving an unchanged card changes nothing', () => {
    const once = storableOllamaHost('localhost:11434/v1')
    expect(storableOllamaHost(once)).toBe(once)
  })
})
