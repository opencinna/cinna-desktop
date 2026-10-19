import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublishedArtifactRow } from '../../db/publishedArtifacts'
import type { RunEvent } from '../../../shared/runEvents'
import { createArtifactService, type ArtifactServiceDeps } from './publishService'
import { approvalInboxHook, createArtifactApprovals } from './artifactApprovals'
import { ArtifactToolProvider, agentArtifactPolicy } from './artifactToolProvider'
import { CinnaApiError } from '../../errors'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SERVER = 'https://core.example'
const session = { scope: { profileUserId: 'p1', settingsUserId: '__default__' }, chatId: 'chat-1', agentId: 'folder:analyst' }

let root: string
let agentDir: string

function published(over: Record<string, unknown> = {}) {
  return { id: ID, title: 'Q3', kind: 'site', visibility: 'private', revision_number: 1, live_link_count: 0, url: `http://core/artifact/${ID}`, excluded: [], ...over }
}

function setup(opts: {
  supported?: boolean
  validate?: () => { agentName: string; agentDir: string }
  timeoutMs?: number
  uploadGraceMs?: number
  maxFiles?: number
  /** The profile active in the app now; the session's is always p1. */
  activeProfile?: string
} = {}) {
  const rows: PublishedArtifactRow[] = []
  const sends: Array<{ profile: string; path: string; method: string; json?: unknown }> = []
  const reads: Array<{ profile: string; path: string }> = []
  const events: unknown[] = []
  let revision = 0
  /** The artifact on core, as the fake answers it — changes made on core's web page included. */
  const core = { visibility: 'private', liveLinks: 0, grants: 0, owner: true, readFails: false, uploadFails: false, deleted: false }
  /** The profile active in the app; tests switch it after loading p1's support. */
  const active = { profile: opts.activeProfile ?? 'p1' }
  /** Hold the next upload until released (a slow publish). */
  const gate: { hold: Promise<void> | null } = { hold: null }
  const repo: ArtifactServiceDeps['repo'] = {
    findBySource: (p, s, src) => rows.filter((row) => row.profileUserId === p && row.serverUrl === s && row.sourcePath === src).at(-1) ?? null,
    get: (p, s, id) => rows.find((row) => row.profileUserId === p && row.serverUrl === s && row.artifactId === id) ?? null,
    recordPublish: (p, s, source, state) => {
      const row = repo.get(p, s, state.artifactId)
      if (row) Object.assign(row, source, state)
      else rows.push({ id: String(rows.length), profileUserId: p, serverUrl: s, ...source, ...state, approvedAgentId: null, createdAt: new Date(), updatedAt: new Date() })
    },
    sync: (p, s, state) => { const row = repo.get(p, s, state.artifactId); if (row) Object.assign(row, state) },
    forget: () => {},
    addCard: () => {},
    cards: () => [],
    urls: () => []
  }
  const service = createArtifactService({
    profileId: () => active.profile,
    account: () => (opts.supported === false ? null : { serverUrl: SERVER, signedIn: true }),
    discover: async () => ({ artifacts: 1, instance_name: 'Acme' }),
    fetchJson: async (p, path) => {
      reads.push({ profile: p, path })
      if (path.endsWith('/capabilities')) return { limits: { max_revision_bytes: 10_000, max_revision_files: opts.maxFiles ?? 50, max_file_bytes: 5_000 } }
      if (core.readFails) throw new Error('offline')
      if (core.deleted) throw new CinnaApiError('request_failed', 'Cinna API 404: Not found', 'Not found', 404)
      return published({ current_revision_number: revision, visibility: core.visibility, live_link_count: core.liveLinks, grant_count: core.grants, is_owner: core.owner })
    },
    send: async (p, path, o) => {
      sends.push({ profile: p, path, method: o.method, json: o.json })
      if (gate.hold) await gate.hold
      if (core.uploadFails) return { status: 500, ok: false, body: { detail: 'boom' } }
      if (o.method === 'PATCH') {
        core.visibility = (o.json as { visibility: string }).visibility
        return { status: 200, ok: true, body: published({ revision_number: revision, visibility: core.visibility }) }
      }
      revision += 1
      return { status: 200, ok: true, body: published({ revision_number: revision, visibility: core.visibility }) }
    },
    locateAgent: () => { throw new Error('the provider must pass the validated folder') },
    agentName: () => 'Analyst',
    realpath: async (path) => realpathSync(path),
    repo,
    publishEvent: (channel, payload) => events.push({ channel, payload }),
    latestMessageId: () => null
  })
  const approvals = createArtifactApprovals({ publishEvent: (channel, payload) => events.push({ channel, payload }), timeoutMs: opts.timeoutMs, uploadGraceMs: opts.uploadGraceMs })
  const provider = new ArtifactToolProvider(session, {
    validate: opts.validate ?? (() => ({ agentName: 'Analyst', agentDir })),
    service,
    repo,
    approvals
  })
  return { provider, approvals, service, rows, sends, reads, events, repo, core, gate, active }
}

/** Publish once: a new artifact, which goes out without a card. */
async function publishedOnce(ctx: ReturnType<typeof setup>): Promise<void> {
  const first = call(ctx.provider, { path: 'reports/q3', title: 'Q3' })
  expect(await first.result).toMatchObject({ content: { artifact_id: ID } })
  expect(first.runEvents).toEqual([])
}

/** `reports/q3` already published by another agent: a call into it asks (the card). */
function publishedByOther(ctx: ReturnType<typeof setup>): void {
  ctx.repo.recordPublish('p1', SERVER, { sourcePath: join(agentDir, 'reports', 'q3'), agentId: 'folder:other' }, {
    artifactId: ID, title: 'Q3', kind: 'site', revision: 1, visibility: 'private', url: `http://core/artifact/${ID}`, liveLinkCount: 0
  })
}

/** Call the tool, collecting its events; resolves with the result. */
function call(provider: ArtifactToolProvider, input: Record<string, unknown>, extra: { signal?: AbortSignal; toolCallId?: string } = {}) {
  const runEvents: RunEvent[] = []
  const result = provider.callTool('artifacts_publish', input, { toolCallId: extra.toolCallId ?? 'tc1', signal: extra.signal, onEvent: (event) => runEvents.push(event) })
  return { result, runEvents }
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(check()).toBe(true)
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-tool-')))
  agentDir = join(root, 'analyst')
  mkdirSync(join(agentDir, 'reports', 'q3'), { recursive: true })
  writeFileSync(join(agentDir, 'reports', 'q3', 'index.html'), '<h1>Q3</h1>')
  writeFileSync(join(agentDir, 'reports', 'q3', '.env'), 'X=1')
  mkdirSync(join(root, 'elsewhere'))
  writeFileSync(join(root, 'elsewhere', 'leak.txt'), 'nope')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('agentArtifactPolicy (A8)', () => {
  const own = { agentId: 'folder:analyst' }
  const now = { isOwner: true, visibility: 'private' as const, liveLinkCount: 0, grantCount: 0 }
  type Now = typeof now | { isOwner: boolean; visibility: string; liveLinkCount: number; grantCount: number }
  const decide = (over: { row?: typeof own | null; readNow?: () => Promise<Now | 'gone' | null> } = {}) =>
    agentArtifactPolicy({ row: own, agentId: 'folder:analyst', readNow: async () => now, ...over } as Parameters<typeof agentArtifactPolicy>[0])

  it('publishes a new artifact without asking or reading core', async () => {
    const readNow = vi.fn(async () => now)
    expect(await decide({ row: null, readNow })).toBe('publish')
    expect(readNow).not.toHaveBeenCalled()
  })

  it('republishes its own artifact without asking while core says the user still owns it, however it is shared', async () => {
    expect(await decide()).toBe('publish')
    expect(await decide({ readNow: async () => ({ ...now, visibility: 'instance' }) })).toBe('publish')
    expect(await decide({ readNow: async () => ({ ...now, liveLinkCount: 1 }) })).toBe('publish')
    expect(await decide({ readNow: async () => ({ ...now, grantCount: 2 }) })).toBe('publish')
  })

  it('publishes anew when core says its artifact was deleted', async () => {
    expect(await decide({ readNow: async () => 'gone' })).toBe('publish')
  })

  it('asks when core cannot be read, answers nothing, or says the user is not the owner', async () => {
    expect(await decide({ readNow: async () => { throw new Error('offline') } })).toBe('ask')
    expect(await decide({ readNow: async () => null })).toBe('ask')
    expect(await decide({ readNow: async () => ({ ...now, isOwner: false }) })).toBe('ask')
  })

  it('asks for another agent’s artifact without reading core', async () => {
    const readNow = vi.fn(async () => now)
    expect(await decide({ row: { agentId: 'folder:other' }, readNow })).toBe('ask')
    expect(readNow).not.toHaveBeenCalled()
  })
})

describe('artifacts_publish', () => {
  it('refuses a path outside the workspace, a symlink out of it, and a missing one, in words the agent can act on', async () => {
    symlinkSync(join(root, 'elsewhere'), join(agentDir, 'out-link'))
    const { provider, sends, service } = setup()
    await service.support()
    for (const path of ['../elsewhere', join(root, 'elsewhere', 'leak.txt'), 'out-link']) {
      const { result } = call(provider, { path, title: 'x' })
      expect(await result).toMatchObject({ isError: true, content: expect.stringMatching(/outside your workspace folder/) })
    }
    expect(await call(provider, { path: 'nope', title: 'x' }).result).toMatchObject({ isError: true, content: expect.stringMatching(/does not exist/) })
    expect(sends).toEqual([])
  })

  it('refuses unknown arguments (no visibility), bad types, and an artifact_id this computer did not publish', async () => {
    const { provider, service } = setup()
    await service.support()
    expect(await call(provider, { path: 'reports/q3', title: 'x', visibility: 'instance' }).result).toMatchObject({ isError: true, content: expect.stringMatching(/Unknown argument `visibility`/) })
    expect(await call(provider, { path: 'reports/q3', title: '' }).result).toMatchObject({ isError: true, content: expect.stringMatching(/`title`/) })
    expect(await call(provider, { path: 'reports/q3', title: 'x', artifact_id: OTHER }).result).toMatchObject({ isError: true, content: expect.stringMatching(/not an artifact published from this computer/) })
  })

  it('names what is wrong with an empty folder and one over the limits', async () => {
    mkdirSync(join(agentDir, 'secrets'))
    writeFileSync(join(agentDir, 'secrets', '.env'), 'A=1')
    mkdirSync(join(agentDir, 'many'))
    for (let i = 0; i < 4; i++) writeFileSync(join(agentDir, 'many', `f${i}`), 'x')
    const { provider, service } = setup({ maxFiles: 3 })
    await service.support()
    expect(await call(provider, { path: 'secrets', title: 'x' }).result).toMatchObject({ isError: true, content: expect.stringMatching(/Nothing to publish.*\.env \(secret file\)/) })
    expect(await call(provider, { path: 'many', title: 'x' }).result).toMatchObject({ isError: true, content: expect.stringMatching(/more than 3 files/) })
  })

  it('is refused when the session is not this agent’s or artifacts are unsupported', async () => {
    const refused = setup({ validate: () => { throw new Error('The active profile changed.') } })
    expect(await call(refused.provider, { path: 'reports/q3', title: 'x' }).result).toMatchObject({ isError: true, content: 'The active profile changed.' })
    const unsupported = setup({ supported: false })
    expect(await call(unsupported.provider, { path: 'reports/q3', title: 'x' }).result).toMatchObject({ isError: true, content: expect.stringMatching(/not available/) })
  })

  it('publishes a new artifact privately without asking and returns exactly the schema result, with no note', async () => {
    const { provider, approvals, service, sends, rows } = setup()
    await service.support()
    const { result, runEvents } = call(provider, { path: 'reports/q3', title: 'Q3 churn', description: 'By plan' })
    expect(await result).toEqual({
      content: { artifact_id: ID, revision: 1, url: `http://core/artifact/${ID}`, kind: 'site', file_count: 1, size_bytes: 11, excluded: ['.env'] }
    })
    expect(runEvents).toEqual([])
    expect(approvals.list('p1', 'chat-1')).toEqual([])
    expect(sends.map((send) => [send.method, send.path])).toEqual([['POST', '/api/v1/artifacts']])
    expect(rows[0]).toMatchObject({ agentId: 'folder:analyst', visibility: 'private' })
  })

  it('asks for another agent’s artifact, then publishes on approval and returns exactly the schema result', async () => {
    const ctx = setup()
    const { provider, approvals, service, sends } = ctx
    await service.support()
    publishedByOther(ctx)
    const { result, runEvents } = call(provider, { path: 'reports/q3', title: 'Q3 churn', description: 'By plan' })
    await until(() => approvals.list('p1', 'chat-1').length === 1)
    const [summary] = approvals.list('p1', 'chat-1')
    expect(summary).toMatchObject({
      requestId: 'art_tc1', relativePath: 'reports/q3', title: 'Q3 churn', kindLine: 'Mini-site · opens index.html',
      files: [{ path: 'index.html', size: 11 }], excluded: [{ path: '.env', reason: 'secret file' }], audience: 'only you', update: { artifactId: ID }
    })
    expect(runEvents[0]).toMatchObject({
      type: 'needs_input', requestId: 'art_tc1', resume: 'reply',
      request: { kind: 'question', questions: [{ header: 'Publish artifact', options: [{ label: 'Publish' }, { label: 'Deny' }] }] }
    })
    expect(sends).toEqual([])
    // Another agent's artifact is not this call's to judge: core is not even read.
    expect(ctx.reads.map((read) => read.path)).not.toContain(`/api/v1/artifacts/${ID}`)
    expect(await approvals.answer('someone-else', 'art_tc1', 'publish')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await approvals.answer('p1', 'art_tc1', 'publish')).toMatchObject({ ok: true, artifact: { id: ID } })
    expect(await result).toEqual({
      content: { artifact_id: ID, revision: 1, url: `http://core/artifact/${ID}`, kind: 'site', file_count: 1, size_bytes: 11, excluded: ['.env'] }
    })
    expect(runEvents[1]).toEqual({ type: 'input_resolved', requestId: 'art_tc1', resolution: { kind: 'question', answers: [['Publish']] } })
    expect(sends.map((send) => send.method)).toEqual(['POST'])
  })

  it('republishes its own private artifact without a card, noting the revision', async () => {
    const ctx = setup()
    await ctx.service.support()
    await publishedOnce(ctx)
    const again = call(ctx.provider, { path: 'reports/q3/', title: 'Q3' }, { toolCallId: 'tc2' })
    expect(await again.result).toMatchObject({ content: { artifact_id: ID, revision: 2 }, parts: [{ kind: 'notice', text: 'Updated rev 2' }] })
    expect(again.runEvents).toEqual([])
    expect(ctx.sends.map((send) => send.path)).toEqual(['/api/v1/artifacts', `/api/v1/artifacts/${ID}/revisions`])
    // Core was asked first: the local row is not trusted for who owns it.
    expect(ctx.reads.map((read) => read.path)).toContain(`/api/v1/artifacts/${ID}`)
  })

  it('republishes its own artifact without a card however the user shared it, and never changes the sharing', async () => {
    for (const change of [
      (core: ReturnType<typeof setup>['core']) => { core.grants = 1 },
      (core: ReturnType<typeof setup>['core']) => { core.liveLinks = 1 },
      (core: ReturnType<typeof setup>['core']) => { core.visibility = 'instance' }
    ]) {
      const ctx = setup()
      await ctx.service.support()
      await publishedOnce(ctx)
      change(ctx.core)
      const again = call(ctx.provider, { path: 'reports/q3', title: 'Q3', artifact_id: ID }, { toolCallId: 'tc2' })
      expect(await again.result).toMatchObject({ content: { artifact_id: ID, revision: 2 }, parts: [{ kind: 'notice', text: 'Updated rev 2' }] })
      expect(again.runEvents).toEqual([])
      // No PATCH: an agent's republish never changes who can see it.
      expect(ctx.sends.map((send) => send.method)).toEqual(['POST', 'POST'])
    }
  })

  it('asks before republishing its own artifact when core cannot be read or says the user no longer owns it', async () => {
    for (const change of [
      (core: ReturnType<typeof setup>['core']) => { core.readFails = true },
      (core: ReturnType<typeof setup>['core']) => { core.owner = false }
    ]) {
      const ctx = setup()
      await ctx.service.support()
      await publishedOnce(ctx)
      change(ctx.core)
      const again = call(ctx.provider, { path: 'reports/q3', title: 'Q3' }, { toolCallId: 'tc2' })
      await until(() => ctx.approvals.has('art_tc2'))
      expect(ctx.sends).toHaveLength(1)
      await ctx.approvals.answer('p1', 'art_tc2', 'deny')
      expect(await again.result).toMatchObject({ isError: true })
    }
  })

  it('the card names the audience core reports now, grants included, not the stale local row', async () => {
    const ctx = setup()
    await ctx.service.support()
    await publishedOnce(ctx)
    ctx.core.owner = false
    ctx.core.grants = 2
    ctx.core.liveLinks = 1
    const again = call(ctx.provider, { path: 'reports/q3', title: 'Q3' }, { toolCallId: 'tc2' })
    await until(() => ctx.approvals.has('art_tc2'))
    const [summary] = ctx.approvals.list('p1', 'chat-1')
    expect(summary.audience).toBe('only you · shared with 2 people · 1 public link')
    expect(again.runEvents[0]).toMatchObject({ type: 'needs_input', request: { questions: [{ question: expect.stringContaining('shared with 2 people') }] } })
    await ctx.approvals.answer('p1', 'art_tc2', 'deny')
    await again.result
  })

  it('an artifact deleted on core becomes a new private artifact without a card, not an update that fails as gone', async () => {
    const ctx = setup()
    await ctx.service.support()
    await publishedOnce(ctx)
    ctx.core.deleted = true
    const again = call(ctx.provider, { path: 'reports/q3', title: 'Q3' }, { toolCallId: 'tc2' })
    const result = await again.result
    expect(result).toMatchObject({ content: { artifact_id: ID } })
    expect(result.parts).toBeUndefined()
    expect(again.runEvents).toEqual([])
    // The second upload created rather than posting a revision of the deleted id.
    expect(ctx.sends.map((send) => send.path)).toEqual(['/api/v1/artifacts', '/api/v1/artifacts'])
    expect(ctx.sends[1].json).toBeUndefined()
  })

  it('a stop waits for an approved upload only so long; a core that never answers cannot hold the call', async () => {
    const ctx = setup({ uploadGraceMs: 30 })
    await ctx.service.support()
    publishedByOther(ctx)
    const controller = new AbortController()
    const { result } = call(ctx.provider, { path: 'reports/q3', title: 'Q3' }, { signal: controller.signal })
    await until(() => ctx.approvals.has('art_tc1'))
    ctx.gate.hold = new Promise<void>(() => {})
    void ctx.approvals.answer('p1', 'art_tc1', 'publish')
    await until(() => ctx.sends.length === 1)
    controller.abort()
    expect(await result).toMatchObject({ isError: true, content: expect.stringMatching(/cancelled before the user answered/) })
    expect(ctx.approvals.has('art_tc1')).toBe(false)
  })

  it('reads, publishes and remembers under the session’s profile, not the active one', async () => {
    const ctx = setup()
    await ctx.service.support()
    // The user switched profiles while the agent's session (opened under p1) goes on.
    ctx.active.profile = 'p-other'
    await publishedOnce(ctx)
    expect(ctx.sends.map((send) => send.profile)).toEqual(['p1'])
    expect(ctx.rows.map((row) => row.profileUserId)).toEqual(['p1'])
    const again = call(ctx.provider, { path: 'reports/q3', title: 'Q3' }, { toolCallId: 'tc2' })
    expect(await again.result).toMatchObject({ content: { revision: 2 } })
    expect(ctx.reads.filter((read) => read.path.includes(ID)).map((read) => read.profile)).toEqual(['p1'])
    expect(ctx.sends.map((send) => send.profile)).toEqual(['p1', 'p1'])
  })

  it('a deny is an error the agent reads, and nothing is sent', async () => {
    const cardCtx = setup()
    const { provider, approvals, service, sends } = cardCtx
    await service.support()
    publishedByOther(cardCtx)
    const { result, runEvents } = call(provider, { path: 'reports/q3', title: 'Q3' })
    await until(() => approvals.has('art_tc1'))
    await approvals.answer('p1', 'art_tc1', 'deny')
    expect(await result).toEqual({
      isError: true,
      content: 'The user declined to publish reports/q3; do not retry unless they ask.',
      parts: [{ kind: 'notice', text: 'artifact-refusal:declined:you declined' }]
    })
    expect(runEvents.at(-1)).toMatchObject({ type: 'input_resolved', resolution: { kind: 'question', answers: [['Deny']] } })
    expect(sends).toEqual([])
  })

  it('times out and cancels with clear sentences, settling the ask as expired', async () => {
    const timed = setup({ timeoutMs: 20 })
    await timed.service.support()
    publishedByOther(timed)
    const late = call(timed.provider, { path: 'reports/q3', title: 'Q3' })
    expect(await late.result).toMatchObject({ isError: true, content: expect.stringMatching(/Nobody answered/), parts: [{ text: 'artifact-refusal:timeout:no answer within an hour' }] })
    expect(late.runEvents.at(-1)).toMatchObject({ type: 'input_resolved', resolution: { kind: 'rejected' } })

    const cardCtx = setup()
    const { provider, approvals, service } = cardCtx
    await service.support()
    publishedByOther(cardCtx)
    const controller = new AbortController()
    const stopped = call(provider, { path: 'reports/q3', title: 'Q3' }, { signal: controller.signal })
    await until(() => approvals.has('art_tc1'))
    controller.abort()
    expect(await stopped.result).toMatchObject({ isError: true, content: expect.stringMatching(/cancelled before the user answered/) })
    expect(approvals.has('art_tc1')).toBe(false)
  })

  it('a stop during an approved upload waits for it and reports the publish that happened', async () => {
    const ctx = setup()
    await ctx.service.support()
    publishedByOther(ctx)
    const controller = new AbortController()
    const { result, runEvents } = call(ctx.provider, { path: 'reports/q3', title: 'Q3' }, { signal: controller.signal })
    await until(() => ctx.approvals.has('art_tc1'))
    let release!: () => void
    ctx.gate.hold = new Promise<void>((resolve) => { release = resolve })
    const answered = ctx.approvals.answer('p1', 'art_tc1', 'publish')
    await until(() => ctx.sends.length === 1)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(ctx.approvals.has('art_tc1')).toBe(true)
    release()
    expect(await answered).toMatchObject({ ok: true, artifact: { id: ID } })
    expect(await result).toEqual({ content: expect.objectContaining({ artifact_id: ID, revision: 1 }) })
    expect(runEvents.at(-1)).toEqual({ type: 'input_resolved', requestId: 'art_tc1', resolution: { kind: 'question', answers: [['Publish']] } })
  })

  it('a timeout during an approved upload waits for it too; a failed upload then settles as the timeout', async () => {
    const ctx = setup({ timeoutMs: 30 })
    await ctx.service.support()
    publishedByOther(ctx)
    const first = call(ctx.provider, { path: 'reports/q3', title: 'Q3' })
    await until(() => ctx.approvals.has('art_tc1'))
    let release!: () => void
    ctx.gate.hold = new Promise<void>((resolve) => { release = resolve })
    const answered = ctx.approvals.answer('p1', 'art_tc1', 'publish')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(ctx.approvals.has('art_tc1')).toBe(true)
    release()
    expect(await answered).toMatchObject({ ok: true })
    expect(await first.result).toMatchObject({ content: { artifact_id: ID } })

    // The publish fails after the timeout: the call ends as the timeout, nobody waits for a retry.
    const failing = setup({ timeoutMs: 30 })
    await failing.service.support()
    publishedByOther(failing)
    const second = call(failing.provider, { path: 'reports/q3', title: 'Q3' })
    await until(() => failing.approvals.has('art_tc1'))
    let releaseFail!: () => void
    failing.gate.hold = new Promise<void>((resolve) => { releaseFail = resolve })
    failing.core.uploadFails = true
    const refused = failing.approvals.answer('p1', 'art_tc1', 'publish')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(failing.approvals.has('art_tc1')).toBe(true)
    releaseFail()
    expect(await refused).toMatchObject({ ok: false, code: 'request_failed' })
    expect(await second.result).toMatchObject({ isError: true, content: expect.stringMatching(/Nobody answered/) })
    expect(failing.approvals.has('art_tc1')).toBe(false)
  })

  it('Edit… publishes with the user’s choices, which may share it', async () => {
    const cardCtx = setup()
    const { provider, approvals, service, sends } = cardCtx
    await service.support()
    publishedByOther(cardCtx)
    const { result } = call(provider, { path: 'reports/q3', title: 'Q3' })
    await until(() => approvals.has('art_tc1'))
    expect(await approvals.answer('p1', 'art_tc1', 'publish', { title: 'Renamed', artifactId: null, visibility: 'instance' })).toMatchObject({ ok: true })
    expect(await result).toMatchObject({ content: { artifact_id: ID } })
    expect(sends.map((send) => [send.method, send.json])).toEqual([['POST', undefined], ['PATCH', { visibility: 'instance' }]])
  })
})

describe('the Inbox way back', () => {
  it('claims only art_ ids, publishes or denies, and refuses what is not waiting', async () => {
    const cardCtx = setup()
    const { provider, approvals, service } = cardCtx
    await service.support()
    publishedByOther(cardCtx)
    const hook = approvalInboxHook(approvals)
    expect(hook.answer('p1', 'per_x', { kind: 'question', answers: [['Publish']] })).toBeNull()
    expect(await hook.answer('p1', 'art_gone', { kind: 'question', answers: [['Publish']] })).toMatchObject({ ok: false, code: 'no_longer_waiting' })
    const { result, runEvents } = call(provider, { path: 'reports/q3', title: 'Q3' })
    await until(() => approvals.has('art_tc1'))
    expect(await hook.answer('p1', 'art_tc1', { kind: 'question', answers: [['Maybe']] })).toMatchObject({ ok: false, code: 'malformed' })
    expect(await hook.answer('p2', 'art_tc1', { kind: 'question', answers: [['Publish']] })).toMatchObject({ ok: false, code: 'not_owned' })
    expect(await hook.answer('p1', 'art_tc1', { kind: 'question', answers: [['Publish']] })).toEqual({ ok: true })
    expect(await result).toMatchObject({ content: { artifact_id: ID } })
    // The provider settles the Inbox row the way an engine ask does: input_resolved.
    expect(runEvents.map((event) => event.type)).toEqual(['needs_input', 'input_resolved'])
  })
})
