import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Improvement Request, against a real database: which agents of a chat can be
 * sent (a bundle install on the account's own token, with a session), that
 * main finds the core session id itself, the comment rules, and how core's
 * answers come back — a 403 is core's refusal in its own words, never a lost
 * sign-in; only a 401 is that. The network is faked at `cinnaSend`.
 */

const USER = 'profile-1'
const OTHER = 'profile-2'

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const cinnaSend = vi.hoisted(() => vi.fn())
const broadcastReauthRequired = vi.hoisted(() => vi.fn())

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
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./cinna-http', () => ({ cinnaSend }))
vi.mock('../auth/reauth-notify', () => ({ broadcastReauthRequired }))

const { improvementRequestService } = await import('./improvementRequestService')
const { chatRepo } = await import('../db/chats')
const { agentSessionRepo } = await import('../db/agents')
const { chatOnDemandAgentRepo } = await import('../db/chatOnDemandAgent')
const { CinnaApiError } = await import('../errors')

const BUNDLE_META = { bundle_uuid: 'b-1', is_publisher_install: false }

function seedAgent(id: string, opts: { userId?: string; source?: string; meta?: Record<string, unknown> | null; token?: boolean; name?: string } = {}): void {
  holder.current!.raw.prepare(
    `INSERT INTO agents (id, user_id, name, protocol, enabled, source, remote_target_type, remote_metadata, driver, access_token_enc, created_at)
     VALUES (?, ?, ?, 'a2a', 1, ?, ?, ?, 'a2a', ?, ?)`
  ).run(
    id,
    opts.userId ?? USER,
    opts.name ?? id,
    opts.source ?? 'remote',
    (opts.source ?? 'remote') === 'remote' ? 'agent' : null,
    opts.meta === null ? null : JSON.stringify(opts.meta ?? BUNDLE_META),
    opts.token ? Buffer.from('enc') : null,
    Date.now()
  )
}

/** A session row, with the agent attached to the chat unless it is the bound one. */
function session(chatId: string, agentId: string, taskId: string | null, attach = true): void {
  agentSessionRepo.upsert({ chatId, agentId, contextId: 'ctx', taskId, taskState: null })
  if (attach && (chatRepo.getOwned(USER, chatId) ?? chatRepo.getOwned(OTHER, chatId))?.agentId !== agentId) chatOnDemandAgentRepo.add(chatId, agentId)
}

beforeEach(() => {
  holder.current = createTestDatabase()
  cinnaSend.mockReset()
  broadcastReauthRequired.mockReset()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('listTargets', () => {
  it('offers only bundle installs on the Cinna token with a session id in this chat, the bound agent first', () => {
    seedAgent('remote:bundle-a', { name: 'Alpha' })
    seedAgent('remote:bundle-b', { name: 'Bravo' })
    seedAgent('remote:own', { meta: { bundle_uuid: 'b-2', is_publisher_install: true } })
    seedAgent('remote:standalone', { meta: {} })
    seedAgent('remote:no-task')
    seedAgent('hand-added', { userId: '__default__', source: 'local', meta: null, token: true })
    const chat = chatRepo.create(USER, { agentId: 'remote:bundle-b' })
    session(chat.id, 'remote:bundle-a', 'task-a')
    session(chat.id, 'remote:bundle-b', 'task-b')
    session(chat.id, 'remote:own', 'task-own')
    session(chat.id, 'remote:standalone', 'task-s')
    session(chat.id, 'remote:no-task', null)
    session(chat.id, 'hand-added', 'task-h')

    const targets = improvementRequestService.listTargets(USER, chat.id)
    expect(targets.map((t) => [t.agentId, t.agentName, t.bound])).toEqual([
      ['remote:bundle-b', 'Bravo', true],
      ['remote:bundle-a', 'Alpha', false]
    ])
    expect(typeof targets[0].lastActivityAt).toBe('number')
  })

  it('does not offer an agent removed from the chat, whose session row remains', () => {
    seedAgent('remote:bundle-a')
    seedAgent('remote:gone')
    const chat = chatRepo.create(USER, { agentId: 'remote:bundle-a' })
    session(chat.id, 'remote:bundle-a', 'task-a')
    session(chat.id, 'remote:gone', 'task-g', false)
    expect(improvementRequestService.listTargets(USER, chat.id).map((t) => t.agentId)).toEqual(['remote:bundle-a'])
  })

  it('offers nothing for a chat another profile owns, or a session in another chat', () => {
    seedAgent('remote:bundle-a')
    const mine = chatRepo.create(USER)
    const theirs = chatRepo.create(OTHER)
    session(theirs.id, 'remote:bundle-a', 'task-a')
    expect(improvementRequestService.listTargets(USER, theirs.id)).toEqual([])
    expect(improvementRequestService.listTargets(USER, mine.id)).toEqual([])
    expect(improvementRequestService.listTargets(USER, 42)).toEqual([])
  })

  it('excludes a hand-added A2A agent (its own typed token) even when it carries bundle metadata', () => {
    seedAgent('hand-added', { source: 'local', token: true })
    const chat = chatRepo.create(USER)
    session(chat.id, 'hand-added', 'task-h')
    expect(improvementRequestService.listTargets(USER, chat.id)).toEqual([])
  })
})

describe('context', () => {
  it('asks core about the session id main resolved, and maps the answer', async () => {
    seedAgent('remote:bundle-a')
    const chat = chatRepo.create(USER)
    session(chat.id, 'remote:bundle-a', 'task-a')
    cinnaSend.mockResolvedValue({
      status: 200,
      ok: true,
      body: {
        eligible: true, reason: null, is_shared_externally: true, recipient_display: 'Pub Co',
        target_agent_name: 'Alpha', bundle_id: 'com.pub.alpha', installed_version: '1.2.0',
        message_count: 7, existing_request_count: 1
      }
    })
    const outcome = await improvementRequestService.context(USER, chat.id, 'remote:bundle-a')
    expect(cinnaSend).toHaveBeenCalledWith(USER, '/api/v1/sessions/task-a/improvement-context', { method: 'GET' })
    expect(outcome).toEqual({
      ok: true,
      context: {
        eligible: true, reason: null, reasonText: null, isSharedExternally: true, recipientDisplay: 'Pub Co', recipientEmail: null,
        targetAgentName: 'Alpha', bundleId: 'com.pub.alpha', installedVersion: '1.2.0',
        messageCount: 7, existingRequestCount: 1
      }
    })
  })

  it('gives an ineligible answer a sentence', async () => {
    seedAgent('remote:bundle-a')
    const chat = chatRepo.create(USER)
    session(chat.id, 'remote:bundle-a', 'task-a')
    cinnaSend.mockResolvedValue({ status: 200, ok: true, body: { eligible: false, reason: 'empty_session', message_count: 0 } })
    const outcome = await improvementRequestService.context(USER, chat.id, 'remote:bundle-a')
    expect(outcome).toMatchObject({ ok: true, context: { eligible: false, reason: 'empty_session', reasonText: expect.stringContaining('no messages') } })
  })

  it('refuses an agent that is not a target without calling core', async () => {
    seedAgent('remote:standalone', { meta: {} })
    const chat = chatRepo.create(USER)
    session(chat.id, 'remote:standalone', 'task-s')
    expect(await improvementRequestService.context(USER, chat.id, 'remote:standalone')).toMatchObject({ ok: false, code: 'no_target' })
    expect(cinnaSend).not.toHaveBeenCalled()
  })
})

describe('create', () => {
  let chatId: string
  beforeEach(() => {
    seedAgent('remote:bundle-a')
    chatId = chatRepo.create(USER).id
    session(chatId, 'remote:bundle-a', 'task-a')
  })

  it('sends the resolved session id, the trimmed comment and include_memory', async () => {
    cinnaSend.mockResolvedValue({ status: 201, ok: true, body: { id: 'req-1' } })
    const outcome = await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: '  Please fix X  ', includeMemory: false })
    expect(outcome).toEqual({ ok: true, request: { id: 'req-1' } })
    expect(cinnaSend).toHaveBeenCalledWith(USER, '/api/v1/improvement-requests', {
      method: 'POST',
      json: { session_id: 'task-a', comment: 'Please fix X', include_memory: false }
    })
  })

  it('includes memory only on an explicit true', async () => {
    cinnaSend.mockResolvedValue({ status: 201, ok: true, body: { id: 'req-1' } })
    await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x' })
    await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x', includeMemory: 'yes' })
    await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x', includeMemory: true })
    expect(cinnaSend.mock.calls.map((call) => call[2].json.include_memory)).toEqual([false, false, true])
  })

  it('rejects a blank comment, and one over the limit, before calling core', async () => {
    expect(await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: '   \n ', includeMemory: true }))
      .toMatchObject({ ok: false, code: 'invalid_comment' })
    expect(await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: undefined }))
      .toMatchObject({ ok: false, code: 'invalid_comment' })
    expect(await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x'.repeat(4001) }))
      .toMatchObject({ ok: false, code: 'invalid_comment' })
    expect(cinnaSend).not.toHaveBeenCalled()
  })

  it('returns core’s 403 as its own refusal, not as a lost sign-in', async () => {
    cinnaSend.mockResolvedValue({ status: 403, ok: false, body: { detail: 'Only the owner of this session can share it.' } })
    const outcome = await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x' })
    expect(outcome).toEqual({ ok: false, code: 'refused', message: 'Only the owner of this session can share it.' })
    expect(broadcastReauthRequired).not.toHaveBeenCalled()
  })

  it.each([400, 404, 429])('returns core’s %i detail as the message', async (status) => {
    cinnaSend.mockResolvedValue({ status, ok: false, body: { detail: `core says ${status}` } })
    expect(await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x' }))
      .toEqual({ ok: false, code: 'refused', message: `core says ${status}` })
  })

  it('treats a 401 as a lost sign-in and raises the app-wide prompt', async () => {
    cinnaSend.mockRejectedValue(new CinnaApiError('reauth_required', 'Cinna 401', '401', 401))
    const outcome = await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x' })
    expect(outcome).toMatchObject({ ok: false, code: 'reauth_required' })
    expect(broadcastReauthRequired).toHaveBeenCalledTimes(1)
  })

  it('answers a dropped connection as data', async () => {
    cinnaSend.mockRejectedValue(new CinnaApiError('request_failed', 'socket hang up'))
    expect(await improvementRequestService.create(USER, chatId, 'remote:bundle-a', { comment: 'x' }))
      .toMatchObject({ ok: false, code: 'failed' })
  })
})
