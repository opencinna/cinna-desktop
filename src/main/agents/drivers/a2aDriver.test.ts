import { describe, it, expect, vi } from 'vitest'
import type { AgentRow } from '../../db/agents'
import type { A2ARunAgentTurnInput } from '../../services/a2aStreamingService'
import { A2aHttpError, AgentCardFetchError } from '../a2a-client'
import { AgentError } from '../../errors'
import { CINNA_REAUTH_REQUIRED_CODE, CINNA_SESSION_EXPIRED_MESSAGE } from '../../../shared/cinnaErrors'
import {
  AGENT_NOT_CONFIGURED,
  NO_ENDPOINT_CONFIGURED,
  createA2aDriver,
  type A2aDriverDeps
} from './a2aDriver'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * The A2A driver's pre-flight, its cancel, and its readiness.
 *
 * The pre-flight used to live twice — in `agent:send-message` and in
 * `A2AAsMcpProvider.callTool` — with different sentences and only one of them
 * mapping an expired Cinna session to the re-auth code. It now returns every
 * failure as `result.error`, and the direct chat finalizes it through
 * `streamToAgent` like any failed turn.
 */

class Reauth extends Error {}

const REMOTE = {
  id: 'remote:agent:1',
  name: 'Researcher',
  source: 'remote',
  driver: 'a2a',
  cardUrl: 'https://agents.example/card',
  accessTokenEncrypted: null
} as unknown as AgentRow
const LOCAL = { ...REMOTE, id: 'nano1', source: 'local' } as AgentRow

function deps(over: Partial<A2aDriverDeps> = {}): A2aDriverDeps & { runTurn: ReturnType<typeof vi.fn> } {
  return {
    runTurn: vi.fn(async () => ({ text: 'ok', parts: [], notices: [] })),
    resolveEndpoint: async () => 'https://agents.example/rpc',
    resolveAccessToken: async () => 'jwt',
    fetchCard: async () => ({}),
    isReauthRequired: (err) => err instanceof Reauth,
    ...over
  } as A2aDriverDeps & { runTurn: ReturnType<typeof vi.fn> }
}

const input = (signal = new AbortController().signal) => ({
  chatId: 'chat-1',
  wireContent: 'hello',
  fileIds: ['file-1'],
  signal
})

describe('a2a driver — run', () => {
  it('hands runAgentTurn everything the pre-flight resolved', async () => {
    const d = deps()
    const onEvent = vi.fn()
    const result = await createA2aDriver(d).run('owner-1', REMOTE, { ...input(), onEvent })
    expect(result).toEqual({ text: 'ok', parts: [], notices: [] })
    expect(d.runTurn).toHaveBeenCalledTimes(1)
    expect(d.runTurn.mock.calls[0][0]).toMatchObject({
      chatId: 'chat-1',
      agentId: 'remote:agent:1',
      agentName: 'Researcher',
      endpointUrl: 'https://agents.example/rpc',
      cardUrl: 'https://agents.example/card',
      accessToken: 'jwt',
      wireContent: 'hello',
      fileIds: ['file-1'],
      isCinnaTokenAuth: true,
      onEvent
    })
  })

  it('treats a stream 401 as a re-auth only for a Cinna-synced agent', async () => {
    const d = deps()
    await createA2aDriver(d).run('owner-1', LOCAL, input())
    expect((d.runTurn.mock.calls[0][0] as A2ARunAgentTurnInput).isCinnaTokenAuth).toBe(false)
  })

  it('refuses a row with no card before resolving anything', async () => {
    const resolveEndpoint = vi.fn()
    const d = deps({ resolveEndpoint })
    const result = await createA2aDriver(d).run('owner-1', { ...REMOTE, cardUrl: null } as AgentRow, input())
    expect(result.error).toEqual({ message: AGENT_NOT_CONFIGURED, raw: AGENT_NOT_CONFIGURED })
    expect(resolveEndpoint).not.toHaveBeenCalled()
    expect(d.runTurn).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an expired Cinna session, with the re-auth code',
      new Reauth('No Cinna tokens stored'),
      { message: CINNA_SESSION_EXPIRED_MESSAGE, code: CINNA_REAUTH_REQUIRED_CODE }
    ],
    [
      'a domain error, in its own words',
      new AgentError('no_endpoint', 'No compatible protocol endpoint resolved. Test the agent connection first.'),
      { message: 'No compatible protocol endpoint resolved. Test the agent connection first.' }
    ],
    ['anything else, prefixed', new Error('boom'), { message: 'Failed to resolve agent endpoint: boom' }]
  ])('reports an endpoint that cannot be resolved: %s', async (_label, thrown, expected) => {
    // Mutation: let the throw escape — `run` rejects, and the never-throws
    // assertion below fails before anything else.
    const d = deps({ resolveEndpoint: () => Promise.reject(thrown) })
    const result = await createA2aDriver(d).run('owner-1', REMOTE, input())
    expect(result.error).toMatchObject(expected)
    expect(result.error?.code).toBe((expected as { code?: string }).code)
    expect(d.runTurn).not.toHaveBeenCalled()
  })

  it('says so when the resolution finds no endpoint', async () => {
    const result = await createA2aDriver(deps({ resolveEndpoint: async () => null })).run('owner-1', REMOTE, input())
    expect(result.error?.message).toBe(NO_ENDPOINT_CONFIGURED)
  })

  it('maps a token that cannot be resolved the same way', async () => {
    const reauth = await createA2aDriver(
      deps({ resolveAccessToken: () => Promise.reject(new Reauth('replay')) })
    ).run('owner-1', REMOTE, input())
    expect(reauth.error).toMatchObject({ message: CINNA_SESSION_EXPIRED_MESSAGE, code: CINNA_REAUTH_REQUIRED_CODE })

    const other = await createA2aDriver(
      deps({ resolveAccessToken: () => Promise.reject(new Error('keychain locked')) })
    ).run('owner-1', LOCAL, input())
    expect(other.error?.message).toBe('Failed to resolve agent access token: keychain locked')
    expect(other.error?.code).toBeUndefined()
  })

  it('sends nothing when the turn was stopped during the pre-flight', async () => {
    const controller = new AbortController()
    const d = deps({
      resolveAccessToken: async () => {
        controller.abort()
        return 'jwt'
      }
    })
    const result = await createA2aDriver(d).run('owner-1', REMOTE, input(controller.signal))
    expect(result).toEqual({ text: '', parts: [], notices: [] })
    expect(d.runTurn).not.toHaveBeenCalled()
  })

  it('tells the agent to cancel its task on abort — once', async () => {
    // Moved here from both callers, so the orchestrator's tool and the user's
    // Stop cancel the same way. `streamToAgent.cancel` only aborts now; were
    // it still to send `tasks/cancel` too, the agent would get two.
    const cancelTask = vi.fn(async () => ({}))
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const d = deps({
      runTurn: vi.fn(async (turn: A2ARunAgentTurnInput) => {
        turn.onClient?.({ cancelTask } as never)
        turn.onTaskId?.('task-1')
        const aborted = new Promise<void>((resolve) =>
          turn.signal.addEventListener('abort', () => resolve())
        )
        markStarted()
        await aborted
        return { text: 'half', parts: [], notices: [] }
      })
    })
    const pending = createA2aDriver(d).run('owner-1', REMOTE, input(controller.signal))
    // Past the pre-flight and into the stream, with a task to cancel.
    await started
    controller.abort()
    await pending
    expect(cancelTask).toHaveBeenCalledTimes(1)
    expect(cancelTask).toHaveBeenCalledWith({ id: 'task-1' })
  })

  it('cancels nothing when the stop lands before a task exists', async () => {
    const cancelTask = vi.fn(async () => ({}))
    const controller = new AbortController()
    const d = deps({
      runTurn: vi.fn(async (turn: A2ARunAgentTurnInput) => {
        turn.onClient?.({ cancelTask } as never)
        controller.abort()
        return { text: '', parts: [], notices: [] }
      })
    })
    await createA2aDriver(d).run('owner-1', REMOTE, input(controller.signal))
    expect(cancelTask).not.toHaveBeenCalled()
  })

  it('never answers a parked ask: A2A parks nothing', () => {
    expect(
      createA2aDriver(deps()).respond(
        { requestId: 'task-1', chatId: 'chat-1', agentId: REMOTE.id, kind: 'question' },
        { kind: 'question', answers: [['yes']] }
      )
    ).toEqual({ delivered: false })
  })
})

describe('a2a driver — readiness', () => {
  const refused = (): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } })

  it('is ok when the card comes back, fetched with the agent’s token', async () => {
    const fetchCard = vi.fn(async () => ({}))
    await expect(createA2aDriver(deps({ fetchCard })).readiness('owner-1', REMOTE)).resolves.toEqual({
      state: 'ok',
      reason: null
    })
    expect(fetchCard).toHaveBeenCalledWith('https://agents.example/card', 'jwt')
  })

  it('probes a disabled row like any other', async () => {
    const fetchCard = vi.fn(async () => ({}))
    await createA2aDriver(deps({ fetchCard })).readiness('owner-1', { ...REMOTE, enabled: false } as AgentRow)
    expect(fetchCard).toHaveBeenCalledTimes(1)
  })

  it('calls a row with no card invalid, and says where to add one', async () => {
    await expect(
      createA2aDriver(deps()).readiness('owner-1', { ...REMOTE, cardUrl: null } as AgentRow)
    ).resolves.toEqual({
      state: 'invalid',
      reason: 'This agent has no card URL. Add one in Settings → Agents.'
    })
  })

  it('reports an expired Cinna session as a state, without raising anything', async () => {
    const fetchCard = vi.fn()
    await expect(
      createA2aDriver(deps({ resolveAccessToken: () => Promise.reject(new Reauth('gone')), fetchCard })).readiness(
        'owner-1',
        REMOTE
      )
    ).resolves.toEqual({ state: 'not_logged_in', reason: CINNA_SESSION_EXPIRED_MESSAGE, detail: 'gone' })
    expect(fetchCard).not.toHaveBeenCalled()
  })

  it('reads a 401 on the card as a lost session for a synced agent, and a wrong token for a hand-added one', async () => {
    const rejected = (): Promise<never> =>
      Promise.reject(new A2aHttpError(401, 'Unauthorized', 'https://agents.example/card'))
    const raw = 'A2A request to https://agents.example/card rejected: 401 Unauthorized'
    await expect(createA2aDriver(deps({ fetchCard: rejected })).readiness('owner-1', REMOTE)).resolves.toEqual({
      state: 'not_logged_in',
      reason: CINNA_SESSION_EXPIRED_MESSAGE,
      detail: raw
    })
    await expect(createA2aDriver(deps({ fetchCard: rejected })).readiness('owner-1', LOCAL)).resolves.toEqual({
      state: 'credentials_needed',
      reason: 'The agent refused its access token (401). Check it in Settings → Agents.',
      detail: raw
    })
  })

  it('calls an agent that cannot be reached unreachable, with the network error kept as detail', async () => {
    // The reason sits beside a disabled Send, truncated: a short sentence with
    // no URL in front. Mutation: put `humanizeA2AError(err)` back in `reason`
    // fails this — on screen that read "fetch failed".
    await expect(
      createA2aDriver(deps({ fetchCard: () => Promise.reject(refused()) })).readiness('owner-1', LOCAL)
    ).resolves.toEqual({
      state: 'unreachable',
      reason: 'Can’t reach this agent.',
      detail: 'Could not reach agent (connection refused).'
    })
  })

  it('answers null — could not tell — for a card that never arrives, which refuses nothing', async () => {
    // A turn's own card fetch has no bound, so a slow agent still answers a
    // turn. Mutation: map the timeout to `unreachable` again fails this.
    await expect(
      createA2aDriver(deps({ fetchCard: () => new Promise(() => {}), readinessTimeoutMs: 10 })).readiness(
        'owner-1',
        LOCAL
      )
    ).resolves.toBeNull()
  })

  it('answers null when the token resolve never returns — the bound covers the whole check', async () => {
    // A synced agent's token resolve can refresh the Cinna session over a
    // request with no bound of its own. Mutation: bound only the card fetch
    // again fails this (by timing out): the check held a list-time slot for ever.
    const fetchCard = vi.fn(async () => ({}))
    await expect(
      createA2aDriver(
        deps({ resolveAccessToken: () => new Promise(() => {}), fetchCard, readinessTimeoutMs: 10 })
      ).readiness('owner-1', REMOTE)
    ).resolves.toBeNull()
    expect(fetchCard).not.toHaveBeenCalled()
  })

  it('tells a missing card from a failing server, and puts the status in the reason', async () => {
    const status = (code: number): (() => Promise<never>) => () =>
      Promise.reject(new AgentCardFetchError(code, 'x', 'https://agents.example/card'))
    const notFound = await createA2aDriver(deps({ fetchCard: status(404) })).readiness('owner-1', LOCAL)
    const down = await createA2aDriver(deps({ fetchCard: status(503) })).readiness('owner-1', LOCAL)
    expect(notFound).toMatchObject({
      state: 'invalid',
      reason: 'There is no agent card at this address (404).'
    })
    expect(down).toMatchObject({
      state: 'unreachable',
      reason: 'The agent’s server returned an error (503).'
    })
    expect(down?.detail).toContain('https://agents.example/card')
  })

  it('calls a card that offers no protocol this build speaks invalid', async () => {
    const result = await createA2aDriver(
      deps({ fetchCard: () => Promise.reject(new Error('Agent does not support A2A protocol v0.3.x')) })
    ).readiness('owner-1', LOCAL)
    expect(result).toEqual({
      state: 'invalid',
      reason: 'This agent’s card can’t be used by this app.',
      detail: 'Agent does not support A2A protocol v0.3.x'
    })
  })

  it('never throws, even when a dependency throws synchronously', async () => {
    const d = deps({
      fetchCard: () => {
        throw new Error('sync')
      }
    })
    await expect(createA2aDriver(d).readiness('owner-1', LOCAL)).resolves.toMatchObject({ state: 'invalid' })
  })
})
