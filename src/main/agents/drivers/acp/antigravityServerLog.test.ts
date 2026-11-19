import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS,
  ANTIGRAVITY_SERVER_LOG_TAIL_BYTES,
  antigravityTranscriptPath,
  classifyProviderError,
  createProviderErrorWatch,
  providerErrorNotice,
  readAntigravityProviderErrors,
  type AntigravityProviderError
} from './antigravityServerLog'

/**
 * Antigravity's server writes a Gemini error into its own transcript and
 * nothing on the ACP wire. Only SYSTEM ERROR_MESSAGE steps from this turn on
 * are provider errors; nothing else of the file (the user's prompts) is read out.
 */

const SESSION = '7d0c3a52-1b9e-4f3e-9a51-2f7a3c1d9e00'
const homes: string[] = []
const at = (iso: string): number => Date.parse(iso)

function home(lines: (string | object)[], sessionId = SESSION): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-'))
  homes.push(dir)
  const path = antigravityTranscriptPath(dir, sessionId)!
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n')
  return dir
}

const step = (index: number, extra: Record<string, unknown>): Record<string, unknown> => ({ step_index: index, status: 'DONE', created_at: '2026-11-19T09:42:13Z', ...extra })
const PROMPT = step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', user_input: 'my secret prompt' })
const SYSTEM_503 = step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'The model is currently unreachable.', error_code: 503 })
const SINCE = at('2026-11-19T09:42:00Z')

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readAntigravityProviderErrors', () => {
  it('finds a SYSTEM error message with its code, and nothing of the prompt', async () => {
    const found = await readAntigravityProviderErrors(home([PROMPT, SYSTEM_503]), SESSION, SINCE)
    expect(found).toEqual([{ stepIndex: 2, message: 'The model is currently unreachable.', code: 503, at: at('2026-11-19T09:42:13Z') }])
    expect(JSON.stringify(found)).not.toContain('secret')
  })

  it('ignores a MODEL error message (a tool denial) and other steps', async () => {
    const denial = step(3, { source: 'MODEL', type: 'ERROR_MESSAGE', error: 'Permission denied by user.' })
    const plain = step(4, { source: 'SYSTEM', type: 'PLANNER_RESPONSE', error: 'not an error step' })
    expect(await readAntigravityProviderErrors(home([PROMPT, denial, plain]), SESSION, SINCE)).toEqual([])
  })

  it('keeps errors from `since` on, with a two-second slack for second precision', async () => {
    const dir = home([
      step(1, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'old', created_at: '2026-11-19T09:40:00Z' }),
      step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'same second', created_at: '2026-11-19T09:42:00Z' }),
      step(3, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'undated', created_at: 'never' })
    ])
    const found = await readAntigravityProviderErrors(dir, SESSION, SINCE + 900)
    expect(found.map((error) => error.message)).toEqual(['same second'])
  })

  it('omits a code the step does not carry', async () => {
    const found = await readAntigravityProviderErrors(home([step(5, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'Quota exhausted.' })]), SESSION, SINCE)
    expect(found).toEqual([{ stepIndex: 5, message: 'Quota exhausted.', at: at('2026-11-19T09:42:13Z') }])
  })

  it('answers nothing for a missing file or home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-log-'))
    homes.push(dir)
    expect(await readAntigravityProviderErrors(dir, SESSION, SINCE)).toEqual([])
    expect(await readAntigravityProviderErrors(join(dir, 'nope'), SESSION, SINCE)).toEqual([])
  })

  it('skips malformed and partial lines', async () => {
    const dir = home(['{"step_index":1,', 'not json', '[]', 'null', SYSTEM_503, '{"step_index":9,"source":"SYSTEM","type":"ERROR_MES'])
    expect((await readAntigravityProviderErrors(dir, SESSION, SINCE)).map((error) => error.stepIndex)).toEqual([2])
  })

  it('reads only the file’s tail', async () => {
    const early = step(1, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'early' })
    const filler = step(2, { source: 'MODEL', type: 'PLANNER_RESPONSE', text: 'x'.repeat(ANTIGRAVITY_SERVER_LOG_TAIL_BYTES) })
    const late = step(3, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'late' })
    const found = await readAntigravityProviderErrors(home([early, filler, late]), SESSION, SINCE)
    expect(found.map((error) => error.message)).toEqual(['late'])
  })

  it('refuses a session id that is not a plain id', async () => {
    for (const bad of ['../x', 'a/b', '..', '.', '', 'a\\b', 'a\0b']) {
      expect(antigravityTranscriptPath('/h', bad)).toBeNull()
      expect(await readAntigravityProviderErrors('/h', bad, SINCE)).toEqual([])
    }
    expect(antigravityTranscriptPath('/h', SESSION)).toBe(join('/h', 'antigravity-acp', 'brain', SESSION, '.system_generated', 'logs', 'transcript_full.jsonl'))
  })

  it('caps the message and strips control characters', async () => {
    const long = step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: `Bad\u001b[31m\nthing ${'y'.repeat(1000)}`, error_code: 500 })
    const [found] = await readAntigravityProviderErrors(home([long]), SESSION, SINCE)
    expect(found.message.length).toBeLessThanOrEqual(ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS)
    expect(found.message.startsWith('Bad [31m thing yyy')).toBe(true)
    expect(found.message.endsWith('…')).toBe(true)
    expect(/[\u0000-\u001f]/.test(found.message)).toBe(false)
  })
})

describe('which errors belong to this turn', () => {
  const input = (index: number, created = '2026-11-19T09:42:05Z'): Record<string, unknown> =>
    step(index, { source: 'USER_EXPLICIT', type: 'USER_INPUT', user_input: 'secret prompt', created_at: created })
  const error = (index: number, text: string, created = '2026-11-19T09:42:13Z'): Record<string, unknown> =>
    step(index, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: text, error_code: 503, created_at: created })

  it('takes only errors after the last USER_INPUT, whatever their timestamps', async () => {
    // Mutation: drop the `stepIndex <= lastInput.index` check → the earlier turn's fresh-stamped error shows.
    const dir = home([input(0), error(1, 'earlier turn'), input(2), error(3, 'this turn', 'not a date')])
    const found = await readAntigravityProviderErrors(dir, SESSION, SINCE)
    expect(found.map((e) => e.message)).toEqual(['this turn'])
    expect(JSON.stringify(found)).not.toContain('secret')
  })

  it('falls back on `since` when the last USER_INPUT is an earlier turn’s (this turn’s is not written yet)', async () => {
    const dir = home([input(0, '2026-11-19T09:30:00Z'), error(1, 'old', '2026-11-19T09:31:00Z'), error(2, 'new')])
    expect((await readAntigravityProviderErrors(dir, SESSION, SINCE)).map((e) => e.message)).toEqual(['new'])
  })
})

/** Verbatim from a real 1.4.5 transcript with Gemini blackholed (error_code 2). */
const BLACKHOLE = 'doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse": dial tcp 10.255.255.1:443: i/o timeout: doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse": dial tcp 10.255.255.1:443: i/o timeout'

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
    const long = providerErrorNotice({ message: 'z'.repeat(500) })
    expect(long.length).toBeLessThan(300)
    expect(long).toContain('…')
  })
})

describe('createProviderErrorWatch', () => {
  const error = (stepIndex: number): AntigravityProviderError => ({ stepIndex, message: `e${stepIndex}`, at: 0 })
  const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('reports each step once, from `start` until `heard`, and survives a throwing read', async () => {
    let errors: AntigravityProviderError[] = []
    let fail = false
    const read = vi.fn(async () => { if (fail) throw new Error('EIO'); return errors })
    const seen: number[] = []
    const watch = createProviderErrorWatch({ pollMs: 10, read, home: '/h', sessionId: () => 's1', onError: (e) => void seen.push(e.stepIndex), now: () => 1234 })
    await tick(30)
    expect(read).not.toHaveBeenCalled()
    watch.start()
    errors = [error(1)]
    await tick(40)
    fail = true
    await tick(30)
    fail = false
    errors = [error(1), error(2)]
    await tick(40)
    expect(seen).toEqual([1, 2])
    expect(read).toHaveBeenCalledWith('/h', 's1', 1234)
    watch.heard()
    errors = [error(1), error(2), error(3)]
    const calls = read.mock.calls.length
    await tick(40)
    expect(read.mock.calls.length).toBe(calls)
    expect(seen).toEqual([1, 2])
  })

  it('reports a retried error once: later steps with the same code and message are repeats', async () => {
    // Mutation: dedupe by step only → three notes for one 503.
    const same = (stepIndex: number): AntigravityProviderError => ({ stepIndex, message: 'The model is currently unreachable.', code: 503, at: 0 })
    let errors = [same(2)]
    const seen: number[] = []
    const repeats: number[] = []
    const watch = createProviderErrorWatch({ pollMs: 10, read: async () => errors, home: '/h', sessionId: () => 's1',
      onError: (e) => void seen.push(e.stepIndex), onRepeat: (e) => void repeats.push(e.stepIndex) })
    watch.start()
    await tick(30)
    errors = [same(2), same(3), same(4), { ...same(5), code: 429 }]
    await tick(40)
    watch.stop()
    expect(seen).toEqual([2, 5])
    expect(repeats).toEqual([3, 4])
  })
})
