import { describe, expect, it } from 'vitest'
import { readVaultAgentDetails, VAULT_STATUS_FILE } from './vaultAgentDetails'
import type { VaultFileAccess } from './fileAccess'
import { VaultError } from './vaultService'
import { VAULT_LAUNCH_FALLBACK, type VaultLaunchSettings } from './vaultAgentState'

const VAULT = 'vault-details'

/** A vault folder as `files.read` answers it: agent-relative paths to text; anything else is vaultd's `not_found`. */
function fakeFiles(files: Record<string, string>, options: { locked?: boolean; rel?: Record<string, string> } = {}): VaultFileAccess & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async resolve() { throw new Error('not used') },
    async exportFile() { throw new Error('not used') },
    async read(vaultId, path, { maxBytes }) {
      expect(vaultId).toBe(VAULT)
      reads.push(path)
      if (options.locked) throw new VaultError('locked', 'The vault is locked.')
      const text = files[path]
      if (text === undefined) throw Object.assign(new Error('No such file.'), { code: 'not_found' })
      const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes)
      return { rel: options.rel?.[path] ?? path, bytes, size: Buffer.byteLength(text), truncated: false }
    }
  }
}

const launch = (settings: Partial<VaultLaunchSettings> = {}) => async (): Promise<VaultLaunchSettings> => ({ ...VAULT_LAUNCH_FALLBACK, ...settings })

const MANIFEST = JSON.stringify({
  name: 'Ledger',
  description: 'Reconciles the books.',
  example_prompts: ['What is owed?'],
  credentials: [
    { name: 'bank', type: 'api_token', fields: ['api_token'], env_prefix: 'BANK_' },
    { name: 'mail', type: 'smtp', fields: ['host', 'password'], env_prefix: 'MAIL_' }
  ]
})

describe('readVaultAgentDetails', () => {
  it('reads the manifest, status, prompts, credential names and launch settings from inside the vault', async () => {
    const files = fakeFiles({
      'cinna-agent.json': MANIFEST,
      [VAULT_STATUS_FILE]: '---\nstate: healthy\ntimestamp: 2026-11-18T10:00\n---\nAll balanced.\n',
      'credentials/.env': 'BANK_API_TOKEN="sk-bank-secret-value"\nMAIL_HOST=smtp.example\nMAIL_PASSWORD=\n',
      'docs/WORKFLOW_PROMPT.md': '# Workflow prompt\nBalance the books.\n',
      'docs/REFINER_PROMPT.md': 'Defaults: this month.'
    })
    const details = await readVaultAgentDetails({ files, vaultId: VAULT, launch: launch({ approval: 'auto', model: 'opus' }) })

    expect(details.manifest).toMatchObject({ name: 'Ledger', example_prompts: ['What is owed?'] })
    expect(details.description).toBe('Reconciles the books.')
    expect(details.status).toEqual({ summary: null, state: 'healthy', updatedAt: '2026-11-18T10:00', body: 'All balanced.\n' })
    expect(details.docs).toEqual({
      workflow: { relPath: 'docs/WORKFLOW_PROMPT.md', text: '# Workflow prompt\nBalance the books.\n' },
      entrypoint: null,
      refiner: { relPath: 'docs/REFINER_PROMPT.md', text: 'Defaults: this month.' }
    })
    expect(details.credentials.map((c) => ({ name: c.name, presentKeys: c.presentKeys, satisfied: c.satisfied }))).toEqual([
      { name: 'bank', presentKeys: ['BANK_API_TOKEN'], satisfied: true },
      // An empty `MAIL_PASSWORD=` is not a value, as the kit reads it.
      { name: 'mail', presentKeys: ['MAIL_HOST'], satisfied: false }
    ])
    expect(details.launch).toEqual({ kind: 'kit', model: 'opus', approval: 'auto' })
  })

  it('never puts a .env value in what it answers', async () => {
    const files = fakeFiles({ 'cinna-agent.json': MANIFEST, 'credentials/.env': 'BANK_API_TOKEN=sk-bank-secret-value\nOTHER=hunter2\n' })
    const details = await readVaultAgentDetails({ files, vaultId: VAULT, launch: launch() })
    const wire = JSON.stringify(details)
    expect(wire).not.toContain('sk-bank-secret-value')
    expect(wire).not.toContain('hunter2')
    expect(files.reads).toContain('credentials/.env')
  })

  it('treats missing files as absent: an empty manifest, no status, no prompts, no slots', async () => {
    const details = await readVaultAgentDetails({ files: fakeFiles({}), vaultId: VAULT, launch: launch() })
    expect(details).toEqual({
      manifest: {},
      description: '',
      status: null,
      docs: { workflow: null, entrypoint: null, refiner: null },
      credentials: [],
      launch: { kind: 'kit', model: null, approval: 'ask' }
    })
  })

  it('treats an unparseable manifest as empty, and a file the vault opened under another path as absent', async () => {
    const details = await readVaultAgentDetails({
      files: fakeFiles(
        { 'cinna-agent.json': '{ not json', 'docs/WORKFLOW_PROMPT.md': 'BANK_API_TOKEN=leaked' },
        { rel: { 'docs/WORKFLOW_PROMPT.md': 'credentials/.env' } }
      ),
      vaultId: VAULT,
      launch: launch()
    })
    expect(details.manifest).toEqual({})
    expect(details.docs.workflow).toBeNull()
  })

  it('refuses with the vault’s own `locked` code while it is locked', async () => {
    await expect(readVaultAgentDetails({ files: fakeFiles({}, { locked: true }), vaultId: VAULT, launch: launch() }))
      .rejects.toMatchObject({ code: 'locked' })
  })
})
