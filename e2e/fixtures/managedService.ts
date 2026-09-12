import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BetaManagedAgentsStreamSessionEvents as ManagedEvent } from '@anthropic-ai/sdk/resources/beta/sessions/events'

export const MANAGED_NAME = 'Checklist Managed Agent'
export const MANAGED_KEY = 'sk-ant-api-e2e-synthetic-managed-key'
export const MANAGED_REMOTE_ID = 'managed-checklist-agent'
export const MANAGED_ENVIRONMENT = 'managed-checklist-environment'
export const MANAGED_WORKSPACE = 'workspace-e2e'
export const FIRST_PROMPT = 'Inspect the deployment checklist.'
export const SECOND_PROMPT = 'Summarize the approved checklist.'
export const BUDGET_PROMPT = 'Check the remaining remote budget.'
export const UNCERTAIN_PROMPT = 'Inspect the checklist with a lost confirmation response.'
export const BEFORE_PERMISSION = 'Checklist verified before approval: cedar-8142.'
export const AFTER_PERMISSION = 'The approved checklist is complete: maple-9637.'
export const SECOND_ANSWER = 'The same session remembers its approved checklist: pine-5276.'
export const BUDGET_ANSWER = 'The remote budget is exhausted: oak-2318.'
const STAMP = '2026-09-12T12:00:00Z'
interface SentEvent { type: string; [key: string]: unknown }
export interface ManagedRequest { method: string; path: string; workspace?: string; key?: string; body?: Record<string, unknown> & { events?: SentEvent[] } }
export interface ManagedSessionFixture { id: string; history: ManagedEvent[]; streams: Set<ServerResponse>; turns: number; uncertain: boolean; held: { res: ServerResponse; acknowledgment: unknown }[] }
const text = (id: string, value: string): ManagedEvent => ({ type: 'agent.message', id, processed_at: STAMP, content: [{ type: 'text', text: value }] })
const idle = (id: string, reason: 'end_turn' | 'budget_reached' = 'end_turn'): ManagedEvent => ({ type: 'session.status_idle', id, processed_at: STAMP, stop_reason: { type: reason } })

/** Real account discovery + Managed session HTTP/SSE. No model inference or app IPC is replaced. */
export async function serveManaged() {
  const requests: ManagedRequest[] = []
  const sessions = new Map<string, ManagedSessionFixture>()
  const unexpected: string[] = []
  const state = { holdConfirmation: true, failChoices: false, failSave: false }
  const json = (res: ServerResponse, value: unknown, status = 200): void => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
  }
  const emit = (session: ManagedSessionFixture, ...events: ManagedEvent[]): void => {
    session.history.push(...events)
    for (const event of events) for (const stream of session.streams) stream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const agent = { id: MANAGED_REMOTE_ID, name: MANAGED_NAME, description: 'A deployment checklist assistant.', version: 1 }
  const environment = { id: MANAGED_ENVIRONMENT, name: 'Checklist workspace' }
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const row: ManagedRequest = { method: req.method ?? 'GET', path, key: req.headers['x-api-key'] as string | undefined,
      workspace: req.headers['anthropic-workspace-id'] as string | undefined }
    requests.push(row)
    if (req.method === 'GET' && ['/v1/agents', '/v1/environments'].includes(path)) {
      if (state.failChoices) { json(res, { error: { type: 'api_error', message: 'Fixture workspace temporarily unavailable.' } }, 503); return }
      json(res, { data: path === '/v1/agents' ? [agent] : [environment], next_page: null }); return
    }
    if (req.method === 'GET' && [ `/v1/agents/${MANAGED_REMOTE_ID}`, `/v1/environments/${MANAGED_ENVIRONMENT}` ].includes(path)) {
      if (state.failSave) { json(res, { error: { type: 'api_error', message: 'Fixture agent verification temporarily unavailable.' } }, 503); return }
      json(res, path.includes('/agents/') ? agent : environment); return
    }
    // A harmless catalogue probe can occur when the credential is displayed. No inference route is implemented.
    if (req.method === 'GET' && path === '/v1/models') { json(res, { data: [], has_more: false }); return }
    const sessionId = path.split('/')[3]
    const session = sessions.get(sessionId)
    if (req.method === 'GET' && session && path.endsWith('/events/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders()
      session.streams.add(res); res.on('close', () => session.streams.delete(res)); return
    }
    if (req.method === 'GET' && session && path.endsWith('/events')) { json(res, { data: session.history, next_page: null }); return }
    if (req.method === 'GET' && session && path === `/v1/sessions/${sessionId}`) { json(res, { id: session.id, status: 'idle', usage: {}, budget: {} }); return }
    if (req.method !== 'POST') { unexpected.push(`${req.method} ${path}`); json(res, { error: 'Unexpected fixture path' }, 404); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      row.body = JSON.parse(body)
      if (path === '/v1/sessions') {
        const id = `sesn_e2e_${sessions.size + 1}`
        sessions.set(id, { id, history: [], streams: new Set(), turns: 0, uncertain: false, held: [] })
        json(res, { id, status: 'idle', budget: {}, usage: {} }); return
      }
      const event = row.body?.events?.[0]
      if (!session || !event || !path.endsWith('/events')) { unexpected.push(`POST ${path}`); json(res, { error: 'Unexpected inference or event' }, 400); return }
      if (event.type === 'user.message') {
        session.turns++
        const content = event.content as { type: string; text?: string }[]
        const prompt = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('')
        const id = `${session.id}-user-${session.turns}`
        emit(session, { type: 'user.message', id, processed_at: STAMP, content: [{ type: 'text', text: prompt }] })
        if (prompt === FIRST_PROMPT || prompt === UNCERTAIN_PROMPT) {
          session.uncertain = prompt === UNCERTAIN_PROMPT
          const toolId = `${session.id}-permission`
          emit(session, text(`${id}-before`, BEFORE_PERMISSION), { type: 'agent.tool_use', id: toolId, processed_at: STAMP,
            name: 'bash', input: { command: 'printf checklist-reviewed' }, evaluated_permission: 'ask' },
          { type: 'session.status_idle', id: `${id}-waiting`, processed_at: STAMP, stop_reason: { type: 'requires_action', event_ids: [toolId] } })
        } else if (prompt === SECOND_PROMPT) emit(session, text(`${id}-answer`, SECOND_ANSWER), idle(`${id}-done`))
        else if (prompt === BUDGET_PROMPT) emit(session, text(`${id}-answer`, BUDGET_ANSWER), idle(`${id}-budget`, 'budget_reached'))
        else { unexpected.push(`message:${prompt}`); emit(session, idle(`${id}-unexpected`)) }
        json(res, { data: [{ type: 'user.message', id, content: [{ type: 'text', text: prompt }], processed_at: null }] }); return
      }
      if (event.type === 'user.tool_confirmation') {
        if (session.uncertain) { res.destroy(); return }
        const acknowledgment = { data: [{ ...event, id: `${session.id}-confirmation`, processed_at: null }] }
        // The stream can overtake HTTP confirmation. Local acceptance/commit must remain the barrier.
        emit(session, { type: 'user.tool_confirmation', id: `${session.id}-confirmation`, processed_at: STAMP,
          tool_use_id: String(event.tool_use_id), result: event.result as 'allow' | 'deny' },
          text(`${session.id}-after`, AFTER_PERMISSION), idle(`${session.id}-done`))
        if (state.holdConfirmation) session.held.push({ res, acknowledgment }); else json(res, acknowledgment)
        return
      }
      if (event.type === 'user.interrupt') {
        const interrupt = { type: 'user.interrupt' as const, id: `${session.id}-interrupt`, processed_at: STAMP }
        emit(session, interrupt, idle(`${session.id}-stopped`))
        json(res, { data: [interrupt] }); return
      }
      unexpected.push(`event:${event.type}`); json(res, { error: 'Unexpected event type' }, 400)
    })
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, sessions, state, unexpected,
    releaseConfirmation(id: string) { const session = sessions.get(id)!; for (const held of session.held.splice(0)) json(held.res, held.acknowledgment) },
    async close() { for (const session of sessions.values()) { for (const stream of session.streams) stream.destroy(); for (const held of session.held) held.res.destroy() }
      server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())) }
  }
}
export type ManagedServiceFixture = Awaited<ReturnType<typeof serveManaged>>
