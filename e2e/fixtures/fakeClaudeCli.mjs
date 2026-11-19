// A stand-in for the `claude` CLI, behind the real `@agentclientprotocol/claude-agent-acp`
// adapter (see `fakeClaudeCli.ts`). It speaks the Agent SDK's stream-json control
// protocol on stdio, just enough for `session/new`, a model or effort change and one
// short turn:
//
// - `--version` and `auth status` answer as a logged-in install does;
// - `control_request` `initialize` answers with the models in FAKE_CLAUDE_CONFIG
//   (`{ models: [{ value, displayName, description, supportsEffort?, supportedEffortLevels? }] }`);
// - every other `control_request` succeeds with an empty response;
// - a `user` message is echoed back (`isReplay`) under `--replay-user-messages`, as the
//   real CLI does, and answered with one assistant text and a costed `result`: the
//   constant `reply`, or, when `echoPattern` (a regex source) matches the prompt's text,
//   `Heard <match>.` — so the reply says which prompt the CLI was sent;
// - a `user` message whose text contains `holdMarker` starts a turn that does not end on
//   its own: one assistant `tool_use` of `Bash` (`sleep 600`), then nothing until the
//   SDK's `interrupt` control request. That is answered as the real CLI answers an
//   interrupt during a tool: the control response, a `tool_result` of
//   `[Request interrupted by user for tool use]` and a `result` of subtype
//   `error_during_execution` with `terminal_reason: 'aborted_tools'`. The interrupt of a
//   held turn is logged as `{ dir: 'event', event: 'interrupted', toolUseId }`.
//
// Every line it reads, and its argv, is appended to FAKE_CLAUDE_LOG (JSONL, each entry
// with the process's `pid` and `cwd`), the only witness of what the adapter asked of
// the CLI.
import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const LOG = process.env.FAKE_CLAUDE_LOG
const log = (entry) => { if (LOG) appendFileSync(LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...entry }) + '\n') }

if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '9.9.9'} (Claude Code)\n`)
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }) + '\n')
  process.exit(0)
}

const config = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_CONFIG, 'utf8'))
const flag = (name) => {
  const joined = args.find((arg) => arg.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID()
let model = flag('--model') ?? config.models[0]?.value ?? 'default'
log({ dir: 'argv', args })

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const ok = (requestId, response = {}) =>
  send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })

const usage = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const promptText = (message) => {
  const content = message.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : ''
}
const init = () => send({
  type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), model,
  cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [],
  apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '9.9.9', output_style: 'default', agents: [], skills: [], plugins: []
})
const assistant = (content, stopReason) => send({
  type: 'assistant', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
  message: {
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
    content, stop_reason: stopReason, stop_sequence: null, usage
  }
})
const modelUsage = () => ({ [model]: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0001, contextWindow: 200000, maxOutputTokens: 32000 } })
/** The tool use of the turn held open by `holdMarker`, until an interrupt ends it. */
let held = null

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  log({ dir: 'in', message })
  if (message.type === 'control_request') {
    const request = message.request ?? {}
    switch (request.subtype) {
      case 'interrupt': {
        ok(message.request_id)
        if (!held) return
        const toolUseId = held
        held = null
        log({ dir: 'event', event: 'interrupted', toolUseId })
        send({
          type: 'user', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '[Request interrupted by user for tool use]', is_error: true }] }
        })
        send({
          type: 'result', subtype: 'error_during_execution', is_error: false, duration_ms: 5, duration_api_ms: 5, num_turns: 1,
          stop_reason: null, terminal_reason: 'aborted_tools', session_id: sessionId, uuid: randomUUID(), total_cost_usd: 0.0001, usage,
          modelUsage: modelUsage(), permission_denials: [], errors: []
        })
        return
      }
      case 'initialize':
        return ok(message.request_id, {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: config.models,
          account: { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }
        })
      case 'set_model':
        model = request.model ?? model
        return ok(message.request_id)
      case 'mcp_status':
        return ok(message.request_id, { mcpServers: [] })
      default:
        return ok(message.request_id)
    }
  }
  if (message.type === 'control_response' || message.type === 'keep_alive') return
  if (message.type === 'user') {
    const said = promptText(message)
    // The real CLI echoes each prompt it takes up, under the uuid it was sent with,
    // when asked to (`--replay-user-messages`); the adapter starts the prompt's turn
    // at that echo, which is what ends a cancel's hold on the session.
    if (args.includes('--replay-user-messages')) {
      send({ type: 'user', message: message.message, session_id: sessionId, parent_tool_use_id: null, uuid: message.uuid ?? randomUUID(), isReplay: true })
    }
    init()
    if (config.holdMarker && said.includes(config.holdMarker)) {
      held = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
      log({ dir: 'event', event: 'held', toolUseId: held })
      assistant([{ type: 'tool_use', id: held, name: 'Bash', input: { command: 'sleep 600', description: 'Wait for ten minutes' } }], 'tool_use')
      return
    }
    const heard = config.echoPattern ? said.match(new RegExp(config.echoPattern)) : null
    const text = heard ? `Heard ${heard[0]}.` : (config.reply ?? 'Fake Claude answered.')
    assistant([{ type: 'text', text }], 'end_turn')
    send({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 5, num_turns: 1,
      result: text, stop_reason: 'end_turn', session_id: sessionId, uuid: randomUUID(), total_cost_usd: 0.0001, usage,
      modelUsage: modelUsage(), permission_denials: []
    })
  }
}).on('close', () => process.exit(0))
