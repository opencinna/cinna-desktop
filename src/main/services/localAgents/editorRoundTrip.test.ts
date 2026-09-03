import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'
import {
  editFileText,
  receiveFileSnapshot,
  saveRefused,
  saveRequest,
  saveSucceeded,
  seedFileEditor
} from '../../../renderer/src/utils/localAgents'
import { isStaleWriteError } from '../../../shared/localAgents'

/**
 * The stamp round trip, across the seam it actually crosses.
 *
 * `localAgentService.test.ts` proves the writer refuses a stale stamp;
 * `utils/localAgents.test.ts` proves the editor state machine hands the right
 * one back. Neither proves they agree — and the failure mode they leave open is
 * silent: an editor that re-reads the stamp at save time, or looks the manifest's
 * stamp up for a prompt document, passes both suites and destroys an
 * assistant's work in production.
 *
 * So this drives the real editor functions against the real service, and the
 * external write it simulates is **content-only** — same byte length, mtime
 * restored — so the assertion cannot pass by accident on a filesystem whose
 * timestamp resolution happens to notice. Only the SHA-256 comparison can
 * catch it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
vi.mock('../../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { clearContractCache } = await import('../../kit/contractStore')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { localAgentService } = await import('./localAgentService')
const { turnLock } = await import('./turnLock')

const USER = '__default__'
const WORKFLOW = 'docs/WORKFLOW_PROMPT.md'

let workshop: string
let agentDir: string
let agentId: string

beforeEach(() => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  turnLock.releaseAll()
  workshop = mkdtempSync(join(tmpdir(), 'cinna-editor-'))
  appSettingsRepo.set('localAgentsHome', workshop)
  scaffoldService.installRootTemplates(workshop)
  const root = agentRootRepo.create(USER, { path: workshop, label: 'Agents', isDefault: true })
  agentDir = scaffoldService.scaffoldAgent({
    rootPath: workshop,
    slug: 'alpha',
    name: 'Alpha',
    description: 'Watches the alpha feed.'
  }).agentDir
  agentId = scannerService.scanRoot(USER, root).agents[0].id
  pinMtime(join(agentDir, WORKFLOW))
})

afterEach(() => {
  turnLock.releaseAll()
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

/**
 * A whole-second timestamp, pinned onto the file before the editor reads it.
 *
 * A file freshly written by the scaffolder carries a sub-millisecond mtime that
 * `utimesSync` cannot reproduce — it truncates — so "restore the timestamp I
 * found" silently leaves a fractional difference behind. The metadata
 * pre-check then fires, the refusal happens for the *cheap* reason, and the
 * hash comparison this test exists to exercise is never reached. Pinning a
 * value the filesystem can store exactly removes that luck from the test.
 */
const PINNED_MTIME = new Date(1_700_000_000_000)

function pinMtime(path: string): void {
  utimesSync(path, PINNED_MTIME, PINNED_MTIME)
  expect(statSync(path).mtimeMs).toBe(PINNED_MTIME.getTime())
}

/**
 * An assistant rewriting the file at exactly the same length, restoring the
 * timestamps it found — `cp -p`, `git checkout`, an editor that preserves
 * mtime. Every cheap check still matches; only the content differs.
 */
function rewriteInvisibly(path: string, replacement: string): void {
  const before = statSync(path)
  // Byte length, not string length: the templates carry em dashes, and padding
  // to `String.length` would leave the file a few bytes short — which the
  // cheap metadata check would then catch, letting the test pass without the
  // hash comparison ever being exercised.
  const existing = readFileSync(path)
  const padded = Buffer.alloc(existing.length, ' ')
  Buffer.from(replacement, 'utf8').copy(padded, 0, 0, Math.min(existing.length, replacement.length))
  writeFileSync(path, padded)
  utimesSync(path, PINNED_MTIME, PINNED_MTIME)
  const after = statSync(path)
  // The premise of the test: nothing but the bytes changed.
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).toBe(before.mtimeMs)
}

describe('the agent page editing a prompt document', () => {
  it('saves an edit through the stamp it rendered', () => {
    const agent = localAgentService.get(USER, agentId)
    let editor = seedFileEditor(WORKFLOW, 'first draft', agent.stamps[WORKFLOW])
    editor = editFileText(editor, 'first draft, revised')

    const request = saveRequest(editor)
    expect(request).not.toBeNull()
    const saved = localAgentService.updateField(USER, {
      agentId,
      update: { field: 'prompt', prompt: 'workflow', value: request!.text },
      expectedStamp: request!.expectedStamp
    })

    expect(readFileSync(join(agentDir, WORKFLOW), 'utf8')).toBe('first draft, revised')
    editor = saveSucceeded(editor, request!.text, saved.stamps[WORKFLOW])
    expect(saveRequest(editor)).toBeNull()
  })

  it('is refused when the file changed underneath, with only the content differing', () => {
    const agent = localAgentService.get(USER, agentId)
    let editor = seedFileEditor(WORKFLOW, 'my draft', agent.stamps[WORKFLOW])
    editor = editFileText(editor, 'my draft, revised')

    rewriteInvisibly(join(agentDir, WORKFLOW), 'AN ASSISTANT WROTE THIS')
    const theirs = readFileSync(join(agentDir, WORKFLOW), 'utf8')

    const request = saveRequest(editor)
    expect(request).not.toBeNull()
    let error: unknown = null
    try {
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'prompt', prompt: 'workflow', value: request!.text },
        expectedStamp: request!.expectedStamp
      })
    } catch (err) {
      error = err
    }

    expect(error).not.toBeNull()
    expect(isStaleWriteError(error)).toBe(true)
    // Their file is untouched — that is the whole point of the refusal.
    expect(readFileSync(join(agentDir, WORKFLOW), 'utf8')).toBe(theirs)

    // And the page must not try again: the editor goes to a reload prompt.
    editor = saveRefused(editor, theirs)
    expect(editor.conflict).toBe('refused')
    expect(saveRequest(editor)).toBeNull()
  })

  it('will not save at all once the watcher has reported the outside change', () => {
    const agent = localAgentService.get(USER, agentId)
    let editor = seedFileEditor(WORKFLOW, 'my draft', agent.stamps[WORKFLOW])
    editor = editFileText(editor, 'my draft, revised')

    rewriteInvisibly(join(agentDir, WORKFLOW), 'AN ASSISTANT WROTE THIS')
    // What a `local-agent:changed` push produces: a fresh scan of the folder.
    const rescanned = localAgentService.get(USER, agentId)
    editor = receiveFileSnapshot(
      editor,
      readFileSync(join(agentDir, WORKFLOW), 'utf8'),
      rescanned.stamps[WORKFLOW]
    )

    expect(editor.conflict).toBe('external-change')
    expect(saveRequest(editor)).toBeNull()
  })

  it('looks up the stamp of the file it is writing, not the manifest', () => {
    const agent = localAgentService.get(USER, agentId)
    // The manifest's stamp is a perfectly well-formed `FileStamp`. Handing it
    // back for a prompt document would look right at every call site and be
    // wrong at exactly one place — so the writer has to refuse it.
    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'prompt', prompt: 'workflow', value: 'sneaky' },
        expectedStamp: agent.stamps['cinna-agent.json']!
      })
    ).toThrow()
  })
})
