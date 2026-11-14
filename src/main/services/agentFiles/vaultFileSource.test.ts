import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { Duplex } from 'node:stream'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVaultd, type Harness } from '../../../../native/vault/guest/vaultd/test/harness'
import { HOST_FILE_ACTIONS, type AgentFileRef } from '../../../shared/agentFiles'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createAgentFileService } = await import('./agentFileService')
const { createConsentRegistry } = await import('./consent')
const { createVaultFileSource, VAULT_FILE_ACTIONS, VAULT_CREDENTIAL_FILE_ACTIONS } = await import('./vaultFileSource')
const { createGuestFileAccess } = await import('../../vault/fileAccess')
const { VaultdClient } = await import('../../vault/vaultdClient')
const { resetVaultAgentsForTest } = await import('../../vault/isVaultAgent')
type VaultFileAccess = import('../../vault/fileAccess').VaultFileAccess
type VaultdClientT = import('../../vault/vaultdClient').VaultdClient

/**
 * A vault agent's file references, end to end through the seams: the agent
 * file service picks the vault source, which reaches a real (fake-mode)
 * cinna-vaultd through the guest file access. Nothing is read from the
 * agent folder by this process directly.
 */

const VAULT_AGENT = 'folder:vault-agent'
const HOST_AGENT = 'folder:host-agent'
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

let h: Harness
let client: VaultdClientT
let agentDir: string
let exported: { vaultId: string; path: string }[]
let exportAnswer: () => Promise<{ savedTo: string } | null>
let locked: boolean

function write(rel: string, contents: string | Buffer = 'hello'): void {
  const path = join(agentDir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

async function connectClient(sock: string): Promise<VaultdClientT> {
  const open = async () => {
    const socket = connect(sock)
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const web = Duplex.toWeb(socket) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
    return { readable: web.readable, writable: web.writable, close: () => socket.destroy() }
  }
  return VaultdClient.connect(await open(), { openChannel: open })
}

function service(wrap: (files: VaultFileAccess) => VaultFileAccess = (files) => files) {
  const guest = createGuestFileAccess({
    client: async () => {
      if (locked) throw Object.assign(new Error('The vault is locked.'), { code: 'locked' })
      return client
    },
    exportPath: async (vaultId, path) => {
      exported.push({ vaultId, path })
      return exportAnswer()
    }
  })
  const files: VaultFileAccess = wrap(guest)
  return createAgentFileService({
    locateAgent: () => {
      throw new Error('a vault agent is never located on this computer')
    },
    agentName: () => 'Payroll',
    getConsentUserId: () => 'u',
    consent: createConsentRegistry(),
    platform: process.platform,
    isGuardedLocation: () => false,
    getDefaultEditor: async () => null,
    launchEditor: async () => {},
    openPath: async () => '',
    openInTextEditor: async () => {},
    showItemInFolder: () => {},
    openInBrowser: async () => {},
    vaultSource: createVaultFileSource({
      locateVault: (agentId) => {
        if (agentId !== VAULT_AGENT) throw Object.assign(new Error('not in a vault'), { code: 'not_vault_agent' })
        return { vaultId: 'vault-1', agentDir }
      },
      files: () => files
    })
  })
}

beforeEach(async () => {
  h = await startVaultd()
  client = await connectClient(h.sock)
  await client.request('layout.ensure', {})
  agentDir = join(h.root, 'agent')
  exported = []
  exportAnswer = async () => ({ savedTo: '/Users/me/Downloads/report.md' })
  locked = false
  resetVaultAgentsForTest([VAULT_AGENT])
})

afterEach(async () => {
  client.close()
  await h.stop()
  resetVaultAgentsForTest()
})

const input = (path: string) => ({ agentId: VAULT_AGENT, path })
const refsOf = async (entries: { text: string; source: 'span' | 'link' }[]): Promise<AgentFileRef[]> => {
  const result = await service().resolve({ agentId: VAULT_AGENT, entries })
  if (!result.success) throw new Error(result.error)
  return result.refs
}

describe('resolving references in a vault chat', () => {
  it('links relative and absolute paths inside the agent folder, as the vault spells them, with the vault actions', async () => {
    write('docs/report.md', '# Report')
    write('notes.md')
    const refs = await refsOf([
      { text: 'docs/report.md', source: 'span' },
      { text: `${agentDir}/notes.md`, source: 'link' },
      { text: 'docs/', source: 'span' },
      { text: 'missing.md', source: 'span' }
    ])
    expect(refs).toEqual([
      { text: 'docs/report.md', source: 'span', path: `${agentDir}/docs/report.md`, displayPath: 'docs/report.md', kind: 'file', inside: true, actions: VAULT_FILE_ACTIONS },
      { text: `${agentDir}/notes.md`, source: 'link', path: `${agentDir}/notes.md`, displayPath: 'notes.md', kind: 'file', inside: true, actions: VAULT_FILE_ACTIONS },
      { text: 'docs/', source: 'span', path: `${agentDir}/docs`, displayPath: 'docs', kind: 'dir', inside: true, actions: VAULT_FILE_ACTIONS }
    ])
    expect(VAULT_FILE_ACTIONS).toMatchObject({ preview: true, previewImages: true, download: true, open: false, reveal: false, openInBrowser: false, pin: false, readText: false })
  })

  it('never links outside the agent folder: ~/, ../, absolute elsewhere, a symlink out', async () => {
    writeFileSync(join(h.root, 'secrets', 'ANTHROPIC_API_KEY'), 'sk')
    mkdirSync(join(h.root, 'home', '.claude'), { recursive: true })
    writeFileSync(join(h.root, 'home', 'notes.md'), 'x')
    symlinkSync(join(h.root, 'secrets'), join(agentDir, 'out'))
    const refs = await refsOf([
      { text: '~/notes.md', source: 'span' },
      { text: '../secrets/ANTHROPIC_API_KEY', source: 'span' },
      { text: join(h.root, 'secrets', 'ANTHROPIC_API_KEY'), source: 'span' },
      { text: '/etc/hosts', source: 'span' },
      { text: 'out/ANTHROPIC_API_KEY', source: 'span' },
      { text: `${agentDir}/../home/notes.md`, source: 'span' }
    ])
    expect(refs).toEqual([])
  })

  it('tries a short name against the folders of earlier references, linking only a single match', async () => {
    write('src/app.py')
    write('src/util.py')
    write('lib/util.py')
    write('lib/x.py')
    const refs = await refsOf([
      { text: 'src/app.py', source: 'span' },
      { text: 'app.py', source: 'span' },
      { text: 'lib/x.py', source: 'span' },
      { text: 'util.py', source: 'span' }
    ])
    expect(refs.map((r) => [r.text, r.displayPath])).toEqual([['src/app.py', 'src/app.py'], ['app.py', 'src/app.py'], ['lib/x.py', 'lib/x.py']])
  })

  it('offers no Download for a credential file, and keeps it for a folder whatever is in it', async () => {
    write('.env', 'SECRET=1')
    write('credentials/token.json', '{}')
    const refs = await refsOf([
      { text: '.env', source: 'span' },
      { text: 'credentials/token.json', source: 'span' },
      { text: 'credentials/', source: 'span' }
    ])
    expect(refs.map((r) => [r.displayPath, r.actions])).toEqual([
      ['.env', VAULT_CREDENTIAL_FILE_ACTIONS],
      ['credentials/token.json', VAULT_CREDENTIAL_FILE_ACTIONS],
      ['credentials', VAULT_FILE_ACTIONS]
    ])
    expect(VAULT_CREDENTIAL_FILE_ACTIONS).toMatchObject({ download: false, copyPath: false, preview: true })
    expect(VAULT_FILE_ACTIONS.copyPath).toBe(false)
  })

  it('answers locked while the vault is, so the renderer keeps the links it has', async () => {
    locked = true
    expect(await service().resolve({ agentId: VAULT_AGENT, entries: [{ text: 'notes.md', source: 'span' }] })).toMatchObject({ success: false, code: 'locked' })
  })
})

describe('preview and download', () => {
  it('previews text, cut at the preview cap, and HTML as its source', async () => {
    write('docs/report.md', '# Report')
    write('site/index.html', '<h1>hi</h1>')
    const files = service()
    expect(await files.authorize(input(`${agentDir}/docs/report.md`), async () => ({ approved: false, rememberDir: false }))).toEqual({ success: true, approved: true })
    expect(await files.readPreview(input(`${agentDir}/docs/report.md`))).toEqual({ success: true, text: '# Report', truncated: false })
    expect(await files.readPreview(input(`${agentDir}/site/index.html`))).toEqual({ success: true, text: '<h1>hi</h1>', truncated: false })
    // The HTML frame and Open in browser are a folder's only.
    expect(await files.htmlDocumentAccess(input(`${agentDir}/site/index.html`))).toMatchObject({ code: 'unsupported' })
    expect(await files.readHtmlDocument(input(`${agentDir}/site/index.html`), 1000)).toMatchObject({ code: 'unsupported' })
    write('big.txt', 'x'.repeat(100))
    const capped = createAgentFileServiceWithCap(10)
    expect(await capped.readPreview(input(`${agentDir}/big.txt`))).toMatchObject({ success: true, truncated: true })
  })

  it('applies the credential rule, refuses folders, and offers nothing but preview and download', async () => {
    write('.env', 'SECRET=1')
    write('credentials/token.json', '{}')
    write('docs/a.md')
    const files = service()
    expect(await files.readPreview(input(`${agentDir}/.env`))).toMatchObject({ code: 'credential_file' })
    expect(await files.readPreview(input(`${agentDir}/credentials/token.json`))).toMatchObject({ code: 'credential_file' })
    expect(await files.readImage(input(`${agentDir}/.env`))).toMatchObject({ code: 'credential_file' })
    expect(await files.download(input(`${agentDir}/.env`))).toMatchObject({ code: 'credential_file' })
    expect(await files.readPreview(input(`${agentDir}/docs`))).toMatchObject({ code: 'not_a_file' })
    for (const call of [files.open, files.reveal, files.openInBrowser, files.readText]) {
      expect(await call(input(`${agentDir}/docs/a.md`))).toMatchObject({ success: false, code: 'unsupported' })
    }
    expect(exported).toEqual([])
  })

  it('refuses a path outside the agent folder however it is spelled', async () => {
    writeFileSync(join(h.root, 'secrets', 'KEY.md'), 'sk')
    const files = service()
    for (const path of [join(h.root, 'secrets', 'KEY.md'), `${agentDir}/../secrets/KEY.md`, '/etc/hosts']) {
      expect(await files.readPreview(input(path))).toMatchObject({ success: false, code: 'not_found' })
      expect(await files.authorize(input(path), async () => ({ approved: true, rememberDir: false }))).toMatchObject({ success: false })
    }
  })

  it('previews an image from its bytes, as a data URL typed by them', async () => {
    write('chart.png', PNG)
    write('fake.png', 'not an image')
    const files = service()
    expect(await files.readImage(input(`${agentDir}/chart.png`))).toEqual({
      success: true, mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}`
    })
    expect(await files.readImage(input(`${agentDir}/fake.png`))).toMatchObject({ code: 'not_previewable' })
    // Past what one vault read returns (10 MB): refused whole, never shown cut.
    write('huge.png', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]))
    expect(await files.readImage(input(`${agentDir}/huge.png`))).toMatchObject({ success: false, code: 'too_large' })
  }, 20_000)

  it('downloads through the vault export, agent-relative; a cancelled dialog says so, a cancelled prompt is denied', async () => {
    write('docs/report.md')
    const files = service()
    expect(await files.download(input(`${agentDir}/docs/report.md`))).toEqual({ success: true, savedTo: '/Users/me/Downloads/report.md' })
    expect(await files.download(input(`${agentDir}/docs`))).toMatchObject({ success: true })
    expect(exported).toEqual([{ vaultId: 'vault-1', path: 'docs/report.md' }, { vaultId: 'vault-1', path: 'docs' }])
    exportAnswer = async () => null
    expect(await files.download(input(`${agentDir}/docs/report.md`))).toEqual({ success: true, savedTo: null })
    exportAnswer = async () => { throw Object.assign(new Error('nope'), { code: 'denied' }) }
    expect(await files.download(input(`${agentDir}/docs/report.md`))).toEqual({
      success: false, code: 'denied', error: 'Cancelled at the prompt — nothing left the vault.'
    })
  })

  it('refuses to download the agent folder itself, and exports a folder whole, credential files in it included', async () => {
    write('credentials/token.json', '{}')
    const files = service()
    for (const path of [agentDir, `${agentDir}/`, `${agentDir}/.`]) {
      expect(await files.download(input(path))).toMatchObject({ success: false, code: 'unsupported' })
    }
    expect(await files.download(input(`${agentDir}/credentials`))).toMatchObject({ success: true })
    expect(exported).toEqual([{ vaultId: 'vault-1', path: 'credentials' }])
  })

  it('reads only what stat checked: a read answering for another path, or for a credential file, is refused', async () => {
    write('docs/report.md', '# Report')
    write('docs/other.md', 'other')
    const answering = (rel: string) => (files: VaultFileAccess): VaultFileAccess => ({
      ...files,
      read: async (...args) => ({ ...(await files.read(...args)), rel })
    })
    expect(await service(answering('docs/other.md')).readPreview(input(`${agentDir}/docs/report.md`))).toMatchObject({ success: false, code: 'not_found' })
    expect(await service(answering('docs/report.md')).readPreview(input(`${agentDir}/docs/report.md`))).toEqual({ success: true, text: '# Report', truncated: false })
    // The credential rule holds on the path the read reports, even for a target that did not carry it.
    write('.env', 'SECRET=1')
    const source = createVaultFileSource({
      locateVault: () => ({ vaultId: 'vault-1', agentDir }),
      files: () => createGuestFileAccess({ client: async () => client, exportPath: async () => null })
    })
    const target = {
      agentId: VAULT_AGENT, requested: `${agentDir}/.env`, real: `${agentDir}/.env`, kind: 'file' as const, inside: true,
      credential: false, vaultId: 'vault-1', agentDir, rel: '.env'
    }
    expect(await source.read(target, { maxBytes: 100, whole: false })).toMatchObject({ success: false, code: 'credential_file' })
  })

  it('says where a preview cut short by the vault read stopped', async () => {
    write('big.txt', 'x'.repeat(10 * 1024 * 1024 + 7))
    expect(await createAgentFileServiceWithCap(25 * 1024 * 1024).readPreview(input(`${agentDir}/big.txt`))).toMatchObject({
      success: true, truncated: true, shownBytes: 10 * 1024 * 1024
    })
  }, 20_000)

  it('asks to unlock, not crash, while the vault is locked', async () => {
    write('docs/report.md')
    locked = true
    const files = service()
    expect(await files.readPreview(input(`${agentDir}/docs/report.md`))).toMatchObject({ success: false, code: 'locked' })
    expect(await files.authorize(input(`${agentDir}/docs/report.md`), async () => ({ approved: true, rememberDir: false }))).toMatchObject({ code: 'locked' })
    expect(await files.download(input(`${agentDir}/docs/report.md`))).toMatchObject({ code: 'locked' })
  })
})

describe('the source per agent', () => {
  it('keeps a folder agent on its folder, with the host actions and no Download or image read', async () => {
    const host = realpathSync(h.dir)
    writeFileSync(join(host, 'a.md'), 'A')
    const files = createAgentFileService({
      locateAgent: () => host, agentName: () => 'Helper', getConsentUserId: () => 'u', consent: createConsentRegistry(),
      platform: process.platform, isGuardedLocation: () => false, getDefaultEditor: async () => null, launchEditor: async () => {},
      openPath: async () => '', openInTextEditor: async () => {}, showItemInFolder: () => {}, openInBrowser: async () => {}
    })
    const resolved = await files.resolve({ agentId: HOST_AGENT, entries: [{ text: 'a.md', source: 'span' }] })
    expect(resolved).toMatchObject({ success: true, refs: [{ path: join(host, 'a.md'), inside: true }] })
    expect(resolved.success && resolved.refs[0].actions).toBeUndefined()
    expect(HOST_FILE_ACTIONS.download).toBe(false)
    expect(await files.download({ agentId: HOST_AGENT, path: join(host, 'a.md') })).toMatchObject({ code: 'unsupported' })
    expect(await files.readImage({ agentId: HOST_AGENT, path: join(host, 'a.md') })).toMatchObject({ code: 'unsupported' })
    // With no vault source wired, a vault agent's files are refused as before.
    expect(await files.resolve({ agentId: VAULT_AGENT, entries: [{ text: 'a.md', source: 'span' }] })).toMatchObject({ success: false, error: expect.stringContaining('vault') })
  })
})

/** The vault-backed service with a small preview cap. */
function createAgentFileServiceWithCap(maxPreviewBytes: number) {
  return createAgentFileService({
    locateAgent: () => { throw new Error('never') }, agentName: () => 'Payroll', getConsentUserId: () => 'u', consent: createConsentRegistry(),
    platform: process.platform, isGuardedLocation: () => false, getDefaultEditor: async () => null, launchEditor: async () => {},
    openPath: async () => '', openInTextEditor: async () => {}, showItemInFolder: () => {}, openInBrowser: async () => {},
    maxPreviewBytes,
    vaultSource: createVaultFileSource({
      locateVault: () => ({ vaultId: 'vault-1', agentDir }),
      files: () => createGuestFileAccess({ client: async () => client, exportPath: async () => null })
    })
  })
}
