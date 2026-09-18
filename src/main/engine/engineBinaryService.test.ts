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

  it('resolves again when the remembered binary has been deleted, once for callers that notice together', async () => {
    // `<userData>/runtimes/codex-*` removed mid-run. Mutation: return the memo
    // without the stat and every turn until a restart spawns a missing file.
    configured = null
    const onDisk = new Set<string>()
    resolve.mockImplementation(async () => { onDisk.add('/managed/opencode'); return binary('/managed/opencode') })
    const exists = vi.fn(async (path: string) => onDisk.has(path))
    const engine = createEngineBinaryService({
      resolve: (path) => resolve(path) as Promise<ResolvedEngineBinary>, configuredPath: () => configured, exists
    })
    await engine.ensure()
    await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(1)

    onDisk.clear()
    const seen: string[] = []
    engine.onChange((next) => seen.push(next.state))
    const [first, second] = await Promise.all([engine.ensure(), engine.ensure()])
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(first).toBe(second)
    expect(seen).toEqual(['resolving', 'ready'])
    await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('resolves again when a reused PATH copy is no longer the file that passed the version gate', async () => {
    // `~/.local/bin/claude` is a symlink its own updater retargets: the path
    // still exists, and what it runs is now another version. Mutation: drop the
    // fingerprint comparison in `ensure` and the third call answers from memory.
    configured = null
    let onDisk = 'versions/2.1.276:215643408:1'
    resolve.mockImplementation(async () => ({ path: '/Users/x/.local/bin/claude', source: 'path-pinned', version: '2.1.276 (Claude Code)', fingerprint: onDisk }))
    const engine = createEngineBinaryService({
      resolve: (path) => resolve(path) as Promise<ResolvedEngineBinary>, configuredPath: () => configured,
      exists: async () => true, fingerprint: async () => onDisk
    })
    await engine.ensure()
    await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(1)
    onDisk = 'versions/2.1.277:216000000:2'
    await engine.ensure()
    expect(resolve).toHaveBeenCalledTimes(2)
    // A managed or configured binary carries no fingerprint and is never asked for one.
    const fingerprint = vi.fn(async () => 'anything')
    const managed = createEngineBinaryService({
      resolve: async () => binary('/managed/claude'), configuredPath: () => null, exists: async () => true, fingerprint
    })
    await managed.ensure()
    await managed.ensure()
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it('does not stat while the first resolution is still running, and hands its failure through uncached', async () => {
    const exists = vi.fn(async () => true)
    resolve.mockRejectedValueOnce(new Error('no network'))
    const engine = createEngineBinaryService({
      resolve: (path) => resolve(path) as Promise<ResolvedEngineBinary>, configuredPath: () => configured, exists
    })
    const [a, b] = await Promise.allSettled([engine.ensure(), engine.ensure()])
    expect([a.status, b.status]).toEqual(['rejected', 'rejected'])
    expect(exists).not.toHaveBeenCalled()
    await expect(engine.ensure()).resolves.toMatchObject({ path: '/opt/one/opencode' })
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

  describe('peek — what would run without downloading', () => {
    const pinned: ResolvedEngineBinary = { path: '/real/claude/2.1.276', source: 'path-pinned', version: '2.1.276 (Claude Code)' }

    it('looks once, and the answer becomes the state every other reader sees', async () => {
      configured = null
      const known = vi.fn(async () => pinned)
      const engine = createEngineBinaryService({ resolve: (path) => resolve(path), configuredPath: () => configured, known })
      const pushed: string[] = []
      engine.onChange((next) => pushed.push(next.state))

      // A settings row, readiness and the login probe asking together, then again.
      const answers = await Promise.all([engine.peek(), engine.peek(), engine.peek()])
      await engine.peek()
      expect(known).toHaveBeenCalledTimes(1)
      expect(answers[0]).toEqual({ state: 'ready', path: pinned.path, source: 'path-pinned', version: pinned.version })
      expect(engine.state()).toEqual(answers[0])
      expect(pushed).toEqual(['ready'])
      expect(resolve).not.toHaveBeenCalled()
    })

    it('seeds the state, not the memo: the first turn still resolves properly', async () => {
      configured = null
      const engine = createEngineBinaryService({ resolve: (path) => resolve(path), configuredPath: () => configured, known: async () => pinned })
      await engine.peek()
      await engine.ensure()
      expect(resolve).toHaveBeenCalledTimes(1)
    })

    it('believes "nothing installed" for a minute rather than probing PATH on every call, and asks again after', async () => {
      configured = null
      let clock = 1_000_000
      const known = vi.fn(async (): Promise<ResolvedEngineBinary | null> => null)
      const engine = createEngineBinaryService({ resolve: (path) => resolve(path), configuredPath: () => configured, known, now: () => clock })
      expect((await engine.peek()).state).toBe('unresolved')
      await engine.peek()
      expect(known).toHaveBeenCalledTimes(1)

      clock += 61_000
      known.mockResolvedValue(pinned)
      expect((await engine.peek()).state).toBe('ready')
      expect(known).toHaveBeenCalledTimes(2)
    })

    it('asks again at once when the configured path changes, and passes it along', async () => {
      configured = null
      const known = vi.fn(async (): Promise<ResolvedEngineBinary | null> => null)
      const engine = createEngineBinaryService({ resolve: (path) => resolve(path), configuredPath: () => configured, known })
      await engine.peek()
      configured = '/opt/two/claude'
      await engine.peek()
      expect(known.mock.calls).toEqual([[null], ['/opt/two/claude']])
    })

    it('never overrides a resolution: a look that finishes after one started says nothing', async () => {
      configured = null
      let release!: (value: ResolvedEngineBinary | null) => void
      const engine = createEngineBinaryService({
        resolve: (path) => resolve(path),
        configuredPath: () => configured,
        known: () => new Promise((r) => (release = r))
      })
      const looking = engine.peek()
      await engine.ensure()
      release(pinned)
      expect(await looking).toMatchObject({ state: 'ready', path: '/managed/opencode' })
    })

    it('returns a failure as it stands, and is inert for a service with nothing to look with', async () => {
      resolve.mockRejectedValue(new Error('no network'))
      const known = vi.fn(async () => pinned)
      const failing = createEngineBinaryService({ resolve: (path) => resolve(path), configuredPath: () => configured, known })
      await failing.refresh()
      expect(await failing.peek()).toEqual({ state: 'failed', error: 'no network' })
      expect(known).not.toHaveBeenCalled()
      expect(await service().peek()).toEqual({ state: 'unresolved' })
    })
  })

  it('stamps a remembered managed binary as used, at most once an hour: a week-long run must not lose its version to another build’s sweep', async () => {
    configured = null
    let clock = 10 * 60 * 60 * 1000
    const markUsed = vi.fn(async () => undefined)
    resolve.mockResolvedValue({ path: '/data/runtimes/claude-2.1.276/claude', source: 'managed', version: 'v' })
    const engine = createEngineBinaryService({
      resolve: (path) => resolve(path), configuredPath: () => configured, exists: async () => true, markUsed, now: () => clock
    })
    await engine.ensure() // resolves: the resolver stamps that one itself
    expect(markUsed).not.toHaveBeenCalled()
    await engine.ensure()
    await engine.ensure()
    expect(markUsed.mock.calls).toEqual([['/data/runtimes/claude-2.1.276']])
    clock += 61 * 60 * 1000
    await engine.ensure()
    expect(markUsed).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('never stamps a binary that is not Cinna’s own', async () => {
    const markUsed = vi.fn(async () => undefined)
    const engine = createEngineBinaryService({
      resolve: (path) => resolve(path), configuredPath: () => configured, exists: async () => true, markUsed
    })
    await engine.ensure()
    await engine.ensure()
    expect(markUsed).not.toHaveBeenCalled()
  })

  it('says how big the pinned asset is while nothing is installed, and stops once something is', async () => {
    const engine = createEngineBinaryService({
      resolve: async (path, onProgress) => {
        await Promise.resolve()
        onProgress?.(5, null)
        return resolve(path) as Promise<ResolvedEngineBinary>
      },
      configuredPath: () => configured,
      assetBytes: () => 232_059_192
    })
    expect(engine.state()).toEqual({ state: 'unresolved', assetBytes: 232_059_192 })
    const seen: unknown[] = []
    engine.onChange((next) => seen.push(next))
    await engine.ensure()
    expect(seen).toEqual([
      { state: 'resolving', assetBytes: 232_059_192 },
      { state: 'resolving', received: 5, total: null, assetBytes: 232_059_192 },
      { state: 'ready', path: '/opt/one/opencode', source: 'configured', version: '1.18.27' }
    ])
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
