import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MarketplacePluginPin } from '../../shared/kit/manifest'

/**
 * Claude's wrapper plugins for a kit agent's pinned marketplace plugins: our
 * own plugin.json, a link per top-level entry of the cached plugin — never
 * its `.mcp.json` (its servers are Cinna-managed) nor its `skills/` (they join
 * the agent's skills plugin) — and `hooks/` only while neither the pin nor the
 * admin's policy turns hooks off. The OpenCode commands are read from the
 * same tree.
 */

const host = vi.hoisted(() => ({ userData: '' }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => host.userData } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { ensureAgentPluginWrappers, agentPluginWrappersRoot } = await import('./agentPluginWrappers')
const { readPluginTree } = await import('./pluginTree')
const { pluginCommands } = await import('../engine/engineConfigSource')

let root: string
let pluginDir: string

function write(rel: string, body: string): void {
  const file = join(pluginDir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
}

const pin = (over: Partial<MarketplacePluginPin> = {}): MarketplacePluginPin => ({
  entry_uuid: '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f',
  marketplace_uuid: 'm',
  marketplace_name: 'Official',
  name: 'carbone',
  archive_sha256: 'a'.repeat(64),
  ...over
})

const plugin = (over: Partial<MarketplacePluginPin> = {}) => ({ pin: pin(over), dir: pluginDir, tree: readPluginTree(pluginDir) })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-plugin-wrappers-'))
  host.userData = join(root, 'userData')
  pluginDir = join(root, 'cache', 'carbone')
  write('.claude-plugin/plugin.json', JSON.stringify({ name: 'carbone', version: '1.2.0', description: 'Docs.', mcpServers: { x: { command: 'node' } }, hooks: './hooks/hooks.json' }))
  write('.mcp.json', '{"mcpServers":{"carbone":{"command":"node"}}}')
  write('skills/report/SKILL.md', '---\nname: report\ndescription: r\n---\n')
  write('commands/render.md', '---\ndescription: "Render a template"\n---\nRender $ARGUMENTS\n')
  write('agents/reviewer.md', '# Reviewer\n')
  write('hooks/hooks.json', '{"hooks":{"PreToolUse":[]}}')
  write('scripts/run.sh', '#!/bin/sh\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ensureAgentPluginWrappers', () => {
  it('links every top-level entry but the plugin’s .mcp.json, skills and manifest, with a plugin.json of its own', () => {
    const [dir] = ensureAgentPluginWrappers('folder:a', [plugin()], { hooksAllowed: true })
    expect(dir).toBe(join(agentPluginWrappersRoot('folder:a'), 'carbone'))
    const names = readdirSync(dir).filter((name) => !name.startsWith('.cinna-')).sort()
    expect(names).toEqual(['.claude-plugin', 'agents', 'commands', 'hooks', 'scripts'])
    for (const name of ['agents', 'commands', 'hooks', 'scripts']) {
      expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(dir, name))).toBe(join(pluginDir, name))
    }
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
    expect(existsSync(join(dir, 'skills'))).toBe(false)
    // Only name, description and version: no inline mcpServers or hooks ride along.
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({ name: 'carbone', description: 'Docs.', version: '1.2.0' })
  })

  it('leaves hooks out when the pin turns them off or the admin forbids them', () => {
    const [off] = ensureAgentPluginWrappers('folder:a', [plugin({ disabled: { hooks: true } })], { hooksAllowed: true })
    expect(existsSync(join(off, 'hooks'))).toBe(false)
    expect(existsSync(join(off, 'commands'))).toBe(true)
    const [policy] = ensureAgentPluginWrappers('folder:b', [plugin()], { hooksAllowed: false })
    expect(existsSync(join(policy, 'hooks'))).toBe(false)
  })

  it('builds nothing for a plugin with nothing for Claude beyond skills and servers, and removes a wrapper no longer wanted', () => {
    expect(ensureAgentPluginWrappers('folder:a', [plugin()], { hooksAllowed: true })).toHaveLength(1)
    for (const dir of ['commands', 'agents', 'hooks']) rmSync(join(pluginDir, dir), { recursive: true })
    expect(ensureAgentPluginWrappers('folder:a', [plugin()], { hooksAllowed: true })).toEqual([])
    expect(readdirSync(agentPluginWrappersRoot('folder:a'))).toEqual([])
  })

  it('never takes a reserved plugin name, and skips a plugin not on this computer', () => {
    expect(ensureAgentPluginWrappers('folder:a', [plugin()], { hooksAllowed: true, reserved: ['carbone'] })).toEqual([])
    expect(ensureAgentPluginWrappers('folder:a', [{ pin: pin(), dir: null, tree: null }], { hooksAllowed: true })).toEqual([])
  })
})

describe('the plugin tree, read for OpenCode', () => {
  it('reads the servers from .mcp.json and each command as a template with its description', () => {
    const tree = readPluginTree(pluginDir)
    expect(tree).toMatchObject({ skills: ['report'], hasAgents: true, hasHooks: true, manifest: { name: 'carbone', version: '1.2.0' } })
    expect(tree.mcpServers.map((server) => [server.name, server.transport, server.command])).toEqual([['carbone', 'stdio', 'node']])
    expect(pluginCommands([plugin()])).toEqual({ commands: [{ name: 'carbone:render', template: 'Render $ARGUMENTS\n', description: 'Render a template' }] })
    expect(pluginCommands([{ pin: pin(), dir: null, tree: null }])).toEqual({})
  })
})
