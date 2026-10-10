vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * Team sharing over real folders, a real agent index and real git: what the
 * service decides on top of `gitService` — which account's token a remote
 * may use, what Get refuses before reaching the network, and what Use the
 * team's version leaves on disk and in the index.
 *
 * Only the network-facing edges are fakes: the library listing comes from a
 * mocked `cinnaFetch`, and the token from a mocked `getCinnaAccessToken`
 * whose calls prove whether a token was ever minted. Remotes that must be
 * reached are plain bare repositories (an `external` remote).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const USER = '__default__'
const PROFILE = 'profile-cinna'
const OTHER = 'profile-other'
const HOST = 'https://cinna.test'
const OTHER_HOST = 'https://other.test'
/** Where the HOST instance's git lives — its backend, not the origin the profile signed in through. */
const GIT_HOST = 'https://api.cinna.test'

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const getCinnaAccessToken = vi.hoisted(() => vi.fn(async () => 'tok-secret'))
const publishEvent = vi.hoisted(() => vi.fn())
/** Every git child is an `execFile`; counting them proves a read spawned none. */
const spawned = vi.hoisted(() => ({ count: 0 }))
const manifestWrite = vi.hoisted(() => ({ fail: false }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((...args: Parameters<typeof real.execFile>) => {
    spawned.count += 1
    return real.execFile(...args)
  }) as typeof real.execFile
  return { ...real, default: { ...real, execFile }, execFile }
})
vi.mock('../../kit/manifestIo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../kit/manifestIo')>()
  return {
    ...real,
    writeManifest: (...args: Parameters<typeof real.writeManifest>) => {
      if (manifestWrite.fail) throw new Error('EIO: the disk said no')
      return real.writeManifest(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: () => {}, trashItem: async () => {}, openPath: async () => '' },
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
vi.mock('../../shell/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell/env')>()),
  getShellEnv: async () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
  shellEnvForChild: (env: NodeJS.ProcessEnv) =>
    Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')),
  usableTool: async () => 'git'
}))
vi.mock('../../auth/scope', () => ({
  DEFAULT_SCOPE_USER_ID: '__default__',
  getSettingsScopeUserId: () => USER,
  getProfileScopeUserId: () => PROFILE,
  getAgentLookupScope: () => [USER, PROFILE],
  getManagedResourceScopes: () => [USER, PROFILE]
}))
vi.mock('../cinna-http', () => ({ cinnaFetch }))
vi.mock('../../auth/cinna-tokens', () => ({ getCinnaAccessToken, getStoredCinnaSubject: () => 'u1' }))
vi.mock('../../host/events', () => ({ publishEvent, installEventPublisher: () => {} }))

const { agentRepo } = await import('../../db/agents')
const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { userRepo } = await import('../../db/users')
const { clearContractCache } = await import('../../kit/contractStore')
const { manifestPath, readManifest } = await import('../../kit/manifestIo')
const { validateAgentFolder } = await import('../../kit/validator')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { turnLock } = await import('./turnLock')
const { libraryService } = await import('../libraryService')
const { sharingService, commitIdentity, parseRemote, fromCoreGrants, toCoreGrants } = await import('./sharingService')
const { desktopStateService } = await import('./desktopStateService')
const { gitService } = await import('./gitService')
const { libraryTrust, acceptableGitOrigin } = await import('../libraryTrust')
const { CinnaApiError } = await import('../../errors')
const { folderAgentId } = await import('../../../shared/localAgents')
const { CinnaReauthRequired } = await import('../../auth/cinna-oauth')
const { serviceCredentialService } = await import('../serviceCredentials/service')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Teammate',
  GIT_AUTHOR_EMAIL: 'teammate@example.test',
  GIT_COMMITTER_NAME: 'Teammate',
  GIT_COMMITTER_EMAIL: 'teammate@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })

let workshop: string
let agentDir: string
let agentId: string
let rootId = ""

/** A library listing as core sends it. */
function listed(...agents: Array<Record<string, unknown>>): void {
  cinnaFetch.mockResolvedValue({ agents, mirrors: [] })
}

function libraryAgent(repoId: string, slug: string, manifestId: string | null): Record<string, unknown> {
  return {
    repo_id: repoId,
    slug,
    name: slug,
    description: `${slug} agent`,
    clone_url: `${HOST}/git/${repoId}.git`,
    default_branch: 'main',
    head_sha: 'a'.repeat(40),
    updated_at: '2026-10-09T10:00:00Z',
    access: 'write',
    maintainers: [{ user_id: 'u1', display_name: 'Ann' }],
    manifest: manifestId ? { id: manifestId, name: slug, runtime: { engine: 'claude' } } : {}
  }
}

/** Make the agent its own repository with `origin` = `url`, one version recorded. */
function makeOwnRepo(url: string): void {
  git(agentDir, 'init', '-q', '-b', 'main', '.')
  git(agentDir, 'remote', 'add', 'origin', url)
  git(agentDir, 'add', '-A')
  git(agentDir, 'commit', '-q', '-m', 'first')
}

beforeEach(async () => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  turnLock.releaseAll()
  libraryService._reset()
  cinnaFetch.mockReset()
  getCinnaAccessToken.mockClear()
  libraryTrust._reset(join(mkdtempSync(join(tmpdir(), 'cinna-trust-')), 'trust.json'))
  publishEvent.mockClear()
  manifestWrite.fail = false
  workshop = mkdtempSync(join(tmpdir(), 'cinna-sharing-'))
  appSettingsRepo.set('localAgentsHome', workshop)
  scaffoldService.installRootTemplates(workshop)
  const root = agentRootRepo.create(USER, { path: workshop, label: 'Agents', isDefault: true })
  rootId = root.id
  agentDir = scaffoldService.scaffoldAgent({
    rootPath: workshop,
    slug: 'alpha',
    name: 'Alpha',
    description: 'Watches the alpha feed.'
  }).agentDir
  agentId = scannerService.scanRoot(USER, root).agents[0].id
  userRepo.insert({
    id: PROFILE,
    type: 'cinna_user',
    username: 'ann@example.test',
    displayName: 'Ann',
    cinnaServerUrl: HOST
  })
  userRepo.insert({
    id: OTHER,
    type: 'cinna_user',
    username: 'ann@other.test',
    displayName: 'Ann elsewhere',
    cinnaServerUrl: OTHER_HOST
  })
})

afterEach(() => {
  turnLock.releaseAll()
  libraryService._reset()
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

describe('credentials after the team\'s files arrive', () => {
  it('Update that brings changes attaches matching credentials and reports a missing one', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    const mate = join(workshop, '.mate')
    git(workshop, 'clone', '-q', team, mate)
    const manifest = JSON.parse(readFileSync(join(mate, 'cinna-agent.json'), 'utf8'))
    manifest.credentials = [{ name: 'weather', type: 'api_token', env_prefix: 'WEATHER_', fields: ['api_key'] }]
    writeFileSync(join(mate, 'cinna-agent.json'), JSON.stringify(manifest, null, 2))
    git(mate, 'commit', '-q', '-am', 'needs weather')
    git(mate, 'push', '-q')

    const autoAttach = vi.spyOn(serviceCredentialService, 'autoAttach').mockResolvedValue([{ slot: 'acme', credentialName: 'Acme API' }])
    try {
      const result = await sharingService.update(USER, agentId)
      expect(result.done).toBe(true)
      expect(autoAttach).toHaveBeenCalledWith(agentId)
      expect(result.autoAttached).toEqual([{ slot: 'acme', credentialName: 'Acme API' }])
      expect(result.setupNeeded).toBe(true)

      // Nothing new from the team: no credential work, nothing to finish.
      autoAttach.mockClear()
      const again = await sharingService.update(USER, agentId)
      expect(again.done).toBe(false)
      expect(autoAttach).not.toHaveBeenCalled()
      expect(again).toMatchObject({ autoAttached: [], setupNeeded: false })
    } finally {
      autoAttach.mockRestore()
    }
  }, 60_000)

  it('a later Update reopens Finish setup only when a required slot that was filled or absent is now missing', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    const mate = join(workshop, '.mate')
    git(workshop, 'clone', '-q', team, mate)
    const teamPushes = (slots: string[], note: string): void => {
      const manifest = JSON.parse(readFileSync(join(mate, 'cinna-agent.json'), 'utf8'))
      manifest.credentials = slots.map((name) => ({ name, type: 'api_token', env_prefix: `${name.toUpperCase()}_`, fields: ['api_key'] }))
      writeFileSync(join(mate, 'cinna-agent.json'), JSON.stringify(manifest, null, 2))
      writeFileSync(join(mate, 'notes.md'), note)
      git(mate, 'add', '-A')
      git(mate, 'commit', '-q', '-m', note)
      git(mate, 'push', '-q')
    }

    teamPushes(['weather'], 'one\n')
    expect((await sharingService.update(USER, agentId)).setupNeeded).toBe(true)

    // The user chose Finish later: the same slot still missing asks nothing.
    teamPushes(['weather'], 'two\n')
    const same = await sharingService.update(USER, agentId)
    expect(same.done).toBe(true)
    expect(same.setupNeeded).toBe(false)

    // A slot the team just added is missing too: the set grew.
    teamPushes(['weather', 'maps'], 'three\n')
    expect((await sharingService.update(USER, agentId)).setupNeeded).toBe(true)

    // Filling one and losing nothing new stays quiet even though one is still missing.
    writeFileSync(join(agentDir, 'credentials', '.env'), 'MAPS_API_KEY=x\n')
    teamPushes(['weather', 'maps'], 'four\n')
    expect((await sharingService.update(USER, agentId)).setupNeeded).toBe(false)
  }, 60_000)

  it('Update with no signed-in account attaches nothing and still lands', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    const mate = join(workshop, '.mate')
    git(workshop, 'clone', '-q', team, mate)
    writeFileSync(join(mate, 'notes.md'), 'From the team.\n')
    git(mate, 'add', 'notes.md')
    git(mate, 'commit', '-q', '-m', 'notes')
    git(mate, 'push', '-q')
    // No account is active here, so the real service has nothing to attach and says so.
    const result = await sharingService.update(USER, agentId)
    expect(result).toMatchObject({ done: true, autoAttached: [], setupNeeded: false })
  }, 60_000)
})

describe('use the team version', () => {
  it('puts the team version at the original path and keeps this one as a fresh, unshared copy', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    writeFileSync(join(agentDir, 'notes.md'), 'Line one.\n')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    const originalManifestId = readManifest(manifestPath(agentDir)).id

    // A teammate and this machine rewrite the same line.
    const mate = join(workshop, '.mate')
    git(workshop, 'clone', '-q', team, mate)
    writeFileSync(join(mate, 'notes.md'), 'Line one, by the team.\n')
    git(mate, 'commit', '-q', '-am', 'team edit')
    git(mate, 'push', '-q')
    writeFileSync(join(agentDir, 'notes.md'), 'Line one, by me.\n')
    git(agentDir, 'commit', '-q', '-am', 'my edit')
    // This machine's own files, which no clone brings.
    mkdirSync(join(agentDir, 'credentials'), { recursive: true })
    writeFileSync(join(agentDir, 'credentials', '.env'), 'API_KEY=mine\n')
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(join(agentDir, 'app-data', 'desktop.json'), '{"enabled":true}\n')
    mkdirSync(join(agentDir, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(agentDir, '.venv', 'bin', 'python'), '')

    const autoAttach = vi.spyOn(serviceCredentialService, 'autoAttach')
    const update = await sharingService.update(USER, agentId)
    expect(update.refusal).toBe('diverged_conflict')
    expect(update.status?.state).toBe('diverged')
    expect(autoAttach).not.toHaveBeenCalled()

    const result = await sharingService.useTeamVersion(USER, agentId)
    // The team's version keeps the id; that is the agent whose slots are checked.
    expect(autoAttach).toHaveBeenCalledWith(agentId)
    autoAttach.mockRestore()
    expect(result).toMatchObject({ autoAttached: [], setupNeeded: false })
    expect(result.done).toBe(true)
    expect(result.refusal).toBeNull()
    expect(result.detail).toBeNull()

    const mine = join(workshop, 'Local', 'alpha-mine')
    const copyManifestId = readManifest(manifestPath(mine)).id
    expect(copyManifestId).not.toBe(originalManifestId)
    expect(result.agentId).toBe(folderAgentId(copyManifestId!))
    // The copy is nobody's team agent, and still holds this machine's work.
    expect(() => git(mine, 'config', '--get', 'remote.origin.url')).toThrow()
    expect(readFileSync(join(mine, 'notes.md'), 'utf8')).toBe('Line one, by me.\n')

    // The original path — and the original id — are the team's version now.
    expect(readFileSync(join(agentDir, 'notes.md'), 'utf8')).toBe('Line one, by the team.\n')
    expect(readManifest(manifestPath(agentDir)).id).toBe(originalManifestId)
    // …with this machine's per-machine files copied in (not moved), but no
    // rebuildable environment.
    expect(readFileSync(join(agentDir, 'credentials', '.env'), 'utf8')).toBe('API_KEY=mine\n')
    expect(readFileSync(join(agentDir, 'app-data', 'desktop.json'), 'utf8')).toBe('{"enabled":true}\n')
    expect(existsSync(join(agentDir, '.venv'))).toBe(false)
    expect(readFileSync(join(mine, 'credentials', '.env'), 'utf8')).toBe('API_KEY=mine\n')
    expect(existsSync(join(mine, 'app-data', 'desktop.json'))).toBe(true)
    // The two are told apart by name.
    expect(readManifest(manifestPath(mine)).name).toBe(`${readManifest(manifestPath(agentDir)).name} (my copy)`)
    // The copy's slug is its folder's name, so it validates — the team's
    // slug would fail `manifest.slug.folder_mismatch` and put two agents
    // under one slug.
    expect(readManifest(manifestPath(mine)).slug).toBe('alpha-mine')
    const contractVersion = readManifest(manifestPath(mine)).contract_version as string
    expect(validateAgentFolder(mine, { contractVersion }).errors).toEqual([])
    expect(agentRepo.getOwned(USER, agentId)?.localPath).toBe(agentDir)
    expect(agentRepo.getOwned(USER, result.agentId!)?.localPath).toBe(mine)
    expect(result.status?.state).toBe('up_to_date')
    expect(publishEvent).toHaveBeenCalledWith('sharing:changed')
  }, 60_000)

  it('names the per-machine files that could not be copied into the team version', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    mkdirSync(join(agentDir, 'credentials'), { recursive: true })
    const secret = join(agentDir, 'credentials', '.env')
    writeFileSync(secret, 'API_KEY=mine\n')
    chmodSync(secret, 0o000)
    try {
      const result = await sharingService.useTeamVersion(USER, agentId)
      expect(result.done).toBe(true)
      expect(result.detail).toContain('credentials/.env')
    } finally {
      chmodSync(join(workshop, 'Local', 'alpha-mine', 'credentials', '.env'), 0o600)
    }
  }, 60_000)

  it('refuses while a turn holds the agent, and moves nothing', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      expect((await sharingService.useTeamVersion(USER, agentId)).refusal).toBe('turn_in_progress')
    } finally {
      handle.release()
    }
    expect(existsSync(join(workshop, 'Local', 'alpha-mine'))).toBe(false)
  }, 60_000)
})

describe('use the team version — Finish setup', () => {
  /** A diverged folder whose shared first version needs `weather`; the team's side ends with `teamSlots`. */
  async function divergeWith(teamSlots: string[]): Promise<void> {
    const slot = (name: string) => ({ name, type: 'api_token', env_prefix: `${name.toUpperCase()}_`, fields: ['api_key'] })
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    const manifest = JSON.parse(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8'))
    manifest.credentials = [slot('weather')]
    writeFileSync(join(agentDir, 'cinna-agent.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(join(agentDir, 'notes.md'), 'Line one.\n')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    const mate = join(workshop, '.mate')
    git(workshop, 'clone', '-q', team, mate)
    const theirs = JSON.parse(readFileSync(join(mate, 'cinna-agent.json'), 'utf8'))
    theirs.credentials = teamSlots.map(slot)
    writeFileSync(join(mate, 'cinna-agent.json'), JSON.stringify(theirs, null, 2))
    writeFileSync(join(mate, 'notes.md'), 'Line one, by the team.\n')
    git(mate, 'commit', '-q', '-am', 'team edit')
    git(mate, 'push', '-q')
    writeFileSync(join(agentDir, 'notes.md'), 'Line one, by me.\n')
    git(agentDir, 'commit', '-q', '-am', 'my edit')
    scannerService.markAllRootsDirty()
    expect((await sharingService.update(USER, agentId)).refusal).toBe('diverged_conflict')
  }

  it('stays closed when the team’s version is missing only what this folder already was', async () => {
    await divergeWith(['weather'])
    const result = await sharingService.useTeamVersion(USER, agentId)
    expect(result.done).toBe(true)
    expect(result.setupNeeded).toBe(false)
  }, 60_000)

  it('opens when the team’s version brings a required slot this folder did not miss', async () => {
    await divergeWith(['weather', 'maps'])
    const result = await sharingService.useTeamVersion(USER, agentId)
    expect(result.done).toBe(true)
    expect(result.setupNeeded).toBe(true)
  }, 60_000)
})

describe('use the team version, when something fails part-way', () => {
  it('asks for re-auth with the folder where it was when the session has expired', async () => {
    makeOwnRepo(`${HOST}/git/r1.git`)
    const originalId = readManifest(manifestPath(agentDir)).id
    getCinnaAccessToken.mockRejectedValueOnce(new CinnaReauthRequired())
    await expect(sharingService.useTeamVersion(USER, agentId)).rejects.toBeInstanceOf(CinnaReauthRequired)
    expect(readManifest(manifestPath(agentDir)).id).toBe(originalId)
    expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/r1.git`)
    expect(existsSync(join(workshop, 'Local', 'alpha-mine'))).toBe(false)
    // The lock went with it.
    expect(turnLock.acquire(agentId, 'turn').release).toBeTypeOf('function')
  }, 60_000)

  it('puts the folder back whole when the copy cannot be given its own id, never leaving two with one id', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(agentDir, 'mine.md'), 'only here\n')
    const originalId = readManifest(manifestPath(agentDir)).id
    manifestWrite.fail = true

    const result = await sharingService.useTeamVersion(USER, agentId)
    expect(result.done).toBe(false)
    expect(result.refusal).toBe('failed')
    expect(result.detail).toContain('the disk said no')

    expect(readdirSync(join(workshop, 'Local'))).toEqual(['alpha'])
    expect(readManifest(manifestPath(agentDir)).id).toBe(originalId)
    expect(readFileSync(join(agentDir, 'mine.md'), 'utf8')).toBe('only here\n')
    expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(team)
    expect(agentRepo.getOwned(USER, agentId)?.localPath).toBe(agentDir)
  }, 60_000)
})

describe('share changes', () => {
  it('refuses while a turn holds the agent, and records nothing', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(agentDir, 'notes.md'), 'not yet\n')
    const head = git(agentDir, 'rev-parse', 'HEAD').trim()
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      const result = await sharingService.shareChanges(USER, agentId, 'notes')
      expect(result.refusal).toBe('turn_in_progress')
      expect(result.status?.state).toBe('unshared')
    } finally {
      handle.release()
    }
    expect(git(agentDir, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(agentDir, 'ls-files', 'notes.md').trim()).toBe('')
    // And with the turn over, it goes through — as the profile, not this machine's user.
    expect((await sharingService.shareChanges(USER, agentId, 'notes')).done).toBe(true)
    expect(git(agentDir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Ann <ann@example.test>')
  }, 60_000)
})

describe('commit identity', () => {
  it('is the Cinna profile\'s name and email, else a no-reply address, never the machine\'s user', () => {
    expect(commitIdentity({ kind: 'cinna', host: HOST })).toEqual({ name: 'Ann', email: 'ann@example.test' })
    holder.current!.sqlite.prepare('UPDATE users SET username = ? WHERE id = ?').run('ann', PROFILE)
    expect(commitIdentity({ kind: 'cinna', host: HOST })).toEqual({
      name: 'Ann',
      email: `${PROFILE}@users.noreply.cinna.test`
    })
    expect(commitIdentity({ kind: 'external', host: null })).toEqual({
      name: 'Ann',
      email: 'cinna-desktop@users.noreply.invalid'
    })
    holder.current!.sqlite.prepare('DELETE FROM users WHERE id = ?').run(PROFILE)
    expect(commitIdentity(null)).toEqual({ name: 'Cinna Desktop user', email: 'cinna-desktop@users.noreply.invalid' })
  })
})

describe('get', () => {
  it('refuses a slug that is already a folder here, naming the agent, before any network', async () => {
    listed(libraryAgent('r1', 'alpha', 'some-other-id'))
    const result = await sharingService.get(USER, 'r1')
    expect(result.refusal).toBe('exists')
    expect(result.detail).toBe('Alpha')
    expect(getCinnaAccessToken).not.toHaveBeenCalled()
  }, 30_000)

  it('refuses a manifest id that is already here under another folder name', async () => {
    const manifestId = readManifest(manifestPath(agentDir)).id!
    listed(libraryAgent('r2', 'beta', manifestId))
    const result = await sharingService.get(USER, 'r2')
    expect(result.refusal).toBe('exists')
    expect(result.detail).toBe('Alpha')
    expect(existsSync(join(workshop, 'Local', 'beta'))).toBe(false)
    expect(getCinnaAccessToken).not.toHaveBeenCalled()
  }, 30_000)

  it('answers not_in_library for a repository the library no longer lists', async () => {
    listed(libraryAgent('r1', 'gamma', null))
    expect((await sharingService.get(USER, 'gone')).refusal).toBe('not_in_library')
  }, 30_000)

  it('refuses a listing whose address is not a web one, so the token never goes there', async () => {
    listed({ ...libraryAgent('r5', 'delta', null), clone_url: 'file:///tmp/r5.git' })
    const result = await sharingService.get(USER, 'r5')
    expect(result.refusal).toBe('failed')
    expect(getCinnaAccessToken).not.toHaveBeenCalled()
  }, 30_000)

  it('clones from the git origin the instance names, scoping the token to it, and records the instance', async () => {
    // cinna-core builds clone_url from its backend address; the profile signed
    // in through the web app's origin. Both are the same instance.
    listed({ ...libraryAgent('r6', 'delta', null), clone_url: `${GIT_HOST}/git/r6.git` })
    const clone = vi.spyOn(gitService, 'clone').mockImplementation(async (_url, target) => {
      mkdirSync(target, { recursive: true })
      git(target, 'init', '-q', '-b', 'main', '.')
      writeFileSync(join(target, 'cinna-agent.json'), JSON.stringify({ id: 'delta-id', name: 'Delta' }))
      return { done: true, refusal: null, detail: null }
    })
    try {
      await sharingService.get(USER, 'r6')
      expect(clone).toHaveBeenCalledTimes(1)
      const [url, , auth] = clone.mock.calls[0]
      expect(url).toBe(`${GIT_HOST}/git/r6.git`)
      expect(auth).toMatchObject({ kind: 'cinna', origin: GIT_HOST })
      expect(git(join(workshop, 'Local', 'delta'), 'config', '--get', 'cinna.server').trim()).toBe(HOST)
    } finally {
      clone.mockRestore()
    }
  }, 30_000)
})

describe('an instance whose git is on another origin', () => {
  it('is the instance\'s from launch, before any listing, once that instance has named the origin', async () => {
    // An earlier session's listing (persisted by libraryTrust) named GIT_HOST.
    libraryTrust.learn(HOST, `${GIT_HOST}/git/r0.git`)
    makeOwnRepo(`${GIT_HOST}/git/r7.git`)
    git(agentDir, 'config', 'cinna.server', HOST)
    const status = await sharingService.status(USER, agentId, false)
    expect(status?.remote).toMatchObject({ kind: 'cinna', repoId: 'r7', host: HOST })
    expect(status?.state).not.toBe('other_account')
  }, 30_000)

  it('never sends the token to an origin only the folder\'s own config vouches for', async () => {
    // What an agent running in the folder could write: its instance, and a remote elsewhere.
    makeOwnRepo('https://evil.test/git/r7.git')
    git(agentDir, 'config', 'cinna.server', HOST)
    const status = await sharingService.status(USER, agentId, false)
    expect(status?.remote.kind).toBe('external')
    await sharingService.update(USER, agentId)
    await sharingService.shareChanges(USER, agentId, 'x')
    expect(getCinnaAccessToken).not.toHaveBeenCalled()
  }, 60_000)

  it('sends a token over plain http only for an http instance or this machine', () => {
    expect(acceptableGitOrigin('https://cinna.test', 'http://api.cinna.test/git/r.git')).toBeNull()
    expect(acceptableGitOrigin('https://cinna.test', 'https://api.cinna.test/git/r.git')).toBe('https://api.cinna.test')
    expect(acceptableGitOrigin('http://localhost:5173', 'http://localhost:8000/git/r.git')).toBe('http://localhost:8000')
    expect(acceptableGitOrigin('https://cinna.test', 'http://127.0.0.1:8000/git/r.git')).toBe('http://127.0.0.1:8000')
    expect(acceptableGitOrigin('https://cinna.test', 'file:///tmp/r.git')).toBeNull()
  })

  it('is learned from the instance\'s own listing for a folder that recorded nothing', async () => {
    makeOwnRepo(`${GIT_HOST}/git/r8.git`)
    expect((await sharingService.status(USER, agentId, false))?.remote.kind).toBe('external')
    listed({ ...libraryAgent('r8', 'alpha', null), clone_url: `${GIT_HOST}/git/r8.git` })
    await sharingService.library(USER, true)
    expect((await sharingService.status(USER, agentId, false))?.remote).toMatchObject({ kind: 'cinna', host: HOST })
  }, 30_000)

  it('stays external when no instance on this machine named that origin', () => {
    expect(parseRemote(`${GIT_HOST}/git/r9.git`, new Set([HOST])).kind).toBe('external')
    expect(parseRemote(`${GIT_HOST}/git/r9.git`, new Set([HOST]), 'https://unknown.test').kind).toBe('external')
  })
})

describe('which account a remote belongs to', () => {
  it('says other_account for a remote on an instance the active profile is not signed in to, and mints nothing', async () => {
    makeOwnRepo(`${OTHER_HOST}/git/r9.git`)
    const status = await sharingService.status(USER, agentId, true)
    expect(status?.state).toBe('other_account')
    expect(status?.remote).toMatchObject({ kind: 'cinna', repoId: 'r9', host: OTHER_HOST })
    expect(status?.fetched).toBe(false)

    expect((await sharingService.update(USER, agentId)).refusal).toBe('other_account')
    expect((await sharingService.shareChanges(USER, agentId, 'x')).refusal).toBe('other_account')
    expect(getCinnaAccessToken).not.toHaveBeenCalled()
  }, 30_000)

  it('says removed when the loaded listing for its host no longer carries it', async () => {
    makeOwnRepo(`${HOST}/git/r7.git`)
    listed(libraryAgent('r1', 'other', null))
    await libraryService.refresh(PROFILE)
    const status = await sharingService.status(USER, agentId, false)
    expect(status?.remote).toMatchObject({ kind: 'cinna', repoId: 'r7', host: HOST })
    expect(status?.state).toBe('removed')
  }, 30_000)

  it('never says removed from a listing the instance refused (403), which is no answer about the entry', async () => {
    makeOwnRepo(`${HOST}/git/r7.git`)
    cinnaFetch.mockRejectedValue(new CinnaApiError('request_failed', 'Cinna API 403', 'Forbidden', 403))
    await libraryService.refresh(PROFILE)
    const status = await sharingService.status(USER, agentId, false)
    expect(status?.remote).toMatchObject({ kind: 'cinna', repoId: 'r7', host: HOST })
    expect(status?.state).not.toBe('removed')
  }, 30_000)

  it('reads a remote on no known instance as external, and a folder without one as not shared', async () => {
    expect(await sharingService.status(USER, agentId, false)).toBeNull()
    makeOwnRepo('https://github.com/acme/alpha.git')
    const status = await sharingService.status(USER, agentId, false)
    expect(status?.remote).toMatchObject({ kind: 'external', repoId: null, host: null })
    expect((await sharingService.statuses(USER)).map((s) => s.agentId)).toEqual([agentId])
  }, 30_000)

  it('lists a team change in the Inbox when the listing is past this folder', async () => {
    makeOwnRepo(`${HOST}/git/r1.git`)
    listed({ ...libraryAgent('r1', 'alpha', null), pushed_by: { display_name: 'Bob' } })
    await libraryService.refresh(PROFILE)
    expect(await sharingService.teamChanges(USER)).toEqual([
      expect.objectContaining({ kind: 'team_changed', agentId, agentName: 'Alpha', repoId: 'r1', changedBy: 'Bob' })
    ])
    void rootId
  }, 30_000)

  it('answers a repeat Inbox read without running git while nothing changed, and reads again when the folder moves', async () => {
    makeOwnRepo(`${HOST}/git/r1.git`)
    listed({ ...libraryAgent('r1', 'alpha', null), pushed_by: { display_name: 'Bob' } })
    await libraryService.refresh(PROFILE)
    const first = await sharingService.teamChanges(USER)
    expect(first).toHaveLength(1)

    spawned.count = 0
    expect(await sharingService.teamChanges(USER)).toEqual(first)
    expect(spawned.count).toBe(0)

    // A new local version moves HEAD's ref, so the answer is derived again.
    writeFileSync(join(agentDir, 'notes.md'), 'x\n')
    git(agentDir, 'add', '-A')
    git(agentDir, 'commit', '-q', '-m', 'second')
    spawned.count = 0
    expect(await sharingService.teamChanges(USER)).toHaveLength(1)
    expect(spawned.count).toBeGreaterThan(0)
  }, 30_000)
})

describe('overlapping library refreshes', () => {
  /** Two listings in flight at once, answered in the order the test says. */
  function inFlight(): Array<(body: unknown) => void> {
    const answers: Array<(body: unknown) => void> = []
    cinnaFetch.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    return answers
  }
  const repoIds = (listing: { agents: Array<{ repoId: string }> } | null): string[] =>
    (listing?.agents ?? []).map((agent) => agent.repoId)

  it('an older answer landing late neither overwrites the newer cache nor publishes again', async () => {
    const answers = inFlight()
    const older = libraryService.refresh(PROFILE)
    // e.g. `library(true)` after another machine shared r2.
    const newer = libraryService.refresh(PROFILE)
    answers[1]({ agents: [libraryAgent('r1', 'alpha', null), libraryAgent('r2', 'beta', null)], mirrors: [] })
    expect(repoIds(await newer)).toEqual(['r1', 'r2'])
    expect(publishEvent).toHaveBeenCalledTimes(1)

    answers[0]({ agents: [libraryAgent('r1', 'alpha', null)], mirrors: [] })
    // The late caller gets the newer listing: still no older than its own start.
    expect(repoIds(await older)).toEqual(['r1', 'r2'])
    expect(repoIds(libraryService.cached(PROFILE))).toEqual(['r1', 'r2'])
    expect(publishEvent).toHaveBeenCalledTimes(1)
  })

  it('a refresh that starts after another is never handed the earlier one’s answer', async () => {
    const answers = inFlight()
    const older = libraryService.refresh(PROFILE)
    const newer = libraryService.refresh(PROFILE)
    answers[0]({ agents: [libraryAgent('r1', 'alpha', null)], mirrors: [] })
    expect(repoIds(await older)).toEqual(['r1'])
    answers[1]({ agents: [libraryAgent('r1', 'alpha', null), libraryAgent('r2', 'beta', null)], mirrors: [] })
    expect(repoIds(await newer)).toEqual(['r1', 'r2'])
    expect(repoIds(libraryService.cached(PROFILE))).toEqual(['r1', 'r2'])
    expect(publishEvent).toHaveBeenCalledTimes(2)
  })

  it('a later refresh that throws does not make an earlier one’s answer look stale', async () => {
    cinnaFetch.mockResolvedValueOnce({ agents: [], mirrors: [] })
    await libraryService.refresh(PROFILE)
    publishEvent.mockClear()
    const answers: Array<(body: unknown) => void> = []
    cinnaFetch.mockImplementationOnce(() => new Promise((resolve) => answers.push(resolve)))
    cinnaFetch.mockImplementationOnce(async () => {
      throw new CinnaApiError('request_failed', 'Cinna API 500', 'Server Error', 500)
    })
    const older = libraryService.refresh(PROFILE)
    await expect(libraryService.refresh(PROFILE)).rejects.toThrow()
    answers[0]({ agents: [libraryAgent('r1', 'alpha', null)], mirrors: [] })
    expect(repoIds(await older)).toEqual(['r1'])
    expect(repoIds(libraryService.cached(PROFILE))).toEqual(['r1'])
    expect(publishEvent).toHaveBeenCalledTimes(1)
  })
})

describe('share with the team', () => {
  it('starts over on a folder whose team version the library no longer has, and links the new one', async () => {
    makeOwnRepo(`${HOST}/git/gone.git`)
    git(agentDir, 'config', 'cinna.server', HOST)
    const fresh = { ...libraryAgent('r20', 'alpha', null), head_sha: null, access: 'maintain' }
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'POST') return fresh
      return { agents: [], mirrors: [] }
    })
    const init = vi.spyOn(gitService, 'initWithRemote').mockImplementation(async (dir, url) => {
      git(dir, 'remote', 'add', 'origin', url)
      return { done: true, refusal: null, detail: null }
    })
    try {
      const result = await sharingService.shareWithTeam(USER, agentId, {})
      expect(result.done).toBe(true)
      expect(init).toHaveBeenCalledTimes(1)
      expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/r20.git`)
      const state = JSON.parse(readFileSync(join(agentDir, 'app-data', 'desktop.json'), 'utf8'))
      expect(state.shared_remote).toEqual({ kind: 'cinna', repo_id: 'r20', clone_url: `${HOST}/git/r20.git` })
    } finally {
      init.mockRestore()
    }
  }, 30_000)

  it('does not read a 404 listing as the team version being gone, and keeps the link', async () => {
    makeOwnRepo(`${HOST}/git/r22.git`)
    git(agentDir, 'config', 'cinna.server', HOST)
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'POST') return libraryAgent('r23', 'alpha', null)
      throw new CinnaApiError('request_failed', 'Cinna API 404', 'Not Found', 404)
    })
    const result = await sharingService.shareWithTeam(USER, agentId, {})
    expect(result.refusal).toBe('remote_exists')
    expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/r22.git`)
    expect(cinnaFetch.mock.calls.some((call) => (call[2] as { method?: string } | undefined)?.method === 'POST')).toBe(false)
  }, 30_000)

  it('keeps the old link when creating the new library entry fails', async () => {
    makeOwnRepo(`${HOST}/git/gone.git`)
    git(agentDir, 'config', 'cinna.server', HOST)
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'POST') {
        throw new CinnaApiError('request_failed', 'Cinna API 500', 'The library is down.', 500)
      }
      return { agents: [], mirrors: [] }
    })
    const init = vi.spyOn(gitService, 'initWithRemote')
    try {
      const result = await sharingService.shareWithTeam(USER, agentId, {})
      expect(result.refusal).toBe('failed')
      expect(result.detail).toBe('The library is down.')
      expect(init).not.toHaveBeenCalled()
      expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/gone.git`)
    } finally {
      init.mockRestore()
    }
  }, 30_000)

  it('still refuses a folder whose team version the library has', async () => {
    makeOwnRepo(`${HOST}/git/r21.git`)
    listed(libraryAgent('r21', 'alpha', null))
    const result = await sharingService.shareWithTeam(USER, agentId, {})
    expect(result.refusal).toBe('remote_exists')
    expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/r21.git`)
  }, 30_000)
  it('finishes an entry an earlier attempt created and never sent to, instead of failing on the name', async () => {
    const empty = { ...libraryAgent('r10', 'alpha', null), clone_url: `${GIT_HOST}/git/r10.git`, head_sha: null, access: 'maintain' }
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'POST') {
        throw new CinnaApiError('request_failed', 'Cinna API 409', 'An agent called alpha is already in the team library.', 409)
      }
      return { agents: [empty], mirrors: [] }
    })
    const init = vi.spyOn(gitService, 'initWithRemote').mockResolvedValue({ done: true, refusal: null, detail: null })
    // The earlier attempt on this machine recorded the entry it created.
    libraryTrust.setPending(HOST, 'alpha', 'r10')
    try {
      const result = await sharingService.shareWithTeam(USER, agentId, {})
      expect(result.done).toBe(true)
      expect(init.mock.calls[0][1]).toBe(`${GIT_HOST}/git/r10.git`)
      expect(init.mock.calls[0][2]).toMatchObject({ kind: 'cinna', origin: GIT_HOST })
      expect(libraryTrust.pending(HOST, 'alpha')).toBeNull()
    } finally {
      init.mockRestore()
    }
  }, 30_000)

  it('does not take over an empty entry under the same name that this machine did not create', async () => {
    const empty = { ...libraryAgent('r12', 'alpha', null), head_sha: null, access: 'maintain' }
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'POST') {
        throw new CinnaApiError('request_failed', 'Cinna API 409', 'An agent called alpha is already in the team library.', 409)
      }
      return { agents: [empty], mirrors: [] }
    })
    const result = await sharingService.shareWithTeam(USER, agentId, {})
    expect(result.refusal).toBe('failed')
    expect(existsSync(join(agentDir, '.git'))).toBe(false)
  }, 30_000)

  it('keeps refusing a taken name that already has content', async () => {
    const taken = { ...libraryAgent('r11', 'alpha', null), access: 'maintain' }
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'POST') {
        throw new CinnaApiError('request_failed', 'Cinna API 409', 'An agent called alpha is already in the team library.', 409)
      }
      return { agents: [taken], mirrors: [] }
    })
    const result = await sharingService.shareWithTeam(USER, agentId, {})
    expect(result.refusal).toBe('failed')
    expect(result.detail).toBe('An agent called alpha is already in the team library.')
    expect(existsSync(join(agentDir, '.git'))).toBe(false)
  }, 30_000)

  it('refuses a folder that already records a secret before any library entry is created', async () => {
    git(agentDir, 'init', '-q', '-b', 'main', '.')
    writeFileSync(join(agentDir, '.env'), 'API_KEY=mine\n')
    git(agentDir, 'add', '-f', '.env')
    git(agentDir, 'add', '-A')
    git(agentDir, 'commit', '-q', '-m', 'first')
    listed()
    await sharingService.library(USER, true)
    cinnaFetch.mockClear()

    const result = await sharingService.shareWithTeam(USER, agentId, {})
    expect(result.refusal).toBe('secrets_tracked')
    expect(result.detail).toContain('.env')
    expect(cinnaFetch).not.toHaveBeenCalled()
    expect(() => git(agentDir, 'config', '--get', 'remote.origin.url')).toThrow()
  }, 60_000)

  it('refuses while a turn holds the agent, and creates nothing', async () => {
    listed()
    await sharingService.library(USER, true)
    cinnaFetch.mockClear()
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      expect((await sharingService.shareWithTeam(USER, agentId, {})).refusal).toBe('turn_in_progress')
    } finally {
      handle.release()
    }
    expect(cinnaFetch).not.toHaveBeenCalled()
    expect(existsSync(join(agentDir, '.git'))).toBe(false)
  }, 60_000)
})

/** Every `cinnaFetch` call with this method, as `[path, body]`. */
function calls(method: string): Array<[string, unknown]> {
  return cinnaFetch.mock.calls
    .filter((call) => ((call[2] as { method?: string } | undefined)?.method ?? 'GET') === method)
    .map((call) => [call[1] as string, (call[2] as { body?: unknown } | undefined)?.body])
}

describe('share with the team — who gets it', () => {
  const fresh = { ...libraryAgent('r30', 'alpha', null), head_sha: null, access: 'maintain', maintainers: [{ user_id: 'me-1', display_name: 'Ann' }] }

  it('creates with the chosen people, gives them access before anything is sent, and sends the manifest description', async () => {
    const order: string[] = []
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      const method = (args[2] as { method?: string } | undefined)?.method ?? 'GET'
      order.push(`${method} ${args[1] as string}`)
      if (method === 'POST') return fresh
      if (method === 'PUT') return null
      return { agents: [], mirrors: [] }
    })
    const init = vi.spyOn(gitService, 'initWithRemote').mockImplementation(async () => {
      order.push('send')
      return { done: true, refusal: null, detail: null }
    })
    try {
      const result = await sharingService.shareWithTeam(USER, agentId, {
        name: 'Alpha',
        description: 'ignored',
        people: [{ userId: 'bob-2', access: 'write' }, { userId: 'me-1', access: 'read' }, { userId: '', access: 'read' }]
      } as never)
      expect(result.done).toBe(true)
      const [[, created]] = calls('POST')
      expect(created).toEqual({
        slug: 'alpha',
        name: 'Alpha',
        description: 'Watches the alpha feed.',
        grants: [
          { principal: { user_id: 'bob-2' }, access: 'write' },
          { principal: { user_id: 'me-1' }, access: 'read' }
        ]
      })
      const [[path, grants]] = calls('PUT')
      expect(path).toBe('/api/v1/library/agents/r30/grants')
      // The creator stays maintainer; nobody else, and never everyone.
      expect(grants).toEqual([
        { principal: { user_id: 'me-1' }, access: 'maintain' },
        { principal: { user_id: 'bob-2' }, access: 'write' }
      ])
      expect(order.indexOf('PUT /api/v1/library/agents/r30/grants')).toBeLessThan(order.indexOf('send'))
    } finally {
      init.mockRestore()
    }
  }, 30_000)

  it('sends nothing when giving access fails, and leaves the entry for a retry to finish', async () => {
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      const method = (args[2] as { method?: string } | undefined)?.method ?? 'GET'
      if (method === 'POST') return fresh
      if (method === 'PUT') throw new CinnaApiError('request_failed', 'Cinna API 422', 'Unknown user bob-2.', 422)
      return { agents: [], mirrors: [] }
    })
    const init = vi.spyOn(gitService, 'initWithRemote')
    try {
      const result = await sharingService.shareWithTeam(USER, agentId, { name: 'Alpha', people: [{ userId: 'bob-2', access: 'read' }] })
      expect(result.done).toBe(false)
      expect(result.refusal).toBe('failed')
      expect(result.detail).toContain('wasn’t sent')
      expect(result.detail).toContain('Unknown user bob-2.')
      expect(init).not.toHaveBeenCalled()
      expect(existsSync(join(agentDir, '.git'))).toBe(false)
      expect(libraryTrust.pending(HOST, 'alpha')).toBe('r30')
    } finally {
      init.mockRestore()
    }
  }, 30_000)

  it('refuses before sending when the server does not say who maintains the new entry', async () => {
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      const method = (args[2] as { method?: string } | undefined)?.method ?? 'GET'
      if (method === 'POST') return { ...fresh, maintainers: [] }
      return { agents: [], mirrors: [] }
    })
    const init = vi.spyOn(gitService, 'initWithRemote')
    try {
      const result = await sharingService.shareWithTeam(USER, agentId, { name: 'Alpha', people: [] })
      expect(result.refusal).toBe('failed')
      expect(calls('PUT')).toEqual([])
      expect(init).not.toHaveBeenCalled()
    } finally {
      init.mockRestore()
    }
  }, 30_000)
})

describe('people', () => {
  it('maps core’s grants to the People list and back, both ways', () => {
    const fromCore = fromCoreGrants([
      { principal: { user_id: 'u1', display_name: 'Ann' }, access: 'maintain' },
      { principal: { role: 'admin' }, access: 'write', display_name: 'Admins' },
      { principal: 'everyone', access: 'read' },
      { principal: { nonsense: true }, access: 'read' }
    ])
    expect(fromCore).toEqual([
      { principal: { kind: 'user', userId: 'u1' }, access: 'maintain', displayName: 'Ann' },
      { principal: { kind: 'role', role: 'admin' }, access: 'write', displayName: 'Admins' },
      { principal: { kind: 'everyone' }, access: 'read', displayName: '' }
    ])
    expect(fromCoreGrants({ grants: [{ principal: { user_id: 'u2' }, access: 'write', full_name: 'Bob' }] })).toEqual([
      { principal: { kind: 'user', userId: 'u2' }, access: 'write', displayName: 'Bob' }
    ])
    expect(toCoreGrants(fromCore)).toEqual([
      { principal: { user_id: 'u1' }, access: 'maintain' },
      { principal: { role: 'admin' }, access: 'write' },
      { principal: 'everyone', access: 'read' }
    ])
  })

  async function sharedOnHost(): Promise<void> {
    makeOwnRepo(`${HOST}/git/r1.git`)
    git(agentDir, 'config', 'cinna.server', HOST)
  }

  it('reads who has access, and says "not visible" on a 403 instead of asking to sign in again', async () => {
    await sharedOnHost()
    cinnaFetch.mockResolvedValueOnce([{ principal: { user_id: 'u1', display_name: 'Ann' }, access: 'maintain' }])
    // The caller (the stored token's subject) is marked, since it is listed.
    expect(await sharingService.people(USER, agentId)).toEqual({
      visible: true,
      people: [{ principal: { kind: 'user', userId: 'u1' }, access: 'maintain', displayName: 'Ann' }],
      selfUserId: 'u1'
    })
    expect(cinnaFetch.mock.calls[0][1]).toBe('/api/v1/library/agents/r1/grants')
    cinnaFetch.mockRejectedValueOnce(new CinnaApiError('reauth_required', 'Cinna 403', '403', 403))
    expect(await sharingService.people(USER, agentId)).toEqual({ visible: false, people: [], selfUserId: null })
  }, 30_000)

  it('has no people for an agent shared on another account, and asks nothing', async () => {
    makeOwnRepo(`${OTHER_HOST}/git/r9.git`)
    expect(await sharingService.people(USER, agentId)).toBeNull()
    expect(cinnaFetch).not.toHaveBeenCalled()
  }, 30_000)

  it('puts the whole list, mapped to core’s principals, and returns the server’s refusal sentence', async () => {
    await sharedOnHost()
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'PUT') {
        return [
          { principal: { user_id: 'u1', display_name: 'Ann' }, access: 'maintain' },
          { principal: 'everyone', access: 'read' }
        ]
      }
      return { agents: [], mirrors: [] }
    })
    const people = [
      { principal: { kind: 'user', userId: 'u1' }, access: 'maintain' },
      { principal: { kind: 'everyone' }, access: 'read' }
    ]
    const saved = await sharingService.setPeople(USER, agentId, people)
    expect(saved.done).toBe(true)
    // The list as the server answered it, names included, for the renderer's cache.
    expect(saved.people).toEqual({
      visible: true,
      people: [
        { principal: { kind: 'user', userId: 'u1' }, access: 'maintain', displayName: 'Ann' },
        { principal: { kind: 'everyone' }, access: 'read', displayName: '' }
      ],
      selfUserId: 'u1'
    })
    expect(calls('PUT')).toEqual([[
      '/api/v1/library/agents/r1/grants',
      [{ principal: { user_id: 'u1' }, access: 'maintain' }, { principal: 'everyone', access: 'read' }]
    ]])
    expect(publishEvent).toHaveBeenCalledWith('sharing:changed')

    cinnaFetch.mockRejectedValueOnce(
      new CinnaApiError('request_failed', 'Cinna API 409', 'An agent needs at least one maintainer.', 409)
    )
    const refused = await sharingService.setPeople(USER, agentId, [{ principal: { kind: 'everyone' }, access: 'read' }])
    expect(refused).toMatchObject({ done: false, refusal: 'failed', detail: 'An agent needs at least one maintainer.' })
    expect((await sharingService.setPeople(USER, agentId, [{ principal: { kind: 'user' }, access: 'read' }])).done).toBe(false)
  }, 30_000)

  it('finds people by name or email, from two characters', async () => {
    expect(await sharingService.searchPeople('b')).toEqual([])
    expect(cinnaFetch).not.toHaveBeenCalled()
    cinnaFetch.mockResolvedValueOnce({ data: [{ id: 'u2', email: 'bob@x.test', full_name: 'Bob' }, { id: 'u3', email: 'c@x.test', full_name: '' }], count: 2 })
    expect(await sharingService.searchPeople(' bo ')).toEqual([
      { userId: 'u2', email: 'bob@x.test', name: 'Bob' },
      { userId: 'u3', email: 'c@x.test', name: 'c@x.test' }
    ])
    expect(cinnaFetch.mock.calls[0][1]).toBe('/api/v1/users/search?q=bo&limit=10')
  })
})

describe('remove sharing', () => {
  async function sharedOnHost(): Promise<void> {
    makeOwnRepo(`${HOST}/git/r1.git`)
    git(agentDir, 'config', 'cinna.server', HOST)
    desktopStateService.patch(agentDir, 'kit', {
      shared_remote: { kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` }
    })
    listed({ ...libraryAgent('r1', 'alpha', null), access: 'maintain' })
    await libraryService.refresh(PROFILE)
  }
  const sharedRemote = (): unknown =>
    JSON.parse(readFileSync(join(agentDir, 'app-data', 'desktop.json'), 'utf8')).shared_remote ?? null

  it('disconnects the folder and keeps it, its files and its history, without asking the server anything', async () => {
    await sharedOnHost()
    writeFileSync(join(agentDir, 'notes.md'), 'not shared yet\n')
    cinnaFetch.mockClear()
    publishEvent.mockClear()
    listed()
    const result = await sharingService.unshare(USER, agentId, false)
    expect(result.done).toBe(true)
    expect(calls('DELETE')).toEqual([])
    expect(() => git(agentDir, 'config', '--get', 'remote.origin.url')).toThrow()
    expect(() => git(agentDir, 'config', '--get', 'cinna.server')).toThrow()
    expect(sharedRemote()).toBeNull()
    expect(git(agentDir, 'log', '--format=%s').trim()).toBe('first')
    expect(readFileSync(join(agentDir, 'notes.md'), 'utf8')).toBe('not shared yet\n')
    expect(await sharingService.status(USER, agentId, false)).toBeNull()
    expect(publishEvent).toHaveBeenCalledWith('sharing:changed')
  }, 30_000)

  it('deletes the library entry first when asked, then disconnects', async () => {
    await sharedOnHost()
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'DELETE') return null
      return { agents: [], mirrors: [] }
    })
    const result = await sharingService.unshare(USER, agentId, true)
    expect(result.done).toBe(true)
    expect(calls('DELETE').map(([path]) => path)).toEqual(['/api/v1/library/agents/r1'])
    expect(() => git(agentDir, 'config', '--get', 'remote.origin.url')).toThrow()
  }, 30_000)

  it('changes nothing here when the server refuses the delete, and says why', async () => {
    await sharedOnHost()
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { method?: string } | undefined)?.method === 'DELETE') {
        throw new CinnaApiError('request_failed', 'Cinna API 409', 'Another person has this agent in their workspace.', 409)
      }
      return { agents: [], mirrors: [] }
    })
    const result = await sharingService.unshare(USER, agentId, true)
    expect(result).toMatchObject({ done: false, refusal: 'failed', detail: 'Another person has this agent in their workspace.' })
    expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/r1.git`)
    expect(git(agentDir, 'config', '--get', 'cinna.server').trim()).toBe(HOST)
    expect(sharedRemote()).toEqual({ kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` })
  }, 30_000)

  it('disconnects an agent shared on another account, locally only', async () => {
    makeOwnRepo(`${OTHER_HOST}/git/r9.git`)
    cinnaFetch.mockResolvedValue({ agents: [], mirrors: [] })
    expect((await sharingService.unshare(USER, agentId, false)).done).toBe(true)
    // Only the active account's own listing is read again afterwards.
    expect(cinnaFetch.mock.calls.map((call) => call[1])).toEqual(['/api/v1/library'])
    expect(() => git(agentDir, 'config', '--get', 'remote.origin.url')).toThrow()
  }, 30_000)

  it('refuses while a turn holds the agent, and keeps the link', async () => {
    await sharedOnHost()
    const handle = turnLock.acquire(agentId, 'turn')
    try {
      expect((await sharingService.unshare(USER, agentId, true)).refusal).toBe('turn_in_progress')
    } finally {
      handle.release()
    }
    expect(calls('DELETE')).toEqual([])
    expect(git(agentDir, 'config', '--get', 'remote.origin.url').trim()).toBe(`${HOST}/git/r1.git`)
  }, 30_000)
})

describe('history', () => {
  it('lists versions newest first and marks the ones not on the team version', async () => {
    const team = join(workshop, '.team.git')
    mkdirSync(team)
    git(team, 'init', '--bare', '-q', '-b', 'main', '.')
    makeOwnRepo(team)
    git(agentDir, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(agentDir, 'notes.md'), 'x\n')
    git(agentDir, 'add', '-A')
    git(agentDir, 'commit', '-q', '-m', 'Second: with a | pipe')
    const history = await sharingService.history(USER, agentId)
    expect(history.map((v) => [v.note, v.author, v.unsent])).toEqual([
      ['Second: with a | pipe', 'Teammate', true],
      ['first', 'Teammate', false]
    ])
    expect(Number.isNaN(Date.parse(history[0].date))).toBe(false)
    expect(Object.keys(history[0]).sort()).toEqual(['author', 'date', 'note', 'unsent'])
  }, 30_000)

  it('marks nothing when there is no team version to measure against, and is empty for an agent not shared', async () => {
    expect(await sharingService.history(USER, agentId)).toEqual([])
    makeOwnRepo('https://github.com/acme/alpha.git')
    expect((await sharingService.history(USER, agentId)).map((v) => v.unsent)).toEqual([false])
  }, 30_000)
})

describe('the library poll', () => {
  it('turns an agent whose entry was deleted on the server into "no longer shared", and tells the renderer', async () => {
    makeOwnRepo(`${HOST}/git/r1.git`)
    listed(libraryAgent('r1', 'alpha', null))
    await libraryService.refresh(PROFILE)
    expect((await sharingService.status(USER, agentId, false))?.state).not.toBe('removed')
    publishEvent.mockClear()
    // An admin deleted it; the next poll lists the library without it.
    listed(libraryAgent('r2', 'other', null))
    await libraryService.refreshQuietly(PROFILE)
    expect(publishEvent).toHaveBeenCalledWith('sharing:changed')
    expect((await sharingService.status(USER, agentId, false))?.state).toBe('removed')
  }, 30_000)
})
