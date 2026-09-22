import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { findContractCodex, makeScratch, spawnAdapter, startFakeProvider, writeProviderConfig, type ProviderReply, type AdapterMessage } from './codexHarness'
import { findContractClaude, makeClaudeScratch, startEgressTrap, startFakeAnthropic, type ClaudeProviderReply } from './claudeHarness'
const require = createRequire(import.meta.url)
describe('credential path reaches pinned runtime script children', () => {
  it.each(['claude', 'codex'] as const)('%s reads a credential outside cwd using the injected path', async engine => {
    const binary = engine === 'claude' ? findContractClaude(RUNTIME_PINS.claude.cli) : findContractCodex(RUNTIME_PINS.codex.cli)
    expect(binary, `Install pinned ${engine} before probing`).not.toBeNull()
    let claudeReplies: ClaudeProviderReply[] = [], codexReplies: ProviderReply[] = []
    const trap = await startEgressTrap()
    const claude = engine === 'claude' ? await startFakeAnthropic(turn => turn.kind === 'title' ? { kind: 'text', text: 'Credential probe' } : claudeReplies.shift() ?? { kind: 'text', text: 'OK' }) : undefined
    const codex = engine === 'codex' ? await startFakeProvider(turn => turn.kind !== 'conversation' ? { kind: 'text', text: 'OK' } : codexReplies.shift() ?? { kind: 'text', text: 'OK' }) : undefined
    const scratch = engine === 'claude' ? makeClaudeScratch('cinna-credential-claude-', { providerPort: claude!.port, trapPort: trap.port }) : makeScratch('.cinna-credential-codex-', process.cwd())
    const path = join(scratch.home, 'credentials.json')
    writeFileSync(path, JSON.stringify([{ credential_data: { marker: 'CREDENTIAL_SCRIPT_OK' } }]), { mode: 0o600 })
    if (codex) writeProviderConfig((scratch as ReturnType<typeof makeScratch>).codexHome, codex.port, 'gpt-5.5')
    const adapter = require.resolve(engine === 'claude' ? '@agentclientprotocol/claude-agent-acp/dist/index.js' : '@agentclientprotocol/codex-acp/dist/index.js')
    const connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: { ...scratch.env, CINNA_CREDENTIALS_PATH: path,
      ...(engine === 'claude' ? { CLAUDE_CODE_EXECUTABLE: binary!.path } : { CODEX_PATH: binary!.path, INITIAL_AGENT_MODE: 'read-only', MODEL_PROVIDER: 'probe', CODEX_CONFIG: JSON.stringify({ model: 'gpt-5.5', model_provider: 'probe' }) }) }, answer: (request: AdapterMessage) => {
        const option = (request.params?.options as { kind: string; optionId: string }[] | undefined)?.find(o => o.kind === 'allow_once')
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined
      } })
    try {
      await connection.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'credentials-probe', version: '1' } })
      const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], ...(claude ? { _meta: { claudeCode: { options: { settingSources: [], systemPrompt: 'Run the requested script, then answer OK.', strictMcpConfig: true, mcpServers: {} } } } } : {}) }, 60_000)
      expect(created.error).toBeUndefined()
      const cmd = `sh -c 'cat "$CINNA_CREDENTIALS_PATH"'`
      if (claude) claudeReplies = [{ kind: 'tool', name: 'Bash', input: { command: cmd, description: 'Read dummy credential fixture through the injected path' } }]
      else codexReplies = [{ kind: 'tool', name: 'exec_command', args: JSON.stringify({ cmd, yield_time_ms: 10000, max_output_tokens: 1000 }) }]
      const result = await connection.rpc('session/prompt', { sessionId: created.result?.sessionId, prompt: [{ type: 'text', text: 'Run the fixture script through CINNA_CREDENTIALS_PATH.' }] }, 60_000)
      expect(result.error).toBeUndefined()
      const outputs = claude ? claude.turns.flatMap(t => t.toolResults) : codex!.turns.flatMap(t => t.outputs)
      expect(outputs.join('\n')).toContain('CREDENTIAL_SCRIPT_OK')
    } finally { await connection.close(); await claude?.close(); await codex?.close(); await trap.close(); scratch.dispose() }
  })
})


describe('OpenCode credential path contract', () => {
  it('reads the bare credential path from a shell child', async () => {
    let replies: ClaudeProviderReply[] = []
    const provider = await startFakeAnthropic(turn => !turn.tools.length ? { kind: 'text', text: 'Credential probe' } : replies.shift() ?? { kind: 'text', text: 'OK' })
    const scratch = makeScratch('cinna-credential-opencode-')
    const binary = join(homedir(), '.cache/cinna-e2e/engine', `opencode-${RUNTIME_PINS.opencode.cli}`, 'opencode')
    const path = join(scratch.home, 'credentials.json')
    writeFileSync(path, JSON.stringify([{ marker: 'OPENCODE_CREDENTIAL_SCRIPT_OK' }]), { mode: 0o600 })
    const config = join(scratch.cwd, 'opencode.json')
    writeFileSync(config, JSON.stringify({ model: 'anthropic/claude-sonnet-4-6', enabled_providers: ['anthropic'], permission: { '*': 'ask' }, provider: { anthropic: { options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: 'fixture-key' } } } }))
    const shim = join(scratch.home, 'opencode.cjs')
    writeFileSync(shim, `require('node:child_process').spawn(${JSON.stringify(binary)}, ['acp'], {stdio: 'inherit'}).on('exit', c => process.exit(c || 0))`)
    const connection = spawnAdapter({ adapterPath: shim, cwd: scratch.cwd, env: { ...scratch.env, CINNA_CREDENTIALS_PATH: path, OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: scratch.cwd, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }, answer: request => {
      const option = (request.params?.options as { kind: string; optionId: string }[] | undefined)?.find(o => o.kind === 'allow_once')
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined
    } })
    try {
      await connection.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'credentials-probe', version: '1' } })
      const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [] }, 60_000)
      expect(created.error).toBeUndefined()
      replies = [{ kind: 'tool', name: 'bash', input: { command: `sh -c 'cat "$CINNA_CREDENTIALS_PATH"'`, description: 'Read a dummy credential fixture' } }]
      const result = await connection.rpc('session/prompt', { sessionId: created.result?.sessionId, prompt: [{ type: 'text', text: 'Run the fixture script.' }] }, 60_000)
      expect(result.error).toBeUndefined()
      expect(provider.turns.flatMap(t => t.toolResults).join('\n'), JSON.stringify({ turns: provider.turns.map(t => ({ model: t.model, tools: t.tools, results: t.toolResults })), stderr: connection.stderr() })).toContain('OPENCODE_CREDENTIAL_SCRIPT_OK')
    } finally { await connection.close(); await provider.close(); scratch.dispose() }
  })
})
