/** Test-only legacy MCP process. Logs synthetic selected env and protocol, never the whole environment. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.argv[2]
if (!logPath) throw new Error('A fixture log path is required')
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
log({ kind: 'start', pid: process.pid, env: {
  HOME: process.env.HOME,
  MCP_TEST_SHELL_SECRET: process.env.MCP_TEST_SHELL_SECRET ?? null,
  MCP_TEST_EXPLICIT: process.env.MCP_TEST_EXPLICIT ?? null
} })
process.on('exit', (code) => log({ kind: 'exit', pid: process.pid, code }))
process.on('SIGTERM', () => { log({ kind: 'signal', signal: 'SIGTERM' }); process.exit(0) })
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const rpc = JSON.parse(line)
  log({ kind: 'rpc', rpc })
  if (rpc.id === undefined) return
  let result
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} },
    serverInfo: { name: 'stdio-raw-peer', version: '1.0.0' } }
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'peer_echo', description: 'Echo fixture',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }
  else if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: `stdio:${rpc.params.arguments.value}` }] }
  else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n`)
})
lines.on('close', () => { log({ kind: 'stdin-closed' }); process.exit(0) })
