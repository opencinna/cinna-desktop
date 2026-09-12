import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'

export interface RemoteFrame {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
  params?: Record<string, any>
  result?: any
  error?: { code: number; message: string }
}

/** Wire contract from cinna-core's ACP connector, with deterministic execution. */
export async function fakeRemoteAcp(options: {
  token?: string; version?: number; hangInitialize?: boolean; hangPrompt?: boolean
  disconnectPrompt?: boolean; refuseLoad?: boolean; permission?: boolean; loadSession?: boolean
} = {}) {
  const headers: { authorization?: string; url?: string; origin?: string }[] = []
  const frames: RemoteFrame[] = []
  const sessions = new Set<string>()
  let sessionCount = 0
  let toolCount = 0
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient(info, done) {
    headers.push({ authorization: info.req.headers.authorization, url: info.req.url, origin: info.req.headers.origin })
    done(!options.token || info.req.headers.authorization === `Bearer ${options.token}`, 401, 'Unauthorized')
  } })
  const send = (socket: WebSocket, frame: Omit<RemoteFrame, 'jsonrpc'>) => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
  const update = (socket: WebSocket, sessionId: string, text: string) => send(socket, { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
  server.on('connection', (socket) => {
    const loaded = new Set<string>()
    let prompt: RemoteFrame | undefined
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(); return }
      const frame = JSON.parse(data.toString()) as RemoteFrame
      frames.push(frame)
      const reply = (result: unknown) => send(socket, { id: frame.id, result })
      const error = (code: number, message: string) => send(socket, { id: frame.id, error: { code, message } })
      const id = frame.params?.sessionId as string
      switch (frame.method) {
        case 'initialize':
          if (!options.hangInitialize) reply({ protocolVersion: options.version ?? 1, agentInfo: { name: 'cinna-core', version: '1.0.0' }, agentCapabilities: { loadSession: options.loadSession ?? true, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [], _meta: { cinna: { transport: 'websocket', remoteCwd: '/app/workspace', clientTools: false } } })
          break
        case 'session/new':
        case 'session/load': {
          if (frame.params?.cwd !== '/app/workspace' || JSON.stringify(frame.params?.mcpServers) !== '[]') { error(-32602, 'Remote sessions require cwd=/app/workspace and no client MCP servers'); break }
          if (frame.method === 'session/load') {
            if (options.refuseLoad || !sessions.has(id)) { error(-32001, 'Session not found'); break }
            loaded.add(id); update(socket, id, 'Replayed history must not appear twice.'); reply({}); break
          }
          const created = `00000000-0000-4000-8000-${String(++sessionCount).padStart(12, '0')}`
          sessions.add(created); loaded.add(created); reply({ sessionId: created })
          // Traffic can follow session/new before the desktop binds.
          send(socket, { method: 'session/update', params: { sessionId: created, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } })
          break
        }
        case 'session/prompt':
          if (!loaded.has(id)) { error(-32001, 'Load the session on this connection first'); break }
          prompt = frame
          update(socket, id, 'Remote partial. ')
          if (options.disconnectPrompt) { socket.terminate(); break }
          if (options.permission) {
            const tool = ++toolCount
            send(socket, { id: `permission-${tool}`, method: 'session/request_permission', params: { sessionId: id,
              toolCall: { toolCallId: `tool-${tool}`, title: 'Edit remote file', kind: 'edit', status: 'pending', rawInput: { filepath: '/app/workspace/notes.txt' } },
              options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } })
          } else if (!options.hangPrompt) { update(socket, id, 'Remote answer.'); reply({ stopReason: 'end_turn' }) }
          break
        case 'session/cancel':
          if (prompt) send(socket, { id: prompt.id, result: { stopReason: 'cancelled' } })
          break
        default:
          if (typeof frame.id === 'string' && frame.id.startsWith('permission-') && prompt) { update(socket, prompt.params!.sessionId, 'Remote answer.'); send(socket, { id: prompt.id, result: { stopReason: 'end_turn' } }) }
          else if (frame.method) error(-32601, 'Method not found')
      }
    })
  })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  return {
    url: `ws://127.0.0.1:${address.port}/acp/fixture-connector`, frames, headers, server,
    received: (method: string) => frames.filter((frame) => frame.method === method),
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
}
