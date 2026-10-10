import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const host = vi.hoisted(() => ({ isPackaged: false, resourcesPath: '/packaged', appPath: '/repo', userData: '' }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: {
  get isPackaged() { return host.isPackaged }, get resourcesPath() { return host.resourcesPath },
  getAppPath: () => host.appPath, getPath: () => host.userData
} }))
import { engineCredentialEnv, ensureSkillRuntime, skillRuntimeCopiesDir, skillRuntimeSourceDir, withSkillRuntime } from './skillRuntime'

const repoRoot = process.cwd()
const SHIM = join(repoRoot, 'resources', 'skill-runtime')

describe('the engine env of a folder agent', () => {
  const dir = () => '/res/skill-runtime'

  it('puts the skill runtime first on PYTHONPATH for a kit agent, keeping what was there', () => {
    expect(engineCredentialEnv({ PATH: '/bin' }, { path: '/a/credentials/credentials.json', skillRuntime: true }, dir))
      .toEqual({ PATH: '/bin', CINNA_CREDENTIALS_PATH: '/a/credentials/credentials.json', PYTHONPATH: '/res/skill-runtime' })
    expect(engineCredentialEnv({ PYTHONPATH: ['/mine', '/res/skill-runtime', ''].join(delimiter) }, { skillRuntime: true }, dir).PYTHONPATH)
      .toBe(['/res/skill-runtime', '/mine'].join(delimiter))
  })

  it('leaves a bare folder’s PYTHONPATH alone, and drops a stale credentials path', () => {
    expect(engineCredentialEnv({ PYTHONPATH: '/mine', CINNA_CREDENTIALS_PATH: '/stale' }, { skillRuntime: false }, dir)).toEqual({ PYTHONPATH: '/mine' })
    expect(engineCredentialEnv({ CINNA_CREDENTIALS_PATH: '/stale' }, { skillRuntime: true }, dir)).toEqual({ PYTHONPATH: '/res/skill-runtime' })
  })

  it('reads the runtime from the repo in development', () => {
    expect(skillRuntimeSourceDir()).toBe(join('/repo', 'resources', 'skill-runtime'))
    expect(withSkillRuntime({}, '/x')).toEqual({ PYTHONPATH: '/x' })
  })

  it('ships the runtime as its own resource, outside the asar, without bytecode', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain("  - '!resources/skill-runtime/**'")
    expect(yml).toMatch(/- from: resources\/skill-runtime\n\s+to: skill-runtime\n\s+filter:\n\s+- '\*\*\/\*'\n\s+- '!\*\*\/__pycache__\/\*\*'/)
  })
})

describe('the copy of the skill runtime under userData', () => {
  function sandbox() {
    const base = mkdtempSync(join(tmpdir(), 'cinna-skill-runtime-copy-'))
    const source = join(base, 'Resources', 'skill-runtime')
    mkdirSync(join(source, 'core', 'cinna_api', '__pycache__'), { recursive: true })
    writeFileSync(join(source, 'core', '__init__.py'), '')
    writeFileSync(join(source, 'core', 'cinna_api', '__init__.py'), 'VERSION = 1\n')
    writeFileSync(join(source, 'core', 'cinna_api', '__pycache__', 'x.pyc'), 'bytecode')
    Object.assign(host, { isPackaged: true, resourcesPath: join(base, 'Resources'), userData: join(base, 'userData') })
    return { base, source, done: () => { Object.assign(host, { isPackaged: false, resourcesPath: '/packaged', userData: '' }); rmSync(base, { recursive: true, force: true }) } }
  }

  it('puts the userData copy on PYTHONPATH, never the shipped folder inside the app bundle', () => {
    const { source, done } = sandbox()
    try {
      const path = engineCredentialEnv({}, { skillRuntime: true }).PYTHONPATH
      expect(path.startsWith(join(host.userData, 'skill-runtime') + '/')).toBe(true)
      expect(path.startsWith(source)).toBe(false)
      expect(readFileSync(join(path, 'core', 'cinna_api', '__init__.py'), 'utf8')).toBe('VERSION = 1\n')
      // Bytecode the shipped tree may carry is not copied.
      expect(existsSync(join(path, 'core', 'cinna_api', '__pycache__'))).toBe(false)
    } finally { done() }
  })

  it('copies once, and rebuilds only when the shipped tree changes, removing the old copy', () => {
    const { source, done } = sandbox()
    try {
      const first = ensureSkillRuntime()!
      expect(first).toBe(join(skillRuntimeCopiesDir(), first.split('/').pop()!))
      // Python's bytecode beside the copy survives another turn: nothing is copied again.
      mkdirSync(join(first, 'core', '__pycache__'))
      writeFileSync(join(first, 'core', '__pycache__', 'written-by-python.pyc'), '')
      expect(ensureSkillRuntime()).toBe(first)
      expect(existsSync(join(first, 'core', '__pycache__', 'written-by-python.pyc'))).toBe(true)

      writeFileSync(join(source, 'core', 'cinna_api', '__init__.py'), 'VERSION = 2\n')
      const second = ensureSkillRuntime()!
      expect(second).not.toBe(first)
      expect(readFileSync(join(second, 'core', 'cinna_api', '__init__.py'), 'utf8')).toBe('VERSION = 2\n')
      expect(readdirSync(skillRuntimeCopiesDir())).toEqual([second.split('/').pop()])
    } finally { done() }
  })

  it('gives no PYTHONPATH entry when the copy cannot be made', () => {
    const { source, done } = sandbox()
    try {
      rmSync(source, { recursive: true, force: true })
      expect(ensureSkillRuntime()).toBeNull()
      expect(engineCredentialEnv({ PATH: '/bin' }, { skillRuntime: true })).toEqual({ PATH: '/bin' })
    } finally { done() }
  })
})

const python = spawnSync('python3', ['--version']).status === 0
const credentialsFile = [
  { id: 'c1', name: 'ERP placeholder', type: 'api_token', service_uri: 'erp-api', is_placeholder: true, credential_data: {} },
  { id: 'c2', name: 'ERP', type: 'api_token', service_uri: 'erp-api', is_placeholder: false, credential_data: { http_header_value: 'Bearer erp' } },
  { id: 'c3', name: 'CRM draft', type: 'odoo', service_uri: 'crm', is_placeholder: true, credential_data: {} },
  { id: 'k1', name: 'Producer key', type: 'agent_api', service_uri: 'producer', is_placeholder: false, unavailable_reason: 'key_revoked', key_status: 'revoked_by_issuer', credential_data: { base_url: 'https://p.example' } },
  { id: 'current_user', name: 'me', type: 'current_user', service_uri: 'me', is_placeholder: false, credential_data: { email: 'me@example.test' } }
]

/** Run a script against the shim, isolated (`-I` ignores PYTHONPATH, so the path is inserted here) and writing no bytecode. */
function run(script: string, env: Record<string, string | undefined>): string {
  return execFileSync('python3', ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(SHIM)})\n${script}`], { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv, encoding: 'utf8' }).trim()
}

describe.skipIf(!python)('core.cinna_api on a desktop', () => {
  it('finds credentials by slot as core does: filled first, then why not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinna-skill-runtime-'))
    try {
      const file = join(dir, 'credentials.json')
      writeFileSync(file, JSON.stringify(credentialsFile))
      const out = run(`
from core.cinna_api import credentials, CredentialMissing
print(credentials.require_slot('erp-api')['id'])
print(credentials.by_slot('me'))
for slot in ('crm', 'producer', 'nothing'):
    try:
        credentials.require_slot(slot)
    except CredentialMissing as e:
        print(e.reason, e.key_status)
print(credentials.by_type('odoo')['id'], [c['id'] for c in credentials.all_by_type('api_token')], credentials.get('ERP')['id'], len(credentials.all()))
try:
    credentials.require_slot('nothing')
except CredentialMissing as e:
    print(e)
try:
    credentials.agent_api_session('erp-api')
except ValueError as e:
    print('ValueError')
`, { CINNA_CREDENTIALS_PATH: file })
      expect(out.split('\n')).toEqual([
        'c2',
        'None',
        'not_configured None',
        'key_revoked revoked_by_issuer',
        'not_linked None',
        "c3 ['c1', 'c2'] c2 5",
        "credential_missing: no credential for slot 'nothing' is linked to this agent. Fix: open the agent's Credentials tab and link a credential whose service URI (slot) is 'nothing'.",
        'ValueError'
      ])
      // Re-read on every call, envelope tolerated.
      writeFileSync(file, JSON.stringify({ credentials: [credentialsFile[2]] }))
      expect(run(`from core.cinna_api import credentials\nprint(credentials.by_slot('erp-api'), credentials.by_slot('crm')['id'])`, { CINNA_CREDENTIALS_PATH: file })).toBe('None c3')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads nothing without CINNA_CREDENTIALS_PATH, and never calls the platform for a token', () => {
    expect(run(`
from core.cinna_api import credentials, CredentialMissing, CredentialRefreshError
print(credentials.all())
try:
    credentials.access_token('c2')
except CredentialRefreshError as e:
    print(e.code)
`, { CINNA_CREDENTIALS_PATH: undefined, BACKEND_URL: 'http://127.0.0.1:9', AGENT_AUTH_TOKEN: 't', ENV_ID: 'e' }).split('\n')).toEqual(['[]', 'credential_not_linked'])
  })
})
