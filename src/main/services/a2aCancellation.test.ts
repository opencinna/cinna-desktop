import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import type { A2AClient } from '@a2a-js/sdk/client'

const session = vi.hoisted(() => ({ getByChatAndAgent: vi.fn(), upsert: vi.fn() }))
vi.mock('../db/agents', () => ({ agentSessionRepo: session }))
vi.mock('../db/messages', () => ({ messageRepo: {} }))
vi.mock('./jobService', () => ({ jobService: {} }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const { runAgentTurn } = await import('./a2aStreamingService')

// Real loopback HTTP, fetch, logging tee and SDK parser. The server deliberately
// never finishes the held response, even when it acknowledges tasks/cancel.
it.each(['card headers', 'card body', 'JSON headers', 'JSON body', 'silent SSE', 'first delta', 'first artifact delta'] as const)(
  'stops while waiting for %s without remote cooperation', async (mode) => {
    session.getByChatAndAgent.mockReset()
    session.upsert.mockReset()
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => { ready = resolve })
    const calls: string[] = []
    const streaming = mode === 'silent SSE' || mode.endsWith('delta')
    let origin = ''
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') {
        if (mode.startsWith('card')) {
          if (mode === 'card body') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.write('{')
          }
          ready()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ name: 'Silent agent', version: '1', protocolVersion: '0.3.0',
          url: origin + '/rpc', capabilities: { streaming },
          skills: [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const rpc = JSON.parse(Buffer.concat(chunks).toString())
      calls.push(rpc.method)
      if (rpc.method === 'tasks/cancel') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          kind: 'task', id: 'task-silent', contextId: 'context-silent', status: { state: 'canceled' }
        } }))
        return
      }
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const result = mode === 'first artifact delta' ? {
          kind: 'artifact-update', taskId: 'task-silent', contextId: 'context-silent',
          artifact: { artifactId: 'first-artifact', parts: [{ kind: 'text', text: 'Keep this partial answer.' }] }
        } : {
          kind: 'task', id: 'task-silent', contextId: 'context-silent', status: { state: 'working',
            message: { kind: 'message', messageId: 'partial', role: 'agent',
              parts: [{ kind: 'text', text: 'Keep this partial answer.' }] } }
        }
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`)
      } else {
        if (mode === 'JSON body') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.write('{')
        }
        ready()
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const controller = new AbortController()
    let client: A2AClient | undefined
    let taskId: string | undefined
    const events: unknown[] = []
    try {
      const pending = runAgentTurn({ chatId: 'chat-silent', agentId: 'agent-silent', agentName: 'Silent agent',
        endpointUrl: origin + '/rpc', cardUrl: origin + '/card.json', wireContent: 'Start',
        signal: controller.signal, onClient: (value) => { client = value },
        onTaskId: (value) => { taskId = value }, onEvent: (event) => {
          events.push(event)
          if (mode.endsWith('delta') && event.type === 'delta') { controller.abort(); ready() }
          if (event.type === 'status' && event.state === 'working') ready()
        } })
      await waiting
      const eventCount = events.length
      controller.abort()
      const result = await Promise.race([pending,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Stop did not settle')), 1000)
          timer.unref()
          void pending.finally(() => clearTimeout(timer))
        })])
      expect(result.error).toBeDefined()
      expect(events).toHaveLength(eventCount)
      // A stop saves nothing past the ids the stream's first task event
      // carried (crash recovery); a non-streaming turn saves nothing.
      if (streaming) {
        expect(session.upsert).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-silent', agentId: 'agent-silent',
          contextId: 'context-silent', taskId: 'task-silent', taskState: null })
      } else expect(session.upsert).not.toHaveBeenCalled()
      expect(result.text).toBe(streaming ? 'Keep this partial answer.' : '')
      if (mode.endsWith('delta')) expect(events).toHaveLength(1)
      if (streaming) {
        expect(taskId).toBe('task-silent')
        await client!.cancelTask({ id: taskId! })
        expect(calls).toEqual(['message/stream', 'tasks/cancel'])
      } else expect(calls).toEqual(mode.startsWith('card') ? [] : ['message/send'])
    } finally {
      controller.abort()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
)
