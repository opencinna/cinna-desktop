import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
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

const { agentRepo } = await import('../../db/agents')
const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { clearContractCache } = await import('../../kit/contractStore')
const { manifestPath, readManifest } = await import('../../kit/manifestIo')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { localAgentService } = await import('./localAgentService')
const { turnLock } = await import('./turnLock')
const { isBlockedWriteError, isStaleWriteError } = await import('../../../shared/localAgents')
const { jobsRepo, jobAgentRepo } = await import('../../db/jobs')
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

  it('refuses an empty description', () => {
    expect(() => localAgentService.create(USER, { name: 'Fine', description: '  ' })).toThrow(
      /cannot be empty/i
    )
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
