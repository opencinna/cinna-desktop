import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * The gate in front of the agents home.
 *
 * What is being protected is not a file, it is a *moment*: on macOS the first
 * write into `~/Documents/CinnaAgents` raises the system's Documents-folder
 * prompt, and the app has to have explained the folder before that happens.
 * So the assertions are mostly about what does **not** happen — `ensureHome`
 * creating nothing while the question is outstanding — and about the cases
 * where asking would be wrong: a folder that is not guarded, and an install
 * that has been using the folder for months.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  /** Stands in for `$HOME`, so a "Documents" folder here is a real tmpdir. */
  home: ''
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => holder.home }
})
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

const { appSettingsRepo } = await import('../../db/appSettings')
const { agentRootRepo } = await import('../../db/agentRoots')
const { clearContractCache } = await import('../../kit/contractStore')
const { agentsHomeService } = await import('./agentsHomeService')
const { homeAccessService } = await import('./homeAccessService')
const { isGuardedLocation } = await import('./homePath')
const { LocalAgentError } = await import('../../errors')
const { scannerService } = await import('./scannerService')

const USER = '__default__'

const realPlatform = process.platform

/**
 * Everything the gate does is conditional on macOS, so a suite that ran as
 * itself would assert nothing on the Linux CI — and would pass there for the
 * wrong reason, which is worse than failing. The platform is pinned instead;
 * the "off macOS" case is covered explicitly, through the parameter
 * `isGuardedLocation` takes for exactly this.
 */
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  holder.current = createTestDatabase()
  holder.home = mkdtempSync(join(tmpdir(), 'cinna-home-'))
  clearContractCache()
  scannerService.markAllRootsDirty()
})

afterEach(() => {
  homeAccessService.clearRefusal()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  holder.current?.close()
  holder.current = null
  rmSync(holder.home, { recursive: true, force: true })
})

/** The default home, spelled the way `homePath` spells it. */
function defaultHome(): string {
  return join(holder.home, 'Documents', 'CinnaAgents')
}

describe('which folders macOS guards', () => {
  it('guards the Documents folder and what is under it', () => {
    expect(isGuardedLocation(defaultHome(), 'darwin')).toBe(true)
    expect(isGuardedLocation(join(holder.home, 'Desktop', 'x'), 'darwin')).toBe(true)
    expect(isGuardedLocation(join(holder.home, 'Downloads', 'x'), 'darwin')).toBe(true)
  })

  it('guards the iCloud spelling of Documents as well', () => {
    // What `~/Documents` resolves to on a Mac with Desktop & Documents syncing.
    const iCloud = join(holder.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
    expect(isGuardedLocation(iCloud, 'darwin')).toBe(true)
  })

  it('leaves the rest of the home directory alone', () => {
    // The escape hatch a refused Documents folder leads to: nothing in TCC
    // guards the home directory itself, so this needs no prompt and no modal.
    expect(isGuardedLocation(join(holder.home, 'CinnaAgents'), 'darwin')).toBe(false)
  })

  it('guards nothing off macOS', () => {
    // A modal explaining a permission prompt that is never going to arrive is
    // worse than no modal.
    expect(isGuardedLocation(defaultHome(), 'linux')).toBe(false)
    expect(isGuardedLocation(defaultHome(), 'win32')).toBe(false)
  })
})

describe('the question, before anything is written', () => {
  it('reports the folder and asks first', () => {
    const state = homeAccessService.state(USER)
    expect(state.path).toBe(defaultHome())
    expect(state.guarded).toBe(true)
    expect(state.access).toBe('needs_consent')
  })

  it('answers without touching the disk', () => {
    homeAccessService.state(USER)
    // The whole point. A `stat` inside `~/Documents` to find out whether the
    // folder is there is a read in the folder we have not been let into yet.
    expect(existsSync(join(holder.home, 'Documents'))).toBe(false)
  })

  it('refuses to create the home while the question stands', () => {
    expect(() => agentsHomeService.ensureHome(USER)).toThrow(LocalAgentError)
    try {
      agentsHomeService.ensureHome(USER)
    } catch (err) {
      expect((err as InstanceType<typeof LocalAgentError>).code).toBe('home_consent_required')
    }
    expect(existsSync(defaultHome())).toBe(false)
  })
})

describe('once the user has answered', () => {
  it('creates the folder and stops asking', async () => {
    const state = await agentsHomeService.prepare(USER)
    expect(state.access).toBe('ready')
    expect(existsSync(join(defaultHome(), 'Local'))).toBe(true)
    expect(homeAccessService.state(USER).access).toBe('ready')
    // And the ordinary path works from here on, with no gate in the way.
    expect(agentsHomeService.ensureHome(USER).path).toBe(defaultHome())
  })

  it('asks again when the home is pointed at a different guarded folder', async () => {
    await agentsHomeService.prepare(USER)
    appSettingsRepo.set('localAgentsHome', join(holder.home, 'Desktop', 'Workshop'))
    // A different place is a different thing to say — and a different prompt,
    // since macOS guards Desktop separately from Documents.
    expect(homeAccessService.state(USER).access).toBe('needs_consent')
  })

  it('says nothing about a home that is not guarded', () => {
    appSettingsRepo.set('localAgentsHome', join(holder.home, 'CinnaAgents'))
    const state = homeAccessService.state(USER)
    expect(state.guarded).toBe(false)
    expect(state.access).toBe('ready')
    expect(agentsHomeService.ensureHome(USER).path).toBe(join(holder.home, 'CinnaAgents'))
  })
})

describe('an install that already has the folder', () => {
  it('is not asked about a folder it has been using', () => {
    // The update case: a build from before this gate existed created the home
    // and registered it, which on a guarded path is only possible with the
    // grant already given. Asking now would explain a folder full of the
    // user's own agents.
    mkdirSync(defaultHome(), { recursive: true })
    agentRootRepo.create(USER, { path: defaultHome(), label: 'Agents', isDefault: true })
    expect(homeAccessService.state(USER).access).toBe('ready')
  })

  it('asks again when the row outlived the folder', () => {
    // A database carried to another Mac by Migration Assistant: the row comes
    // with it, the folder and the grant do not. Trusting the row alone would
    // send `ensureHome` into a synchronous `mkdir` in `~/Documents` — the main
    // thread frozen behind a prompt nothing had explained.
    agentRootRepo.create(USER, { path: defaultHome(), label: 'Agents', isDefault: true })
    expect(homeAccessService.state(USER).access).toBe('needs_consent')
  })
})

describe('a refusal, for as long as the process lives', () => {
  it('is what every surface is told, until something succeeds', async () => {
    // Nothing about a refusal is written down — macOS remembers it, and a
    // stored "denied" would outlive the user fixing it in System Settings. So
    // main holds it in memory, and holds it in *one* place: a second answer in
    // the renderer is a second thing to keep in step.
    homeAccessService.noteRefusal(defaultHome())
    expect(homeAccessService.state(USER).access).toBe('denied')
    expect(agentsHomeService.tryEnsureHome(USER)).toBe('denied')
    // And it does not survive the folder actually being made.
    await agentsHomeService.prepare(USER)
    expect(homeAccessService.state(USER).access).toBe('ready')
  })

  it('is forgotten when the home moves somewhere else', () => {
    homeAccessService.noteRefusal(defaultHome())
    appSettingsRepo.set('localAgentsHome', join(holder.home, 'CinnaAgents'))
    // The refusal was about a folder, not about the app. Another folder is a
    // question nobody has answered yet.
    expect(homeAccessService.state(USER).access).toBe('ready')
  })
})

describe('the roots the home is not', () => {
  it('keeps listing an adopted folder while the home question stands', () => {
    // The gate is on the home, not on the list. A user who dismissed the folder
    // question and then adopted their own workshop watched it register and
    // never appear — `addRoot` does not go through the gate, so the folder was
    // scaffolded, the row written, and the sidebar still said there were none.
    const workshop = join(holder.home, 'MyWorkshop')
    agentsHomeService.addRoot(USER, workshop)

    expect(homeAccessService.state(USER).access).toBe('needs_consent')
    expect(agentsHomeService.listRoots(USER).map((r) => r.path)).toEqual([workshop])
    expect(existsSync(defaultHome())).toBe(false)
  })
})
