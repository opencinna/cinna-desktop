import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { CINNA_NODE_ENV, cinnaNodeShim, createCinnaNode } = await import('./cinnaNode')

const ELECTRON = { command: '/Applications/Cinna Desktop.app/Contents/MacOS/Cinna Desktop', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cinna-node-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    return statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function fakeNodeOn(dir: string): string {
  const path = join(dir, 'node')
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

describe('CINNA_NODE', () => {
  it('names the user’s node when one resolves on the engine’s PATH, and writes no shim', async () => {
    const bin = tempDir()
    const shims = join(tempDir(), 'bin')
    const node = fakeNodeOn(bin)
    const cinnaNode = createCinnaNode({ platform: 'darwin', nodeRuntime: () => ELECTRON, binDir: () => shims, isExecutable })
    const env = await cinnaNode.apply({ PATH: `/nowhere:${bin}`, HOME: '/h' })
    expect(env).toEqual({ PATH: `/nowhere:${bin}`, HOME: '/h', [CINNA_NODE_ENV]: node })
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false)
    expect(() => statSync(shims)).toThrow()
  })

  it('otherwise names a shim around the host runtime, executable, with ELECTRON_RUN_AS_NODE inside it only', async () => {
    const shims = join(tempDir(), 'bin')
    const cinnaNode = createCinnaNode({ platform: 'darwin', nodeRuntime: () => ELECTRON, binDir: () => shims, isExecutable })
    const env = await cinnaNode.apply({ PATH: '/nowhere' })
    expect(env[CINNA_NODE_ENV]).toBe(join(shims, 'cinna-node'))
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false)
    expect(readFileSync(join(shims, 'cinna-node'), 'utf8')).toBe(
      "#!/bin/sh\nELECTRON_RUN_AS_NODE='1' exec '/Applications/Cinna Desktop.app/Contents/MacOS/Cinna Desktop' \"$@\"\n"
    )
    expect(statSync(join(shims, 'cinna-node')).mode & 0o777).toBe(0o755)
  })

  it('rewrites the shim only when its content differs', async () => {
    const shims = join(tempDir(), 'bin')
    let runtime = ELECTRON
    const cinnaNode = createCinnaNode({ platform: 'linux', nodeRuntime: () => runtime, binDir: () => shims, isExecutable })
    const path = await cinnaNode.ensureShim()
    const before = statSync(path).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await cinnaNode.ensureShim()).toBe(path)
    expect(statSync(path).mtimeMs).toBe(before)
    runtime = { ...ELECTRON, command: '/opt/Cinna/cinna' }
    await cinnaNode.ensureShim()
    expect(readFileSync(path, 'utf8')).toContain("exec '/opt/Cinna/cinna' \"$@\"")
    // An edited shim is put back.
    writeFileSync(path, 'tampered')
    await cinnaNode.ensureShim()
    expect(readFileSync(path, 'utf8')).toContain('#!/bin/sh')
  })

  it('runs a script the way node does, through the host runtime (plain Node here)', async () => {
    const shims = join(tempDir(), 'bin')
    const cinnaNode = createCinnaNode({ platform: process.platform, nodeRuntime: () => ({ command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }), binDir: () => shims, isExecutable })
    if (process.platform === 'win32') return
    const shim = await cinnaNode.ensureShim()
    const dir = tempDir()
    mkdirSync(join(dir, 'api'))
    writeFileSync(join(dir, 'api', 'echo.mjs'), 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), flag: process.env.ELECTRON_RUN_AS_NODE }))')
    const out = execFileSync(shim, [join(dir, 'api', 'echo.mjs'), 'a b'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(JSON.parse(out)).toEqual({ argv: ['a b'], flag: '1' })
  })

  it('is a .cmd on Windows', () => {
    const shim = cinnaNodeShim('win32', { command: 'C:\\Program Files\\Cinna\\Cinna.exe', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(shim).toEqual({
      name: 'cinna-node.cmd',
      content: '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\Program Files\\Cinna\\Cinna.exe" %*\r\n'
    })
  })

  it('leaves the env alone when the shim cannot be written', async () => {
    const file = join(tempDir(), 'not-a-dir')
    writeFileSync(file, '')
    const cinnaNode = createCinnaNode({ platform: 'darwin', nodeRuntime: () => ELECTRON, binDir: () => join(file, 'bin'), isExecutable })
    expect(await cinnaNode.apply({ PATH: '/nowhere' })).toEqual({ PATH: '/nowhere' })
  })
})
