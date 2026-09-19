import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CinnaApp } from './app'

/**
 * A hand-added A2A agent on a loopback port that holds every `message/send`
 * until the test answers it — so a job run started through the UI is really
 * running (main has it in `activeRunsByChat`, the sidebar row spins) for as
 * long as the test needs, and ends when the test says so.
 *
 * No model, no engine, no credential: the smallest agent a job can be bound to
 * that still makes a real turn. `autoReply` answers at once instead of holding,
 * for runs that only need to have finished.
 */
export interface HeldCall {
  /** Every text part of the message the desktop sent, joined. */
  text: string
  released: boolean
  release(reply: string): void
}

export interface HeldA2aAgent {
  host: string
  calls: HeldCall[]
  /** When set, a new call is answered with this at once instead of being held. */
  autoReply: ((text: string, index: number) => string) | null
  /** Upsert the agent row through the same IPC the Settings form uses; answers its id. */
  register(cinna: CinnaApp, name: string): Promise<string>
  close(): Promise<void>
}

export async function heldA2aAgent(): Promise<HeldA2aAgent> {
  let host = ''
  const calls: HeldCall[] = []
  const agent: HeldA2aAgent = {
    host: '',
    calls,
    autoReply: null,
    async register(cinna, name) {
      const result = await cinna.page.evaluate(
        ({ base, agentName }) =>
          window.api.agents.upsert({
            name: agentName,
            protocol: 'a2a',
            cardUrl: `${base}/.well-known/agent-card.json`,
            endpointUrl: `${base}/a2a`
          }),
        { base: host, agentName: name }
      )
      if (!result.success || !result.id) throw new Error(`Could not add the fixture agent: ${result.error}`)
      return result.id
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          name: 'Held agent',
          description: 'A fake A2A agent that answers when the E2E test says so',
          url: `${host}/a2a`,
          protocolVersion: '0.3.0',
          version: '1.0.0',
          capabilities: { streaming: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: []
        })
      )
      return
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const rpc = JSON.parse(body) as {
          id: number | string
          params?: { message?: { parts?: Array<{ kind?: string; text?: string }> } }
        }
        const text = (rpc.params?.message?.parts ?? [])
          .map((part) => part.text ?? '')
          .join('\n')
        const index = calls.length
        const call: HeldCall = {
          text,
          released: false,
          release(reply) {
            if (call.released) return
            call.released = true
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  kind: 'message',
                  messageId: `e2e-held-reply-${index}`,
                  role: 'agent',
                  contextId: `e2e-held-context-${index}`,
                  parts: [{ kind: 'text', text: reply }]
                }
              })
            )
          }
        }
        calls.push(call)
        if (agent.autoReply) call.release(agent.autoReply(text, index))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  agent.host = host
  return agent
}
