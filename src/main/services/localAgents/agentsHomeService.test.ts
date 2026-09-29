vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  join(repoRoot, 'resources/cinna-agent-kit/CONTRACT_VERSION'),
  'utf8'
).trim()
/** The kit hash this build bundles — what an up-to-date workshop carries. */
const BUNDLED_KIT = readFileSync(join(repoRoot, 'resources/cinna-agent-kit/VERSION'), 'utf8').trim()
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
/** When set, the workshop swap's second rename fails, as a cross-device move would. */
const swapFault = vi.hoisted(() => ({ failInstall: false }))

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
vi.mock('../../kit/treeSwap', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../kit/treeSwap')>()
  const { renameSync: rename } = await import('node:fs')
  return {
    swapInto: (staging: string, target: string) =>
      real.swapInto(staging, target, (from, to) => {
        if (swapFault.failInstall && from === staging) throw new Error('EXDEV: simulated')
        rename(from, to)
      })
  }
})
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
  swapFault.failInstall = false
  agentsHomeService._resetKitSync()
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

describe('the workshop kit copy', () => {
  const kitPath = (home: string, rel = ''): string => join(home, '.cinna-kit', rel)
  const stagingLeftovers = (home: string): string[] =>
    readdirSync(home).filter((name) => name.startsWith('.cinna-kit.staging-'))
  const setContractVersion = (home: string, version: string): void => {
    const kit = JSON.parse(readFileSync(kitPath(home, 'kit.json'), 'utf8'))
    kit.contract_version = version
    writeFileSync(kitPath(home, 'kit.json'), JSON.stringify(kit, null, 2))
  }

  it('installs the full kit into a fresh workshop', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    for (const rel of ['kit.json', 'layout.json', 'README.md', 'START.md', 'assistants/cinna-desktop.md', 'tools/kit.py']) {
      expect(existsSync(kitPath(home, rel)), rel).toBe(true)
    }
    expect(readdirSync(kitPath(home, 'guides')).length).toBeGreaterThan(0)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8').trim()).toBe(BUNDLED_KIT)
    // The template's `make validate` runs it.
    expect(statSync(kitPath(home, 'tools/kit.py')).mode & 0o111).toBe(0o111)
    expect(existsSync(kitPath(home, '.desktop_install'))).toBe(true)
    expect(existsSync(kitPath(home, '.last_refresh_check'))).toBe(true)
    expect(stagingLeftovers(home)).toEqual([])
  })

  it('upgrades a contract-only copy at the same contract version', () => {
    // The regression: earlier builds installed only the contract, so a
    // workshop at the bundled contract version had no guides, no kit.py and
    // no VERSION — and a contract-version comparison called it up to date.
    const home = join(sandbox, 'workshop')
    setHome(home)
    for (const rel of ['README.md', 'START.md', 'VERSION', 'guides', 'assistants', 'tools', '.desktop_install', '.last_refresh_check']) {
      rmSync(kitPath(home, rel), { recursive: true, force: true })
    }
    expect(JSON.parse(readFileSync(kitPath(home, 'kit.json'), 'utf8')).contract_version).toBe(BUNDLED_CONTRACT)

    clearContractCache()
    agentsHomeService.ensureHome(USER)

    expect(existsSync(kitPath(home, 'tools/kit.py'))).toBe(true)
    expect(existsSync(kitPath(home, 'README.md'))).toBe(true)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8').trim()).toBe(BUNDLED_KIT)
  })

  it('leaves an up-to-date copy alone', () => {
    // `ensureHome` is on the path of `list`, `rescan`, `listRoots`, `create`
    // and `requireRoot`; an install on every call would copy the tree and
    // drop the contract cache on nearly every request. A file the bundle does
    // not have survives only when no swap happened.
    const home = join(sandbox, 'workshop')
    setHome(home)
    writeFileSync(kitPath(home, 'marker.txt'), 'still here')

    agentsHomeService.ensureHome(USER)
    agentsHomeService.listRoots(USER)

    expect(readFileSync(kitPath(home, 'marker.txt'), 'utf8')).toBe('still here')
  })

  it('leaves a strictly newer contract untouched, even in a tree it installed', () => {
    // A refresh pulled it down, and `contractStore` prefers it.
    const home = join(sandbox, 'workshop')
    setHome(home)
    const [major] = BUNDLED_CONTRACT.split('.')
    agentsHomeService._resetKitSync()
    setContractVersion(home, `${major}.999.0`)
    writeFileSync(kitPath(home, 'VERSION'), 'refreshed-kit\n')
    rmSync(kitPath(home, '.last_refresh_check'))
    writeFileSync(kitPath(home, 'marker.txt'), 'mine')

    clearContractCache()
    agentsHomeService.ensureHome(USER)

    expect(readFileSync(kitPath(home, 'marker.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8')).toBe('refreshed-kit\n')
    expect(existsSync(kitPath(home, '.last_refresh_check'))).toBe(false)
  })

  it('marks every tree it installs with the kit version it installed', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    expect(readFileSync(kitPath(home, '.desktop_install'), 'utf8')).toBe(`${BUNDLED_KIT}\n`)
  })

  it('replaces its own tree of another kit hash once per process, never back and forth', () => {
    // Two builds sharing one home bundle different hashes. Each may bring the
    // tree to its own kit once; without the limit they would swap it on
    // every `ensureHome`.
    const home = join(sandbox, 'workshop')
    setHome(home)
    agentsHomeService._resetKitSync() // a new process, e.g. the next launch
    writeFileSync(kitPath(home, 'VERSION'), 'other-build-kit\n')

    agentsHomeService.ensureHome(USER)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8').trim()).toBe(BUNDLED_KIT)

    // The other build puts its kit back while this process is still running.
    writeFileSync(kitPath(home, 'VERSION'), 'other-build-kit\n')
    agentsHomeService.ensureHome(USER)
    agentsHomeService.listRoots(USER)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8')).toBe('other-build-kit\n')
  })

  for (const contract of ['same', 'older'] as const) {
    it(`never touches a complete kit it did not install (${contract} contract), stamp included`, () => {
      // Downloaded by `kit.py refresh` or the CLI, or brought by an adopted
      // workshop — possibly from a self-hosted or newer core. This build's
      // public-cloud render must not undo it, and the app reads its bundled
      // contract whatever this tree says.
      const home = join(sandbox, 'workshop')
      setHome(home)
      agentsHomeService._resetKitSync()
      rmSync(kitPath(home, '.desktop_install'))
      rmSync(kitPath(home, '.last_refresh_check'))
      if (contract === 'older') setContractVersion(home, '0.9.0')
      writeFileSync(kitPath(home, 'VERSION'), 'downloaded-kit\n')
      writeFileSync(kitPath(home, 'guides/99-their-own.md'), 'theirs')

      clearContractCache()
      agentsHomeService.ensureHome(USER)

      expect(readFileSync(kitPath(home, 'VERSION'), 'utf8')).toBe('downloaded-kit\n')
      expect(existsSync(kitPath(home, 'guides/99-their-own.md'))).toBe(true)
      expect(existsSync(kitPath(home, '.desktop_install'))).toBe(false)
      expect(existsSync(kitPath(home, '.last_refresh_check'))).toBe(false)
    })
  }

  it('leaves a newer contract alone even when it lacks what today\'s kit has', () => {
    // A newer core may lay its kit out differently; completeness is judged by
    // this build's layout, so it must not decide over a newer contract.
    const home = join(sandbox, 'workshop')
    setHome(home)
    const [major] = BUNDLED_CONTRACT.split('.')
    agentsHomeService._resetKitSync()
    rmSync(kitPath(home, '.desktop_install'))
    rmSync(kitPath(home, 'guides'), { recursive: true })
    setContractVersion(home, `${major}.999.0`)

    clearContractCache()
    agentsHomeService.ensureHome(USER)

    expect(existsSync(kitPath(home, 'guides'))).toBe(false)
    expect(existsSync(kitPath(home, '.desktop_install'))).toBe(false)
  })

  it('reads the installed contract version as contractStore does, CONTRACT_VERSION included', () => {
    // A `kit.json` without the key is a state kit.py itself tolerates; the
    // tree is still a complete downloaded kit, not a broken one.
    const home = join(sandbox, 'workshop')
    setHome(home)
    agentsHomeService._resetKitSync()
    rmSync(kitPath(home, '.desktop_install'))
    const kit = JSON.parse(readFileSync(kitPath(home, 'kit.json'), 'utf8'))
    delete kit.contract_version
    writeFileSync(kitPath(home, 'kit.json'), JSON.stringify(kit, null, 2))
    writeFileSync(kitPath(home, 'VERSION'), 'downloaded-kit\n')

    clearContractCache()
    agentsHomeService.ensureHome(USER)

    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8')).toBe('downloaded-kit\n')
    expect(existsSync(kitPath(home, '.desktop_install'))).toBe(false)
  })

  for (const missing of ['kit.json', 'VERSION', 'README.md', 'tools/kit.py', 'guides']) {
    it(`repairs a kit it did not install when ${missing} is missing`, () => {
      // Complete is what earns a downloaded kit its hands-off treatment; a
      // tree missing any of these (no `kit.json`: no readable contract
      // version) is not one the builder steps can use.
      const home = join(sandbox, 'workshop')
      setHome(home)
      agentsHomeService._resetKitSync()
      rmSync(kitPath(home, '.desktop_install'))
      rmSync(kitPath(home, missing), { recursive: true })

      clearContractCache()
      agentsHomeService.ensureHome(USER)

      expect(existsSync(kitPath(home, missing))).toBe(true)
      expect(existsSync(kitPath(home, '.desktop_install'))).toBe(true)
    })
  }

  it('replaces the tree wholesale, so a file dropped upstream disappears', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    // An earlier build's install (it carries the marker), met by a new process.
    agentsHomeService._resetKitSync()
    writeFileSync(kitPath(home, 'VERSION'), '0000000000000000\n')
    writeFileSync(kitPath(home, 'guides/99-dropped-upstream.md'), 'stale')
    // What an interrupted earlier install leaves in the root.
    mkdirSync(join(home, '.cinna-kit.staging-abc123', 'guides'), { recursive: true })
    mkdirSync(join(home, '.cinna-kit.staging-def456.previous'))

    agentsHomeService.ensureHome(USER)

    expect(existsSync(kitPath(home, 'guides/99-dropped-upstream.md'))).toBe(false)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8').trim()).toBe(BUNDLED_KIT)
    expect(stagingLeftovers(home)).toEqual([])
  })

  it('keeps the previous tree when an install fails, and leaves no staging behind', () => {
    const home = join(sandbox, 'workshop')
    setHome(home)
    agentsHomeService._resetKitSync()
    writeFileSync(kitPath(home, 'VERSION'), 'old-kit\n')
    writeFileSync(kitPath(home, 'marker.txt'), 'previous tree')

    swapFault.failInstall = true
    expect(() => agentsHomeService.ensureHome(USER)).not.toThrow()

    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8')).toBe('old-kit\n')
    expect(readFileSync(kitPath(home, 'marker.txt'), 'utf8')).toBe('previous tree')
    expect(stagingLeftovers(home)).toEqual([])

    // Not retried in the same process: a folder that refuses the copy would
    // otherwise be copied into on every `ensureHome`.
    swapFault.failInstall = false
    agentsHomeService.ensureHome(USER)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8')).toBe('old-kit\n')

    // The next launch, with the fault gone, installs.
    agentsHomeService._resetKitSync()
    agentsHomeService.ensureHome(USER)
    expect(readFileSync(kitPath(home, 'VERSION'), 'utf8').trim()).toBe(BUNDLED_KIT)
  })

  it('writes the refresh stamp the way kit.py does, and re-touches it only once stale', () => {
    // The root AGENTS.md freshness rule sends an assistant to
    // `kit.py refresh --check` when the stamp is missing or a week old; the
    // desktop owns `.cinna-kit/`, so it keeps the stamp fresh itself.
    const home = join(sandbox, 'workshop')
    setHome(home)
    const stamp = kitPath(home, '.last_refresh_check')
    const written = readFileSync(stamp, 'utf8')
    // `time.strftime("%Y-%m-%dT%H:%M:%S%z") + "\n"`: local time, `+0200`.
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2})(\d{2})\n$/.exec(written)
    expect(match, written).not.toBeNull()
    // Local time and offset agree: read back, it is now.
    const parsed = Date.parse(`${match![1]}${match![2]}:${match![3]}`)
    expect(Math.abs(parsed - Date.now())).toBeLessThan(60_000)

    // Fresh: left alone.
    writeFileSync(stamp, 'fresh\n')
    agentsHomeService.ensureHome(USER)
    expect(readFileSync(stamp, 'utf8')).toBe('fresh\n')

    // Two days old: touched.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stamp, old, old)
    agentsHomeService.ensureHome(USER)
    expect(readFileSync(stamp, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}\n$/)

    // Missing: written.
    rmSync(stamp)
    agentsHomeService.ensureHome(USER)
    expect(existsSync(stamp)).toBe(true)
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
