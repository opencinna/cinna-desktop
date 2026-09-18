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
  it('refuses synthetic Codex sessions because its adapter overrides the no-file-tools policy', () => {
    expect(() => applyConductorToolPolicy(plan(), 'codex')).toThrow('Choose Claude or OpenCode')
  })
})
