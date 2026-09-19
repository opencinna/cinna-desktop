/** Native folder evidence for file handovers: real engines, local fake models only. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConductorMcpServer } from '../../../../services/conductorMcpServer'
import { makeScratch, spawnAdapter, startFakeProvider, writeProviderConfig, type AdapterConnection, type AdapterMessage, type ProviderReply } from './codexHarness'
import { makeClaudeScratch, startFakeAnthropic, type ClaudeProviderReply, type EgressTrap } from './claudeHarness'

type Json = Record<string, unknown>
export interface HandoverProbe {
  writes: { mode: string; accepted: boolean; permissionCount: number; kinds: string[]; titles: string[]; wrote: boolean; outputs: string[]; promptError: unknown }[]
  mcp: { nativeTools: boolean; first: boolean; second: boolean; loaded: boolean; calls: string[]; listReads: number; differentDescriptors: boolean; outputs: string[] }
}
const allow = (request: AdapterMessage): Json | undefined => {
  const options = request.params?.options as Json[] | undefined
  const option = options?.find((value) => value.kind === 'allow_once')
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined
}
const initial = (): HandoverProbe => ({ writes: [], mcp: { nativeTools: false, first: false, second: false, loaded: false, calls: [], listReads: 0, differentDescriptors: false, outputs: [] } })

export async function probeFolderHandovers(engine: 'claude' | 'codex', binary: string, adapterPath: string, trap?: EgressTrap): Promise<HandoverProbe> {
  const result = initial()
  let claudeScript: ClaudeProviderReply[] = [], codexScript: ProviderReply[] = []
  const claude = engine === 'claude' ? await startFakeAnthropic((turn) => turn.kind === 'title' ? { kind: 'text', text: 'Handover probe' } : claudeScript.shift() ?? { kind: 'text', text: 'OK' }) : undefined
  const codex = engine === 'codex' ? await startFakeProvider((turn) => turn.kind === 'title' ? { kind: 'text', text: '{"title":"Handover probe"}' } : turn.kind !== 'conversation' ? { kind: 'text', text: 'Summary.' } : codexScript.shift() ?? { kind: 'text', text: 'OK' }) : undefined
  const scratch = engine === 'claude' ? makeClaudeScratch('cinna-handover-claude-', { providerPort: claude!.port, trapPort: trap!.port }) : makeScratch('.cinna-handover-codex-', process.cwd())
  const mcp = new ConductorMcpServer()
  let connection: AdapterConnection | undefined
  const marker = 'HANDOVER_OUTSIDE_WRITE_OK'
  const options = { systemPrompt: 'Use the requested tool then answer OK.', settingSources: [], strictMcpConfig: true, mcpServers: {} }
  const meta = engine === 'claude' ? { claudeCode: { options } } : undefined
  try {
    if (codex) writeProviderConfig((scratch as ReturnType<typeof makeScratch>).codexHome, codex.port, 'gpt-5.5')
    connection = spawnAdapter({ adapterPath, cwd: scratch.cwd, answer: allow, env: {
      ...scratch.env,
      ...(engine === 'claude' ? { CLAUDE_CODE_EXECUTABLE: binary } : { CODEX_PATH: binary, INITIAL_AGENT_MODE: 'read-only', MODEL_PROVIDER: 'probe', CODEX_CONFIG: JSON.stringify({ model: 'gpt-5.5', model_provider: 'probe' }) })
    } })
    const initialized = await connection.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-handover-probe', version: '1' } })
    if (initialized.error) throw new Error(JSON.stringify(initialized.error))
    const sibling = join(scratch.home, 'sibling')
    mkdirSync(sibling)
    for (const mode of engine === 'claude' ? ['default', 'auto'] : ['read-only', 'agent']) {
      const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) }, 60_000)
      const sessionId = String(created.result?.sessionId ?? '')
      if (!sessionId) throw new Error(JSON.stringify(created.error))
      const accepted = !(await connection.rpc('session/set_mode', { sessionId, modeId: mode })).error
      for (const escalation of engine === 'codex' ? [false, true] : [false]) {
        const label = mode + (escalation ? ':escalated' : '')
        const path = join(sibling, `${label}.txt`)
        const before = connection.clientRequests.length
        const beforeTurns = (claude?.turns.length ?? codex!.turns.length)
        if (claude) claudeScript = [{ kind: 'tool', name: 'Write', input: { file_path: path, content: marker } }]
        else codexScript = [{ kind: 'tool', name: 'exec_command', args: JSON.stringify({ cmd: `printf '%s' '${marker}' > '${path}'`, yield_time_ms: 1000, max_output_tokens: 1000, ...(escalation ? { sandbox_permissions: 'require_escalated', justification: 'Write the authorized scratch sibling file.' } : {}) }) }]
        const prompt = await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `Write ${marker} to the sibling file ${path}.` }] }, 60_000)
        const permissions = connection.clientRequests.slice(before).filter((request) => request.method === 'session/request_permission')
        result.writes.push({ mode: label, accepted, permissionCount: permissions.length,
          kinds: permissions.map((request) => String((request.params?.toolCall as Json)?.kind ?? '')),
          titles: permissions.map((request) => String((request.params?.toolCall as Json)?.title ?? (request.params?.toolCall as Json)?.name ?? '').replaceAll(scratch.home, '<scratch>')),
          wrote: existsSync(path) && readFileSync(path, 'utf8') === marker,
          outputs: (claude ? claude.turns.slice(beforeTurns).flatMap((turn) => turn.toolResults) : codex!.turns.slice(beforeTurns).flatMap((turn) => turn.pendingOutputs ? turn.outputs.slice(-turn.pendingOutputs) : [])).map((output) => output.replaceAll(scratch.home, '<scratch>')),
          promptError: prompt.error ?? null })
      }
    }
    const sessions = await Promise.all(['first', 'second'].map((identity) => mcp.ensureSession(`handover-${identity}`, { getProviders: () => {
      result.mcp.listReads++
      return [{ providerType: 'mcp', displayName: 'handover probe', getTools: () => [{ name: 'probe', description: 'Return the session identity.', inputSchema: { type: 'object', properties: {} }, providerType: 'mcp', mcpProviderId: 'probe' }],
        callTool: async () => { result.mcp.calls.push(identity); return { content: `HANDOVER_SESSION_${identity}` } } }]
    } } as never)))
    result.mcp.differentDescriptors = JSON.stringify(sessions[0].descriptor) !== JSON.stringify(sessions[1].descriptor)
    const call = async (sessionId: string, identity: string): Promise<void> => {
      if (claude) claudeScript = [{ kind: 'tool', name: 'mcp__cinna__probe' }]
      else codexScript = [{ kind: 'tool-search', args: { query: 'cinna probe', limit: 1 } }, { kind: 'tool', name: 'probe' }]
      await connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `Call the cinna probe for ${identity}.` }] }, 60_000)
    }
    const ids: string[] = []
    for (let index = 0; index < sessions.length; index++) {
      const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [sessions[index].descriptor], ...(meta ? { _meta: meta } : {}) }, 60_000)
      const id = String(created.result?.sessionId ?? '')
      ids.push(id)
      if (id) await call(id, index === 0 ? 'first' : 'second')
    }
    result.mcp.first = result.mcp.calls.includes('first')
    result.mcp.second = result.mcp.calls.includes('second')
    const beforeLoad = result.mcp.calls.length
    const loaded = await connection.rpc('session/load', { sessionId: ids[0], cwd: scratch.cwd, mcpServers: [sessions[0].descriptor], ...(meta ? { _meta: meta } : {}) }, 60_000)
    if (!loaded.error) await call(ids[0], 'loaded first')
    result.mcp.loaded = !loaded.error && result.mcp.calls.slice(beforeLoad).includes('first')
    result.mcp.nativeTools = claude ? claude.turns.some((turn) => turn.tools.includes('Write') && turn.tools.includes('mcp__cinna__probe')) : codex!.turns.some((turn) => turn.tools.some((name) => name.endsWith('exec_command')))
    result.mcp.outputs = (claude ? claude.turns.flatMap((turn) => turn.toolResults) : codex!.turns.flatMap((turn) => turn.outputs)).filter((output) => output.includes('HANDOVER_SESSION_'))
    return result
  } finally {
    await connection?.close()
    await mcp.dispose()
    await claude?.close()
    await codex?.close()
    scratch.dispose()
  }
}

/** Only stable outcomes belong in the pin snapshot; CLI durations and call ids do not. */
export function handoverProbeSnapshot(probe: HandoverProbe | null): Json | null {
  if (!probe) return null
  return {
    writes: probe.writes.map(({ outputs, ...write }) => ({ ...write,
      deniedBySandbox: outputs.some((output) => /operation not permitted|permission denied/i.test(output)),
      reviewUnavailable: outputs.some((output) => /could not evaluate|approval review failed/.test(output)) })),
    mcp: { ...probe.mcp, listReads: probe.mcp.listReads > 0, outputs: [...new Set(probe.mcp.outputs.flatMap((output) => output.match(/HANDOVER_SESSION_(first|second)/g) ?? []))].sort() }
  }
}
