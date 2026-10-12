/**
 * The default OpenCode database bootstrap against a real child process: its own
 * start timeout, and app shutdown stopping it. It runs outside the process
 * pool, so nothing else would stop an engine still starting at quit.
 *
 * Its own file because shutdown closes the bootstrap for the module's life.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InitializeRequest } from '@agentclientprotocol/sdk'
import { createFakeAcp, waitFor, type FakeAcp } from './testSupport/fakeAcp'
import { ACP_PROTOCOL_VERSION } from './types'

const startCalls: unknown[][] = []
vi.mock('./acpConnection', async (importOriginal) => {
  const original = await importOriginal<typeof import('./acpConnection')>()
  return {
    ...original,
    startAcpConnection: (...args: Parameters<typeof original.startAcpConnection>) => {
      startCalls.push(args)
      return original.startAcpConnection(...args)
    }
  }
})

const { bootstrapOpencodeAcp, shutdownOpencodeBootstraps, OPENCODE_BOOTSTRAP_START_TIMEOUT_MS } = await import('./acpLaunchers')
const { ACP_START_TIMEOUT_MS } = await import('./types')

const INIT: InitializeRequest = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }
const fakes: FakeAcp[] = []
afterEach(() => { for (const fake of fakes.splice(0)) fake.cleanup() })

/** Whether the fake's last started process is still there. */
function running(fake: FakeAcp): boolean {
  const pid = fake.log().filter((entry) => entry.dir === 'start').at(-1)?.pid
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the OpenCode database bootstrap', () => {
  it('starts with its own start timeout, shorter than a turn’s', async () => {
    // Mutation: start with the default and a hung bootstrap costs the turn's
    // whole start timeout before the turn's own start begins.
    const fake = createFakeAcp()
    fakes.push(fake)
    await bootstrapOpencodeAcp(fake.spec, INIT)
    expect(startCalls.at(-1)?.[2]).toMatchObject({ startTimeoutMs: OPENCODE_BOOTSTRAP_START_TIMEOUT_MS })
    expect(OPENCODE_BOOTSTRAP_START_TIMEOUT_MS).toBeLessThan(ACP_START_TIMEOUT_MS)
    // Stopped once it answered.
    await waitFor(() => !running(fake), 'the bootstrap engine to stop')
  })

  it('is stopped by app shutdown, and none starts after it', async () => {
    // Mutation: drop the tracking (or the abort) and this engine keeps
    // starting until its own timeout, past the app's quit.
    const fake = createFakeAcp({ initialize: { hang: true } })
    fakes.push(fake)
    const started = Date.now()
    const bootstrap = bootstrapOpencodeAcp(fake.spec, INIT)
    const outcome = bootstrap.then(() => 'resolved', (err: Error) => err.message)
    await waitFor(() => fake.received('initialize').length > 0, 'initialize to arrive')
    expect(running(fake)).toBe(true)
    await shutdownOpencodeBootstraps()
    expect(await outcome).toMatch(/canceled/)
    expect(Date.now() - started).toBeLessThan(OPENCODE_BOOTSTRAP_START_TIMEOUT_MS / 2)
    await waitFor(() => !running(fake), 'the bootstrap engine to stop')

    const calls = startCalls.length
    await expect(bootstrapOpencodeAcp(fake.spec, INIT)).rejects.toThrow(/closing/)
    expect(startCalls.length).toBe(calls)
  })
})
