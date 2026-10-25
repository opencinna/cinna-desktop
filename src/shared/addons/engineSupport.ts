/**
 * Which parts of an addon each local engine can use — the one place that
 * knows the matrix (unified addons D4). Shared, pure: main computes an
 * entry's compatibility with it, the picker's detail lists it per engine.
 *
 * | part        | Claude          | OpenCode      | Codex          | Antigravity    |
 * |-------------|-----------------|---------------|----------------|----------------|
 * | skills      | plugin          | skills.paths  | prompt pointer | prompt pointer |
 * | MCP servers | Cinna provider  | Cinna provider| Cinna provider | Cinna provider |
 * | commands    | native (plugin) | Cinna expands | Cinna expands  | Cinna expands  |
 * | agents      | native          | —             | —              | —              |
 * | hooks       | native          | —             | —              | —              |
 * | LSP         | native          | —             | —              | —              |
 *
 * MCP is never the reason an entry is not compatible: every local engine is a
 * stdio ACP launch the conductor bridge reaches, and a plugin's servers are
 * delivered as Cinna MCP providers. OpenCode's agent format does not map from
 * Claude's (`agents/*.md`), so agents are Claude only. A plugin's commands run
 * natively only on Claude; elsewhere the ACP driver expands a typed one into
 * a plain prompt (`pluginCommandExpansion`).
 */

import type { AgentEngine } from '../engine'
import type { AddonComponents } from './directory'

export type AddonPart = 'skills' | 'mcpServers' | 'commands' | 'agents' | 'hooks' | 'lspServers'

export const ADDON_PARTS: readonly AddonPart[] = ['skills', 'mcpServers', 'commands', 'agents', 'hooks', 'lspServers']

/** The engines in the order the detail lists them after the agent's own. */
export const ADDON_ENGINES: readonly AgentEngine[] = ['claude', 'opencode', 'codex', 'antigravity']

const SUPPORT: Readonly<Record<AddonPart, ReadonlySet<AgentEngine>>> = {
  skills: new Set<AgentEngine>(['claude', 'opencode', 'codex', 'antigravity']),
  mcpServers: new Set<AgentEngine>(['claude', 'opencode', 'codex', 'antigravity']),
  commands: new Set<AgentEngine>(['claude', 'opencode', 'codex', 'antigravity']),
  agents: new Set<AgentEngine>(['claude']),
  hooks: new Set<AgentEngine>(['claude']),
  lspServers: new Set<AgentEngine>(['claude'])
}

export const ENGINE_LABELS: Readonly<Record<AgentEngine, string>> = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

/** Lowercase plural nouns for a sentence: "Skills and connectors only on Codex". */
const PART_NOUNS: Readonly<Record<AddonPart, string>> = {
  skills: 'skills',
  mcpServers: 'connectors',
  commands: 'commands',
  agents: 'agents',
  hooks: 'hooks',
  lspServers: 'language servers'
}

export function engineSupports(engine: AgentEngine, part: AddonPart): boolean {
  return SUPPORT[part].has(engine)
}

/** What the user turned off on a pinned plugin (the manifest's `disabled`, camelCased). */
export interface AddonDisabledParts {
  hooks?: boolean
  mcpServers?: readonly string[]
  skills?: readonly string[]
}

/** The parts an entry has, less what is turned off. */
export function enabledParts(components: AddonComponents, disabled: AddonDisabledParts | null = null): AddonPart[] {
  const off = (names: readonly string[] | undefined, name: string): boolean => !!names && names.includes(name)
  const parts: AddonPart[] = []
  if (components.skills.some((skill) => !off(disabled?.skills, skill.name))) parts.push('skills')
  if (components.mcpServers.some((server) => !off(disabled?.mcpServers, server.name))) parts.push('mcpServers')
  if (components.commands.length > 0) parts.push('commands')
  if (components.agents.length > 0) parts.push('agents')
  if (components.hooks && components.hooks.events.length > 0 && disabled?.hooks !== true) parts.push('hooks')
  if (components.lspServers.length > 0) parts.push('lspServers')
  return parts
}

export type AddonCompatibility =
  | { level: 'compatible'; reason: null }
  | { level: 'partly_compatible'; reason: string }
  | { level: 'incompatible'; reason: string }

function joinNouns(nouns: string[]): string {
  if (nouns.length <= 1) return nouns.join('')
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * Whether an entry's enabled parts work on `engine`: `compatible` when every
 * one does, `partly_compatible` when at least one does (with the sentence
 * "Skills and connectors only on Codex"), `incompatible` when none does. An
 * entry with no part at all is compatible: nothing in it fails. MCP is never
 * the reason — it works everywhere.
 */
export function compatibilityOf(
  components: AddonComponents,
  disabled: AddonDisabledParts | null,
  engine: AgentEngine
): AddonCompatibility {
  const parts = enabledParts(components, disabled)
  const usable = parts.filter((part) => engineSupports(engine, part))
  const unusable = parts.filter((part) => !engineSupports(engine, part))
  if (unusable.length === 0) return { level: 'compatible', reason: null }
  const label = ENGINE_LABELS[engine]
  if (usable.length === 0) return { level: 'incompatible', reason: `Not for ${label}` }
  return { level: 'partly_compatible', reason: `${capitalised(joinNouns(usable.map((part) => PART_NOUNS[part])))} only on ${label}` }
}

/** One engine's line in the picker's "Works with": which enabled parts it uses and which it leaves out. */
export interface EngineDetail {
  engine: AgentEngine
  label: string
  level: AddonCompatibility['level']
  supported: AddonPart[]
  unsupported: AddonPart[]
}

/** Every engine's detail, the agent's own engine first. */
export function engineDetails(
  components: AddonComponents,
  disabled: AddonDisabledParts | null,
  agentEngine: AgentEngine | null
): EngineDetail[] {
  const parts = enabledParts(components, disabled)
  const order = agentEngine ? [agentEngine, ...ADDON_ENGINES.filter((engine) => engine !== agentEngine)] : [...ADDON_ENGINES]
  return order.map((engine) => ({
    engine,
    label: ENGINE_LABELS[engine],
    level: compatibilityOf(components, disabled, engine).level,
    supported: parts.filter((part) => engineSupports(engine, part)),
    unsupported: parts.filter((part) => !engineSupports(engine, part))
  }))
}
