import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, type CinnaApp } from './app'

/** Real loopback Cinna/A2A fixture shared by the bounded Job executor scenarios. */
export const TITLE = 'Delegate the quarterly briefing'
export const GOAL = 'Prepare the quarterly briefing with the approved revenue figures.'
export const NOTE = 'Revenue figures are verified. Continue with the regional forecast and cite the source sheet.'
export const LOCAL_AGENT = 'Local Briefing Planner'
export const REMOTE_AGENT = 'Remote Briefing Writer'
export const AGENT_ID = 'remote-briefing-writer'
export const REMOTE_ID = 'delegated-quarterly-briefing'
export const REMOTE_KEY = 'BRIEF-91'
export const RECEIPT = `Handed off to ${REMOTE_AGENT} (${REMOTE_KEY}).`
const TOKEN = 'task-handoff-fixture-token'

export interface RemoteTask {
  id: string
  short_code: string
  title: string
  original_message: string
  current_description: string
  priority: string
  status: string
  selected_agent_id: string | null
  agent_name: string | null
  external_ref: string
  updated_at: string
}
interface Request { method: string; path: string; body?: Record<string, unknown> }

export async function jobRemoteService(): Promise<{
  host: string
  server: Server
  requests: Request[]
  state: { task: RemoteTask | null; refuseNote: boolean; dropExecute: boolean; remoteRunning: boolean;
    notes: string[]; localSends: number; includeInLists: boolean; unauthorized: string[] }
}> {
  let host = ''
  const requests: Request[] = []
  const state = { task: null as RemoteTask | null, refuseNote: true, dropExecute: false, remoteRunning: false,
    notes: [] as string[], localSends: 0, includeInLists: true, unauthorized: [] as string[] }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('content-type', 'application/json')
    const send = (value: unknown): void => { res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      send({ name: LOCAL_AGENT, description: LOCAL_AGENT, url: `${host}/a2a`,
        protocolVersion: '0.3.0', version: '1.0.0', capabilities: { streaming: false },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] })
      return
    }
    // Public OAuth discovery runs after profile restart and has no bearer token.
    if (req.method === 'GET' && url.pathname === '/.well-known/cinna-desktop') {
      res.statusCode = 404
      send({ detail: 'No OAuth discovery is configured in this fixture.' })
      return
    }
    if (url.pathname === '/a2a') {
      state.localSends += 1
      res.statusCode = 400
      send({ detail: 'A local run must not start during remote handoff' })
      return
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) state.unauthorized.push(`${req.method} ${url.pathname}`)
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = body ? JSON.parse(body) as Record<string, unknown> : undefined
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body: payload })
      if (req.method === 'GET' && url.pathname === '/api/v1/agents/') {
        send({ data: [{ id: AGENT_ID, name: REMOTE_AGENT, description: 'Writes the delegated briefing.' }], count: 1 })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/tasks/') {
        const since = url.searchParams.get('updated_since')
        const include = state.includeInLists && state.task && (url.searchParams.get('status') === 'active' ||
          (!!since && Date.parse(state.task.updated_at) > Date.parse(since)))
        send({ data: include ? [state.task] : [], count: include ? 1 : 0 })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/tasks/') {
        if (!state.task) state.task = {
          id: REMOTE_ID, short_code: REMOTE_KEY, title: String(payload?.title ?? ''),
          original_message: String(payload?.original_message ?? ''), current_description: '',
          priority: String(payload?.priority ?? 'normal'), status: 'new',
          selected_agent_id: typeof payload?.selected_agent_id === 'string' ? payload.selected_agent_id : null,
          agent_name: payload?.selected_agent_id === AGENT_ID ? REMOTE_AGENT : null,
          external_ref: String(payload?.external_ref ?? ''), updated_at: new Date().toISOString()
        }
        send(state.task)
        return
      }
      if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/detail` && state.task) {
        send(state.task)
        return
      }
      if (req.method === 'GET' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/sessions`) {
        send({ data: state.remoteRunning
          ? [{ id: 'briefing-session', interaction_status: 'running' }] : [],
        count: state.remoteRunning ? 1 : 0 })
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/subtasks/')) {
        send({ data: [], count: 0 })
        return
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/comments/`) {
        if (state.refuseNote) {
          res.statusCode = 400
          send({ detail: 'The fixture refused this handoff note.' })
        } else if (payload?.comment_type !== 'result' || payload.content !== NOTE) {
          res.statusCode = 400
          send({ detail: 'The handoff note or comment type is incorrect.' })
        } else {
          state.notes.push(String(payload.content))
          send({ id: `note-${state.notes.length}`, ...payload })
        }
        return
      }
      if (req.method === 'PATCH' && url.pathname === `/api/v1/tasks/${REMOTE_ID}` && state.task) {
        if (typeof payload?.selected_agent_id === 'string') {
          state.task.selected_agent_id = payload.selected_agent_id
          state.task.agent_name = payload.selected_agent_id === AGENT_ID ? REMOTE_AGENT : null
        }
        if (typeof payload?.current_description === 'string') state.task.current_description = payload.current_description
        if (typeof payload?.title === 'string') state.task.title = payload.title
        state.task.updated_at = new Date().toISOString()
        send(state.task)
        return
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/status` && state.task) {
        state.task.status = String(payload?.status)
        state.task.updated_at = new Date().toISOString()
        send(state.task)
        return
      }
      if (req.method === 'POST' && url.pathname === `/api/v1/tasks/${REMOTE_ID}/execute` && state.task) {
        const valid = state.task.original_message === GOAL && state.task.selected_agent_id === AGENT_ID &&
          state.notes.includes(NOTE) && payload?.mode === 'conversation'
        if (valid) {
          state.remoteRunning = true
          state.task.status = 'in_progress'
          state.task.updated_at = new Date().toISOString()
        }
        if (valid && state.dropExecute) {
          // A warmed reusable connection makes Electron's buffered fetch replay
          // this accepted POST. The one-shot mutation transport must not.
          setTimeout(() => res.destroy(), 1_000)
          return
        }
        send({ success: valid, error: valid ? undefined : 'The goal, recipient or handoff note is missing.' })
        return
      }
      res.statusCode = 404
      send({ detail: 'No fixture route for this request' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, requests, state }
}

export async function linkSandboxAccount(cinna: CinnaApp, host: string): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  expect(user).not.toBeNull()
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${app.getPath('userData')}/cinna.db`)
    try {
      const token = safeStorage.encryptString(input.token)
      db.prepare(`UPDATE users SET type = 'cinna_user', cinna_server_url = ?,
        cinna_access_token_enc = ?, cinna_refresh_token_enc = ?, cinna_token_expires_at = ?
        WHERE id = ?`).run(input.host, token, token, Date.now() + 3_600_000, input.userId)
    } finally { db.close() }
  }, { host, token: TOKEN, userId: user!.id, userData: cinna.sandbox.userData })
}
