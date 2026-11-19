import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS,
  ANTIGRAVITY_SERVER_LOG_TAIL_BYTES,
  antigravityTranscriptPath,
  createProviderErrorWatch,
  readAntigravityProviderErrors,
  vaultProviderErrorReader,
  type AntigravityProviderError
} from './antigravityServerLog'

/**
 * Antigravity's server writes a Gemini error into its own transcript and
 * nothing on the ACP wire. The host's file IO and the watch; what a line means,
 * the redaction and the note's words are tested with the shared parser
 * (`src/shared/antigravityProviderErrors.test.ts`).
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
    const long = step(2, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: `Bad\u001b[31m\nthing ${'y '.repeat(1000)}`, error_code: 500 })
    const [found] = await readAntigravityProviderErrors(home([long]), SESSION, SINCE)
    expect(found.message.length).toBeLessThanOrEqual(ANTIGRAVITY_PROVIDER_ERROR_MAX_CHARS)
    expect(found.message.startsWith('Bad [31m thing y y')).toBe(true)
    expect(found.message.endsWith('…')).toBe(true)
    expect(/[\u0000-\u001f]/.test(found.message)).toBe(false)
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

describe('a reader that cannot answer for its connection', () => {
  const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('ends the watch at the first null: no more reads, nothing reported', async () => {
    // Mutation: drop the `errors === null` finish → reads go on every poll.
    const read = vi.fn(async () => null)
    const seen: number[] = []
    const watch = createProviderErrorWatch({ pollMs: 10, read, home: '', sessionId: () => 's1', onError: (e) => void seen.push(e.stepIndex) })
    watch.start()
    await tick(60)
    expect(read).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([])
    watch.stop()
  })

  it('asks the vault connection, checks and redacts its answer, and answers null when it cannot ask', async () => {
    const providerErrors = vi.fn(async () => ({ errors: [
      { key: 'k', stepIndex: 2, code: 503, message: 'The model is currently unreachable.', at: 7 },
      { key: 'k', stepIndex: 'three', message: 'malformed', at: 7 },
      { key: 'k', stepIndex: 4, message: 'Bearer abc.def refused', at: 7 }
    ] }))
    const read = vaultProviderErrorReader(() => ({ providerErrors }))
    expect(await read('', 's1', 1234)).toEqual([
      { stepIndex: 2, code: 503, message: 'The model is currently unreachable.', at: 7 },
      { stepIndex: 4, message: 'Bearer [redacted] refused', at: 7 }
    ])
    expect(providerErrors).toHaveBeenCalledWith('s1', 1234)
    expect(await vaultProviderErrorReader(() => ({ providerErrors: async () => null }))('', 's1', 0)).toBeNull()
    expect(await vaultProviderErrorReader(() => ({}))('', 's1', 0)).toBeNull()
    expect(await vaultProviderErrorReader(() => undefined)('', 's1', 0)).toBeNull()
  })
})
