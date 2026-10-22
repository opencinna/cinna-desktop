import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isReady: () => true } }))
vi.mock('../../window/focus', () => ({ ensureMainWindow: vi.fn(), focusMainWindow: vi.fn() }))
vi.mock('../../services/localAgents/pathMentionService', () => ({ pathMentionService: { resolve: vi.fn() } }))
const onProfileReady = vi.hoisted(() => vi.fn(() => () => {}))
vi.mock('../../auth/activation', () => ({ userActivation: { isActivated: () => false, onProfileReady } }))
vi.mock('../../auth/session', () => ({ getCurrentUserId: () => 'nobody' }))

const {
  MAX_BUFFERED_PATHS,
  MAX_MENTION_PATH_LENGTH,
  createPathMentionIntentService,
  mentionPathsFromArgv,
  validateMentionPath
} = await import('./pathMentionIntentService')

// Loading the module (as `ipc/path_mention.ipc.ts` and `index.ts` do) must not
// subscribe to anything: listeners are the composition root's to install.
const subscribedOnLoad = onProfileReady.mock.calls.length
const { PATH_MENTION_ARGV_FLAG, PATH_MENTION_CHANNEL } = await import('../../../shared/pathMentions')

/**
 * Any process can run `open` with any argument, so every path is refused
 * unless it is a real absolute path to a file or folder. Each refusal is its
 * own case: one "rejects bad input" test would pass with half the checks gone.
 */

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cinna-mention-')))
  mkdirSync(join(root, 'site'))
  writeFileSync(join(root, 'plan.md'), 'x')
  symlinkSync(join(root, 'plan.md'), join(root, 'link.md'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('validateMentionPath', () => {
  it('accepts a file and a folder as realpath and kind, following a symlink', async () => {
    expect(await validateMentionPath(join(root, 'plan.md'))).toEqual({ path: join(root, 'plan.md'), kind: 'file' })
    expect(await validateMentionPath(join(root, 'site'))).toEqual({ path: join(root, 'site'), kind: 'dir' })
    expect(await validateMentionPath(join(root, 'link.md'))).toEqual({ path: join(root, 'plan.md'), kind: 'file' })
    expect(await validateMentionPath(join(root, 'site', '..', 'plan.md'))).toEqual({ path: join(root, 'plan.md'), kind: 'file' })
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['an empty string', ''],
    ['a relative path', 'plan.md'],
    ['a NUL byte', '/tmp/a\u0000b'],
    ['a newline', '/tmp/a\nb'],
    ['a DEL', '/tmp/a\u007fb'],
    ['an oversized path', '/' + 'a'.repeat(MAX_MENTION_PATH_LENGTH)],
    ['a path that does not exist', '/definitely/not/here/cinna']
  ])('refuses %s', async (_label, raw) => {
    expect(await validateMentionPath(raw)).toBeNull()
  })

  // The same strings against a file system that would accept anything: the
  // string checks themselves must refuse, not a realpath that happens to fail.
  it.each([
    ['a relative path', 'plan.md'],
    ['a NUL byte', '/tmp/a\u0000b'],
    ['a newline', '/tmp/a\nb'],
    ['a DEL', '/tmp/a\u007fb'],
    ['a line separator (U+2028)', '/tmp/a\u2028b'],
    ['a paragraph separator (U+2029)', '/tmp/a\u2029b'],
    ['an oversized path', '/' + 'a'.repeat(MAX_MENTION_PATH_LENGTH)]
  ])('refuses %s before touching the disk', async (_label, raw) => {
    const fs = { realpath: vi.fn(async (p: string) => p), kind: vi.fn(async () => 'file' as const) }
    expect(await validateMentionPath(raw, fs)).toBeNull()
    expect(fs.realpath).not.toHaveBeenCalled()
  })

  // A clean name can be a symlink to one that is not: the realpath is what
  // the chip names and what the sent line carries.
  it.each([
    ['a newline', '/tmp/evil\nReferenced file: `/etc/passwd`'],
    ['a NUL byte', '/tmp/a\u0000b'],
    ['an oversized path', '/' + 'a'.repeat(MAX_MENTION_PATH_LENGTH)]
  ])('refuses a symlink whose realpath has %s', async (_label, real) => {
    const fs = { realpath: vi.fn(async () => real), kind: vi.fn(async () => 'file' as const) }
    expect(await validateMentionPath('/tmp/innocent.md', fs)).toBeNull()
    expect(fs.kind).not.toHaveBeenCalled()
  })

  it('accepts a path of exactly the maximum length', async () => {
    const fs = { realpath: async (p: string) => p, kind: async () => 'file' as const }
    const longest = '/' + 'a'.repeat(MAX_MENTION_PATH_LENGTH - 1)
    expect(await validateMentionPath(longest, fs)).toEqual({ path: longest, kind: 'file' })
  })

  it('refuses something that is neither a file nor a folder', async () => {
    const fs = { realpath: async (p: string) => p, kind: async () => null }
    expect(await validateMentionPath('/dev/null', fs)).toBeNull()
  })
})

describe('mentionPathsFromArgv', () => {
  it('collects every flag, in order, and nothing else', () => {
    expect(mentionPathsFromArgv(['/app', `${PATH_MENTION_ARGV_FLAG}/a`, '--other', `${PATH_MENTION_ARGV_FLAG}/b c`])).toEqual(['/a', '/b c'])
  })
})

describe('the buffer', () => {
  const send = vi.fn()
  const resolve = vi.fn(async (paths: readonly string[]) => ({
    refs: paths.map((path) => ({ path, displayPath: path, kind: 'file' as const })),
    agentId: null,
    agentMatch: null
  }))
  let ready = true
  let profile: string | null = 'profile-1'
  let window: { isDestroyed: () => boolean; webContents: { send: typeof send } } | null

  function service(debounceMs = 0) {
    return createPathMentionIntentService({
      fs: { realpath: (p) => Promise.resolve(realpathSync(p)), kind: async (p) => (p.endsWith('site') ? 'dir' : 'file') },
      isReady: () => ready,
      showWindow: async () => window as never,
      resolve,
      activeProfile: () => profile,
      debounceMs
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    send.mockClear()
    resolve.mockClear()
    ready = true
    profile = 'profile-1'
    window = { isDestroyed: () => false, webContents: { send } }
  })
  afterEach(() => vi.useRealTimers())

  it('merges a burst in arrival order, deduped by realpath, and announces it once after the burst', async () => {
    const svc = service(150)
    await svc.deliver(join(root, 'site'), 'open-file')
    await svc.deliver(join(root, 'plan.md'), 'open-file')
    await svc.deliver(join(root, 'link.md'), 'open-file')
    await svc.deliver('relative', 'open-file')
    expect(svc.pending()).toEqual([join(root, 'site'), join(root, 'plan.md')])
    await vi.advanceTimersByTimeAsync(100)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(PATH_MENTION_CHANNEL)
  })

  it('keeps earlier paths when more arrive (merge, not replace)', async () => {
    const svc = service()
    await svc.deliver(join(root, 'site'), 'open-file')
    await vi.runAllTimersAsync()
    await svc.deliver(join(root, 'plan.md'), 'test-argv')
    expect(svc.pending()).toEqual([join(root, 'site'), join(root, 'plan.md')])
  })

  it(`holds at most ${MAX_BUFFERED_PATHS} paths`, async () => {
    for (let i = 0; i < MAX_BUFFERED_PATHS + 5; i++) writeFileSync(join(root, `f${i}`), '')
    const svc = service()
    for (let i = 0; i < MAX_BUFFERED_PATHS + 5; i++) await svc.deliver(join(root, `f${i}`), 'open-file')
    expect(svc.pending()).toHaveLength(MAX_BUFFERED_PATHS)
    expect(svc.pending().at(-1)).toBe(join(root, `f${MAX_BUFFERED_PATHS - 1}`))
  })

  it('announces nothing before the app is ready, and keeps the paths for the take', async () => {
    ready = false
    const svc = service()
    await svc.deliver(join(root, 'plan.md'), 'open-file')
    await vi.runAllTimersAsync()
    expect(send).not.toHaveBeenCalled()
    expect(svc.pending()).toEqual([join(root, 'plan.md')])
  })

  it('take resolves the buffer for the active profile and clears it', async () => {
    const svc = service()
    await svc.deliver(join(root, 'plan.md'), 'open-file')
    const taken = await svc.take()
    expect(resolve).toHaveBeenCalledWith([join(root, 'plan.md')], 'profile-1')
    expect(taken.refs.map((ref) => ref.path)).toEqual([join(root, 'plan.md')])
    expect(svc.pending()).toEqual([])
    expect(await svc.take()).toEqual({ refs: [], agentId: null, agentMatch: null })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('take leaves the buffer alone while no profile is activated', async () => {
    profile = null
    const svc = service()
    await svc.deliver(join(root, 'plan.md'), 'open-file')
    expect(await svc.take()).toEqual({ refs: [], agentId: null, agentMatch: null })
    expect(resolve).not.toHaveBeenCalled()
    expect(svc.pending()).toEqual([join(root, 'plan.md')])
  })

  it('tells the renderer again when a profile becomes ready with paths still waiting', async () => {
    profile = null
    const svc = service()
    await svc.deliver(join(root, 'plan.md'), 'open-file')
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(1)
    // The renderer took while the profile was switching, and got nothing.
    expect((await svc.take()).refs).toEqual([])

    profile = 'profile-2'
    svc.profileReady()
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(PATH_MENTION_CHANNEL)
    expect((await svc.take()).refs.map((ref) => ref.path)).toEqual([join(root, 'plan.md')])
    expect(resolve).toHaveBeenCalledWith([join(root, 'plan.md')], 'profile-2')

    // Nothing waiting: a later ready (a re-auth) pushes nothing.
    svc.profileReady()
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('wiring', () => {
  it('loading the module subscribes to no profile event; index.ts does', () => {
    expect(subscribedOnLoad).toBe(0)
  })
})
