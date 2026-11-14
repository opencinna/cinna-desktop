import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * D23 for attachments: a vault chat takes text and images inline, refuses
 * anything else before a byte is stored, and leaves no copy in userData once
 * the turn that sent them is over (a pasted image's own copy goes at once).
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

const { chatRepo } = await import('../db/chats')
const { agentRepo } = await import('../db/agents')
const { installRuntimeHost } = await import('../host/runtimeHost')
const { fileService } = await import('../services/fileService')
const { pastedRoot } = await import('../services/pastedFiles')
const { vaultTranscripts } = await import('./transcriptStore')
const { resetVaultAgentsForTest } = await import('./isVaultAgent')
const { vaultService } = await import('./vaultService')
const { discardVaultChatFiles, sweepVaultChatFiles, VAULT_FILE_REFUSED } = await import('./vaultChatFiles')

const USER = '__default__'
const AGENT = 'folder:99999999-2222-3333-4444-555555555555'
const VAULT = 'vault-files'
const OTHER_AGENT = 'folder:99999999-2222-3333-4444-666666666666'
const OTHER_VAULT = 'vault-files-2'

let home = ''
let userData = ''
let vaultChat = ''
let hostChat = ''

function source(name: string, content: string | Buffer = 'hello'): string {
  const path = join(home, 'picked', name)
  mkdirSync(join(home, 'picked'), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** A chat's stored copies: a vault chat's under `vault/chat-files/`, any other's under `files/`. */
function stored(chatId: string): string[] {
  const dir = chatId === hostChat ? join(userData, 'files', USER, chatId) : join(userData, 'vault', 'chat-files', USER, chatId)
  return existsSync(dir) ? readdirSync(dir) : []
}

function fileRows(): number {
  return (holder.current!.sqlite.prepare('SELECT count(*) AS n FROM chat_files').get() as { n: number }).n
}

beforeEach(() => {
  holder.current = createTestDatabase()
  home = mkdtempSync(join(tmpdir(), 'cinna-vault-files-'))
  userData = join(home, 'userData')
  installRuntimeHost({ isPackaged: false, getPath: () => userData, getAppPath: () => home } as never)
  vaultTranscripts.resetForTest()
  vaultService.resetForTest()
  agentRepo.replaceFolderIndex(USER, 'root-1', [{ id: AGENT, name: 'Payroll', description: null, localPath: '/agents/Local/payroll', remoteMetadata: {} as never, launcher: 'claude' }])
  agentRepo.markVault(USER, AGENT, { vaultId: VAULT, engine: 'claude' })
  resetVaultAgentsForTest()
  vaultTranscripts.openVault(VAULT)
  vaultChat = chatRepo.create(USER, { agentId: AGENT }).id
  vaultService.bindChat(USER, USER, vaultChat, AGENT)
  hostChat = chatRepo.create(USER, {}).id
})

afterEach(() => {
  vaultTranscripts.resetForTest()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
  rmSync(home, { recursive: true, force: true })
})

describe('attachments in a vault chat', () => {
  it('refuses a file that cannot go inline before anything is stored', async () => {
    for (const name of ['bundle.zip', 'tool.bin', 'clip.mp4', 'picture.bmp']) {
      await expect(fileService.ingest({ userId: USER, scope: 'local', chatId: vaultChat, filePaths: [source('notes.txt'), source(name)] }))
        .rejects.toMatchObject({ code: 'vault_chat', message: VAULT_FILE_REFUSED })
    }
    expect(stored(vaultChat)).toEqual([])
    expect(holder.current!.sqlite.prepare('SELECT count(*) AS n FROM chat_files').get()).toEqual({ n: 0 })
    // An ordinary chat still takes them.
    expect(await fileService.ingest({ userId: USER, scope: 'local', chatId: hostChat, filePaths: [source('bundle.zip')] })).toHaveLength(1)
  })

  it('takes text and images, and keeps no copy once the turn is over', async () => {
    const files = await fileService.ingest({ userId: USER, scope: 'local', chatId: vaultChat, filePaths: [source('notes.md'), source('report.pdf'), source('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))] })
    // A PDF or an Office file goes as its extracted text, as for a remote agent.
    expect(files.map((f) => f.mimeType)).toEqual(['text/markdown', 'application/pdf', 'image/png'])
    expect(stored(vaultChat)).toHaveLength(3)
    await discardVaultChatFiles(USER, vaultChat, files)
    expect(stored(vaultChat)).toEqual([])
    expect(holder.current!.sqlite.prepare('SELECT count(*) AS n FROM chat_files').get()).toEqual({ n: 0 })
  })

  it('deletes a pasted image\'s own copy as soon as it is ingested', async () => {
    const pasted = join(pastedRoot(userData), 'Pasted image.png')
    mkdirSync(pastedRoot(userData), { recursive: true })
    writeFileSync(pasted, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await fileService.ingest({ userId: USER, scope: 'local', chatId: vaultChat, filePaths: [pasted] })
    expect(existsSync(pasted)).toBe(false)
  })

  it('keeps a vault chat\'s copies apart from ordinary chats\' files', async () => {
    await fileService.ingest({ userId: USER, scope: 'local', chatId: vaultChat, filePaths: [source('notes.txt')] })
    expect(stored(vaultChat)).toHaveLength(1)
    expect(existsSync(join(userData, 'files', USER, vaultChat))).toBe(false)
  })

  it('removes what it copied when an ingest of several files fails part way', async () => {
    await expect(fileService.ingest({ userId: USER, scope: 'local', chatId: vaultChat, filePaths: [source('a.txt'), source('b.txt'), join(home, 'picked', 'gone.txt')] }))
      .rejects.toThrow()
    expect(stored(vaultChat)).toEqual([])
    expect(fileRows()).toBe(0)
  })

  it('sweeps the copies no turn took: one vault\'s at its lock, every vault chat\'s at start', async () => {
    agentRepo.replaceFolderIndex(USER, 'root-1', [
      { id: AGENT, name: 'Payroll', description: null, localPath: '/agents/Local/payroll', remoteMetadata: {} as never, launcher: 'claude' },
      { id: OTHER_AGENT, name: 'Ledger', description: null, localPath: '/agents/Local/ledger', remoteMetadata: {} as never, launcher: 'claude' }
    ])
    agentRepo.markVault(USER, OTHER_AGENT, { vaultId: OTHER_VAULT, engine: 'claude' })
    resetVaultAgentsForTest()
    vaultTranscripts.openVault(OTHER_VAULT)
    const otherChat = chatRepo.create(USER, { agentId: OTHER_AGENT }).id
    vaultService.bindChat(USER, USER, otherChat, OTHER_AGENT)
    await fileService.ingest({ userId: USER, scope: 'local', chatId: vaultChat, filePaths: [source('draft.txt')] })
    await fileService.ingest({ userId: USER, scope: 'local', chatId: otherChat, filePaths: [source('other.txt')] })
    await fileService.ingest({ userId: USER, scope: 'local', chatId: hostChat, filePaths: [source('host.txt')] })
    expect(fileRows()).toBe(3)

    // One vault locks: its chats' copies go, nothing else.
    expect(await sweepVaultChatFiles(VAULT)).toBe(1)
    expect(stored(vaultChat)).toEqual([])
    expect(stored(otherChat)).toHaveLength(1)
    expect(stored(hostChat)).toHaveLength(1)
    expect(fileRows()).toBe(2)

    // At start: every vault chat's rows, and the whole directory (a stray file a crash left too).
    writeFileSync(join(userData, 'vault', 'chat-files', USER, otherChat, 'stray.bin'), 'x')
    expect(await sweepVaultChatFiles()).toBe(1)
    expect(existsSync(join(userData, 'vault', 'chat-files'))).toBe(false)
    expect(stored(hostChat)).toHaveLength(1)
    expect(fileRows()).toBe(1)
  })

  it('leaves an ordinary chat\'s attachments alone', async () => {
    const files = await fileService.ingest({ userId: USER, scope: 'local', chatId: hostChat, filePaths: [source('notes.txt')] })
    await discardVaultChatFiles(USER, hostChat, files)
    expect(stored(hostChat)).toHaveLength(1)
  })
})
