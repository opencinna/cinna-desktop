import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseProviderErrors } from '../../../../../src/shared/antigravityProviderErrors'
import { providerErrorsScript, readTranscriptTail } from '../src/providerErrors'
import { attach, Client, startVaultd, type Harness } from './harness'

/**
 * `engine.providerErrors` (fake mode): the provider errors a vault Antigravity
 * server logged into its own transcript under the agent's home, read as the
 * agent user and parsed with the host's parser. Only SYSTEM error steps of the
 * current turn leave, redacted and capped; a link out of the brain folder is
 * refused, never followed; only a live Antigravity stream may ask.
 */

let h: Harness
let c: Client
let engine: Socket | null = null
let outside = ''

const SESSION = 'ses-silent-1'
/** As the server stamps a step: seconds precision. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
/** Every step here was logged a few seconds ago; every ask looks back a minute. */
const CREATED = iso(Date.now() - 5_000)
const AGO = 60_000
const step = (index: number, extra: Record<string, unknown>): Record<string, unknown> => ({ step_index: index, status: 'DONE', created_at: CREATED, ...extra })
const PROMPT = (index: number): Record<string, unknown> => step(index, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'my secret prompt' })
const DENIAL = (index: number): Record<string, unknown> => step(index, { source: 'MODEL', type: 'ERROR_MESSAGE', error: 'Permission to run the command was denied by the user.' })
const SYSTEM = (index: number, error = 'The model is currently unreachable.', code: number | undefined = 503): Record<string, unknown> =>
  step(index, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error, ...(code !== undefined ? { error_code: code } : {}) })

const brain = (): string => join(h.root, 'home', '.gemini', 'antigravity-acp', 'brain')
const logsOf = (sessionId: string): string => join(brain(), sessionId, '.system_generated', 'logs')

function writeTranscript(lines: object[], sessionId = SESSION): string {
  mkdirSync(logsOf(sessionId), { recursive: true })
  const file = join(logsOf(sessionId), 'transcript_full.jsonl')
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return file
}

/** A stand-in Antigravity server, indexed as `runtime.install` would; it just echoes its stdin. */
function installAntigravity(): void {
  const dir = join(h.root, 'runtime', 'antigravity', '1.0.0')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agy_acp_server.par'), '#!/bin/sh\nexec cat\n', { mode: 0o755 })
  writeFileSync(join(h.root, 'runtime', 'index.json'), JSON.stringify({ runtimes: [{ engine: 'antigravity', version: '1.0.0', kind: 'archive', name: 'agy_acp_server.par', sha256: 'x', installedAt: 1 }] }))
}

async function spawnAntigravity(): Promise<string> {
  installAntigravity()
  const { stream } = await c.call<{ stream: string }>('engine.spawn', { engine: 'antigravity', options: {} })
  engine = await attach(h.sock, stream)
  engine.on('error', () => {})
  return stream
}

type Answer = { errors: { key: string; stepIndex: number; code?: number; message: string; at: number }[] }

beforeEach(async () => {
  h = await startVaultd()
  c = await Client.open(h.sock)
  await c.call('layout.ensure')
})

afterEach(async () => {
  engine?.destroy()
  engine = null
  c?.close()
  await h?.stop()
  if (outside) rmSync(outside, { recursive: true, force: true })
  outside = ''
})

describe('engine.providerErrors', () => {
  it('answers the SYSTEM 503 after the last prompt, never the MODEL denial, an earlier turn’s error or the prompt', async () => {
    const stream = await spawnAntigravity()
    writeTranscript([PROMPT(0), SYSTEM(1, 'An earlier turn’s error.', 500), PROMPT(2), DENIAL(3), SYSTEM(4), SYSTEM(5)])
    const answer = await c.call<Answer>('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: AGO })
    expect(answer).toEqual({ errors: [
      { key: '503|the model is currently unreachable.', stepIndex: 4, code: 503, message: 'The model is currently unreachable.', at: Date.parse(CREATED) },
      { key: '503|the model is currently unreachable.', stepIndex: 5, code: 503, message: 'The model is currently unreachable.', at: Date.parse(CREATED) }
    ] })
    expect(JSON.stringify(answer)).not.toMatch(/secret|denied|earlier/i)
  })

  it('dates the turn on the guest’s own clock: a guest 60 s behind the host still answers this turn’s error', async () => {
    // No prompt in the tail, so only the dates decide. The host's prompt was 2 s ago on its
    // clock; the guest's clock (vaultd's, the server's stamps) runs 60 s behind it.
    const stream = await spawnAntigravity()
    const hostNow = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now: hostNow - 60_000 })
    try {
      const file = writeTranscript([SYSTEM(3, 'The model is currently unreachable.', 503), step(1, { source: 'SYSTEM', type: 'ERROR_MESSAGE', error: 'An hour old.', created_at: iso(Date.now() - 3_600_000) })].map((line, i) =>
        i === 0 ? { ...line, created_at: iso(Date.now()) } : line))
      // The old wire, a host date compared with the guest's stamps, drops it.
      expect(parseProviderErrors(readFileSync(file, 'utf8'), hostNow - 2_000)).toEqual([])
      const answer = await c.call<Answer>('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: 2_000 })
      expect(answer.errors.map((error) => error.message)).toEqual(['The model is currently unreachable.'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers no errors for a session with no transcript yet', async () => {
    const stream = await spawnAntigravity()
    expect(await c.call('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: AGO })).toEqual({ errors: [] })
  })

  it('redacts every message and caps the answer at the newest eight, each at most 1000 characters', async () => {
    const stream = await spawnAntigravity()
    const errors = Array.from({ length: 11 }, (_, i) => SYSTEM(i + 1, `Failure ${i} ${'w '.repeat(800)}`, 500 + i))
    writeTranscript([PROMPT(0), SYSTEM(20, 'API key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW not valid; see https://x.example/v1?key=abc', 400), ...errors])
    const answer = await c.call<Answer>('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: AGO })
    expect(answer.errors).toHaveLength(8)
    // Mutation: drop the cap in `vaultProviderErrorEntries` → nine or more answered.
    expect(answer.errors.map((error) => error.stepIndex)).toEqual([20, 4, 5, 6, 7, 8, 9, 10, 11].slice(-8))
    for (const error of answer.errors) expect(error.message.length).toBeLessThanOrEqual(1000)
    writeTranscript([PROMPT(0), SYSTEM(1, 'API key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW not valid; see https://x.example/v1?key=abc', 400)])
    const keyed = await c.call<Answer>('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: AGO })
    expect(keyed.errors.map((error) => error.message)).toEqual(['API key [redacted] not valid; see https://x.example/v1'])
    expect(JSON.stringify(keyed)).not.toContain('AIza')
  })

  it('refuses a transcript that is a link to a file outside, and does not follow it', async () => {
    const stream = await spawnAntigravity()
    outside = mkdtempSync(join(tmpdir(), 'vd-out-'))
    const target = join(outside, 'root-only.jsonl')
    writeFileSync(target, JSON.stringify(SYSTEM(1, 'LEAKED-FROM-OUTSIDE')) + '\n')
    mkdirSync(logsOf(SESSION), { recursive: true })
    symlinkSync(target, join(logsOf(SESSION), 'transcript_full.jsonl'))
    const refused = await c.call('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: 0 }).catch((error: { data?: { code: string }; message: string }) => error)
    expect((refused as { data?: { code: string } }).data?.code).toBe('invalid')
    expect(JSON.stringify(refused)).not.toContain('LEAKED')
  })

  it('refuses a session folder or a brain folder reached through a link', async () => {
    const stream = await spawnAntigravity()
    outside = mkdtempSync(join(tmpdir(), 'vd-out-'))
    const logs = join(outside, 'session', '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript_full.jsonl'), JSON.stringify(SYSTEM(1, 'LEAKED-FROM-OUTSIDE')) + '\n')
    mkdirSync(brain(), { recursive: true })
    symlinkSync(join(outside, 'session'), join(brain(), SESSION))
    expect(await c.code('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: 0 })).toBe('invalid')
    // The whole `.gemini` a link: the brain folder is not where it must be.
    rmSync(join(h.root, 'home', '.gemini'), { recursive: true, force: true })
    mkdirSync(join(outside, 'gemini', 'antigravity-acp', 'brain', SESSION, '.system_generated', 'logs'), { recursive: true })
    writeFileSync(join(outside, 'gemini', 'antigravity-acp', 'brain', SESSION, '.system_generated', 'logs', 'transcript_full.jsonl'), JSON.stringify(SYSTEM(1, 'LEAKED-FROM-OUTSIDE')) + '\n')
    symlinkSync(join(outside, 'gemini'), join(h.root, 'home', '.gemini'))
    expect(await c.code('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: 0 })).toBe('invalid')
  })

  it('refuses a session folder swapped for a link out between the check and the open', async () => {
    writeTranscript([PROMPT(0), SYSTEM(1)])
    outside = mkdtempSync(join(tmpdir(), 'vd-out-'))
    const logs = join(outside, 'session', '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript_full.jsonl'), JSON.stringify(SYSTEM(1, 'LEAKED-FROM-OUTSIDE')) + '\n')
    const session = join(brain(), SESSION)
    const swap = `require('fs').renameSync(${JSON.stringify(session)}, ${JSON.stringify(session + '.moved')}); require('fs').symlinkSync(${JSON.stringify(join(outside, 'session'))}, ${JSON.stringify(session)})`
    // Mutation: drop the descriptor's location check in the script → the outside file is read.
    await expect(readTranscriptTail(h.vaultd.ctx, SESSION, providerErrorsScript({ beforeOpen: swap }))).rejects.toThrow(/cannot be read/)
    rmSync(session)
    renameSync(session + '.moved', session)
    expect(await readTranscriptTail(h.vaultd.ctx, SESSION)).toContain('"step_index":1')
  })

  it('refuses a stream that is not a live Antigravity engine', async () => {
    const stream = await spawnAntigravity()
    writeTranscript([PROMPT(0), SYSTEM(1)])
    expect(await c.code('engine.providerErrors', { stream: 'no-such-stream', sessionId: SESSION, sinceAgoMs: 0 })).toBe('invalid')
    expect(await c.code('engine.providerErrors', { sessionId: SESSION, sinceAgoMs: 0 })).toBe('invalid')
    // Another engine's live stream (as engine.spawn records one).
    const ctx = h.vaultd.ctx
    ctx.engines.set('claude-stream', ctx.engines.get(stream)!)
    ctx.engineNames.set('claude-stream', 'claude')
    try {
      // Mutation: drop the engine-name check → a Claude stream reads Antigravity's transcript.
      expect(await c.code('engine.providerErrors', { stream: 'claude-stream', sessionId: SESSION, sinceAgoMs: 0 })).toBe('invalid')
    } finally {
      ctx.engines.delete('claude-stream')
      ctx.engineNames.delete('claude-stream')
    }
    // Ended: no longer asks.
    await c.call('engine.kill', { stream })
    await c.waitFor((n) => n.method === 'engine.exit' && n.params.stream === stream)
    expect(await c.code('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs: 0 })).toBe('invalid')
  })

  it('refuses a session id that is not plain, and a bad sinceAgoMs', async () => {
    const stream = await spawnAntigravity()
    for (const sessionId of ['../x', '..', '.', 'a/b', '', 'a\\b', 'a'.repeat(129), 7]) {
      expect(await c.code('engine.providerErrors', { stream, sessionId, sinceAgoMs: 0 })).toBe('invalid')
    }
    for (const sinceAgoMs of [-1, 'now', null, Number.NaN, 24 * 60 * 60_000 + 1]) {
      expect(await c.code('engine.providerErrors', { stream, sessionId: SESSION, sinceAgoMs })).toBe('invalid')
    }
    // Only the span is taken: a date from the host is not.
    expect(await c.code('engine.providerErrors', { stream, sessionId: SESSION, since: Date.now() })).toBe('invalid')
  })
})
