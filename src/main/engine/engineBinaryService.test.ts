import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedEngineBinary } from './binaryResolver'
import { createEngineBinaryService } from './engineBinaryService'

/**
 * The three properties worth having, all of them about *when* a resolution
 * happens rather than what it finds — the finding is `binaryResolver`'s job and
 * has its own suite.
 *
 * **Nothing resolves unasked**, because a resolution downloads and verifies
 * 46 MB on a machine with no `opencode`, and a user who never chats with a
 * folder agent must never pay for it.
 *
 * **Two turns starting together share one resolution**, or they download the
 * same archive twice into the same directory.
 *
 * **The memo is keyed on the configured path, and a failure is not cached.**
 * Both are settings a user changes *because* something is wrong: a path typed
 * into Settings, then corrected. `engineManager` kept the same key for the same
 * reason, and losing it would mean Settings appeared to do nothing until the
 * app was restarted.
 */
describe('createEngineBinaryService', () => {
  const binary = (path: string): ResolvedEngineBinary => ({
    path,
    source: 'configured',
    version: '1.18.27'
  })

  let configured: string | null
  let resolve: ReturnType<typeof vi.fn>

  beforeEach(() => {
    configured = '/opt/one/opencode'
    resolve = vi.fn(async (path: string | null) => binary(path ?? '/managed/opencode'))
  })

  const service = () =>
    createEngineBinaryService({
      resolve: (path) => resolve(path) as Promise<ResolvedEngineBinary>,
      configuredPath: () => configured
    })

  it('answers unresolved, and resolves nothing, until somebody asks', () => {
    const engine = service()
    expect(engine.state()).toEqual({ state: 'unresolved' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('reports the resolved binary, and reports resolving while it looks', async () => {
    let release!: (value: ResolvedEngineBinary) => void
    resolve.mockImplementation(() => new Promise((r) => (release = r)))
    const engine = service()
    const seen: string[] = []
    engine.onChange((next) => seen.push(next.state))

    const pending = engine.ensure()
    expect(engine.state()).toEqual({ state: 'resolving' })
    release(binary('/opt/one/opencode'))
    await pending
    expect(engine.state()).toEqual({
      state: 'ready',
      path: '/opt/one/opencode',
      source: 'configured',
      version: '1.18.27'
    })
    expect(seen).toEqual(['resolving', 'ready'])
  })

  it('shares one resolution between concurrent callers', async () => {
    const engine = service()
    const [a, b] = await Promise.all([engine.ensure(), engine.ensure()])
    expect(a).toBe(b)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('answers from the memo while the configured path holds', async () => {
    const engine = service()
    await engine.ensure()
    await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('resolves again when the configured path moves', async () => {
    const engine = service()
    await engine.ensure()
    configured = '/opt/two/opencode'
    const next = await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenLastCalledWith('/opt/two/opencode')
    expect(next.path).toBe('/opt/two/opencode')
  })

  it('does not cache a failure — the path the user just fixed must be tried', async () => {
    resolve.mockRejectedValueOnce(new Error('does not point at a file'))
    const engine = service()
    await expect(engine.ensure()).rejects.toThrow('does not point at a file')
    expect(engine.state()).toEqual({ state: 'failed', error: 'does not point at a file' })

    const recovered = await engine.ensure()
    expect(recovered.path).toBe('/opt/one/opencode')
    expect(engine.state()).toMatchObject({ state: 'ready' })
  })

  it('refreshes on demand, and reports a failure rather than rejecting', async () => {
    const engine = service()
    await engine.ensure()
    resolve.mockRejectedValueOnce(new Error('no network'))
    // The caller renders the state; a rejection here would make it handle the
    // same message twice.
    await expect(engine.refresh()).resolves.toEqual({ state: 'failed', error: 'no network' })
  })

  it('refreshes past a good answer, which is what Check again is for', async () => {
    const engine = service()
    await engine.ensure()
    await engine.refresh()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('lets a refresh that overtakes a failing resolution keep the slot', async () => {
    // The failure handler clears the memo so a path the user has fixed is tried
    // again — but a `refresh` issued while the first one was still failing has
    // already put a newer promise there, and clearing that would cost whoever
    // is awaiting it a second resolution for nothing.
    let failFirst!: (err: Error) => void
    resolve.mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)))
    const engine = service()
    const first = engine.ensure().catch(() => 'failed')
    const second = engine.refresh()
    failFirst(new Error('the first one, late'))
    await first
    await second
    expect(engine.state()).toMatchObject({ state: 'ready' })
    // The memo the refresh installed is still the one that answers.
    await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('stops telling a listener that has unsubscribed', async () => {
    const engine = service()
    const seen: string[] = []
    const off = engine.onChange((next) => seen.push(next.state))
    await engine.ensure()
    off()
    configured = '/opt/two/opencode'
    await engine.ensure()
    expect(seen).toEqual(['resolving', 'ready'])
  })

  it('keeps going when a listener throws', async () => {
    const engine = service()
    engine.onChange(() => {
      throw new Error('a listener that misbehaves')
    })
    await expect(engine.ensure()).resolves.toMatchObject({ path: '/opt/one/opencode' })
    expect(engine.state()).toMatchObject({ state: 'ready' })
  })
})
