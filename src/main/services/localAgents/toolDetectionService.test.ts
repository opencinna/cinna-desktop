import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

// The managed uv's path; a test that wants it installed writes a file there.
const managedUv = vi.hoisted(() => ({ path: '/nonexistent/cinna-toolchain/uv-0.12.10/uv' }))
vi.mock('../../localdev/toolchain', () => ({
  toolchain: { root: () => '/nonexistent/cinna-toolchain' },
  managedUvLayout: () => ({ uvBin: managedUv.path })
}))

/**
 * A Mac without the command line developer tools: `/usr/bin/git`, `make` and
 * `python3` are on PATH (so `which` finds them) but are stubs (so
 * `usableTool` does not), and `uv` is a real Homebrew install.
 */
const paths: Record<string, string> = {
  git: '/usr/bin/git',
  make: '/usr/bin/make',
  python3: '/usr/bin/python3',
  uv: '/opt/homebrew/bin/uv'
}

vi.mock('../../shell/env', () => ({
  which: vi.fn(async (bin: string) => paths[bin] ?? null),
  usableTool: vi.fn(async (bin: string) => {
    const path = paths[bin] ?? null
    return path?.startsWith('/usr/bin/') ? null : path
  }),
  getShellEnv: async () => ({ PATH: '/usr/bin' }),
  shellEnvForChild: (env: NodeJS.ProcessEnv) => env,
  clearToolCache: vi.fn()
}))

const execFile = vi.fn(
  (_file: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, 'uv 0.4.20 (a1b2c3d 2024-09-30)\n', '')
  }
)
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (...args: Parameters<typeof execFile>) => execFile(...args)
}))

const { toolDetectionService } = await import('./toolDetectionService')

beforeEach(() => {
  execFile.mockClear()
})

describe('detecting tools behind macOS developer-tool stubs', () => {
  it('reports git and python3 as not available, with no version, and never runs them', async () => {
    const tools = await toolDetectionService.refresh()
    for (const id of ['git', 'python3'] as const) {
      const tool = tools.find((t) => t.id === id)
      expect([id, tool?.available, tool?.path, tool?.version]).toEqual([id, false, null, null])
    }
    const ran = execFile.mock.calls.map((call) => call[0])
    expect(ran.filter((file) => file.startsWith('/usr/bin/'))).toEqual([])
  })

  it('still finds and asks a real tool its version', async () => {
    const tools = await toolDetectionService.refresh()
    const uv = tools.find((t) => t.id === 'uv')
    expect(uv).toMatchObject({ available: true, path: '/opt/homebrew/bin/uv', source: 'path', version: '0.4.20' })
    expect(execFile.mock.calls.map((call) => call[0])).toContain('/opt/homebrew/bin/uv')
  })
})

describe('the managed uv', () => {
  it('reports uv as managed when only the desktop\'s copy exists, and the user\'s own when both do', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'managed-uv-'))
    const own = paths.uv
    try {
      managedUv.path = join(dir, 'uv')
      writeFileSync(managedUv.path, '#!/bin/sh\n', { mode: 0o755 })
      expect((await toolDetectionService.refresh()).find((t) => t.id === 'uv')).toMatchObject({ source: 'path', path: own })
      delete paths.uv
      expect((await toolDetectionService.refresh()).find((t) => t.id === 'uv')).toMatchObject({
        available: true, source: 'managed', path: managedUv.path, version: '0.4.20'
      })
    } finally {
      paths.uv = own
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
