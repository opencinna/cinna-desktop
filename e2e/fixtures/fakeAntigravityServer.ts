/**
 * The fake Antigravity server's script (see `fakeAntigravity.ts` for what it
 * does), as text: no imports, so the real-VM lane
 * (`scripts/vault/vault-provider-error-smoke.vault.ts`) packs the same server
 * into a vault with the guest's own `node` in its shebang.
 */

/** The SYSTEM error the `silent-provider-error` fake logs, verbatim from a real 1.4.5 transcript. */
export const FAKE_PROVIDER_ERROR = { error: 'The model is currently unreachable.', code: 503 } as const
/** The MODEL error (a tool denial) logged beside it, which must never be surfaced. */
export const FAKE_MODEL_DENIAL = 'Permission to run the command was denied by the user.'

export type FakeAntigravityMode = 'logged-out' | 'silent-provider-error'

/**
 * `node`: the interpreter path for the shebang. `logDir`: where `requests.jsonl`
 * and `transcripts.jsonl` go; null puts them under the server's own
 * `$HOME/.fake-antigravity` (inside a vault, the agent's home).
 */
export function fakeAntigravityScript(options: { node: string; mode: FakeAntigravityMode; logDir: string | null }): string {
  return `#!${options.node}
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
const LOG_DIR = ${JSON.stringify(options.logDir)} || join(process.env.HOME || '/tmp', '.fake-antigravity')
mkdirSync(LOG_DIR, { recursive: true })
const LOG = join(LOG_DIR, 'requests.jsonl')
const WRITTEN = join(LOG_DIR, 'transcripts.jsonl')
const MODE = ${JSON.stringify(options.mode)}
const PROVIDER_ERROR = ${JSON.stringify(FAKE_PROVIDER_ERROR)}
const MODEL_DENIAL = ${JSON.stringify(FAKE_MODEL_DENIAL)}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const held = new Map()
let sessions = 0
const stamp = () => new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')
function logProviderError(sessionId, promptText) {
  const home = (process.env.GEMINI_HOME || '').trim() || join(process.env.HOME || '', '.gemini')
  const logs = join(home, 'antigravity-acp', 'brain', sessionId, '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const file = join(logs, 'transcript_full.jsonl')
  const steps = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: promptText, created_at: stamp() },
    { step_index: 1, source: 'MODEL', type: 'ERROR_MESSAGE', status: 'DONE', error: MODEL_DENIAL, created_at: stamp() },
    { step_index: 2, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: PROVIDER_ERROR.error, error_code: PROVIDER_ERROR.code, created_at: stamp() }
  ]
  appendFileSync(file, steps.map((step) => JSON.stringify(step)).join('\\n') + '\\n')
  appendFileSync(WRITTEN, JSON.stringify(file) + '\\n')
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (typeof message.method !== 'string') return
  appendFileSync(LOG, JSON.stringify({ method: message.method, params: message.params ?? null }) + '\\n')
  if (MODE === 'silent-provider-error') {
    const params = message.params || {}
    if (message.method === 'session/cancel') {
      const id = held.get(params.sessionId)
      held.delete(params.sessionId)
      if (id !== undefined) send({ id, result: { stopReason: 'cancelled' } })
      return
    }
    if (message.id === undefined || message.id === null) return
    switch (message.method) {
      case 'initialize':
        return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
      case 'authenticate':
        return send({ id: message.id, result: {} }) // a vault signs in with its Gemini API key
      case 'session/new':
        return send({ id: message.id, result: { sessionId: 'ses-silent-' + process.pid + '-' + (++sessions) } })
      case 'session/load':
        return send({ id: message.id, result: {} })
      case 'session/set_mode':
        return send({ id: message.id, result: {} })
      case 'session/set_config_option':
        return send({ id: message.id, result: { configOptions: [] } })
      case 'session/prompt': {
        held.set(params.sessionId, message.id)
        const text = (params.prompt || []).filter((block) => block && block.type === 'text').map((block) => block.text).join('\\n')
        setTimeout(() => logProviderError(params.sessionId, text), 2000)
        return // never answered: the provider error stays in the transcript
      }
      default:
        return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  if (message.id === undefined || message.id === null) return
  switch (message.method) {
    case 'initialize':
      return send({ id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }]
      } })
    case 'authenticate':
      return // held: the real server answers only once the browser sign-in is done
    case 'session/new':
    case 'session/load':
      return send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
    default:
      return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
}).on('close', () => process.exit(0))
`
}
