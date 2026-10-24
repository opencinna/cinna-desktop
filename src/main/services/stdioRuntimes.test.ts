import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const shell = vi.hoisted(() => ({ which: vi.fn(async (_bin: string): Promise<string | null> => null), resetShellEnv: vi.fn(), clearToolCache: vi.fn() }))
vi.mock('../shell/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('../shell/env')>()), ...shell }))

import { createStdioRuntimes, runtimeOfCommand, STDIO_RUNTIME_TEXT, stdioRuntimes, throughManagedUv } from './stdioRuntimes'

describe('stdioRuntimes as the app runs it', () => {
  it('reads the login shell’s PATH again on Check again, so a Node installed into a new PATH entry is found', async () => {
    shell.which.mockImplementation(async () => null)
    expect(await stdioRuntimes.available('node')).toBe(false)
    shell.which.mockImplementation(async (bin: string) => (bin === 'node' ? '/new/bin/node' : null))
    expect(await stdioRuntimes.recheck()).toEqual({ node: true, docker: false })
    expect(shell.resetShellEnv).toHaveBeenCalledTimes(1)
    stdioRuntimes._reset()
  })
})

/**
 * A plugin's local servers on this computer: Python through the managed uv
 * (never a block), Node and Docker only when already installed — looked up
 * once per session, again on Check again — and none at all when the admin's
 * policy says so.
 */

const UV = { uvBin: '/ud/localdev/uv-0.12.10/uv', uvxBin: '/ud/localdev/uv-0.12.10/uvx', env: { UV_CACHE_DIR: '/ud/localdev/uv-cache' } }
const ALLOWED = { stdioMcp: true }

function runtimes(found: Record<string, string | null>) {
  const which = vi.fn(async (bin: string) => found[bin] ?? null)
  const clear = vi.fn()
  return { which, clear, runtimes: createStdioRuntimes({ which, clear, ensureUv: async () => UV }) }
}

describe('stdioRuntimes', () => {
  it('names the runtime a command needs', () => {
    expect(['uvx', 'uv', 'python3', '/usr/bin/python', 'npx', 'node', 'docker', '/plugin/bin/server', null].map(runtimeOfCommand)).toEqual([
      'python', 'python', 'python', 'python', 'node', 'node', 'docker', null, null
    ])
  })

  it('rewrites a Python command to the managed uv', () => {
    expect(throughManagedUv('uvx', ['mcp-server-fetch'], UV)).toEqual({ command: UV.uvxBin, args: ['mcp-server-fetch'] })
    expect(throughManagedUv('/opt/homebrew/bin/uvx', ['x'], UV)).toEqual({ command: UV.uvxBin, args: ['x'] })
    expect(throughManagedUv('python', ['s.py'], UV)).toEqual({ command: UV.uvBin, args: ['run', '--no-project', 'python', 's.py'] })
    expect(throughManagedUv('node', ['s.js'], UV)).toEqual({ command: 'node', args: ['s.js'] })
  })

  it('makes a `uv run` of a locked project in the read-only cache --frozen, and leaves one without a lock as written', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-uv-frozen-'))
    try {
      mkdirSync(join(root, 'server'))
      writeFileSync(join(root, 'server', 'uv.lock'), 'version = 1\n')
      const dir = join(root, 'server')
      expect(throughManagedUv('uv', ['run', '--directory', dir, 'carbone'], UV, root)).toEqual({ command: UV.uvBin, args: ['run', '--frozen', '--directory', dir, 'carbone'] })
      expect(throughManagedUv('uv', ['run', `--project=${dir}`, 'carbone'], UV, root)).toEqual({ command: UV.uvBin, args: ['run', '--frozen', `--project=${dir}`, 'carbone'] })
      // Relative to the plugin root, and a flag already there is kept as the plugin wrote it.
      expect(throughManagedUv('uv', ['run', '--directory', 'server', 'x'], UV, root).args).toEqual(['run', '--frozen', '--directory', 'server', 'x'])
      expect(throughManagedUv('uv', ['run', '--locked', '--directory', dir, 'x'], UV, root).args).toEqual(['run', '--locked', '--directory', dir, 'x'])
      // No uv.lock at the root itself: nothing to freeze.
      expect(throughManagedUv('uv', ['run', 'x'], UV, root).args).toEqual(['run', 'x'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('points a `uv run` of an unlocked project in the cache, and a `uvx --from` of a cached folder, at the working copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-uv-unlocked-'))
    const work = join(tmpdir(), 'cinna-work-copy', 'e', 's')
    try {
      mkdirSync(join(root, 'server'))
      writeFileSync(join(root, 'server', 'pyproject.toml'), '[project]\nname = "srv"\n')
      const dir = join(root, 'server')
      expect(throughManagedUv('uv', ['run', '--directory', dir, 'srv'], UV, root, work)).toEqual({
        command: UV.uvBin,
        args: ['run', '--directory', join(work, 'server'), 'srv'],
        usesWork: true
      })
      expect(throughManagedUv('uv', ['run', `--project=${dir}`, 'srv'], UV, root, work).args).toEqual(['run', `--project=${join(work, 'server')}`, 'srv'])
      // Relative to the plugin root.
      expect(throughManagedUv('uv', ['run', '--directory', 'server', 'srv'], UV, root, work).args).toEqual(['run', '--directory', join(work, 'server'), 'srv'])
      expect(throughManagedUv('uvx', ['--from', root, 'srv'], UV, root, work)).toEqual({ command: UV.uvxBin, args: ['--from', work, 'srv'], usesWork: true })
      expect(throughManagedUv('uvx', [`--from=${dir}`, 'srv'], UV, root, work).args).toEqual([`--from=${join(work, 'server')}`, 'srv'])
      // A package from an index, a project outside the cache, an explicit --no-project, or no working copy: as written.
      expect(throughManagedUv('uvx', ['--from', 'carbone-mcp==1.0', 'srv'], UV, root, work)).toEqual({ command: UV.uvxBin, args: ['--from', 'carbone-mcp==1.0', 'srv'] })
      expect(throughManagedUv('uv', ['run', '--directory', '/elsewhere', 'srv'], UV, root, work).args).toEqual(['run', '--directory', '/elsewhere', 'srv'])
      expect(throughManagedUv('uv', ['run', '--no-project', '--directory', dir, 'x'], UV, root, work).args).toEqual(['run', '--no-project', '--directory', dir, 'x'])
      expect(throughManagedUv('uv', ['run', '--directory', dir, 'srv'], UV, root)).toEqual({ command: UV.uvBin, args: ['run', '--directory', dir, 'srv'] })
      // A locked project stays in the cache, frozen.
      writeFileSync(join(root, 'server', 'uv.lock'), 'version = 1\n')
      expect(throughManagedUv('uv', ['run', '--directory', dir, 'srv'], UV, root, work).args).toEqual(['run', '--frozen', '--directory', dir, 'srv'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks a Node server when Node.js is not on the login-shell PATH, and never a Python one', async () => {
    const { runtimes: r } = runtimes({})
    expect(await r.blockOf([{ transport: 'stdio', runtime: 'node' }], ALLOWED)).toBe(STDIO_RUNTIME_TEXT.node)
    expect(STDIO_RUNTIME_TEXT.node).toBe('Needs Node.js — install it from nodejs.org')
    expect(await r.blockOf([{ transport: 'stdio', runtime: 'docker' }], ALLOWED)).toBe(STDIO_RUNTIME_TEXT.docker)
    expect(await r.blockOf([{ transport: 'stdio', runtime: 'python' }], ALLOWED)).toBeNull()
    expect(await r.blockOf([{ transport: 'http', runtime: 'node' }], ALLOWED)).toBeNull()
  })

  it('lets a Node server through when Node.js is there', async () => {
    const { runtimes: r } = runtimes({ node: '/usr/local/bin/node', npx: '/usr/local/bin/npx' })
    expect(await r.blockOf([{ transport: 'stdio', runtime: 'node' }], ALLOWED)).toBeNull()
  })

  it('looks once per session, and again on recheck', async () => {
    const found: Record<string, string | null> = {}
    const { which, clear, runtimes: r } = runtimes(found)
    await r.available('node')
    await r.available('node')
    expect(which).toHaveBeenCalledTimes(2) // node and npx, once
    found.node = '/usr/local/bin/node'
    expect(await r.available('node')).toBe(false)
    expect(await r.recheck()).toEqual({ node: true, docker: false })
    expect(clear).toHaveBeenCalled()
    expect(await r.blockOf([{ transport: 'stdio', runtime: 'node' }], ALLOWED)).toBeNull()
  })

  it('blocks every local server when the admin’s policy forbids them', async () => {
    const { runtimes: r } = runtimes({ node: '/n' })
    expect(await r.blockOf([{ transport: 'stdio', runtime: 'python' }], { stdioMcp: false })).toBe('Blocked by your admin')
    expect(await r.blockOf([{ transport: 'http', runtime: null }], { stdioMcp: false })).toBeNull()
  })
})
