import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * The write path: Invariant 3 in both halves.
 *
 * A save must be refused while a turn holds the agent, and refused when the
 * file changed since the editor read it. Both are tested against real files —
 * the stamp guard is only meaningful over a real mtime.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
/** `shell.trashItem`, replaced per test — the default fake is set in `delete`. */
const trash = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>())
/** `shell.openPath` — '' is Electron's "it opened"; a message is a failure. */
const openPath = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => ''))
/** `shell.showItemInFolder` — the fallback the credentials click must not need. */
const reveal = vi.hoisted(() => vi.fn<(path: string) => void>())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: reveal, trashItem: trash, openPath },
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

const { agentRepo } = await import('../../db/agents')
const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { clearContractCache } = await import('../../kit/contractStore')
const { manifestPath, readManifest } = await import('../../kit/manifestIo')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { desktopStatePath, desktopStateService } = await import('./desktopStateService')
const { localAgentService } = await import('./localAgentService')
const { turnLock } = await import('./turnLock')
const { isBlockedWriteError, isStaleWriteError } = await import('../../../shared/localAgents')
const { jobsRepo, jobAgentRepo } = await import('../../db/jobs')
const { a2aSessionRepo } = await import('../../db/agents')
const { chatRepo } = await import('../../db/chats')
const { rebuildJobManifest } = await import('../../sync/manifest')
const { buildResolveIndex, manifestNeedsSetup } = await import('../../sync/resolvers')

const USER = '__default__'
const WORKFLOW = 'docs/WORKFLOW_PROMPT.md'
const MANIFEST = 'cinna-agent.json'

let workshop: string
let agentDir: string
let agentId: string

beforeEach(() => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  turnLock.releaseAll()
  workshop = mkdtempSync(join(tmpdir(), 'cinna-write-'))
  // Point the agents home at the temp workshop *before* anything calls
  // `ensureHome`, which would otherwise resolve the real `~/Documents/CinnaAgents`
  // and create it. A test must never write outside its temp directory.
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
})

afterEach(() => {
  turnLock.releaseAll()
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

function currentAgent() {
  return localAgentService.get(USER, agentId)
}

/** Age a file so a later write produces a different mtime on any filesystem. */
function ageFile(path: string): void {
  const past = new Date(Date.now() - 60_000)
  utimesSync(path, past, past)
}

describe('updateField', () => {
  it('writes a manifest field back to the folder', () => {
    const agent = currentAgent()
    const updated = localAgentService.updateField(USER, {
      agentId,
      update: { field: 'description', value: 'Now watches the beta feed.' },
      expectedStamp: agent.stamps[MANIFEST]!
    })

    expect(updated.description).toBe('Now watches the beta feed.')
    expect(readManifest(manifestPath(agentDir)).description).toBe('Now watches the beta feed.')
  })

  it('preserves unknown manifest keys across a write', () => {
    const raw = JSON.parse(readFileSync(manifestPath(agentDir), 'utf8'))
    raw.some_future_key = { written_by: 'cinna-core' }
    writeFileSync(manifestPath(agentDir), `${JSON.stringify(raw, null, 2)}\n`)

    const agent = currentAgent()
    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'name', value: 'Renamed' },
      expectedStamp: agent.stamps[MANIFEST]!
    })

    const after = readManifest(manifestPath(agentDir))
    expect(after.name).toBe('Renamed')
    expect(after.some_future_key).toEqual({ written_by: 'cinna-core' })
  })

  it('writes a prompt document', () => {
    const agent = currentAgent()
    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'prompt', prompt: 'workflow', value: '# New workflow\n' },
      expectedStamp: agent.stamps[WORKFLOW]!
    })
    expect(readFileSync(join(agentDir, WORKFLOW), 'utf8')).toBe('# New workflow\n')
  })

  it('refuses a manifest that changed underneath', () => {
    const agent = currentAgent()
    const stale = agent.stamps[MANIFEST]!

    // Someone else writes the file while the editor is open.
    const manifest = readManifest(manifestPath(agentDir))
    manifest.description = 'edited by an assistant'
    writeFileSync(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'description', value: 'edited in the app' },
        expectedStamp: stale
      })
    ).toThrow(/changed on disk/i)

    // The other party's edit survives untouched.
    expect(readManifest(manifestPath(agentDir)).description).toBe('edited by an assistant')
  })

  it('refuses a prompt document that changed underneath', () => {
    const agent = currentAgent()
    const stale = agent.stamps[WORKFLOW]!
    const path = join(agentDir, WORKFLOW)
    writeFileSync(path, 'rewritten by an assistant\n')

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'prompt', prompt: 'workflow', value: 'rewritten in the app\n' },
        expectedStamp: stale
      })
    ).toThrow(/changed on disk/i)
    expect(readFileSync(path, 'utf8')).toBe('rewritten by an assistant\n')
  })

  /**
   * The silent-clobber case, on the files it matters most for. A second writer
   * replaces a prompt document at **equal size** with the **original
   * timestamps** — `cp -p`, `rsync -t`, `git checkout`, `unzip`, a backup
   * restore. Metadata says "unchanged"; only the content hash knows better.
   */
  it('refuses a same-size, same-mtime rewrite of a prompt document', () => {
    const path = join(agentDir, WORKFLOW)
    writeFileSync(path, 'AAAAAAAAAA\n')
    const stale = currentAgent().stamps[WORKFLOW]!
    const before = statSync(path)

    // Byte-for-byte the same length, timestamps put back exactly.
    writeFileSync(path, 'BBBBBBBBBB\n')
    utimesSync(path, before.atime, before.mtime)
    expect(statSync(path).size).toBe(stale.size)

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'prompt', prompt: 'workflow', value: 'CCCCCCCCCC\n' },
        expectedStamp: stale
      })
    ).toThrow(/changed on disk/i)

    // The other writer's content is intact — nothing was destroyed silently.
    expect(readFileSync(path, 'utf8')).toBe('BBBBBBBBBB\n')
  })

  /**
   * The deterministic companion to the case above. On APFS `utimes` lands a
   * fraction of a microsecond off, so the metadata pre-check can fire by luck
   * and mask a hash that is not actually consulted. Handing the write a stamp
   * carrying the file's *current* metadata but an *earlier* hash removes the
   * luck: this can only pass if the hash is the authority.
   */
  it('refuses when only the hash differs, whatever the metadata says', () => {
    const path = join(agentDir, WORKFLOW)
    writeFileSync(path, 'the assistant wrote this\n')
    const current = currentAgent().stamps[WORKFLOW]!

    const forged = { ...current, hash: 'f'.repeat(64) }
    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'prompt', prompt: 'workflow', value: 'clobbered\n' },
        expectedStamp: forged
      })
    ).toThrow(/changed on disk/i)
    expect(readFileSync(path, 'utf8')).toBe('the assistant wrote this\n')
  })

  /** The same guarantee on the manifest, through Phase 1's `writeIfUnchanged`. */
  it('refuses a same-size, same-mtime rewrite of the manifest', () => {
    const path = manifestPath(agentDir)
    const stale = currentAgent().stamps[MANIFEST]!
    const before = statSync(path)

    const manifest = readManifest(path)
    // `description` is 'Watches the alpha feed.' — same length, different bytes.
    manifest.description = 'Watches the omega feed.'
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    utimesSync(path, before.atime, before.mtime)
    expect(statSync(path).size).toBe(stale.size)

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'description', value: 'clobbered' },
        expectedStamp: stale
      })
    ).toThrow(/changed on disk/i)
    expect(readManifest(path).description).toBe('Watches the omega feed.')
  })

  it('releases the lock even when the write is refused', () => {
    const agent = currentAgent()
    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'description', value: '' },
        expectedStamp: agent.stamps[MANIFEST]!
      })
    ).toThrow()

    expect(turnLock.isLocked(agentId)).toBe(false)
    // …and a valid save straight afterwards still works.
    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'description', value: 'fine now' },
      expectedStamp: currentAgent().stamps[MANIFEST]!
    })
    expect(readManifest(manifestPath(agentDir)).description).toBe('fine now')
  })

  it('refuses to write while a turn holds the agent', () => {
    const agent = currentAgent()
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      expect(() =>
        localAgentService.updateField(USER, {
          agentId,
          update: { field: 'description', value: 'mid-stream' },
          expectedStamp: agent.stamps[MANIFEST]!
        })
      ).toThrow(/busy/i)

      // The *code* is what the page keys off, and it must not be one of the
      // stale-write codes: those mean "the file changed, reload" and the page
      // answers them by discarding the user's text. This one means "not yet".
      let thrown: unknown = null
      try {
        localAgentService.updateField(USER, {
          agentId,
          update: { field: 'description', value: 'mid-stream' },
          expectedStamp: agent.stamps[MANIFEST]!
        })
      } catch (err) {
        thrown = err
      }
      expect(isBlockedWriteError(thrown)).toBe(true)
      expect(isStaleWriteError(thrown)).toBe(false)
    } finally {
      handle.release()
    }
    expect(readManifest(manifestPath(agentDir)).description).toBe('Watches the alpha feed.')
  })

  it('requires a stamp', () => {
    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'description', value: 'x' },
        expectedStamp: undefined as never
      })
    ).toThrow(/out of date/i)
  })

  it('validates what it is given', () => {
    const stamp = () => currentAgent().stamps[MANIFEST]!
    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'name', value: '   ' },
        expectedStamp: stamp()
      })
    ).toThrow(/cannot be empty/i)

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'example_prompts', value: 'not a list' as never },
        expectedStamp: stamp()
      })
    ).toThrow(/list/i)

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'description', value: 'x'.repeat(2001) },
        expectedStamp: stamp()
      })
    ).toThrow(/too long/i)
  })

  it('clears an optional field when given null', () => {
    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'router_trigger_prompt', value: 'Use me for alpha questions.' },
      expectedStamp: currentAgent().stamps[MANIFEST]!
    })
    expect(readManifest(manifestPath(agentDir)).router_trigger_prompt).toBe(
      'Use me for alpha questions.'
    )

    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'router_trigger_prompt', value: null },
      expectedStamp: currentAgent().stamps[MANIFEST]!
    })
    expect(readManifest(manifestPath(agentDir)).router_trigger_prompt).toBeNull()
  })

  it('refuses an id that is not a folder agent', () => {
    expect(() =>
      localAgentService.updateField(USER, {
        agentId: 'remote:agent:abc',
        update: { field: 'name', value: 'x' },
        expectedStamp: { mtimeMs: 1, size: 1, hash: 'deadbeef' }
      })
    ).toThrow(/not a local agent/i)
  })

  it('writes atomically — the file is never left half-written', () => {
    const path = join(agentDir, WORKFLOW)
    ageFile(path)
    const before = statSync(path).mtimeMs
    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'prompt', prompt: 'workflow', value: 'x'.repeat(50_000) },
      expectedStamp: currentAgent().stamps[WORKFLOW]!
    })
    expect(readFileSync(path, 'utf8')).toHaveLength(50_000)
    expect(statSync(path).mtimeMs).toBeGreaterThan(before)
  })
})

/**
 * Stamping a legacy folder's identity.
 *
 * The action exists because a hand-built workshop is adopted as-is, and a
 * manifest with no `id` is a *supported* shape rather than a broken one. Two
 * rules make it safe: it goes through the same stamped write as every other
 * edit (Invariant 3), and it never runs by itself.
 */
describe('stamp_identity', () => {
  /** Strip the folder back to the pre-contract shape a legacy workshop has. */
  function writeLegacyManifest(): void {
    const manifest = readManifest(manifestPath(agentDir))
    delete manifest.id
    delete manifest.contract_version
    manifest.schema_version = 1
    writeFileSync(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  /** Re-read the root and return the id the legacy folder was indexed under. */
  function rescan(): string {
    scannerService.markAllRootsDirty()
    return scannerService.scanRoot(USER, agentRootRepo.list(USER)[0]).agents[0].id
  }

  function makeLegacy(): string {
    writeLegacyManifest()
    return rescan()
  }

  it('writes a fresh id and re-keys the agent', () => {
    const legacyId = makeLegacy()
    expect(legacyId).toBe(`folder:legacy:${agentRootRepo.list(USER)[0].id}:alpha`)
    const before = localAgentService.get(USER, legacyId)
    expect(before.identity).toBe('legacy')

    const after = localAgentService.updateField(USER, {
      agentId: legacyId,
      update: { field: 'stamp_identity' },
      expectedStamp: before.stamps[MANIFEST]!
    })

    const manifest = readManifest(manifestPath(agentDir))
    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/)
    expect(after.identity).toBe('manifest')
    expect(after.id).toBe(`folder:${manifest.id}`)
    // The index followed: the positional row is gone and the durable one is
    // there, which is what `locate()` — and so the page — resolves through.
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([after.id])
  })

  it('writes contract_version too, so the folder does not become invalid', () => {
    const legacyId = makeLegacy()
    const before = localAgentService.get(USER, legacyId)
    // The premise: legacy is a *warning*, and the folder is runnable as it is.
    expect(before.readiness).toBe('ok')

    const after = localAgentService.updateField(USER, {
      agentId: legacyId,
      update: { field: 'stamp_identity' },
      expectedStamp: before.stamps[MANIFEST]!
    })

    // An `id` without a `contract_version` leaves the legacy shape behind and
    // the manifest then fails a required-field check — the fix would break the
    // folder it was meant to repair.
    expect(readManifest(manifestPath(agentDir)).contract_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(after.readiness).toBe('ok')
    expect(after.validation.errors).toEqual([])
    expect(after.validation.warnings.some((w) => w.code === 'manifest.legacy')).toBe(false)
  })

  /**
   * The point of the whole action. Stamping is offered as the cure for "this
   * folder loses its chats if you rename it" — so it must not itself be the
   * thing that loses them. Every table that names an agent id has to follow the
   * row, including the three columns with no foreign key behind them, which a
   * cascade would not have touched at all.
   */
  it('carries every attached row across the re-key', () => {
    const legacyId = makeLegacy()
    const raw = holder.current!.raw
    const now = Date.now()
    raw.prepare('INSERT INTO chats (id, title, agent_id, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('c1', 'A chat with the legacy agent', legacyId, now, now)
    raw.prepare(
      `INSERT INTO a2a_sessions (id, chat_id, agent_id, context_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`
    ).run('s1', 'c1', legacyId, 'engine-session-1', now, now)
    raw.prepare(
      'INSERT INTO chat_on_demand_agents (chat_id, agent_id, pending_announce, created_at) VALUES (?,?,?,?)'
    ).run('c1', legacyId, 1, now)
    raw.prepare(
      `INSERT INTO jobs (id, user_id, title, prompt, agent_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run('j1', USER, 'Nightly', 'go', legacyId, now, now)
    raw.prepare('INSERT INTO job_agents (job_id, agent_id) VALUES (?,?)').run('j1', legacyId)
    raw.prepare(
      `INSERT INTO messages (id, chat_id, role, content, addressed_agent_id, source_agent_id,
                             sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run('m1', 'c1', 'user', 'hello', legacyId, legacyId, 0, now)

    const before = localAgentService.get(USER, legacyId)
    const after = localAgentService.updateField(USER, {
      agentId: legacyId,
      update: { field: 'stamp_identity' },
      expectedStamp: before.stamps[MANIFEST]!
    })

    expect(after.id).not.toBe(legacyId)
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([after.id])

    // Stated before the per-column checks so a regression to insert+prune fails
    // with "expected 0 to be 1" rather than a null dereference downstream.
    const rows = (table: string): number =>
      (raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c
    expect(rows('a2a_sessions')).toBe(1)
    expect(rows('chat_on_demand_agents')).toBe(1)
    expect(rows('job_agents')).toBe(1)

    const one = (sql: string): unknown => Object.values(raw.prepare(sql).get() as object)[0]
    // The FK children survived rather than cascading away with the old row...
    expect(one('SELECT context_id FROM a2a_sessions')).toBe('engine-session-1')
    expect(one('SELECT agent_id FROM a2a_sessions')).toBe(after.id)
    expect(one('SELECT agent_id FROM chat_on_demand_agents')).toBe(after.id)
    expect(one('SELECT agent_id FROM job_agents')).toBe(after.id)
    // ...and the columns with no foreign key, which a cascade never touches and
    // which would otherwise have been left pointing at a row that is gone.
    expect(one('SELECT agent_id FROM chats')).toBe(after.id)
    expect(one('SELECT agent_id FROM jobs')).toBe(after.id)
    expect(one('SELECT addressed_agent_id FROM messages')).toBe(after.id)
    expect(one('SELECT source_agent_id FROM messages')).toBe(after.id)
    // Nothing anywhere still names the id the folder used to have.
    expect(
      raw.prepare('SELECT COUNT(*) c FROM agents WHERE id = ?').get(legacyId)
    ).toEqual({ c: 0 })
  })

  it('refuses to re-stamp an agent that already has an id', () => {
    const agent = currentAgent()
    const original = readManifest(manifestPath(agentDir)).id

    expect(() =>
      localAgentService.updateField(USER, {
        agentId,
        update: { field: 'stamp_identity' },
        expectedStamp: agent.stamps[MANIFEST]!
      })
    ).toThrow(/already has an id/)

    // A second stamp would be a silent re-key: new row, and the old one's
    // chats cascade away.
    expect(readManifest(manifestPath(agentDir)).id).toBe(original)
  })

  it('is refused when the manifest changed since the page read it', () => {
    const legacyId = makeLegacy()
    const before = localAgentService.get(USER, legacyId)

    // An assistant edits the manifest while the page sits on the strip.
    const manifest = readManifest(manifestPath(agentDir))
    manifest.description = 'Rewritten by an assistant.'
    writeFileSync(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`)
    ageFile(manifestPath(agentDir))

    let error: unknown = null
    try {
      localAgentService.updateField(USER, {
        agentId: legacyId,
        update: { field: 'stamp_identity' },
        expectedStamp: before.stamps[MANIFEST]!
      })
    } catch (err) {
      error = err
    }

    expect(isStaleWriteError(error)).toBe(true)
    // Their edit survives, and no id was written behind their back.
    const now = readManifest(manifestPath(agentDir))
    expect(now.description).toBe('Rewritten by an assistant.')
    expect(now.id).toBeUndefined()
  })

  it('never stamps on its own — indexing a legacy folder leaves the file alone', () => {
    // The bytes are captured *before* any scan sees the folder: reading them
    // afterwards would let a scanner that stamps on sight pass, because the
    // second scan then finds an id and has nothing left to write.
    writeLegacyManifest()
    const bytes = readFileSync(manifestPath(agentDir), 'utf8')

    const legacyId = rescan()
    rescan()
    // Indexed — the point of the change — and still untouched on disk. Writing
    // to a user's manifest unprompted is what Invariant 3 forbids, and an
    // assistant may have that file open.
    expect(legacyId).toBe(`folder:legacy:${agentRootRepo.list(USER)[0].id}:alpha`)
    expect(readFileSync(manifestPath(agentDir), 'utf8')).toBe(bytes)
    expect(agentRepo.listFolder(USER).map((r) => r.id)).toEqual([legacyId])
  })
})

describe('create', () => {
  it('scaffolds and indexes in one step', () => {
    const created = localAgentService.create(USER, {
      name: 'Invoice Reader',
      description: 'Reads invoices.'
    })
    expect(created.slug).toBe('invoice-reader')
    expect(created.readiness).toBe('ok')

    const { agents } = localAgentService.list(USER)
    expect(agents.map((a) => a.slug).sort()).toEqual(['alpha', 'invoice-reader'])
  })

  it('refuses a name with nothing to build a folder name from', () => {
    expect(() => localAgentService.create(USER, { name: '!!!', description: 'x' })).toThrow(
      /letters or digits/i
    )
  })

  it('writes the name as the description when none is given — the schema needs one', () => {
    const created = localAgentService.create(USER, { name: 'Fine' })
    expect(created.description).toBe('Fine')
    expect(created.readiness).toBe('ok')
    expect(readManifest(manifestPath(created.path)).description).toBe('Fine')
  })

  it('treats a blank description the same as an absent one', () => {
    const created = localAgentService.create(USER, { name: 'Blank', description: '  ' })
    expect(created.description).toBe('Blank')
  })

  it('leaves the index row’s description empty when it would only repeat the name', () => {
    // The `@` and `[+]` pickers render `agents.description` under the name;
    // "Fine — Fine" is not a description, it is the absence of one.
    const created = localAgentService.create(USER, { name: 'Fine' })
    expect(agentRepo.getOwned(USER, created.id)?.description ?? null).toBeNull()
    const real = localAgentService.create(USER, { name: 'Real', description: 'Does things.' })
    expect(agentRepo.getOwned(USER, real.id)?.description).toBe('Does things.')
  })
})

describe('delete', () => {
  beforeEach(() => {
    trash.mockReset()
    // The default fake does what the OS would: the folder is gone afterwards.
    trash.mockImplementation(async (path: string) => {
      rmSync(path, { recursive: true, force: true })
    })
  })

  it('moves the folder to the trash and prunes the row', async () => {
    const result = await localAgentService.delete(USER, { agentId, trashFolder: true })

    expect(result).toEqual({ agentId, trashed: true })
    expect(trash).toHaveBeenCalledWith(agentDir)
    expect(agentRepo.getOwned(USER, agentId)).toBeUndefined()
    expect(localAgentService.list(USER).agents).toEqual([])
    expect(() => localAgentService.get(USER, agentId)).toThrow(/no longer/i)
  })

  it('refuses while a turn holds the agent, and touches nothing', async () => {
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      await expect(localAgentService.delete(USER, { agentId, trashFolder: true })).rejects.toMatchObject({
        code: 'turn_in_progress'
      })
    } finally {
      handle.release()
    }
    expect(trash).not.toHaveBeenCalled()
    expect(agentRepo.getOwned(USER, agentId)).toBeDefined()
  })

  it('releases the lock and keeps the row when the trash call fails', async () => {
    trash.mockRejectedValueOnce(new Error('EPERM'))

    await expect(localAgentService.delete(USER, { agentId, trashFolder: true })).rejects.toMatchObject({
      code: 'write_failed'
    })
    expect(turnLock.isLocked(agentId)).toBe(false)
    expect(agentRepo.getOwned(USER, agentId)).toBeDefined()
    expect(currentAgent().readiness).toBe('ok')
  })

  it('refuses an id that is not a folder agent', async () => {
    await expect(localAgentService.delete(USER, { agentId: 'remote-1', trashFolder: true })).rejects.toMatchObject({
      code: 'not_found'
    })
    expect(trash).not.toHaveBeenCalled()
  })
})

describe('reindexAgent', () => {
  it('re-points the row when a folder is renamed in place', () => {
    const renamed = join(workshop, 'Local', 'alpha-renamed')
    renameSync(agentDir, renamed)
    // The manifest's `slug` must match the folder, so the rename is completed
    // the way a user would.
    const manifest = readManifest(manifestPath(renamed))
    manifest.slug = 'alpha-renamed'
    writeFileSync(manifestPath(renamed), `${JSON.stringify(manifest, null, 2)}\n`)

    const root = agentRootRepo.getDefault(USER)!
    localAgentService.reindexAgent(USER, root, renamed)

    // Same row — the id came from the manifest — now pointing at the new path.
    // Without this, `locate()` keeps returning the old folder and every read
    // and write for this agent fails until something triggers a full root scan.
    const row = agentRepo.getOwned(USER, agentId)
    expect(row?.localPath).toBe(renamed)
    expect(row?.localRootId).toBe(root.id)
    expect(localAgentService.get(USER, agentId).path).toBe(renamed)
  })

  it('refreshes the row’s manifest metadata, which is why the watcher path matters', () => {
    // This is the single-folder update, and it is what the watcher calls when
    // `cinna-agent.json` changes — so it is the path that runs at exactly the
    // moment `example_prompts` is edited. A full rescan would eventually catch
    // up, but nothing guarantees one runs, and until it did the composer's `#`
    // list and the agent's own tool description would show the old prompts.
    const manifest = readManifest(manifestPath(agentDir))
    manifest.example_prompts = ['ask about last quarter']
    writeFileSync(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`)

    const root = agentRootRepo.getDefault(USER)!
    localAgentService.reindexAgent(USER, root, agentDir)

    expect(agentRepo.getOwned(USER, agentId)?.remoteMetadata?.example_prompts).toEqual([
      'ask about last quarter'
    ])
  })
})

describe('openPath', () => {
  it('refuses a path that escapes the agent folder', () => {
    expect(() =>
      localAgentService.openPath(USER, { agentId, relPath: '../../../etc/passwd' })
    ).toThrow(/not inside/i)
  })

  it('accepts an agent-relative path', () => {
    expect(() => localAgentService.openPath(USER, { agentId, relPath: WORKFLOW })).not.toThrow()
  })
})

/**
 * The "Add them in credentials/.env" click.
 *
 * The label names a file, so the click has to end on that file — and on a
 * scaffolded agent the file does not exist yet, which is exactly the agent
 * whose credentials are missing. Seeding it is therefore part of opening it,
 * and the seed has to leave the credential *unsatisfied*: the scanner counts a
 * bare `KEY=` as defined, so an uncommented placeholder would report every
 * credential as filled the moment the user looked at the file.
 */
describe('openCredentials', () => {
  const ENV = 'credentials/.env'

  /** Declare one credential slot in the scaffolded manifest. */
  function declareCredential(): void {
    const path = manifestPath(agentDir)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.credentials = [
      { name: 'Vendor Portal', type: 'api_key', env_prefix: 'VENDOR_PORTAL_', fields: ['token'] }
    ]
    writeFileSync(path, JSON.stringify(manifest, null, 2))
  }

  beforeEach(() => {
    openPath.mockClear()
    openPath.mockImplementation(async () => '')
    reveal.mockClear()
  })

  it('creates the file from the declared names and opens it, not its folder', async () => {
    declareCredential()

    const result = await localAgentService.openCredentials(USER, agentId)

    expect(result).toEqual({ created: true, revealed: false })
    expect(openPath).toHaveBeenCalledWith(join(agentDir, ENV))
    expect(reveal).not.toHaveBeenCalled()
    const text = readFileSync(join(agentDir, ENV), 'utf8')
    expect(text).toContain('# VENDOR_PORTAL_TOKEN=')
  })

  it('leaves the credential unsatisfied — the seed defines no variable', async () => {
    declareCredential()
    await localAgentService.openCredentials(USER, agentId)

    const [slot] = currentAgent().credentials
    expect(slot.presentKeys).toEqual([])
    expect(slot.satisfied).toBe(false)
  })

  it('opens an existing file without touching a byte of it', async () => {
    writeFileSync(join(agentDir, ENV), 'VENDOR_PORTAL_TOKEN=already-here\n')

    const result = await localAgentService.openCredentials(USER, agentId)

    expect(result).toEqual({ created: false, revealed: false })
    expect(readFileSync(join(agentDir, ENV), 'utf8')).toBe('VENDOR_PORTAL_TOKEN=already-here\n')
  })

  it('refuses to seed a secrets file no .gitignore rule would cover', async () => {
    // The agent's own ignore file, the workshop's, and the one the contract puts
    // in credentials/ — all gone, which is a hand-made folder or one dropped
    // into somebody else's repo.
    rmSync(join(agentDir, '.gitignore'), { force: true })
    rmSync(join(agentDir, 'credentials/.gitignore'), { force: true })
    rmSync(join(workshop, '.gitignore'), { force: true })
    // The contract's template is what gets installed in its place…
    await expect(localAgentService.openCredentials(USER, agentId)).resolves.toEqual({
      created: true,
      revealed: false
    })
    expect(readFileSync(join(agentDir, 'credentials/.gitignore'), 'utf8')).toContain('.env')
    expect(currentAgent().readiness).not.toBe('invalid')

    // …and where the folder un-ignores the file on purpose, the click is
    // refused rather than making the agent invalid on the spot.
    rmSync(join(agentDir, ENV), { force: true })
    writeFileSync(join(agentDir, 'credentials/.gitignore'), '!.env\n')
    await expect(localAgentService.openCredentials(USER, agentId)).rejects.toThrow(/gitignore/i)
    expect(existsSync(join(agentDir, ENV))).toBe(false)
  })

  it('refuses to seed while a turn holds the agent, and opens an existing file anyway', async () => {
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      await expect(localAgentService.openCredentials(USER, agentId)).rejects.toThrow(/busy/i)
      expect(existsSync(join(agentDir, ENV))).toBe(false)

      // A file that is already there is only opened — no write, so no lock.
      writeFileSync(join(agentDir, ENV), '# mine\n')
      await expect(localAgentService.openCredentials(USER, agentId)).resolves.toEqual({
        created: false,
        revealed: false
      })
    } finally {
      handle.release()
    }
  })

  it('never lets a name with a newline in it define a variable', async () => {
    const path = manifestPath(agentDir)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.name = 'Portal\nVENDOR_PORTAL_TOKEN='
    manifest.credentials = [
      { name: 'Vendor Portal', type: 'api_key', env_prefix: 'VENDOR_PORTAL_', fields: ['token'] }
    ]
    writeFileSync(path, JSON.stringify(manifest, null, 2))

    await localAgentService.openCredentials(USER, agentId)

    const [slot] = currentAgent().credentials
    expect(slot.satisfied).toBe(false)
    expect(readFileSync(join(agentDir, ENV), 'utf8')).toContain(
      '# Credentials for Portal VENDOR_PORTAL_TOKEN=.'
    )
  })

  it('reveals the file when nothing on this machine will open it', async () => {
    openPath.mockImplementation(async () => 'no application knows how to open this file')
    // Pinned to a platform without macOS's `open -t` in between — the point is
    // the last resort, and a real `open` would launch an editor from the suite.
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const result = await localAgentService.openCredentials(USER, agentId)

      expect(result).toEqual({ created: true, revealed: true })
      expect(reveal).toHaveBeenCalledWith(join(agentDir, ENV))
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }
    expect(readFileSync(join(agentDir, ENV), 'utf8')).toContain(
      '# This agent declares no credentials yet.'
    )
  })
})

/**
 * "Stamp identity" and the jobs that already depend on the folder.
 *
 * Stamping changes a folder agent's identity — `folder:legacy:<rootId>:<name>`
 * becomes `folder:<uuid>` — and `rekeyFolderRow` moves the `job_agents` join
 * rows with it. A job's *synced* dependency, though, lives in `jobs.sync_deps`
 * as a descriptor keyed on the manifest id, and nothing rebuilt it: the stored
 * descriptor went on naming an id no row has.
 *
 * Two things followed, and the first is what the user sees. The job reported
 * "needs setup" about an agent sitting right there and working, with no action
 * in the app that would clear it. And the next edit to the job re-emitted
 * **both** descriptors — old and new produce different `agentIdentityKey`s, so
 * `remember()`'s dedupe does not merge them — leaving a ghost with no join row
 * that every later rebuild carried forward and every peer received.
 *
 * The job here is owned by a **different user id** from the agent on purpose.
 * A folder agent is a settings-scope row and a property of the machine; jobs
 * are profile-scoped. A repair that passed the agent's own `userId` to
 * `rebuildJobManifest` would find no job and return silently — a fix that looks
 * applied and does nothing — and under a fixture where both scopes were the
 * same string, no test could tell the difference.
 */
describe('stamp_identity with a job already depending on the folder', () => {
  const JOB_OWNER = 'profile-1'

  function writeLegacyManifest(): void {
    const manifest = readManifest(manifestPath(agentDir))
    delete manifest.id
    delete manifest.contract_version
    manifest.schema_version = 1
    writeFileSync(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  /** A legacy-indexed agent, and a job in another scope that depends on it. */
  function legacyAgentWithJob(): { legacyId: string; jobId: string } {
    writeLegacyManifest()
    scannerService.markAllRootsDirty()
    const legacyId = scannerService.scanRoot(USER, agentRootRepo.list(USER)[0]).agents[0].id

    const job = jobsRepo.create(JOB_OWNER, {
      type: 'local',
      title: 'Nightly check',
      prompt: 'Check the invoices'
    })
    jobAgentRepo.setAgentIds(job.id, [legacyId])
    rebuildJobManifest(JOB_OWNER, job.id)
    return { legacyId, jobId: job.id }
  }

  function folderDeps(jobId: string): Array<Record<string, unknown>> {
    const deps = jobsRepo.getById(JOB_OWNER, jobId)?.syncDeps?.deps ?? []
    return deps.filter(
      (d) => d.kind === 'agent' && d.source === 'folder'
    ) as unknown as Array<Record<string, unknown>>
  }

  function stamp(legacyId: string): string {
    const before = localAgentService.get(USER, legacyId)
    return localAgentService.updateField(USER, {
      agentId: legacyId,
      update: { field: 'stamp_identity' },
      expectedStamp: before.stamps[MANIFEST]!
    }).id
  }

  it('leaves the job resolvable instead of reporting setup it cannot need', () => {
    const { legacyId, jobId } = legacyAgentWithJob()
    // Sanity: before stamping, the job is fully set up.
    expect(
      manifestNeedsSetup(jobsRepo.getById(JOB_OWNER, jobId)?.syncDeps ?? null, buildResolveIndex(JOB_OWNER))
    ).toBe(false)

    stamp(legacyId)

    // The consequence first. The agent did not move, was not disabled and was
    // not deleted — the user pressed a button offered as a repair — so anything
    // but `false` here is the app contradicting itself on screen.
    expect(
      manifestNeedsSetup(jobsRepo.getById(JOB_OWNER, jobId)?.syncDeps ?? null, buildResolveIndex(JOB_OWNER))
    ).toBe(false)
  })

  it('re-keys the stored descriptor to the id the row now has', () => {
    const { legacyId, jobId } = legacyAgentWithJob()
    expect(folderDeps(jobId)[0].manifestId).toMatch(/^legacy:/)

    const newId = stamp(legacyId)

    expect(folderDeps(jobId)[0].manifestId).toBe(newId.replace('folder:', ''))
    expect(jobAgentRepo.listAgentIds(jobId)).toEqual([newId])
  })

  it('leaves exactly one folder descriptor behind, not a ghost beside it', () => {
    // The ghost is the expensive half: it has no join row and never will, so
    // every later rebuild carries it forward and every peer receives a job with
    // a dependency that cannot be satisfied anywhere.
    const { legacyId, jobId } = legacyAgentWithJob()
    stamp(legacyId)
    expect(folderDeps(jobId)).toHaveLength(1)
  })

  it('survives a second rebuild, which is where the carry-forward would resurrect it', () => {
    // `buildJobManifest` carries forward folder descriptors from the prior
    // manifest so an unresolvable dependency is not silently dropped. That is
    // correct, and it is also what would have preserved the stale id forever
    // had the rekey not repaired it at the source.
    const { legacyId, jobId } = legacyAgentWithJob()
    const newId = stamp(legacyId)
    rebuildJobManifest(JOB_OWNER, jobId)
    expect(folderDeps(jobId)).toHaveLength(1)
    expect(folderDeps(jobId)[0].manifestId).toBe(newId.replace('folder:', ''))
  })

  it('repairs a job in a scope the stamping caller does not hold', () => {
    // The job's owner is read off the job, never supplied by the caller. This
    // asserts it directly: the agent is stamped under `__default__` while the
    // job belongs to `profile-1`, and the repair still reaches it.
    const { legacyId, jobId } = legacyAgentWithJob()
    expect(jobsRepo.getById(USER, jobId)).toBeFalsy()
    const newId = stamp(legacyId)
    expect(folderDeps(jobId)[0].manifestId).toBe(newId.replace('folder:', ''))
  })
})

/**
 * The init prompt — the briefing for an assistant Cinna cannot launch.
 *
 * The one thing worth testing is the entry document: the prompt's whole job is
 * to say "read this file", and naming a file the folder does not have would
 * send the assistant looking for the wrong thing. So the candidates are checked
 * against a real folder, in order, with each one removed in turn.
 */
describe('initPrompt', () => {
  it('names the folder, the agent and the entry document', () => {
    const prompt = localAgentService.initPrompt(USER, agentId)
    expect(prompt).toContain(`\`${agentDir}\``)
    expect(prompt).toContain('"Alpha"')
    expect(prompt).toContain('`AGENTS.md`')
    // The folder's own AGENTS.md routes on two roles; this prompt is always
    // the Builder one, and says so.
    expect(prompt).toContain('working *on* this agent, not running it')
  })

  it('falls back to CLAUDE.md when the folder has no AGENTS.md', () => {
    rmSync(join(agentDir, 'AGENTS.md'))
    const prompt = localAgentService.initPrompt(USER, agentId)
    expect(prompt).toContain('`CLAUDE.md`')
    expect(prompt).not.toContain('`AGENTS.md`')
  })

  it('points at the manifest and the workflow prompt when there is no entry document', () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
      rmSync(join(agentDir, file), { force: true })
    }
    const prompt = localAgentService.initPrompt(USER, agentId)
    expect(prompt).toContain('`cinna-agent.json`')
    expect(prompt).toContain('`docs/WORKFLOW_PROMPT.md`')
  })

  it('keeps the last good name when the manifest is momentarily unparseable', () => {
    // The name comes from the index row, not from a fresh scan: a scan of this
    // folder is an `unreadableAgent` whose name is the directory basename
    // ('alpha'), which is not what the user calls this agent.
    writeFileSync(manifestPath(agentDir), '{ not json')
    expect(localAgentService.initPrompt(USER, agentId)).toContain('"Alpha"')
  })

  it('refuses a folder that is no longer on disk rather than briefing a dead path', () => {
    // The row outlives the directory (an unmounted volume, a folder moved
    // between rescans). Without the guard this reads as "a folder with no
    // entry document" and copies a confident prompt for a path that is gone.
    rmSync(agentDir, { recursive: true, force: true })
    expect(() => localAgentService.initPrompt(USER, agentId)).toThrow(/no longer there/)
  })

  it('refuses an agent that is not in the index', () => {
    expect(() => localAgentService.initPrompt(USER, 'folder:nope')).toThrow()
  })
})

/**
 * Adopting a folder, and unadopting one.
 *
 * The two halves that are genuinely new rather than a bare variant of something
 * kit agents already do: a pick that has to travel out to the renderer and back
 * without becoming a way to name any folder on disk, and a removal that means
 * two different things depending on which one the user chose.
 */
describe('adopting an existing folder', () => {
  let outside: string

  function bareAgent(relPath: string, body = '# Alpha\n\nDo alpha things.\n'): string {
    const dir = join(outside, ...relPath.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'AGENT.md'), body)
    return dir
  }

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'cinna-adopt-'))
  })
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true })
  })

  it('previews what is in a folder without registering anything', () => {
    bareAgent('local_agents/alpha', '# Invoice watcher\n\nBody.\n')
    bareAgent('local_agents/beta')

    const pick = localAgentService.pickedAgentFolder(USER, outside)

    expect(pick.cancelled).toBe(false)
    if (pick.cancelled) return
    expect(pick.refusal).toBeNull()
    expect(pick.found.map((f) => f.relPath)).toEqual(['local_agents/alpha', 'local_agents/beta'])
    expect(pick.found[0].name).toBe('Invoice watcher')
    // Nothing registered, nothing written: the preview is a read.
    expect(localAgentService.listRoots(USER)).toHaveLength(1)
    expect(existsSync(join(outside, 'Local'))).toBe(false)
  })

  it('refuses a folder with nothing in it, as a state rather than a throw', () => {
    // The dialog stays open and says this (ux_rules rule 6). A rejection would
    // close the picker and leave the user with an error toast and no next step.
    const pick = localAgentService.pickedAgentFolder(USER, outside)
    expect(pick.cancelled).toBe(false)
    if (pick.cancelled) return
    expect(pick.refusal).toMatch(/AGENT\.md/)
  })

  it('refuses a folder that overlaps a registered root', () => {
    // The security rule, checked while the dialog can still say so: every
    // registered root becomes an allowed area for the "open in…" path guard.
    const pick = localAgentService.pickedAgentFolder(USER, dirname(workshop))
    expect(pick.cancelled).toBe(false)
    if (pick.cancelled) return
    expect(pick.refusal).toMatch(/overlaps|already registered/i)
  })

  it('will not adopt a path the picker did not just return', () => {
    // The whole reason the pick is recorded. Without it, splitting the adopt
    // into two calls would make `folder-add` a channel that registers any
    // directory a renderer names.
    bareAgent('alpha')
    expect(() =>
      localAgentService.addAgentFolder(USER, { path: outside, relPaths: ['alpha'] })
    ).toThrow(/picked/i)
  })

  it('adopts the ticked agents and hides the rest, without writing into the folder', () => {
    bareAgent('local_agents/alpha')
    bareAgent('local_agents/beta')
    localAgentService.pickedAgentFolder(USER, outside)

    const { root, agentIds } = localAgentService.addAgentFolder(USER, {
      path: outside,
      relPaths: ['local_agents/alpha']
    })

    expect(root.kind).toBe('external')
    expect(root.agentCount).toBe(1)
    expect(root.hiddenAgentCount).toBe(1)
    // Returned so the dialog can land the user on what they just added.
    expect(agentIds).toHaveLength(1)
    const agents = localAgentService.list(USER).agents.filter((a) => a.rootId === root.id)
    expect(agents.map((a) => a.slug)).toEqual(['alpha'])
    // Not converted: no templates, no `.cinna-kit/`, no `Local/`, and no
    // `app-data/` in either agent folder.
    expect(existsSync(join(outside, '.cinna-kit'))).toBe(false)
    expect(existsSync(join(outside, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(outside, 'local_agents', 'alpha', 'app-data'))).toBe(false)
  })

  it('refuses when the folder has gone between the preview and the confirm', () => {
    // The preview and the adopt are separate calls, so the user can eject the
    // volume, move the folder or delete it in between. Without this the dialog
    // closed on success, no agent appeared, nothing said why, and a registered
    // root with no agents was left behind — which then refused the next attempt
    // for overlapping itself.
    bareAgent('alpha')
    localAgentService.pickedAgentFolder(USER, outside)
    rmSync(outside, { recursive: true, force: true })

    expect(() =>
      localAgentService.addAgentFolder(USER, { path: outside, relPaths: ['alpha'] })
    ).toThrow(/no longer there/i)
    // And nothing is left registered, so choosing the folder again is possible.
    expect(localAgentService.listRoots(USER).map((r) => r.path)).not.toContain(outside)
  })

  it('takes a name for a single adopted folder', () => {
    bareAgent('.', '# From the file\n')
    localAgentService.pickedAgentFolder(USER, outside)
    const { root, agentIds } = localAgentService.addAgentFolder(USER, {
      path: outside,
      relPaths: ['.'],
      name: 'My agent'
    })
    const [agent] = localAgentService.list(USER).agents.filter((a) => a.rootId === root.id)
    expect(agent.name).toBe('My agent')
    expect(agentIds).toEqual([agent.id])
  })

  it('counts a root the same whether the scan is cached or cold', () => {
    // The settings row's counts come off the cached scan, so the tree is not
    // walked again on every `local-agent:list`. The fallback for a root never
    // scanned in this process has to give the *same* answer — two independent
    // counts of the same thing is how they drift, and the drift would show as a
    // settings row disagreeing with the sidebar it sits beside.
    bareAgent('local_agents/alpha')
    bareAgent('local_agents/beta')
    bareAgent('local_agents/gamma')
    localAgentService.pickedAgentFolder(USER, outside)
    const { root } = localAgentService.addAgentFolder(USER, {
      path: outside,
      relPaths: ['local_agents/alpha', 'local_agents/beta']
    })

    const warm = localAgentService.listRoots(USER).find((entry) => entry.id === root.id)
    expect(warm).toMatchObject({ agentCount: 2, hiddenAgentCount: 1, truncated: false })

    // Cold: no cached scan for this root, so `toDto` walks instead.
    scannerService.markAllRootsDirty()
    const cold = localAgentService.listRoots(USER).find((entry) => entry.id === root.id)
    expect(cold).toMatchObject({
      agentCount: warm?.agentCount,
      hiddenAgentCount: warm?.hiddenAgentCount,
      truncated: warm?.truncated
    })
  })

  it('marks folders already added, and refuses when they all are', () => {
    bareAgent('alpha')
    localAgentService.pickedAgentFolder(USER, outside)
    localAgentService.addAgentFolder(USER, { path: outside, relPaths: ['alpha'] })

    const again = localAgentService.pickedAgentFolder(USER, outside)
    expect(again.cancelled).toBe(false)
    if (again.cancelled) return
    // Overlap wins: the folder is now a registered root, which is the more
    // precise thing to say about it.
    expect(again.refusal).toMatch(/already registered/i)
  })
})

describe('removing a bare agent', () => {
  let outside: string
  let bareId: string
  let bareDir: string

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'cinna-bare-del-'))
    bareDir = join(outside, 'local_agents', 'alpha')
    mkdirSync(bareDir, { recursive: true })
    writeFileSync(join(bareDir, 'AGENT.md'), '# Alpha\n')
    localAgentService.pickedAgentFolder(USER, outside)
    const { root } = localAgentService.addAgentFolder(USER, {
      path: outside,
      relPaths: ['local_agents/alpha']
    })
    bareId = localAgentService.list(USER).agents.filter((a) => a.rootId === root.id)[0].id
    trash.mockReset()
    trash.mockResolvedValue(undefined)
  })
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true })
  })

  it('removes only the list entry, leaving the folder exactly as it was', async () => {
    const result = await localAgentService.delete(USER, { agentId: bareId, trashFolder: false })

    expect(result).toEqual({ agentId: bareId, trashed: false })
    expect(trash).not.toHaveBeenCalled()
    expect(existsSync(join(bareDir, 'AGENT.md'))).toBe(true)
    expect(agentRepo.getOwned(USER, bareId)).toBeUndefined()
    // And it stays gone across a rescan, which is what makes the choice mean
    // something: the walk finds the folder every time.
    localAgentService.rescan(USER)
    expect(agentRepo.getOwned(USER, bareId)).toBeUndefined()
  })

  it('trashes the folder when that is what was chosen, and takes its state with it', async () => {
    // The state file is the sharp half. It lives under `userData`, keyed on the
    // folder's *realpath*, so it does not go to the Trash with the folder — and
    // left behind it is adopted wholesale by whatever the user next creates at
    // that path: its sessions, its agent token and every standing permission
    // grant. The path therefore has to be resolved before the folder moves;
    // resolving it afterwards silently derives a different key on any machine
    // where a component is a symlink, which on macOS is every temp directory.
    desktopStateService.patch(bareDir, 'bare', { agentToken: 'tok', displayName: 'Doomed' })
    const stateFile = desktopStatePath(bareDir, 'bare')
    expect(existsSync(stateFile)).toBe(true)
    // The fake `shell.trashItem` does not remove anything, so the folder is
    // taken out here — otherwise the ordering bug cannot show itself.
    trash.mockImplementationOnce(async (path: string) => {
      rmSync(path, { recursive: true, force: true })
    })

    const result = await localAgentService.delete(USER, { agentId: bareId, trashFolder: true })

    expect(result).toEqual({ agentId: bareId, trashed: true })
    expect(trash).toHaveBeenCalledWith(bareDir)
    expect(existsSync(stateFile)).toBe(false)
  })

  it('refuses to remove a kit agent from the list alone', async () => {
    // Its row is a derived index over its folder, so the next scan would put it
    // straight back. A removal that undoes itself is worse than a refusal.
    await expect(
      localAgentService.delete(USER, { agentId, trashFolder: false })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(agentRepo.getOwned(USER, agentId)).toBeDefined()
  })

  it('renames a bare agent without writing into its folder', () => {
    const renamed = localAgentService.renameAgent(USER, bareId, 'Invoice watcher')

    expect(renamed.name).toBe('Invoice watcher')
    expect(agentRepo.getOwned(USER, bareId)?.name).toBe('Invoice watcher')
    expect(existsSync(join(bareDir, 'app-data'))).toBe(false)
    // Survives a rescan — the name is the user's, not the file's.
    localAgentService.rescan(USER)
    expect(localAgentService.get(USER, bareId).name).toBe('Invoice watcher')
  })

  it('clears the name back to the heading in AGENT.md', () => {
    // The card offers this, and it is the only way back to a name that
    // *follows the file*: the scan prefers a stored name over the heading, so
    // re-typing the heading by hand pins the name to a string that happens to
    // match and stops following the moment the heading changes again. Clearing
    // used to silently revert the field, so the user read it as a typo of their
    // own and the rename was permanent for the life of the folder.
    localAgentService.renameAgent(USER, bareId, 'Support (old)')
    expect(localAgentService.get(USER, bareId).name).toBe('Support (old)')

    writeFileSync(join(bareDir, 'AGENT.md'), '# Support, properly named\n')
    scannerService.markAllRootsDirty()
    // Still pinned: a stored name outranks the file.
    expect(localAgentService.get(USER, bareId).name).toBe('Support (old)')

    const cleared = localAgentService.renameAgent(USER, bareId, null)
    expect(cleared.name).toBe('Support, properly named')
    // And it follows the file from now on, which re-typing the heading by hand
    // would not have done.
    writeFileSync(join(bareDir, 'AGENT.md'), '# Renamed again upstream\n')
    scannerService.markAllRootsDirty()
    expect(localAgentService.get(USER, bareId).name).toBe('Renamed again upstream')
  })

  it('refuses to rename a kit agent through this path', () => {
    // A kit agent's name lives in its manifest, and that write is stamp-guarded
    // so an assistant's edit cannot be clobbered. This channel carries no stamp.
    expect(() => localAgentService.renameAgent(USER, agentId, 'Nope')).toThrow(/manifest/i)
  })

  it('puts an agent’s engine sessions back with it', async () => {
    // The chats re-bind on their own — `chats.agent_id` declares no FK and the
    // id is positional — but `a2a_sessions` cascades away with the row, so
    // without this a restored agent's conversations silently start a fresh
    // engine session and the model has forgotten everything, ten seconds after
    // the user undid the removal that caused it.
    const chatId = chatRepo.create(USER, { title: 'With the bare agent' }).id
    a2aSessionRepo.upsert({
      chatId,
      agentId: bareId,
      contextId: 'ses_engine_1',
      taskId: null,
      taskState: null
    })
    desktopStateService.patch(bareDir, 'bare', {
      sessions: { [chatId]: { sessionId: 'ses_engine_1', updatedAt: Date.now() } }
    })

    const rootId = localAgentService.get(USER, bareId).rootId
    await localAgentService.delete(USER, { agentId: bareId, trashFolder: false })
    expect(a2aSessionRepo.getByChatAndAgent(chatId, bareId)).toBeUndefined()

    localAgentService.restoreHiddenAgents(USER, rootId)
    expect(a2aSessionRepo.getByChatAndAgent(chatId, bareId)?.contextId).toBe('ses_engine_1')
  })

  it('puts back everything that was removed from one root’s list', async () => {
    // Without this, "remove from the list" is a one-way door: the folder is
    // still on disk and every rescan keeps skipping it, with nothing anywhere
    // that can bring it back short of re-picking the whole folder.
    const rootId = localAgentService.get(USER, bareId).rootId
    await localAgentService.delete(USER, { agentId: bareId, trashFolder: false })
    expect(localAgentService.list(USER).agents.filter((a) => a.rootId === rootId)).toHaveLength(0)

    expect(localAgentService.restoreHiddenAgents(USER, rootId)).toEqual({ restored: 1 })
    const back = localAgentService.list(USER).agents.filter((a) => a.rootId === rootId)
    expect(back).toHaveLength(1)
    // The same agent, not a new one: the id is positional, so its chats and
    // sessions come back with it.
    expect(back[0].id).toBe(bareId)
  })
})
