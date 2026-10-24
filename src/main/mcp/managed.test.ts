import { describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A managed (plugin) provider at launch: `${VAR}`s filled from the user's
 * encrypted values and the plugin's own env, declared headers resolved, the
 * managed uv's `UV_*` environment plus a writable project environment under
 * a managed-uv command, a launch refused when the policy forbids it or the
 * cached tree changed, and a provider no plugin owns left exactly as it is.
 */

const policy = vi.hoisted(() => ({ stdioMcp: true }))
const tree = vi.hoisted(() => ({ ok: true }))

vi.mock('../localdev/toolchain', () => ({
  managedUvLayout: () => ({ uvBin: '/ud/localdev/uv/uv', uvxBin: '/ud/localdev/uv/uvx', env: { UV_CACHE_DIR: '/ud/localdev/uv-cache', UV_PYTHON_INSTALL_DIR: '/ud/localdev/python' } })
}))
const paths = vi.hoisted(() => ({ userData: '/ud' }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => paths.userData, keystore: { isEncryptionAvailable: () => false } } }))
vi.mock('../services/addonDirectory/policy', () => ({ addonPolicies: { get: () => ({ stdioMcp: policy.stdioMcp, pluginHooks: true }) } }))
vi.mock('../services/marketplacePluginCache', () => ({
  verifyPluginTree: () => tree.ok,
  PLUGIN_TREE_MODIFIED_SENTENCE: 'The cached copy was changed on disk — Update to restore it'
}))
vi.mock('../services/stdioRuntimes', () => ({ STDIO_RUNTIME_TEXT: { policy: 'Blocked by your admin' } }))

const {
  collectPluginWork,
  directoryEnvToSeal,
  directorySlotStates,
  discardPluginWork,
  encryptManagedSecrets,
  ensurePluginWorkCopy,
  managedSecrets,
  fillPlaceholders,
  missingEnvOf,
  pluginWorkDir,
  PLUGIN_WORK_COPY_FAILED,
  managedSlotStates,
  missingManagedEnv,
  pluginManagedBy,
  pluginOfManagedBy,
  resolveManagedLaunch,
  snapshotKeyOfManagedBy
} = await import('./managed')

const ENTRY = '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f'
const SHA = 'a'.repeat(64)
const OWNER = pluginManagedBy(ENTRY, SHA)

const base = {
  id: 'm1',
  userId: 'u',
  configRevision: 0,
  name: 'carbone',
  transportType: 'stdio' as const,
  enabled: true,
  authType: 'oauth' as const
}

const owned = (values: Record<string, string>, spec: Partial<{ slots: string[]; headers: Record<string, string>; bearer: boolean }> = {}) => ({
  managedBy: OWNER,
  managedSpec: { root: '/cache/carbone', slots: Object.keys(values), ...spec },
  envSecretEncrypted: encryptManagedSecrets(values)
})

describe('managed MCP providers', () => {
  it('fills placeholders from the user’s values and the plugin’s env at launch', () => {
    const config = resolveManagedLaunch(
      { ...base, command: 'node', args: ['/c/s.mjs', '--key=${API_KEY}', '${UNKNOWN}'], env: { API_KEY: '${API_KEY}', AUTH: 'Bearer ${API_KEY}', MODE: 'fast' } },
      owned({ API_KEY: 'sk-1' })
    )
    expect(config.args).toEqual(['/c/s.mjs', '--key=sk-1', '${UNKNOWN}'])
    expect(config.env).toEqual({ API_KEY: 'sk-1', AUTH: 'Bearer sk-1', MODE: 'fast' })
    expect(config.blockedReason).toBeUndefined()
  })

  it('hands a managed-uv command uv’s environment and its own writable project environment', () => {
    const config = resolveManagedLaunch({ ...base, command: '/ud/localdev/uv/uv', args: ['run', '--frozen', '--directory', '/cache/carbone', 'carbone'], env: {} }, owned({}))
    expect(config.env).toEqual({
      UV_CACHE_DIR: '/ud/localdev/uv-cache',
      UV_PYTHON_INSTALL_DIR: '/ud/localdev/python',
      UV_PROJECT_ENVIRONMENT: `/ud/plugin-envs/${ENTRY}/${SHA}/carbone`
    })
    expect(resolveManagedLaunch({ ...base, command: 'node', args: [] }, owned({})).env).toEqual({})
  })

  it('resolves an HTTP server’s declared headers', () => {
    const config = resolveManagedLaunch(
      { ...base, transportType: 'streamable-http', url: 'https://api.example/mcp', authType: 'bearer' },
      owned({ API_KEY: 'sk-h' }, { headers: { 'X-Api-Key': '${API_KEY}', 'X-Org': 'acme' } })
    )
    expect(config.headers).toEqual({ 'X-Api-Key': 'sk-h', 'X-Org': 'acme' })
  })

  it('refuses to launch a local server whose cached files changed, or when the policy forbids local servers', () => {
    tree.ok = false
    expect(resolveManagedLaunch({ ...base, command: 'node', args: [] }, owned({})).blockedReason).toBe('The cached copy was changed on disk — Update to restore it')
    tree.ok = true
    policy.stdioMcp = false
    expect(resolveManagedLaunch({ ...base, command: 'node', args: [] }, owned({})).blockedReason).toBe('Blocked by your admin')
    policy.stdioMcp = true
  })

  it('leaves a provider no plugin owns as it is', () => {
    const config = { ...base, command: 'node', args: ['${X}'], env: { X: '1' } }
    expect(resolveManagedLaunch(config, { managedBy: null })).toBe(config)
  })

  it('reads the owner, its snapshot and what is still to fill in — names and booleans only', () => {
    expect(pluginManagedBy(' ABC ', 'F00')).toBe('plugin:abc@f00')
    expect(pluginOfManagedBy('plugin:abc@f00')).toEqual({ entryUuid: 'abc', sha: 'f00' })
    expect(pluginOfManagedBy(null)).toBeNull()
    expect(snapshotKeyOfManagedBy(OWNER)).toBe(`${ENTRY}/${SHA}`)
    const row = { ...owned({ A: 'x' }), managedSpec: { root: '/c', slots: ['A', 'B'] } }
    expect(missingManagedEnv(row)).toEqual(['B'])
    expect(managedSlotStates(row)).toEqual([
      { name: 'A', hasValue: true },
      { name: 'B', hasValue: false }
    ])
    expect(missingManagedEnv({ managedBy: null, managedSpec: { root: '/c', slots: ['A'] } })).toEqual([])
    expect(fillPlaceholders('${A}-${B}', { A: '1' })).toBe('1-${B}')
  })

  it('reads a directory connector’s empty settings as still to fill in, and never a hand-made connector’s', () => {
    const ref = { source: 'core-mcp-directory', id: 'fs' }
    expect(missingEnvOf({ registryRef: ref, env: { ROOT: '', TOKEN: 'x', KEY: '' } })).toEqual(['KEY', 'ROOT'])
    expect(missingEnvOf({ registryRef: null, env: { ROOT: '' } })).toEqual([])
    expect(missingEnvOf({ registryRef: ref, env: null })).toEqual([])
    expect(missingEnvOf({ ...owned({ A: 'x' }), managedSpec: { root: '/c', slots: ['A', 'B'] } })).toEqual(['B'])
  })
})

describe('directory connectors at launch', () => {
  const ref = { source: 'core-mcp-directory', id: 'fetch' }

  it('hands a directory server under the managed uv uv’s environment, its own settings kept', () => {
    const config = resolveManagedLaunch({ ...base, command: '/ud/localdev/uv/uvx', args: ['mcp-server-fetch==1.0'], env: { KEY: 'k' } }, { managedBy: null, registryRef: ref })
    expect(config.env).toEqual({ UV_CACHE_DIR: '/ud/localdev/uv-cache', UV_PYTHON_INSTALL_DIR: '/ud/localdev/python', KEY: 'k' })
    expect(config.blockedReason).toBeUndefined()
  })

  it('refuses a local directory server while the policy forbids local servers, and leaves a remote one and a hand-made one alone', () => {
    policy.stdioMcp = false
    try {
      expect(resolveManagedLaunch({ ...base, command: 'npx', args: ['-y', 'x'] }, { managedBy: null, registryRef: ref }).blockedReason).toBe('Blocked by your admin')
      const remote = { ...base, transportType: 'streamable-http' as const, url: 'https://x.example' }
      expect(resolveManagedLaunch(remote, { managedBy: null, registryRef: ref })).toBe(remote)
      const handMade = { ...base, command: 'npx', args: ['-y', 'x'] }
      expect(resolveManagedLaunch(handMade, { managedBy: null, registryRef: null })).toBe(handMade)
    } finally {
      policy.stdioMcp = true
    }
  })
})

describe('a local directory connector’s settings are secret', () => {
  const ref = { source: 'core-mcp-directory', id: 'fs' }
  const sealed = (values: Record<string, string>, names: string[]) => ({
    managedBy: null,
    registryRef: ref,
    transportType: 'stdio',
    env: Object.fromEntries(names.map((name) => [name, ''])),
    envSecretEncrypted: encryptManagedSecrets(values)
  })

  it('reads the encrypted values for what is still to fill in, and the renderer’s view is names and booleans', () => {
    const row = sealed({ TOKEN: 'sk-1' }, ['ROOT', 'TOKEN'])
    expect(missingEnvOf(row)).toEqual(['ROOT'])
    expect(directorySlotStates(row)).toEqual([
      { name: 'ROOT', hasValue: false },
      { name: 'TOKEN', hasValue: true }
    ])
    expect(JSON.stringify(directorySlotStates(row))).not.toContain('sk-1')
  })

  it('moves values still in the plain env into the encrypted column, the names kept, and nothing when none is plain', () => {
    const legacy = { managedBy: null, registryRef: ref, transportType: 'stdio', env: { ROOT: '/srv', TOKEN: '' }, envSecretEncrypted: encryptManagedSecrets({ OLD: 'o' }) }
    const next = directoryEnvToSeal(legacy)!
    expect(next.env).toEqual({ OLD: '', ROOT: '', TOKEN: '' })
    expect(managedSecrets({ envSecretEncrypted: next.envSecretEncrypted })).toEqual({ OLD: 'o', ROOT: '/srv' })
    expect(directoryEnvToSeal(sealed({ TOKEN: 'x' }, ['TOKEN']))).toBeNull()
    // A hand-made connector's env is the user's as typed, and a remote one has none to seal.
    expect(directoryEnvToSeal({ ...legacy, registryRef: null })).toBeNull()
    expect(directoryEnvToSeal({ ...legacy, transportType: 'streamable-http' })).toBeNull()
  })

  it('launches with the decrypted values, a name with none left empty', () => {
    const row = sealed({ TOKEN: 'sk-1' }, ['ROOT', 'TOKEN'])
    const config = resolveManagedLaunch({ ...base, command: 'npx', args: ['-y', 'fs'], env: row.env }, row)
    expect(config.env).toEqual({ ROOT: '', TOKEN: 'sk-1' })
  })
})

describe('a snapshot’s writable working copy', () => {
  function readOnlyTree(): { home: string; root: string } {
    const home = mkdtempSync(join(tmpdir(), 'cinna-work-'))
    const root = join(home, 'cache', 'srv')
    mkdirSync(join(root, 'server'), { recursive: true })
    writeFileSync(join(root, 'server', 'pyproject.toml'), '[project]\nname = "srv"\n')
    chmodSync(join(root, 'server', 'pyproject.toml'), 0o444)
    chmodSync(join(root, 'server'), 0o555)
    chmodSync(root, 0o555)
    return { home, root }
  }
  const cleanup = (home: string, root: string): void => {
    chmodSync(root, 0o755)
    chmodSync(join(root, 'server'), 0o755)
    rmSync(home, { recursive: true, force: true })
  }

  it('lives under userData per entry and snapshot', () => {
    expect(pluginWorkDir(OWNER)).toBe(join('/ud', 'plugin-work', ENTRY, SHA))
    expect(pluginWorkDir(null)).toBeNull()
  })

  it('is copied writable from the read-only cache once, kept with what the server wrote, and the cache is never written', () => {
    const { home, root } = readOnlyTree()
    try {
      const work = join(home, 'plugin-work', 'e', 's')
      ensurePluginWorkCopy(root, work)
      expect(readFileSync(join(work, 'server', 'pyproject.toml'), 'utf8')).toContain('srv')
      writeFileSync(join(work, 'server', 'uv.lock'), 'version = 1\n')
      expect(statSync(join(work, 'server')).mode & 0o200).toBe(0o200)
      // The cache's files are read-only; their copies are the server's to rewrite.
      expect(statSync(join(work, 'server', 'pyproject.toml')).mode & 0o200).toBe(0o200)
      ensurePluginWorkCopy(root, work)
      expect(existsSync(join(work, 'server', 'uv.lock'))).toBe(true)
      expect(existsSync(join(root, 'server', 'uv.lock'))).toBe(false)
    } finally {
      cleanup(home, root)
    }
  })

  it('is copied again from the cache when a file it copied changed or went, and never for what the server writes', () => {
    const { home, root } = readOnlyTree()
    try {
      const work = join(home, 'plugin-work', 'e', 's')
      ensurePluginWorkCopy(root, work)
      const project = join(work, 'server', 'pyproject.toml')
      // What a server writes: its lock, environments, caches, build output and any new file.
      writeFileSync(join(work, 'server', 'uv.lock'), 'version = 1\n')
      for (const dir of ['.venv', '__pycache__', 'srv.egg-info', 'build', 'dist']) {
        mkdirSync(join(work, 'server', dir), { recursive: true })
        writeFileSync(join(work, 'server', dir, 'f'), 'x')
      }
      writeFileSync(join(work, 'server', 'state.json'), '{}')
      ensurePluginWorkCopy(root, work)
      expect(existsSync(join(work, 'server', 'uv.lock'))).toBe(true)
      expect(existsSync(join(work, 'server', 'state.json'))).toBe(true)

      writeFileSync(project, '[project]\nname = "evil"\n')
      ensurePluginWorkCopy(root, work)
      expect(readFileSync(project, 'utf8')).toContain('"srv"')
      // A fresh copy: what the server wrote into the changed one is gone with it.
      expect(existsSync(join(work, 'server', 'state.json'))).toBe(false)

      rmSync(project)
      ensurePluginWorkCopy(root, work)
      expect(readFileSync(project, 'utf8')).toContain('"srv"')
    } finally {
      cleanup(home, root)
    }
  })

  it('never checks the files of the snapshot’s own build output, environments or lock, which the server may rewrite', () => {
    const home = mkdtempSync(join(tmpdir(), 'cinna-work-own-'))
    try {
      const root = join(home, 'cache')
      for (const dir of ['build', 'dist', '.venv', '__pycache__', 'srv.egg-info']) {
        mkdirSync(join(root, dir), { recursive: true })
        writeFileSync(join(root, dir, 'f'), 'shipped')
      }
      writeFileSync(join(root, 'uv.lock'), 'shipped')
      writeFileSync(join(root, 'main.py'), 'print(1)')
      const work = join(home, 'work')
      ensurePluginWorkCopy(root, work)
      for (const dir of ['build', 'dist', '.venv', '__pycache__', 'srv.egg-info']) writeFileSync(join(work, dir, 'f'), 'rewritten')
      writeFileSync(join(work, 'uv.lock'), 'rewritten')
      writeFileSync(join(work, 'state'), 'mine')
      ensurePluginWorkCopy(root, work)
      expect(readFileSync(join(work, 'uv.lock'), 'utf8')).toBe('rewritten')
      expect(readFileSync(join(work, 'build', 'f'), 'utf8')).toBe('rewritten')
      expect(existsSync(join(work, 'state'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is discarded with its snapshot, and swept when no pin or connector references it', () => {
    const home = mkdtempSync(join(tmpdir(), 'cinna-work-gc-'))
    paths.userData = home
    try {
      const base = join(home, 'plugin-work')
      const make = (entry: string, sha: string): void => {
        mkdirSync(join(base, entry, sha), { recursive: true })
        writeFileSync(join(base, entry, `${sha}.source`), '{}')
      }
      make(ENTRY, SHA)
      make(ENTRY, 'b'.repeat(64))
      make('other-entry', 'c'.repeat(64))
      mkdirSync(join(base, ENTRY, `${'b'.repeat(64)}.staging-1-2`))
      expect(collectPluginWork(new Set([`${ENTRY}/${SHA}`]))).toBe(2)
      expect(readdirSync(base)).toEqual([ENTRY])
      expect(readdirSync(join(base, ENTRY)).sort()).toEqual([SHA, `${SHA}.source`])

      discardPluginWork(OWNER)
      expect(existsSync(join(base, ENTRY, SHA))).toBe(false)
      expect(existsSync(join(base, ENTRY, `${SHA}.source`))).toBe(false)
      expect(collectPluginWork(new Set())).toBe(0)
    } finally {
      paths.userData = '/ud'
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('is made at launch for a server that runs from it, and a copy that cannot be made refuses the launch', () => {
    const { home, root } = readOnlyTree()
    try {
      const work = join(home, 'plugin-work', 'e', 's')
      const row = { managedBy: OWNER, managedSpec: { root, slots: [], work }, envSecretEncrypted: null }
      const config = resolveManagedLaunch({ ...base, command: '/ud/localdev/uv/uv', args: ['run', '--directory', join(work, 'server'), 'srv'] }, row)
      expect(config.blockedReason).toBeUndefined()
      expect(existsSync(join(work, 'server', 'pyproject.toml'))).toBe(true)

      const missing = { ...row, managedSpec: { root: join(home, 'nowhere'), slots: [], work: join(home, 'w2') } }
      expect(resolveManagedLaunch({ ...base, command: '/ud/localdev/uv/uv', args: ['run'] }, missing).blockedReason).toBe(PLUGIN_WORK_COPY_FAILED)
    } finally {
      cleanup(home, root)
    }
  })
})
