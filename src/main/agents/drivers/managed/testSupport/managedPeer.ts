import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ManagedEvent } from '../managedEvents'

export const SESSION = 'sesn_peer_session'
export const STAMP = '2026-09-12T10:00:00Z'
export const KEY = 'synthetic-managed-peer-key'
export const user = (id = 'kickoff', processed = true): ManagedEvent => ({ type: 'user.message', id,
  content: [{ type: 'text', text: 'fixture goal' }], processed_at: processed ? STAMP : null })
export const message = (id: string, text: string): ManagedEvent => ({ type: 'agent.message', id,
  processed_at: STAMP, content: [{ type: 'text', text }] })
export const idle = (id: string, type: 'end_turn' | 'budget_reached' = 'end_turn'): ManagedEvent => ({
  type: 'session.status_idle', id, processed_at: STAMP, stop_reason: { type } })
export const permissionTool = (id: string, thread?: string): ManagedEvent => thread
  ? { type: 'agent.mcp_tool_use', id, processed_at: STAMP, name: 'lookup', input: { q: id },
      mcp_server_name: 'peer-tools', evaluated_permission: 'ask', session_thread_id: thread }
  : { type: 'agent.tool_use', id, processed_at: STAMP, name: 'bash', input: { command: 'printf fixture' }, evaluated_permission: 'ask' }
export const requires = (ids: string[]): ManagedEvent => ({ type: 'session.status_idle', id: `requires-${ids.join('-')}`,
  processed_at: STAMP, stop_reason: { type: 'requires_action', event_ids: ids } })
export const interrupted = (processed: boolean): ManagedEvent => ({ type: 'user.interrupt', id: 'interrupt-peer', processed_at: processed ? STAMP : null })
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
export interface SentEvent { type: string; [key: string]: unknown }
export interface PeerRequest { method: string; path: string; page: string | null; body?: { events?: SentEvent[]; [key: string]: unknown }; key?: string; workspace?: string }
export interface PeerOptions {
  pages?: ManagedEvent[][]
  onHistory?: (page: number, res: ServerResponse) => Promise<boolean | void> | boolean | void
  onSend?: (event: SentEvent, peer: ManagedPeer, res: ServerResponse) => Promise<unknown> | unknown
}
export interface ManagedPeer {
  origin: string
  requests: PeerRequest[]
  send(...events: ManagedEvent[]): void
  persist(...events: ManagedEvent[]): void
  sends(type: string): PeerRequest[]
  close(): Promise<void>
}
/** Actual HTTP/SSE peer for the official SDK. No SDK methods or iterators are replaced. */
export async function managedPeer(options: PeerOptions = {}): Promise<ManagedPeer> {
  const requests: PeerRequest[] = []
  const liveHistory: ManagedEvent[] = []
  const streams = new Set<ServerResponse>()
  const json = (res: ServerResponse, value: unknown): void => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const row: PeerRequest = { method: req.method ?? 'GET', path: url.pathname, page: url.searchParams.get('page'),
      key: req.headers['x-api-key'] as string | undefined, workspace: req.headers['anthropic-workspace-id'] as string | undefined }
    requests.push(row)
    if (req.method === 'GET' && url.pathname.endsWith('/events/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders()
      streams.add(res); res.on('close', () => streams.delete(res)); return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/events')) {
      const page = row.page === 'page-two' ? 1 : 0
      void Promise.resolve(options.onHistory?.(page, res)).then((handled) => {
        if (handled || res.destroyed || res.writableEnded) return
        const more = !!options.pages && page + 1 < options.pages.length
        json(res, { data: [...(options.pages?.[page] ?? []), ...(more ? [] : liveHistory)], next_page: more ? 'page-two' : null })
      }); return
    }
    if (req.method === 'GET' && url.pathname === `/v1/sessions/${SESSION}`) {
      json(res, { id: SESSION, status: 'idle', budget: {}, usage: {} }); return
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      row.body = JSON.parse(body)
      if (url.pathname === '/v1/sessions') { json(res, { id: SESSION, status: 'idle', budget: {}, usage: {} }); return }
      const event = row.body?.events?.[0]
      if (!event) { res.writeHead(400); res.end(); return }
      void Promise.resolve(options.onSend?.(event, peer, res)).then(reply => {
        if (reply !== undefined) { json(res, reply); return }
        if (event.type === 'user.message') json(res, { data: [user('kickoff', false)] })
        else if (event.type === 'user.interrupt') json(res, { data: [interrupted(false)] })
        else json(res, { data: [{ ...event, id: `ack-${event.tool_use_id}`, processed_at: null }] })
      })
    })
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const peer: ManagedPeer = { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    persist(...events) { liveHistory.push(...events) },
    send(...events) { liveHistory.push(...events); for (const event of events) for (const res of streams) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`) },
    sends(type) { return requests.filter(row => row.body?.events?.[0]?.type === type) },
    async close() { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())) }
  }
  return peer
}
