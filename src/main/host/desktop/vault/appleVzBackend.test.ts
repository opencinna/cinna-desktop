import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelperEvent } from '../../../../shared/vault/protocol'

vi.mock('../../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createAppleVzBackend } = await import('./appleVzBackend')

/**
 * A stand-in VaultHelper: reads frames on stdin, answers control requests on
 * stdout. `FLAVOR` is what its hello reports; `vault.status` makes it crash,
 * and it counts its starts in `STARTS`.
 */
const HELPER = `
const fs = require('node:fs')
fs.appendFileSync(process.env.STARTS, 'x')
let buf = Buffer.alloc(0)
const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj))
  const head = Buffer.alloc(9)
  head.writeUInt32BE(5 + body.length, 0); head.writeUInt8(0, 4); head.writeUInt32BE(0, 5)
  process.stdout.write(Buffer.concat([head, body]))
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const len = buf.readUInt32BE(0)
    const msg = JSON.parse(buf.subarray(9, 4 + len).toString())
    buf = buf.subarray(4 + len)
    if (msg.method === 'hello') send({ id: msg.id, result: { protocol: 1, flavor: process.env.FLAVOR, helperVersion: '1.0', guest: { version: 'g1', rootHash: 'ab' } } })
    else if (msg.method === 'availability') send({ id: msg.id, result: { ok: true } })
    else if (msg.method === 'vault.unlock') { send({ event: 'vault.state', vaultId: msg.params.vaultId, state: 'unlocked', until: 1 }); send({ id: msg.id, result: { state: 'unlocked' } }) }
    else if (msg.method === 'vault.status') process.exit(3)
    else send({ id: msg.id, error: { code: 'denied', message: 'no' } })
  }
})
process.stdin.on('end', () => process.exit(0))
`

let dir = ''
let script = ''
let starts = ''
const backends: ReturnType<typeof createAppleVzBackend>[] = []

function make(flavor: string, isPackaged: boolean) {
  const backend = createAppleVzBackend({
    helperPath: script,
    isPackaged,
    spawnHelper: (path) => spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FLAVOR: flavor, STARTS: starts } })
  })
  backends.push(backend)
  return backend
}

const startCount = (): number => {
  try {
    return readFileSync(starts, 'utf8').length
  } catch {
    return 0
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-helper-'))
  script = join(dir, 'helper.cjs')
  starts = join(dir, 'starts')
  writeFileSync(script, HELPER)
})

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('Apple VZ backend', () => {
  it('reports helper-missing when the helper is not installed', async () => {
    const backend = createAppleVzBackend({ helperPath: join(dir, 'nope'), isPackaged: true })
    expect(await backend.availability()).toEqual({ ok: false, reason: 'helper-missing' })
  })

  it('degrades cleanly in a package that ships no helper (unpublished guest): nothing spawned, every call refused with a code', async () => {
    const spawnHelper = vi.fn()
    const backend = createAppleVzBackend({ helperPath: join(dir, 'nope'), isPackaged: true, spawnHelper: spawnHelper as never })
    expect(await backend.availability()).toEqual({ ok: false, reason: 'helper-missing' })
    await expect(backend.hello()).rejects.toMatchObject({ code: 'unavailable' })
    await expect(backend.list(dir)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(backend.unlock('v', 'chat')).rejects.toMatchObject({ code: 'unavailable' })
    await backend.shutdown()
    expect(spawnHelper).not.toHaveBeenCalled()
  })

  it('accepts a test helper in development and reports its flavor', async () => {
    const backend = make('test', false)
    expect(await backend.availability()).toEqual({ ok: true })
    expect(await backend.hello()).toMatchObject({ flavor: 'test', guest: { version: 'g1' } })
  })

  it('refuses any flavor but release in a packaged app', async () => {
    const backend = make('dev', true)
    expect(await backend.availability()).toMatchObject({ ok: false, reason: 'helper-untrusted' })
    await expect(backend.unlock('v', 'chat')).rejects.toMatchObject({ code: 'unavailable' })
    expect(await make('release', true).availability()).toEqual({ ok: true })
  })

  it('passes helper events on and maps helper errors to codes', async () => {
    const backend = make('test', false)
    const events: HelperEvent[] = []
    backend.onEvent((event) => events.push(event))
    expect(await backend.unlock('v1', 'chat')).toBe('unlocked')
    expect(events).toEqual([{ event: 'vault.state', vaultId: 'v1', state: 'unlocked', until: 1 }])
    await expect(backend.approve('v1', 'export', 'x')).rejects.toMatchObject({ code: 'denied' })
  })

  it('restarts the helper once after a crash, reports error for running vaults, then stays broken', async () => {
    const backend = make('test', false)
    const events: HelperEvent[] = []
    backend.onEvent((event) => events.push(event))
    await backend.unlock('v1', 'chat')
    await expect(backend.status('v1')).rejects.toMatchObject({ code: 'unavailable' })
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ event: 'vault.state', vaultId: 'v1', state: 'error' }))
    // Restarted once.
    expect(await backend.availability()).toEqual({ ok: true })
    expect(startCount()).toBe(2)
    await expect(backend.status('v1')).rejects.toMatchObject({ code: 'unavailable' })
    // A second crash: no third start.
    await vi.waitFor(async () => expect(await backend.availability()).toMatchObject({ ok: false, detail: expect.stringContaining('keeps exiting') }))
    expect(startCount()).toBe(2)
  })
})
