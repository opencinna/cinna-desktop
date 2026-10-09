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
vi.mock('../../auth/cinna-tokens', () => ({ getCinnaAccessToken }))
vi.mock('../../host/events', () => ({ publishEvent, installEventPublisher: () => {} }))

const { agentRepo } = await import('../../db/agents')
const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { userRepo } = await import('../../db/users')
const { clearContractCache } = await import('../../kit/contractStore')
const { manifestPath, readManifest } = await import('../../kit/manifestIo')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { turnLock } = await import('./turnLock')
const { libraryService } = await import('../libraryService')
const { sharingService, commitIdentity, parseRemote } = await import('./sharingService')
const { gitService } = await import('./gitService')
const { libraryTrust, acceptableGitOrigin } = await import('../libraryTrust')
const { CinnaApiError } = await import('../../errors')
const { folderAgentId } = await import('../../../shared/localAgents')
const { CinnaReauthRequired } = await import('../../auth/cinna-oauth')

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

    const update = await sharingService.update(USER, agentId)
    expect(update.refusal).toBe('diverged_conflict')
    expect(update.status?.state).toBe('diverged')

    const result = await sharingService.useTeamVersion(USER, agentId)
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
