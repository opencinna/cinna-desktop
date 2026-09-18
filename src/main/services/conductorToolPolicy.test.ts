import { describe, expect, it } from 'vitest'
import { applyConductorToolPolicy } from '../agents/drivers/acp/conductorToolPolicy'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'

function plan(): AcpLaunchPlan {
  return {
    spec: { command: 'fake', args: [], cwd: '/tmp', env: { CODEX_CONFIG: JSON.stringify({ model: 'chosen', features: { shell_tool: true } }) }, key: 'original' },
    init: { protocolVersion: 1, clientCapabilities: {} },
    session: { mcpServers: [{ name: 'cinna', type: 'http', url: 'http://127.0.0.1:123/mcp', headers: [] }], meta: { claudeCode: { options: { systemPrompt: 'chosen', tools: ['Bash'], agents: { specialist: {} } } } } },
    setup: { modeId: 'auto' }
  }
}

describe('conductor native tool policy', () => {
  it('removes Claude native tools and subagents while preserving the injected MCP server and system prompt', () => {
    const original = plan()
    const restricted = applyConductorToolPolicy(original, 'claude')
    expect(restricted.session.meta).toMatchObject({ claudeCode: { options: { systemPrompt: 'chosen', tools: [], agents: {}, settingSources: [], strictMcpConfig: true, mcpServers: {} } } })
    expect(restricted.session.mcpServers).toEqual(original.session.mcpServers)
    expect(original.session.meta).toMatchObject({ claudeCode: { options: { tools: ['Bash'] } } })
  })
  it('refuses Codex sessions without a verified restricted launch', () => {
    expect(() => applyConductorToolPolicy(plan(), 'codex')).toThrow('Choose Claude or OpenCode')
  })
  it('preserves a Codex plan sealed by the runtime policy inspector', () => {
    const sealed = { ...plan(), conductorPolicy: 'no-native-tools' as const }
    expect(applyConductorToolPolicy(sealed, 'codex')).toBe(sealed)
  })
})

describe('the conductor permission gate', () => {
  it.each([
    ['claude', 'mcp__cinna__ask_writer', { title: 'ask_writer' }],
    ['codex', 'mcp.cinna.ask_writer', { title: 'mcp.cinna.ask_writer', rawInput: { server: 'cinna', tool: 'ask_writer', arguments: {} } }],
    ['opencode', 'cinna_ask_writer', { title: 'cinna_ask_writer' }]
  ])('lets %s ask about a Cinna tool', async (_engine, toolName, toolCall) => {
    const { isCinnaToolAsk } = await import('../agents/drivers/acp/acpDriver')
    expect(isCinnaToolAsk(toolName, { toolCall: { toolCallId: 'call', ...toolCall } })).toBe(true)
  })
  it.each(['Bash', 'execute', 'mcp__github__search', 'mcp.github.search'])('refuses %s', async (toolName) => {
    const { isCinnaToolAsk } = await import('../agents/drivers/acp/acpDriver')
    expect(isCinnaToolAsk(toolName, { toolCall: { toolCallId: 'call', title: toolName, rawInput: { command: 'ls' } } })).toBe(false)
  })
})
