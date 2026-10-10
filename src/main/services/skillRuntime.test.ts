import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

vi.mock('../host/runtimeHost', () => ({ runtimeHost: { isPackaged: false, resourcesPath: '/packaged', getAppPath: () => '/repo' } }))
import { engineCredentialEnv, skillRuntimeDir, withSkillRuntime } from './skillRuntime'

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
    expect(skillRuntimeDir()).toBe(join('/repo', 'resources', 'skill-runtime'))
    expect(withSkillRuntime({}, '/x')).toEqual({ PYTHONPATH: '/x' })
  })

  it('ships the runtime as its own resource, outside the asar, without bytecode', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain("  - '!resources/skill-runtime/**'")
    expect(yml).toMatch(/- from: resources\/skill-runtime\n\s+to: skill-runtime\n\s+filter:\n\s+- '\*\*\/\*'\n\s+- '!\*\*\/__pycache__\/\*\*'/)
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
