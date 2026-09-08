import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * Roots: what may become one, and what happens to the agents already indexed
 * when the home moves.
 *
 * Both questions are about destruction rather than convenience. A root is
 * handed to the "open in…" guard as an allowed area, so an over-broad one
 * quietly widens what a compromised renderer can reach; and the index rows
 * cascade to `a2a_sessions` and `job_agents`, so pruning them is not
 * recoverable.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
/**
 * The contract version this build bundles, read rather than pinned: what these
 * tests assert is that the scaffolder records *the contract it built against*,
 * which is a property of the code, not of any particular version number.
 */
const BUNDLED_CONTRACT = readFileSync(
  join(repoRoot, 'resources/cinna-kit-contract/VERSION'),
  'utf8'
).trim()
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: () => undefined }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
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
const { appSettingsRepo } = await import('../../db/appSettings')
const { clearContractCache } = await import('../../kit/contractStore')
const { agentsHomeService } = await import('./agentsHomeService')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')

const USER = '__default__'
let sandbox: string

beforeEach(() => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  sandbox = mkdtempSync(join(tmpdir(), 'cinna-roots-'))
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(sandbox, { recursive: true, force: true })
})

/** Point the home at a sandbox path and materialise it. */
function setHome(path: string) {
  appSettingsRepo.set('localAgentsHome', path)
  return agentsHomeService.ensureHome(USER)
}

describe('adopting a root', () => {
  it('refuses a folder that contains an existing root', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    // `sandbox` is the parent of the home — exactly the `~/Documents` case.
    expect(() => agentsHomeService.addRoot(USER, sandbox)).toThrow(/contains your/i)
  })

  it('refuses a folder inside an existing root', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    const inside = join(home, 'Local', 'alpha')
    mkdirSync(inside, { recursive: true })
    expect(() => agentsHomeService.addRoot(USER, inside)).toThrow(/already inside/i)
  })

  it('refuses a root that is the home itself', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    // Re-adding the same path is idempotent, not an overlap error.
    expect(agentsHomeService.addRoot(USER, home).isDefault).toBe(true)
  })

  it('accepts a sibling folder', () => {
    setHome(join(sandbox, 'workshop'))
    const sibling = join(sandbox, 'other-workshop')
    mkdirSync(sibling, { recursive: true })
    const root = agentsHomeService.addRoot(USER, sibling)
    expect(root.path).toBe(sibling)
    expect(existsSync(join(sibling, 'Local'))).toBe(true)
  })

  it('does not widen the open-in guard past the roots it was given', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    try {
      agentsHomeService.addRoot(USER, sandbox)
    } catch {
      /* expected */
    }
    // The parent never became an allowed root, so nothing under it opened up.
    expect(agentsHomeService.rootPaths(USER)).toEqual([home])
  })
})

describe('adoption confirmation', () => {
  it('is not needed for an empty folder', () => {
    const empty = join(sandbox, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(agentsHomeService.needsAdoptionConfirmation(empty)).toBe(false)
  })

  it('is not needed for something that already looks like a workshop', () => {
    const workshop = join(sandbox, 'existing')
    mkdirSync(join(workshop, 'Local'), { recursive: true })
    writeFileSync(join(workshop, 'README.md'), 'mine\n')
    expect(agentsHomeService.needsAdoptionConfirmation(workshop)).toBe(false)
  })

  it('is needed for a folder holding the user’s own content', () => {
    const docs = join(sandbox, 'documents')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, 'taxes.pdf'), 'x')
    expect(agentsHomeService.needsAdoptionConfirmation(docs)).toBe(true)
  })
})

describe('moving the agents home', () => {
  it('keeps every agent’s row and session when the home moves away and back', () => {
    const first = join(sandbox, 'first')
    const root = setHome(first)
    scaffoldService.scaffoldAgent({
      rootPath: first,
      slug: 'alpha',
      name: 'Alpha',
      description: 'Watches things.'
    })
    const agentId = scannerService.scanRoot(USER, root).agents[0].id

    holder.current!.raw
      .prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?,?,?,?)')
      .run('c1', 'chat', Date.now(), Date.now())
    holder.current!.raw
      .prepare(
        `INSERT INTO a2a_sessions (id, chat_id, agent_id, context_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run('s1', 'c1', agentId, 'engine-session-1', Date.now(), Date.now())

    // Point the home somewhere else, and scan it.
    const second = join(sandbox, 'second')
    const moved = setHome(second)
    scannerService.scanRoot(USER, moved)

    // The folders never moved; only the setting did. Destroying the session for
    // that is not recoverable, and the round trip below is a normal thing to do.
    expect(
      holder.current!.raw.prepare('SELECT context_id FROM a2a_sessions').all()
    ).toEqual([{ context_id: 'engine-session-1' }])

    // …and back.
    const back = setHome(first)
    const after = scannerService.scanRoot(USER, back)
    expect(after.agents.map((a) => a.id)).toEqual([agentId])
    expect(agentRepo.getOwned(USER, agentId)?.localPath).toBe(join(first, 'Local', 'alpha'))
    expect(
      holder.current!.raw.prepare('SELECT context_id FROM a2a_sessions').all()
    ).toEqual([{ context_id: 'engine-session-1' }])
  })

  it('still prunes an agent deleted from the home’s current location', () => {
    const home = join(sandbox, 'workshop')
    const root = setHome(home)
    scaffoldService.scaffoldAgent({
      rootPath: home,
      slug: 'alpha',
      name: 'Alpha',
      description: 'x'
    })
    scannerService.scanRoot(USER, root)
    expect(agentRepo.listFolder(USER)).toHaveLength(1)

    rmSync(join(home, 'Local', 'alpha'), { recursive: true, force: true })
    expect(scannerService.scanRoot(USER, root).pruned).toBe(1)
    expect(agentRepo.listFolder(USER)).toEqual([])
  })
})

describe('the workshop contract copy', () => {
  it('installs it once and then leaves it alone', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    const kitJson = join(home, '.cinna-kit', 'kit.json')
    expect(existsSync(kitJson)).toBe(true)

    // An assistant working in the folder edits a file the bundle also ships.
    // `cpSync(force)` on every `ensureHome` silently reverts exactly this — and
    // `ensureHome` is on the path of `list`, `rescan`, `listRoots`, `create`
    // and `requireRoot`, so it would happen on nearly every request.
    //
    // The edit has to be to a file the bundle *contains*: `cpSync` does not
    // delete extras, so a new file of one's own survives a re-copy and would
    // make this test pass while the reversion still happened.
    const kit = JSON.parse(readFileSync(kitJson, 'utf8'))
    kit.description = 'edited by the assistant working in this workshop'
    writeFileSync(kitJson, `${JSON.stringify(kit, null, 2)}\n`)

    agentsHomeService.ensureHome(USER)
    agentsHomeService.ensureHome(USER)
    agentsHomeService.listRoots(USER)

    expect(JSON.parse(readFileSync(kitJson, 'utf8')).description).toBe(
      'edited by the assistant working in this workshop'
    )
  })

  it('reinstalls when the workshop copy is older', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    const kitJson = join(home, '.cinna-kit', 'kit.json')
    const kit = JSON.parse(readFileSync(kitJson, 'utf8'))
    kit.contract_version = '0.9.0'
    writeFileSync(kitJson, JSON.stringify(kit, null, 2))

    clearContractCache()
    agentsHomeService.ensureHome(USER)

    expect(JSON.parse(readFileSync(kitJson, 'utf8')).contract_version).toBe(BUNDLED_CONTRACT)
  })
})

/**
 * The two lookups, and why there are two.
 *
 * `requireRoot`'s "no id means the home" is load-bearing for `create` and every
 * other home-defaulting caller. It is wrong for anything acting on a *named*
 * root, where a missing id is a bug — and the cost of getting that wrong is not
 * symmetric: the git channels run `fetch` and `merge --ff-only` in the
 * directory they resolve, and this feature is the reason a user might have put
 * their agents home under version control in the first place.
 */
describe('requireNamedRoot', () => {
  it('refuses a missing, empty or non-string id instead of defaulting to the home', () => {
    for (const bad of ['', undefined, null, 0, {}]) {
      expect(() => agentsHomeService.requireNamedRoot(USER, bad)).toThrow(/no agents folder/i)
    }
  })

  it('never creates the agents home as a side effect of being asked', () => {
    // `requireRoot('')` reaches `ensureHome`, which *scaffolds* the directory.
    // A settings screen rendering a git panel would then create
    // `~/Documents/CinnaAgents` on a machine where the user deliberately had
    // none — a write caused by a question.
    const home = join(sandbox, 'never-created')
    appSettingsRepo.set('localAgentsHome', home)
    expect(() => agentsHomeService.requireNamedRoot(USER, '')).toThrow()
    expect(existsSync(home)).toBe(false)
  })

  it('resolves a real root the same way requireRoot does', () => {
    const workshop = mkdtempSync(join(tmpdir(), 'cinna-named-root-'))
    try {
      scaffoldService.installRootTemplates(workshop)
      const added = agentsHomeService.addRoot(USER, workshop)
      expect(agentsHomeService.requireNamedRoot(USER, added.id).path).toBe(workshop)
    } finally {
      rmSync(workshop, { recursive: true, force: true })
    }
  })

  it('still refuses an id that names nothing', () => {
    expect(() => agentsHomeService.requireNamedRoot(USER, 'not-a-root')).toThrow(/not registered/i)
  })
})
