import { describe, expect, it } from 'vitest'
import { compatibilityOf, enabledParts, engineDetails, engineSupports } from './engineSupport'
import type { AddonComponents } from './directory'

/**
 * The engine matrix (unified addons D4): what each engine uses of a plugin,
 * and the one sentence an entry's compatibility reads as. MCP never makes an
 * entry incompatible; what the user turned off is not judged.
 */

function components(over: Partial<AddonComponents> = {}): AddonComponents {
  return { skills: [], commands: [], agents: [], hooks: null, mcpServers: [], lspServers: [], ...over }
}

const SKILL = { name: 'pdf', hasScripts: false }
const SERVER = { name: 'carbone', transport: 'stdio' as const, runtime: 'node' as const, auth: 'none' as const, env: [] }

describe('engineSupport', () => {
  it('holds the matrix', () => {
    expect(['claude', 'opencode', 'codex', 'antigravity'].map((e) => engineSupports(e as never, 'skills'))).toEqual([true, true, true, true])
    expect(['claude', 'opencode', 'codex', 'antigravity'].map((e) => engineSupports(e as never, 'mcpServers'))).toEqual([true, true, true, true])
    expect(['claude', 'opencode', 'codex', 'antigravity'].map((e) => engineSupports(e as never, 'commands'))).toEqual([true, true, true, true])
    for (const part of ['agents', 'hooks', 'lspServers'] as const) {
      expect(['claude', 'opencode', 'codex', 'antigravity'].map((e) => engineSupports(e as never, part))).toEqual([true, false, false, false])
    }
  })

  it('is compatible when every enabled part works, and MCP is never the reason', () => {
    expect(compatibilityOf(components({ skills: [SKILL], mcpServers: [SERVER] }), null, 'codex')).toEqual({ level: 'compatible', reason: null })
    expect(compatibilityOf(components({ mcpServers: [SERVER] }), null, 'antigravity').level).toBe('compatible')
    expect(compatibilityOf(components(), null, 'codex').level).toBe('compatible')
    expect(compatibilityOf(components({ skills: [SKILL], commands: ['c'], hooks: { events: ['PreToolUse'] } }), null, 'claude').level).toBe('compatible')
  })

  it('says which parts work when only some do', () => {
    const plugin = components({ skills: [SKILL], mcpServers: [SERVER], commands: ['c'], hooks: { events: ['Stop'] } })
    expect(compatibilityOf(plugin, null, 'codex')).toEqual({ level: 'partly_compatible', reason: 'Skills, connectors and commands only on Codex' })
    expect(compatibilityOf(plugin, null, 'opencode')).toEqual({ level: 'partly_compatible', reason: 'Skills, connectors and commands only on OpenCode' })
  })

  it('is incompatible when no enabled part works', () => {
    expect(compatibilityOf(components({ agents: ['a'], hooks: { events: ['Stop'] } }), null, 'antigravity')).toEqual({ level: 'incompatible', reason: 'Not for Antigravity' })
  })

  it('judges only what is turned on', () => {
    const plugin = components({ skills: [SKILL], hooks: { events: ['Stop'] } })
    expect(compatibilityOf(plugin, null, 'codex').level).toBe('partly_compatible')
    expect(compatibilityOf(plugin, { hooks: true }, 'codex').level).toBe('compatible')
    expect(enabledParts(components({ skills: [SKILL], mcpServers: [SERVER] }), { skills: ['pdf'], mcpServers: ['carbone'] })).toEqual([])
    expect(enabledParts(components({ hooks: { events: [] } }))).toEqual([])
  })

  it('lists every engine, the agent’s own first', () => {
    const details = engineDetails(components({ skills: [SKILL], commands: ['c'], agents: ['a'] }), null, 'codex')
    expect(details.map((d) => [d.engine, d.level])).toEqual([
      ['codex', 'partly_compatible'],
      ['claude', 'compatible'],
      ['opencode', 'partly_compatible'],
      ['antigravity', 'partly_compatible']
    ])
    expect(details[0]).toMatchObject({ label: 'Codex', supported: ['skills', 'commands'], unsupported: ['agents'] })
  })
})
