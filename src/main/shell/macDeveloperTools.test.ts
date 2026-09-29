import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const { createMacDeveloperTools, createUsableTool, DEVELOPER_TOOLS_TTL_MS, MAC_DEVELOPER_TOOL_STUBS } = await import(
  './macDeveloperTools'
)

const CLT = '/Library/Developer/CommandLineTools'

function tools(options: {
  platform?: NodeJS.Platform
  developerDir?: () => Promise<string | null>
  present?: string[]
  clock?: { now: number }
}) {
  const clock = options.clock ?? { now: 0 }
  const developerDir = vi.fn(options.developerDir ?? (async () => `${CLT}\n`))
  const present = new Set(options.present ?? [`${CLT}/usr/bin/git`])
  return {
    developerDir,
    clock,
    tools: createMacDeveloperTools({
      platform: options.platform ?? 'darwin',
      developerDir,
      exists: (path) => present.has(path),
      now: () => clock.now
    })
  }
}

/** `xcode-select -p` exiting non-zero: "unable to get active developer directory". */
const noTools = async (): Promise<string | null> => null

/** `xcode-select -p` that never answered — killed at its timeout. */
const timedOut = async (): Promise<string | null> => {
  throw Object.assign(new Error('Command failed: /usr/bin/xcode-select -p'), { killed: true, signal: 'SIGTERM', code: null })
}

describe('which paths are the developer-tool stubs', () => {
  it('is /usr/bin/<tool> for the xcrun-shim names, on macOS only', () => {
    const { tools: mac } = tools({})
    for (const name of ['git', 'make', 'python3', 'pip3', 'clang', 'clang++', 'cc', 'c++', 'gcc', 'g++']) {
      expect([name, mac.isStub(`/usr/bin/${name}`)]).toEqual([name, true])
    }
    expect(MAC_DEVELOPER_TOOL_STUBS.size).toBe(78)
  })

  it('is never a tool somewhere else, nor a real system binary in /usr/bin', () => {
    const { tools: mac } = tools({})
    expect(mac.isStub('/opt/homebrew/bin/git')).toBe(false)
    expect(mac.isStub('/usr/local/bin/python3')).toBe(false)
    expect(mac.isStub('/usr/bin/env')).toBe(false)
    expect(mac.isStub('/usr/bin/xcode-select')).toBe(false)
    expect(mac.isStub('/usr/bin/nested/git')).toBe(false)
  })

  it('is never a stub off macOS, where /usr/bin/git is git', () => {
    const { tools: linux } = tools({ platform: 'linux' })
    expect(linux.isStub('/usr/bin/git')).toBe(false)
  })
})

describe('whether the developer tools are installed', () => {
  it('is installed when xcode-select names a directory with git in it (CLT or Xcode.app)', async () => {
    expect(await tools({}).tools.installed()).toBe(true)
    const xcode = '/Applications/Xcode.app/Contents/Developer'
    const { tools: withXcode } = tools({ developerDir: async () => `${xcode}\n`, present: [`${xcode}/usr/bin/git`] })
    expect(await withXcode.installed()).toBe(true)
  })

  it('is absent when xcode-select fails, or its directory has no git', async () => {
    expect(await tools({ developerDir: noTools }).tools.installed()).toBe(false)
    expect(await tools({ present: [] }).tools.installed()).toBe(false)
    expect(await tools({ developerDir: async () => '\n' }).tools.installed()).toBe(false)
  })

  it('is always installed off macOS, without asking xcode-select', async () => {
    const { tools: linux, developerDir } = tools({ platform: 'linux', developerDir: noTools })
    expect(await linux.installed()).toBe(true)
    expect(developerDir).not.toHaveBeenCalled()
  })

  it('holds an answer for the TTL, then asks again — so installing the tools is picked up without a restart', async () => {
    let installedNow = false
    const clock = { now: 1_000 }
    const { tools: mac, developerDir } = tools({
      clock,
      developerDir: async () => (installedNow ? CLT : noTools())
    })
    expect(await mac.installed()).toBe(false)
    installedNow = true
    clock.now += DEVELOPER_TOOLS_TTL_MS - 1
    expect(await mac.installed()).toBe(false)
    expect(developerDir).toHaveBeenCalledTimes(1)
    clock.now += 1
    expect(await mac.installed()).toBe(true)
    expect(developerDir).toHaveBeenCalledTimes(2)
  })

  it('caches a non-zero exit as absent for the TTL', async () => {
    const clock = { now: 1_000 }
    const { tools: mac, developerDir } = tools({ clock, developerDir: noTools })
    expect(await mac.installed()).toBe(false)
    clock.now += DEVELOPER_TOOLS_TTL_MS - 1
    expect(await mac.installed()).toBe(false)
    expect(developerDir).toHaveBeenCalledTimes(1)
  })

  it('keeps the last real answer when a later probe times out', async () => {
    let hang = false
    const clock = { now: 1_000 }
    const { tools: mac, developerDir } = tools({ clock, developerDir: async () => (hang ? timedOut() : CLT) })
    expect(await mac.installed()).toBe(true)
    hang = true
    clock.now += DEVELOPER_TOOLS_TTL_MS
    expect(await mac.installed()).toBe(true)
    expect(developerDir).toHaveBeenCalledTimes(2)
  })

  it('reads a timeout with no answer yet as absent, without caching it', async () => {
    let hang = true
    const { tools: mac, developerDir } = tools({ developerDir: async () => (hang ? timedOut() : CLT) })
    expect(await mac.installed()).toBe(false)
    expect(await mac.state()).toBe('unknown')
    hang = false
    expect(await mac.installed()).toBe(true)
    expect(developerDir).toHaveBeenCalledTimes(3)
  })

  it('tells unknown from absent: a timeout with no answer yet is unknown, a later timeout keeps the answer', async () => {
    let hang = true
    const clock = { now: 1_000 }
    const { tools: mac } = tools({ clock, developerDir: async () => (hang ? timedOut() : noTools()) })
    expect(await mac.state()).toBe('unknown')
    hang = false
    expect(await mac.state()).toBe('absent')
    hang = true
    clock.now += DEVELOPER_TOOLS_TTL_MS
    expect(await mac.state()).toBe('absent')
    expect(await tools({ platform: 'linux' }).tools.state()).toBe('installed')
  })

  it('is asked once for a burst of callers', async () => {
    const { tools: mac, developerDir } = tools({})
    const answers = await Promise.all([mac.installed(), mac.installed(), mac.installed()])
    expect(answers).toEqual([true, true, true])
    expect(developerDir).toHaveBeenCalledTimes(1)
  })

  it('forgets its answer on clear(), for the Refresh affordance', async () => {
    let installedNow = false
    const { tools: mac, developerDir } = tools({ developerDir: async () => (installedNow ? CLT : noTools()) })
    expect(await mac.installed()).toBe(false)
    installedNow = true
    mac.clear()
    expect(await mac.installed()).toBe(true)
    expect(developerDir).toHaveBeenCalledTimes(2)
  })
})

describe('usableTool', () => {
  const which = (paths: Record<string, string>) => async (bin: string) => paths[bin] ?? null

  it('drops a stub when the tools are absent, without touching anything else', async () => {
    const { tools: mac } = tools({ developerDir: noTools })
    const usable = createUsableTool({
      which: which({ git: '/usr/bin/git', make: '/usr/bin/make', uv: '/opt/homebrew/bin/uv', python3: '/opt/homebrew/bin/python3' }),
      tools: mac
    })
    expect(await usable('git')).toBeNull()
    expect(await usable('make')).toBeNull()
    expect(await usable('uv')).toBe('/opt/homebrew/bin/uv')
    expect(await usable('python3')).toBe('/opt/homebrew/bin/python3')
    expect(await usable('missing')).toBeNull()
  })

  it('keeps the stub path when the tools are installed — it is the real tool then', async () => {
    const usable = createUsableTool({ which: which({ git: '/usr/bin/git' }), tools: tools({}).tools })
    expect(await usable('git')).toBe('/usr/bin/git')
  })

  it('does not ask xcode-select for a tool that is not a stub', async () => {
    const { tools: mac, developerDir } = tools({})
    const usable = createUsableTool({ which: which({ git: '/opt/homebrew/bin/git' }), tools: mac })
    expect(await usable('git')).toBe('/opt/homebrew/bin/git')
    expect(developerDir).not.toHaveBeenCalled()
  })

  it('uses a real git further along PATH before the fallback, when the first match is the stub', async () => {
    const fallback = vi.fn(async () => '/data/git-shim/git')
    const pastStub = vi.fn(async (bin: string) => (bin === 'git' ? '/opt/homebrew/bin/git' : null))
    const usable = createUsableTool({
      which: which({ git: '/usr/bin/git', make: '/usr/bin/make' }),
      tools: tools({ developerDir: noTools }).tools,
      pastStub,
      fallback
    })
    expect(await usable('git')).toBe('/opt/homebrew/bin/git')
    expect(fallback).not.toHaveBeenCalled()
    expect(await usable('make')).toBe('/data/git-shim/git')
    expect(pastStub).toHaveBeenCalledWith('make')
  })

  it('never starts the install when the tools could not be asked about', async () => {
    const fallback = vi.fn(async () => null)
    const unknown = createUsableTool({ which: which({ git: '/usr/bin/git' }), tools: tools({ developerDir: timedOut }).tools, fallback })
    expect(await unknown('git')).toBeNull()
    expect(fallback).toHaveBeenLastCalledWith('git', { install: false })
    const absent = createUsableTool({ which: which({ git: '/usr/bin/git' }), tools: tools({ developerDir: noTools }).tools, fallback })
    await absent('git')
    expect(fallback).toHaveBeenLastCalledWith('git', { install: true })
  })

  it('asks the fallback — the managed git wrapper — only when there is no usable tool', async () => {
    const wrapper = '/data/git-shim/git'
    const fallback = vi.fn(async (bin: string) => (bin === 'git' ? wrapper : null))
    // A Mac without the tools: the stub gives way to the wrapper.
    const mac = createUsableTool({ which: which({ git: '/usr/bin/git' }), tools: tools({ developerDir: noTools }).tools, fallback })
    expect(await mac('git')).toBe(wrapper)
    // A Linux without git: nothing on PATH gives way to the wrapper.
    const linux = createUsableTool({ which: which({}), tools: tools({ platform: 'linux' }).tools, fallback })
    expect(await linux('git')).toBe(wrapper)
    expect(fallback).toHaveBeenCalledTimes(2)
    // A real git — the tools installed, or Homebrew — always wins.
    fallback.mockClear()
    const clt = createUsableTool({ which: which({ git: '/usr/bin/git' }), tools: tools({}).tools, fallback })
    expect(await clt('git')).toBe('/usr/bin/git')
    const brew = createUsableTool({ which: which({ git: '/opt/homebrew/bin/git' }), tools: tools({ developerDir: noTools }).tools, fallback })
    expect(await brew('git')).toBe('/opt/homebrew/bin/git')
    expect(fallback).not.toHaveBeenCalled()
  })
})
