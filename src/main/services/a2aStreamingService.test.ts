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
