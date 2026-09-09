/**
 * `streamToAgent`'s guarantee to the renderer: **the port always gets a
 * verdict.**
 *
 * `useChatStream` leaves the streaming state on `done` or on `error` and on
 * nothing else, so a port that closes having posted neither leaves the chat
 * spinning until the app restarts. That is not a hypothetical — it is what
 * `LocalAgentTurnRunner` did when `turnLock.acquire` refused a second
 * concurrent turn, because this `try` had only a `finally`.
 *
 * The runner is fixed at its own end too. This is the wrapper every future
 * runner passes through, and it must not depend on all of them keeping the
 * `AgentTurnRunner.runTurn` contract that says they never throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../shared/agentStreamEvents'

const saved: { short: string }[] = []
const runCompletions: { status: string; message?: string }[] = []

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/messages', () => ({
  messageRepo: {
    saveError: (i: { short: string }) => saved.push(i),
    saveAssistant: () => {},
    saveTransition: () => {},
    touchChat: () => {}
  }
}))
vi.mock('../db/agents', () => ({ a2aSessionRepo: { getByChatAndAgent: () => undefined, upsert: () => {} } }))
vi.mock('./jobService', () => ({
  jobService: {
    reportRunCompletion: (_c: string, status: string, message?: string) =>
      runCompletions.push({ status, message })
  }
}))

import { a2aStreamingService } from './a2aStreamingService'

function fakePort(): { posted: AgentStreamEvent[]; closed: boolean; port: { postMessage: (m: AgentStreamEvent) => void; close: () => void } } {
  const posted: AgentStreamEvent[] = []
  const state = { closed: false }
  return {
    posted,
    get closed() {
      return state.closed
    },
    port: {
      postMessage: (m) => void posted.push(m),
      close: () => {
        state.closed = true
      }
    }
  }
}

describe('a2aStreamingService.streamToAgent', () => {
  beforeEach(() => {
    saved.length = 0
    runCompletions.length = 0
  })

  it('posts an error when a runner throws instead of returning', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      // A runner that breaks the "never throws" contract — which is exactly
      // what the local runner did via `turnLock.acquire`.
      runner: {
        runTurn: async () => {
          throw new Error('This agent is busy right now. Try again when the current run finishes.')
        }
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      agentName: 'Helper',
      wireContent: 'hi',
      port: p.port
    })

    // Mutation: delete the `catch` block, leaving only `try`/`finally` → this
    // fails with only the `request-id` event posted. In production that is a
    // chat that spins forever, unrecoverable without restarting the app.
    const kinds = p.posted.map((e) => e.type)
    expect(kinds).toContain('error')
    expect(kinds).not.toContain('done')
    expect(p.closed).toBe(true)

    // The failure must also be durable and must release the job, or a Job
    // waiting on this run never completes either.
    expect(saved).toHaveLength(1)
    expect(saved[0].short).toContain('busy right now')
    expect(runCompletions).toEqual([
      { status: 'failed', message: 'This agent is busy right now. Try again when the current run finishes.' }
    ])
  })

  it('a runner cancelled cleanly is a stop, not a success — the exit a stop actually takes', async () => {
    // **The common case, and the one the error branches below do not cover.** A
    // cancelled runner returns what it streamed with *no error* — that is the
    // documented `AgentTurnRunner` contract and what both folder runners do —
    // so a stopped turn leaves through the success path. Reporting `succeeded`
    // there is the same lie the OpenAI adapter told by resolving on abort: the
    // job run reads as one that finished, indistinguishable from one that did.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      runner: {
        runTurn: async () => {
          const requestId = p.posted.find((e) => e.type === 'request-id')
          a2aStreamingService.cancel((requestId as { requestId: string }).requestId)
          // Exactly what a cancelled runner returns: whatever streamed, no error.
          return { text: 'half an ans', parts: [{ kind: 'text' as const, text: 'half an ans' }], notices: [] }
        }
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      agentName: 'Helper',
      wireContent: 'hi',
      port: p.port
    })

    // `done` still goes out and the partial answer is still kept — a stop is
    // not an error and the user keeps what they were given.
    expect(p.posted.map((e) => e.type)).toContain('done')
    expect(p.posted.map((e) => e.type)).not.toContain('error')
    expect(runCompletions).toEqual([{ status: 'cancelled', message: undefined }])
  })

  it.each([
    [
      'the runner reports the cancel as an error',
      async (): Promise<{ text: string; parts: []; notices: []; error: { message: string; raw: string } }> => ({
        text: '',
        parts: [],
        notices: [],
        error: { message: 'aborted', raw: 'aborted' }
      })
    ],
    [
      'the runner throws on the way out',
      async (): Promise<never> => {
        throw new Error('aborted')
      }
    ]
  ])('finalizes a stopped run as cancelled when %s', async (_label, runTurn) => {
    // **Suppressing the error surface is not the same as reporting nothing.**
    // Both branches below correctly refuse to post or save a cancel as a
    // failure — and both used to return without finalizing the run at all, so a
    // stopped agent-backed job sat at `running` for the life of the app, with
    // the sidebar's "currently running" badge lit. `chatStreamingService` had
    // the same hole on the LLM path; this is the other half of that fix.
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      runner: {
        runTurn: async (input) => {
          // Stop it the way the user does: through the service's own cancel,
          // keyed by the request id it just posted.
          const requestId = p.posted.find((e) => e.type === 'request-id')
          a2aStreamingService.cancel((requestId as { requestId: string }).requestId)
          void input
          return runTurn()
        }
      },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      agentName: 'Helper',
      wireContent: 'hi',
      port: p.port
    })

    // A stop is not a failure: nothing posted as an error, nothing persisted.
    expect(p.posted.map((e) => e.type)).not.toContain('error')
    expect(saved).toHaveLength(0)
    // But it is an ending.
    expect(runCompletions).toEqual([{ status: 'cancelled', message: undefined }])
  })

  it('still posts done on the ordinary path', async () => {
    const p = fakePort()
    await a2aStreamingService.streamToAgent({
      runner: { runTurn: async () => ({ text: 'hello', parts: [{ kind: 'text', text: 'hello' }], notices: [] }) },
      chatId: 'chat_1',
      agentId: 'folder:abc',
      agentName: 'Helper',
      wireContent: 'hi',
      port: p.port
    })
    // Guards against a `catch` written so broadly it swallows success.
    expect(p.posted.map((e) => e.type)).toEqual(['request-id', 'done'])
    expect(runCompletions).toEqual([{ status: 'succeeded', message: undefined }])
  })
})
