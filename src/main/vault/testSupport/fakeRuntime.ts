/** Test support only: nothing in `src/main` imports this at runtime. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { VaultEngine } from '../../../shared/vault/protocol'
import type { RuntimeArtifact, RuntimePin, RuntimeSource } from '../runtimeInstall'

/**
 * A stand-in for `@agentclientprotocol/claude-agent-acp/dist/index.js`: plain
 * Node, no imports beyond builtins, answering ACP ndjson on stdio the way the
 * driver needs — `initialize`, `session/new`, `session/load`, `session/set_mode`,
 * and `session/prompt` with one `agent_message_chunk` that echoes the prompt
 * and the cwd and HOME it runs with, then `end_turn`. Every request it gets is
 * appended to `$HOME/fake-adapter.log` inside the vault.
 */
export const FAKE_CLAUDE_ADAPTER = `
const fs = require('node:fs')
const path = require('node:path')
const log = path.join(process.env.HOME || '/tmp', 'fake-adapter.log')
let buffered = ''
let sessions = 0
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let nl
  while ((nl = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, nl).trim()
    buffered = buffered.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    try { fs.appendFileSync(log, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n') } catch {}
    if (msg.id === undefined) continue
    switch (msg.method) {
      case 'initialize':
        send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } } })
        break
      case 'session/new':
      case 'session/load':
        // Like claude-agent-acp: a cwd that is not on this machine is refused.
        if (!fs.existsSync(msg.params.cwd)) {
          send({ id: msg.id, error: { code: -32602, message: 'Invalid params: \\\`cwd\\\` does not exist on the machine running the agent: ' + msg.params.cwd } })
          break
        }
        if (msg.method === 'session/load') { send({ id: msg.id, result: {} }); break }
        sessions++
        send({ id: msg.id, result: { sessionId: 'fake-session-' + sessions } })
        break
      case 'session/prompt': {
        const text = (msg.params.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
        // A tool call carrying the prompt's words, as a Bash call would carry a command.
        send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Bash', kind: 'execute', status: 'completed', rawInput: { command: 'echo ' + text } } } })
        send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'vault says: ' + text + ' [cwd=' + process.cwd() + ' home=' + process.env.HOME + ' key=' + (process.env.ANTHROPIC_API_KEY ? 'set' : 'unset') + ']' } } } })
        setTimeout(() => send({ id: msg.id, result: { stopReason: 'end_turn' } }), 20)
        break
      }
      default:
        send({ id: msg.id, result: {} })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

/** A fake `claude` executable (vaultd only checks that it is there; `auth status` is never asked with an API key). */
export const FAKE_CLAUDE_EXECUTABLE = `#!/bin/sh
echo '{"loggedIn": false}'
`

async function* bytesOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer
}

/** A tar of `node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` holding {@link FAKE_CLAUDE_ADAPTER}. */
export function fakeAdapterTar(workDir: string): Buffer {
  const stage = join(workDir, 'adapter-stage')
  const dir = join(stage, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), FAKE_CLAUDE_ADAPTER)
  // CommonJS even under a parent package.json that says "type": "module".
  writeFileSync(join(stage, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'), '{"name":"@agentclientprotocol/claude-agent-acp","version":"0.0.0-fake","type":"commonjs"}\n')
  const out = join(workDir, 'adapter.tar')
  const result = spawnSync('tar', ['-c', '-f', out, '-C', stage, ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []), 'node_modules'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`)
  return readFileSync(out)
}

/**
 * A runtime source with the fake executable and adapter. `executableSha`
 * overrides the pin the guest's hash is compared with (to prove a mismatch fails).
 */
export function fakeRuntimeSource(workDir: string, options: { executableSha?: string } = {}): RuntimeSource & { calls: number } {
  const executable = Buffer.from(FAKE_CLAUDE_EXECUTABLE)
  const adapter = fakeAdapterTar(workDir)
  const executableSha = options.executableSha ?? createHash('sha256').update(executable).digest('hex')
  const source = {
    calls: 0,
    pins: (engine: VaultEngine): RuntimePin[] => ({ claude: [
      { engine: 'claude', kind: 'executable', version: '9.9.9-fake', sha256: executableSha },
      { engine: 'claude', kind: 'adapter', version: '0.0.0-fake', sha256: null }
    ] } as Partial<Record<VaultEngine, RuntimePin[]>>)[engine] ?? [],
    async artifacts(): Promise<RuntimeArtifact[]> {
      source.calls++
      return [
        {
          engine: 'claude', version: '9.9.9-fake', kind: 'executable', name: 'claude',
          open: () => bytesOf(executable),
          expectedSha256: executableSha
        },
        { engine: 'claude', version: '0.0.0-fake', kind: 'adapter', name: 'claude-agent-acp', open: () => bytesOf(adapter), expectedSha256: null }
      ]
    }
  }
  return source
}

/** Bundle the real cinna-vaultd to `<dir>/vaultd.mjs` (what `out/main/vaultd.js` is), for the fake backend. */
export async function buildVaultd(dir: string): Promise<string> {
  const { build } = await import('esbuild')
  const outfile = join(dir, 'vaultd.mjs')
  await build({
    entryPoints: [resolve(__dirname, '../../../../native/vault/guest/vaultd/src/main.ts')],
    outfile, bundle: true, platform: 'node', target: 'node22', format: 'esm', legalComments: 'none', logLevel: 'warning'
  })
  return outfile
}
