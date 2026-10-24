import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStdioRuntimes, runtimeOfCommand, STDIO_RUNTIME_TEXT, throughManagedUv } from './stdioRuntimes'

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
