import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS,
  ANTIGRAVITY_PROVIDER_ERRORS_MAX,
  checkedVaultProviderErrors,
  classifyProviderError,
  parseProviderErrors,
  plainAntigravitySessionId,
  providerErrorKey,
  providerErrorNotice,
  redactProviderErrorMessage,
  vaultProviderErrorEntries
} from './antigravityProviderErrors'

/**
 * The shared half of Antigravity's provider errors: one parser for the host's
 * own transcript read and vaultd's `engine.providerErrors`. Only SYSTEM
 * ERROR_MESSAGE steps of this turn are provider errors; nothing else of the
 * file (the user's prompts) is read out, and every message is redacted.
 */

const at = (iso: string): number => Date.parse(iso)
const step = (index: number, extra: Record<string, unknown>): Record<string, unknown> => ({ step_index: index, status: 'DONE', created_at: '2026-11-19T09:42:13Z', ...extra })
const transcript = (lines: (string | object)[]): string => lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
const SINCE = at('2026-11-19T09:42:00Z')
const PROMPT = step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', user_input: 'my secret prompt' })
/** The 503 shape, verbatim from a real 1.4.5 transcript. */
const SYSTEM_503 = step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'The model is currently unreachable.', error_code: 503 })
/** Verbatim from a real 1.4.5 transcript with Gemini blackholed (error_code 2). */
const BLACKHOLE = 'doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse": dial tcp 10.255.255.1:443: i/o timeout: doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse": dial tcp 10.255.255.1:443: i/o timeout'

describe('parseProviderErrors', () => {
  it('finds the SYSTEM 503 with its code, and nothing of the prompt', () => {
    const found = parseProviderErrors(transcript([PROMPT, SYSTEM_503]), SINCE)
    expect(found).toEqual([{ stepIndex: 2, message: 'The model is currently unreachable.', code: 503, at: at('2026-11-19T09:42:13Z') }])
    expect(JSON.stringify(found)).not.toContain('secret')
  })

  it('ignores a MODEL error message (a tool denial) and other steps', () => {
    const denial = step(3, { source: 'MODEL', type: 'ERROR_MESSAGE', error: 'Permission denied by user.' })
    const plain = step(4, { source: 'SYSTEM', type: 'PLANNER_RESPONSE', error: 'not an error step' })
    expect(parseProviderErrors(transcript([PROMPT, denial, plain]), SINCE)).toEqual([])
  })

  it('caps the message and strips control characters', () => {
    const long = step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: `Bad\u001b[31m\nthing ${'y '.repeat(1000)}`, error_code: 500 })
    const [found] = parseProviderErrors(transcript([long]), SINCE)
    expect(found.message.length).toBeLessThanOrEqual(ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS)
    expect(found.message.startsWith('Bad [31m thing y y')).toBe(true)
    expect(found.message.endsWith('…')).toBe(true)
    expect(/[\u0000-\u001f]/.test(found.message)).toBe(false)
  })

  it('redacts every message it returns', () => {
    // Mutation: drop the redaction from `providerErrorMessageOf` → the key leaves the parser.
    const keyed = step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'API key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW not valid.', error_code: 400 })
    const [found] = parseProviderErrors(transcript([keyed]), SINCE)
    expect(found.message).toBe('API key [redacted] not valid.')
  })
})

describe('which errors belong to this turn', () => {
  const input = (index: number, created = '2026-11-19T09:42:05Z'): Record<string, unknown> =>
    step(index, { source: 'USER_EXPLICIT', type: 'USER_INPUT', user_input: 'secret prompt', created_at: created })
  const error = (index: number, text: string, created = '2026-11-19T09:42:13Z'): Record<string, unknown> =>
    step(index, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: text, error_code: 503, created_at: created })

  it('takes only errors after the last USER_INPUT, whatever their timestamps', () => {
    // Mutation: drop the `stepIndex <= lastInput.index` check → the earlier turn's fresh-stamped error shows.
    const found = parseProviderErrors(transcript([input(0), error(1, 'earlier turn'), input(2), error(3, 'this turn', 'not a date')]), SINCE)
    expect(found.map((e) => e.message)).toEqual(['this turn'])
    expect(JSON.stringify(found)).not.toContain('secret')
  })

  it('falls back on `since` when the last USER_INPUT is an earlier turn’s (this turn’s is not written yet)', () => {
    const text = transcript([input(0, '2026-11-19T09:30:00Z'), error(1, 'old', '2026-11-19T09:31:00Z'), error(2, 'new')])
    expect(parseProviderErrors(text, SINCE).map((e) => e.message)).toEqual(['new'])
  })

  it('keeps errors from `since` on, with a two-second slack for second precision, when no prompt is in the tail', () => {
    const text = transcript([
      step(1, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'old', created_at: '2026-11-19T09:40:00Z' }),
      step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'same second', created_at: '2026-11-19T09:42:00Z' }),
      step(3, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'undated', created_at: 'never' })
    ])
    expect(parseProviderErrors(text, SINCE + 900).map((e) => e.message)).toEqual(['same second'])
  })
})

describe('plainAntigravitySessionId', () => {
  it('takes a plain id of at most 128 characters and nothing that could leave the brain folder', () => {
    expect(plainAntigravitySessionId('7d0c3a52-1b9e-4f3e-9a51-2f7a3c1d9e00')).toBe(true)
    expect(plainAntigravitySessionId('ses-silent-1.2_x')).toBe(true)
    expect(plainAntigravitySessionId('a'.repeat(128))).toBe(true)
    for (const bad of ['../x', 'a/b', '..', '.', '', 'a\\b', 'a\0b', 'a..b', 'a'.repeat(129), 'a b', 3, null]) {
      expect(plainAntigravitySessionId(bad)).toBe(false)
    }
  })
})

describe('redactProviderErrorMessage', () => {
  it.each([
    ['a URL query', 'GET https://generativelanguage.googleapis.com/v1beta/models?key=abc123&alt=sse failed', 'GET https://generativelanguage.googleapis.com/v1beta/models failed'],
    ['a URL fragment and userinfo', 'see https://user:pw@example.com/a/b#frag now', 'see https://example.com/a/b now'],
    ['a long URL path segment', 'https://example.com/v1/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x', 'https://example.com/v1/[redacted]/x'],
    ['a Bearer token', 'got Bearer ya29.a0AfH6SMBx-short back', 'got Bearer [redacted] back'],
    ['an Authorization header', 'Authorization: Basic dXNlcjpwYXNz, then', 'Authorization: [redacted], then'],
    ['an Authorization header with Bearer', 'authorization=Bearer abc.def', 'authorization=[redacted]'],
    ['an x-goog-api-key header', 'x-goog-api-key: shortkey1 refused', 'x-goog-api-key: [redacted] refused'],
    ['a key= value', 'request key=abc123 refused', 'request key=[redacted] refused'],
    ['an api_key= value', 'api_key="xyz" and apikey=qq and api-key=zz', 'api_key="[redacted]" and apikey=[redacted] and api-key=[redacted]'],
    ['a Google API key', 'API key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW is invalid', 'API key [redacted] is invalid'],
    ['an sk- key', 'key sk-proj-abcdEFGH1234ijkl5678 refused', 'key [redacted] refused'],
    ['an sk-ant- key', 'token sk-ant-api03-abcdEFGH1234ijkl refused', 'token [redacted] refused'],
    ['a JSON api_key', '{"api_key":"abc123","x":1}', '{"api_key":"[redacted]","x":1}'],
    ['an api_key with a colon', 'api_key: abc123 refused', 'api_key: [redacted] refused'],
    ['a JSON x-goog-api-key', '{"x-goog-api-key": "abc123"}', '{"x-goog-api-key": "[redacted]"}'],
    ['a JSON Authorization', '{"authorization":"Basic dXNlcjpwYXNz"}', '{"authorization":"[redacted]"}'],
    ['a Proxy-Authorization header', 'Proxy-Authorization: Negotiate abc', 'Proxy-Authorization: [redacted]'],
    ['a token', 'token=abc123 and "access_token": "xyz" and refresh_token:qq', 'token=[redacted] and "access_token": "[redacted]" and refresh_token:[redacted]'],
    ['a password and a secret', 'password=hunter2; secret: s3', 'password=[redacted]; secret: [redacted]'],
    ['a cookie header to the end of the line', 'Cookie: SID=abc; HSID=def\nnext', 'Cookie: [redacted]\nnext'],
    ['a set-cookie header', 'set-cookie: NID=511=abc; Path=/', 'set-cookie: [redacted]'],
    ['a wss URL with userinfo and query', 'dial wss://u:p@relay.example.com/live?token=abc now', 'dial wss://relay.example.com/live now'],
    ['an ftp URL query', 'ftp://files.example.com/a?x=1', 'ftp://files.example.com/a'],
    ['a long run that is not a hostname', 'see ABCDEFGHIJKLMNOPQRSTUVWXYZ.abcdefghij.com end', 'see [redacted] end'],
    ['a long opaque token', 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 expired', 'session [redacted] expired']
  ])('redacts %s', (_what, raw, redacted) => {
    expect(redactProviderErrorMessage(raw)).toBe(redacted)
  })

  it('keeps plain error text, a short code and the host of a URL as they are', () => {
    expect(redactProviderErrorMessage('The model is currently unreachable.')).toBe('The model is currently unreachable.')
    expect(redactProviderErrorMessage('Resource has been exhausted (e.g. check quota).')).toBe('Resource has been exhausted (e.g. check quota).')
    expect(redactProviderErrorMessage(BLACKHOLE)).not.toContain('?alt=sse')
    expect(redactProviderErrorMessage(BLACKHOLE)).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent"')
  })

  it('keeps a bare hostname, however long, that an opaque run would otherwise take', () => {
    // Mutation: drop the HOSTNAME exemption in `redactOpaque` → the host becomes [redacted].
    const lookup = 'dial tcp: lookup generativelanguage.googleapis.com: no such host'
    expect(redactProviderErrorMessage(lookup)).toBe(lookup)
    expect(redactProviderErrorMessage('host averyveryverylongsubdomainname.example.co.uk refused')).toBe('host averyveryverylongsubdomainname.example.co.uk refused')
  })

  it('runs in linear time on 100k-character adversarial input', () => {
    const inputs = [
      'a'.repeat(100_000), 'a.'.repeat(50_000), 'key='.repeat(25_000), 'key '.repeat(25_000), 'https://'.repeat(12_500),
      'Bearer '.repeat(14_000), 'authorization:'.repeat(7_000), '"api_key": "'.repeat(8_000), 'x' + ' '.repeat(100_000) + ':',
      'cookie: '.repeat(12_000), 'a1b2'.repeat(25_000) + '!', 'sk-'.repeat(33_000), 'AIza'.repeat(25_000)
    ]
    for (const input of inputs) {
      const t = performance.now()
      redactProviderErrorMessage(input)
      expect(performance.now() - t, input.slice(0, 20)).toBeLessThan(250)
    }
  })

  it('still classifies a redacted transport chain', () => {
    const redacted = redactProviderErrorMessage(BLACKHOLE)
    expect(classifyProviderError({ message: redacted, code: 2 })).toEqual({ kind: 'transport', phrase: 'connection timed out' })
    expect(providerErrorNotice({ message: redacted, code: 2 })).toBe('Antigravity could not reach Gemini (connection timed out).')
  })
})

describe('providerErrorNotice', () => {
  it('says a transport failure as a phrase, without the URL, the address or the non-HTTP code', () => {
    expect(BLACKHOLE.length).toBe(368)
    expect(classifyProviderError({ message: BLACKHOLE, code: 2 })).toEqual({ kind: 'transport', phrase: 'connection timed out' })
    const note = providerErrorNotice({ message: BLACKHOLE, code: 2 })
    expect(note).toBe('Antigravity could not reach Gemini (connection timed out).')
    expect(note).not.toMatch(/googleapis|10\.255|\(2\)/)
  })

  it.each([
    ['dial tcp: lookup generativelanguage.googleapis.com: no such host', 'host not found'],
    ['dial tcp 1.2.3.4:443: connect: connection refused', 'connection refused'],
    ['read tcp: connection reset by peer', 'connection reset'],
    ['doRequest: error sending request: net/http: TLS handshake timeout', 'TLS handshake failed'],
    ['remote error: TLS handshake failure in dial tcp', 'TLS handshake failed'],
    ['doRequest: error sending request: EOF', 'network error']
  ])('names %s as %s', (message, phrase) => {
    expect(providerErrorNotice({ message })).toBe(`Antigravity could not reach Gemini (${phrase}).`)
  })

  it('names an HTTP status', () => {
    expect(providerErrorNotice({ message: 'The model is currently unreachable.', code: 503 }))
      .toBe('Gemini answered an error (503): The model is currently unreachable.')
  })

  it('says anything else once, capped, with no code that is not an HTTP status', () => {
    expect(providerErrorNotice({ message: 'Quota exhausted: Quota exhausted', code: 2 }))
      .toBe('Antigravity reported an error from Gemini: Quota exhausted.')
    expect(providerErrorNotice({ message: 'Something odd.' }))
      .toBe('Antigravity reported an error from Gemini: Something odd.')
    const long = providerErrorNotice({ message: 'z '.repeat(250) })
    expect(long.length).toBeLessThan(300)
    expect(long).toContain('…')
  })
})

describe('the vault wire', () => {
  const found = (stepIndex: number, message = 'The model is currently unreachable.', code: number | undefined = 503) =>
    ({ stepIndex, message, ...(code !== undefined ? { code } : {}), at: at('2026-11-19T09:42:13Z') })

  it('answers the newest errors with their dedupe key, an undated one at 0', () => {
    const many = Array.from({ length: ANTIGRAVITY_PROVIDER_ERRORS_MAX + 3 }, (_, i) => found(i + 1))
    const entries = vaultProviderErrorEntries([...many, { stepIndex: 99, message: 'Undated.', at: NaN }])
    expect(entries).toHaveLength(ANTIGRAVITY_PROVIDER_ERRORS_MAX)
    expect(entries.at(-1)).toEqual({ key: providerErrorKey({ message: 'Undated.' }), stepIndex: 99, message: 'Undated.', at: 0 })
    expect(entries[0]).toEqual({ key: '503|the model is currently unreachable.', stepIndex: 5, code: 503, message: 'The model is currently unreachable.', at: at('2026-11-19T09:42:13Z') })
  })

  it('checks an answer on the host: malformed entries dropped, messages redacted again, at most the cap', () => {
    const good = { key: 'k', stepIndex: 2, code: 503, message: 'The model is currently unreachable.', at: 5 }
    const answer = {
      errors: [
        good,
        { ...good, stepIndex: 3, message: 'leaked ?key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW' },
        { ...good, stepIndex: 'x' },
        { ...good, message: 7 },
        { ...good, code: 5.5 },
        { ...good, at: 'now' },
        { ...good, key: undefined },
        { ...good, message: '   ' },
        null,
        'text'
      ]
    }
    // Mutation: drop the host's redaction in `checkedVaultProviderErrors` → the key passes through.
    expect(checkedVaultProviderErrors(answer)).toEqual([
      { stepIndex: 2, code: 503, message: 'The model is currently unreachable.', at: 5 },
      { stepIndex: 3, code: 503, message: 'leaked ?key [redacted]', at: 5 }
    ])
    expect(checkedVaultProviderErrors({ errors: Array.from({ length: 20 }, (_, i) => ({ ...good, stepIndex: i })) })).toHaveLength(ANTIGRAVITY_PROVIDER_ERRORS_MAX)
    for (const bad of [null, undefined, 'x', {}, { errors: 'x' }, []]) expect(checkedVaultProviderErrors(bad)).toEqual([])
    const long = checkedVaultProviderErrors({ errors: [{ ...good, message: 'w '.repeat(2000) }] })
    expect(long[0].message.length).toBeLessThanOrEqual(ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS)
  })
})
