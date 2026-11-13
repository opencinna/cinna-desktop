import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { CINNA_NODE_ENV, cinnaNodeShim, createCinnaNode } = await import('./cinnaNode')

// The leading args are the extra-CA preload (runtimeHost.nodeRuntime), a path with a space.
const PRELOAD = '/Applications/Cinna Desktop.app/Contents/Resources/app.asar.unpacked/resources/node-extra-ca/preload.cjs'
const ELECTRON = { command: '/Applications/Cinna Desktop.app/Contents/MacOS/Cinna Desktop', args: ['--require', PRELOAD], env: { ELECTRON_RUN_AS_NODE: '1' } }
const REPO_PRELOAD = join(__dirname, '..', '..', '..', 'resources', 'node-extra-ca', 'preload.cjs')

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
      `#!/bin/sh\nCINNA_EXTRA_CA_CERTS="\${NODE_EXTRA_CA_CERTS-}" ELECTRON_RUN_AS_NODE='1' exec '/Applications/Cinna Desktop.app/Contents/MacOS/Cinna Desktop' '--require' '${PRELOAD}' "$@"\n`
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
    expect(readFileSync(path, 'utf8')).toContain(`exec '/opt/Cinna/cinna' '--require' '${PRELOAD}' "$@"`)
    // An edited shim is put back.
    writeFileSync(path, 'tampered')
    await cinnaNode.ensureShim()
    expect(readFileSync(path, 'utf8')).toContain('#!/bin/sh')
  })

  it('runs a script the way node does, through the host runtime and its preload (plain Node here)', async () => {
    const shims = join(tempDir(), 'bin')
    const cinnaNode = createCinnaNode({ platform: process.platform, nodeRuntime: () => ({ command: process.execPath, args: ['--require', REPO_PRELOAD], env: { ELECTRON_RUN_AS_NODE: '1', CINNA_EXTRA_CA_CERTS: '/host.pem' } }), binDir: () => shims, isExecutable })
    if (process.platform === 'win32') return
    const shim = await cinnaNode.ensureShim()
    const dir = tempDir()
    mkdirSync(join(dir, 'api'))
    writeFileSync(join(dir, 'api', 'echo.mjs'), 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), flag: process.env.ELECTRON_RUN_AS_NODE }))')
    // Host env with its own CA path: not baked into the shim.
    expect(readFileSync(shim, 'utf8')).not.toContain('host.pem')
    const out = execFileSync(shim, [join(dir, 'api', 'echo.mjs'), 'a b'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(JSON.parse(out)).toEqual({ argv: ['a b'], flag: '1' })
    // The preload ran ahead of the script: an unusable NODE_EXTRA_CA_CERTS costs a warning, not the run.
    const child = spawnSync(shim, [join(dir, 'api', 'echo.mjs')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NODE_EXTRA_CA_CERTS: join(dir, 'none.pem') } })
    expect(JSON.parse(child.stdout)).toEqual({ argv: [], flag: '1' })
    expect(child.stderr).toContain(`Warning: Ignoring extra certs from ${join(dir, 'none.pem')}, load failed: ENOENT`)
    // What the preload sees is the engine's value as CINNA_EXTRA_CA_CERTS.
    writeFileSync(join(dir, 'api', 'ca.mjs'), 'process.stdout.write(String(process.env.CINNA_EXTRA_CA_CERTS))')
    expect(execFileSync(shim, [join(dir, 'api', 'ca.mjs')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NODE_EXTRA_CA_CERTS: '/engine/ca.pem' } }))
      .toBe('/engine/ca.pem')
  })

  it('is a .cmd on Windows', () => {
    const preload = 'C:\\Program Files\\Cinna\\resources\\app.asar.unpacked\\resources\\node-extra-ca\\preload.cjs'
    // The host's own CA path is never baked in; the engine's NODE_EXTRA_CA_CERTS is handed on at run time.
    const shim = cinnaNodeShim('win32', { command: 'C:\\Program Files\\Cinna\\Cinna.exe', args: ['--require', preload], env: { ELECTRON_RUN_AS_NODE: '1', CINNA_EXTRA_CA_CERTS: 'C:\\host.pem' } })
    expect(shim).toEqual({
      name: 'cinna-node.cmd',
      content: `@echo off\r\nsetlocal\r\nif defined NODE_EXTRA_CA_CERTS set "CINNA_EXTRA_CA_CERTS=%NODE_EXTRA_CA_CERTS%"\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\Program Files\\Cinna\\Cinna.exe" "--require" "${preload}" %*\r\n`
    })
  })

  it('leaves the env alone when the shim cannot be written', async () => {
    const file = join(tempDir(), 'not-a-dir')
    writeFileSync(file, '')
    const cinnaNode = createCinnaNode({ platform: 'darwin', nodeRuntime: () => ELECTRON, binDir: () => join(file, 'bin'), isExecutable })
    expect(await cinnaNode.apply({ PATH: '/nowhere' })).toEqual({ PATH: '/nowhere' })
  })
})
