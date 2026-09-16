/**
 * The two launchers: what gets spawned, what the config says, and what a
 * refusal reads like.
 *
 * Three of these assertions are the ones worth having. **No key in the config
 * bytes** (Invariant 4 — a credential travels only as an environment variable
 * the config names). **The model stated twice**, because OpenCode ignores the
 * agent entry's own `model` over ACP and would otherwise pick one silently.
 * And **`session/set_mode` on the Claude plan**, because the adapter honours
 * the user's own `defaultMode` — which can be `bypassPermissions` — unless the
 * client sets a mode before the first prompt.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EngineConfigInput } from '../../../engine/configGenerator'
import {
  createClaudeLauncher,
  createOpencodeLauncher,
  isRefusal,
  type AcpLaunchContext,
  type AcpLaunchPlan,
  type AcpPlanResult
} from './acpLaunchers'

const AGENT_ID = 'folder:pineapple'
const FOLDER = {
  name: 'Pineapple',
  slug: 'pineapple',
  description: 'The spike agent.',
  path: '/tmp/agents/pineapple',
  kind: 'kit' as const
}
const CTX: AcpLaunchContext = { userId: 'user-1', agentId: AGENT_ID, folder: FOLDER }

const API_KEY = 'sk-secret-do-not-write-me'

function configInput(overrides: Partial<EngineConfigInput> = {}): EngineConfigInput {
  return {
    providers: [
      {
        id: 'prov-1',
        type: 'anthropic',
        name: 'Anthropic',
        apiKey: API_KEY,
        baseUrl: null,
        models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5' }]
      }
    ],
    agents: [
      {
        agentId: AGENT_ID,
        slug: 'pineapple',
        description: 'The spike agent.',
        prompt: 'You are the pineapple agent.',
        providerId: 'prov-1',
        modelId: 'claude-sonnet-5',
        permissions: null
      }
    ],
    ...overrides
  }
}

/** The per-agent directory name out of the written path, so the test does not re-derive its hash. */
function configDirOf(env: Record<string, string>): string {
  return env.OPENCODE_CONFIG_DIR.split('/').pop() as string
}

function plan(result: AcpPlanResult): AcpLaunchPlan {
  if (isRefusal(result)) throw new Error(`expected a plan, got a refusal: ${result.error}`)
  return result
}

describe('the OpenCode launcher', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'acp-launcher-'))
  })

  const launcher = (input = configInput()) =>
    createOpencodeLauncher({
      binary: async () => ({ path: '/usr/local/bin/opencode', version: '1.18.27' }),
      configInput: async () => input,
      configRoot: () => root,
      childEnv: async () => ({ PATH: '/usr/bin', HOME: '/Users/x' })
    })

  it('does not claim a cost-bearing end marker, so its follow-ups end on a quiet spell', () => {
    expect(launcher().endsTurnsWithCostedUsage).toBeFalsy()
  })

  it('spawns `opencode acp` in the agent’s folder', async () => {
    const p = plan(await launcher().plan(CTX))
    expect(p.spec.command).toBe('/usr/local/bin/opencode')
    expect(p.spec.args).toEqual(['acp'])
    expect(p.spec.cwd).toBe(FOLDER.path)
  })

  it('writes a config holding this agent alone, and names the credential in the environment', async () => {
    const p = plan(await launcher().plan(CTX))
    const configPath = p.spec.env.OPENCODE_CONFIG
    expect(configPath).toContain(root)
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(Object.keys(config.agent)).toHaveLength(1)
    const entry = Object.values(config.agent)[0] as Record<string, unknown>
    expect(entry.prompt).toBe('You are the pineapple agent.')
    expect(entry.mode).toBe('primary')
    // The conversation permission profile, merged in by `buildEngineConfig`.
    expect(entry.permission).toMatchObject({ webfetch: 'ask' })
    const provider = config.provider.anthropic as Record<string, unknown>
    expect(provider.env).toEqual([expect.stringMatching(/^CINNA_ENGINE_KEY_/)])
  })

  it('never writes a key into the config bytes', async () => {
    const p = plan(await launcher().plan(CTX))
    const bytes = readFileSync(p.spec.env.OPENCODE_CONFIG, 'utf8')
    expect(bytes).not.toContain(API_KEY)
    // …and the key does reach the process, under the name the config referenced.
    const named = Object.entries(p.spec.env).find(([, value]) => value === API_KEY)
    expect(named?.[0]).toMatch(/^CINNA_ENGINE_KEY_/)
  })

  it('leaves no temp file behind, so the engine only ever reads a whole config', async () => {
    // The engine reads this file at start. A write interrupted halfway would
    // leave a truncated config for the next turn to spawn an agent on, which is
    // why it is a temp file and a rename — the same thing the shared server's
    // own writer did.
    const p = plan(await launcher().plan(CTX))
    const dir = p.spec.env.OPENCODE_CONFIG_DIR
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // …and a second plan overwrites it without leaving one either.
    plan(await launcher().plan(CTX))
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(dir)).toEqual(['opencode.json'])
  })

  it('states the model in the config and again on the session', async () => {
    // The agent entry's own `model` is ignored over ACP (spike Q1), so a config
    // with only that would start every session on whatever the engine picks.
    const p = plan(await launcher().plan(CTX))
    const config = JSON.parse(readFileSync(p.spec.env.OPENCODE_CONFIG, 'utf8'))
    expect(config.model).toBe('anthropic/claude-sonnet-5')
    expect(p.setup.configOptions).toEqual([
      { configId: 'mode', value: expect.stringMatching(/^pineapple-/) },
      // Optional: the engine's model catalogue is populated asynchronously, so
      // this set can be refused for a model the config has already selected —
      // measured against the real binary, see the launcher.
      { configId: 'model', value: 'anthropic/claude-sonnet-5', optional: true }
    ])
  })

  it('sets both config variables, because only one of them reaches the v2 loader', async () => {
    const p = plan(await launcher().plan(CTX))
    expect(p.spec.env.OPENCODE_CONFIG_DIR).toBe(join(root, 'opencode', configDirOf(p.spec.env)))
    expect(p.spec.env.OPENCODE_CONFIG).toBe(join(p.spec.env.OPENCODE_CONFIG_DIR, 'opencode.json'))
  })

  it('leaves the question tool alone: neither variable that would enable it is set', async () => {
    // Enabled, its answer has nowhere to go over ACP: the probe's question hung
    // for 150 s and had to be cancelled.
    const p = plan(await launcher().plan(CTX))
    expect(p.spec.env.OPENCODE_CLIENT).toBeUndefined()
    expect(p.spec.env.OPENCODE_ENABLE_QUESTION_TOOL).toBeUndefined()
    expect(p.init.clientCapabilities?.elicitation ?? null).toBeNull()
  })

  it('declares no fs and no terminal capability', async () => {
    // Both are removed in ACP's draft v2; a client that never declared them is
    // forward-compatible.
    const p = plan(await launcher().plan(CTX))
    expect(p.init.clientCapabilities?.fs ?? null).toBeNull()
    expect(p.init.clientCapabilities?.terminal ?? null).toBeNull()
  })

  it('keys the spec on what the process was started with, and moves it when the config does', async () => {
    const first = plan(await launcher().plan(CTX))
    const same = plan(await launcher().plan(CTX))
    expect(same.spec.key).toBe(first.spec.key)

    const otherModel = configInput()
    otherModel.agents[0].modelId = 'claude-haiku-4-5-20251001'
    const moved = plan(await launcher(otherModel).plan(CTX))
    expect(moved.spec.key).not.toBe(first.spec.key)
  })

  it('moves the key when a credential is rotated, though the config bytes do not change', async () => {
    const first = plan(await launcher().plan(CTX))
    const rotated = configInput()
    rotated.providers[0].apiKey = 'sk-rotated'
    const moved = plan(await launcher(rotated).plan(CTX))
    expect(moved.spec.key).not.toBe(first.spec.key)
  })

  it('refuses in the engine’s own words when the agent has no usable credential', async () => {
    const noCredential = configInput()
    noCredential.providers = []
    const result = await launcher(noCredential).plan(CTX)
    expect(isRefusal(result) && result.error).toMatch(/credential is not available/)
  })

  it('refuses when the runtime names no model', async () => {
    const noModel = configInput()
    noModel.agents[0].modelId = ''
    const result = await launcher(noModel).plan(CTX)
    expect(isRefusal(result) && result.error).toMatch(/names no model/)
  })

  it('passes an unresolvable binary’s own sentence through', async () => {
    const result = await createOpencodeLauncher({
      binary: async () => {
        throw new Error('The engine path in Settings does not point at a file.')
      },
      configInput: async () => configInput(),
      configRoot: () => root,
      childEnv: async () => ({})
    }).plan(CTX)
    expect(isRefusal(result) && result.error).toBe(
      'The engine path in Settings does not point at a file.'
    )
  })

  it('refuses rather than throwing when the config inputs cannot be read', async () => {
    const result = await createOpencodeLauncher({
      binary: async () => ({ path: '/usr/local/bin/opencode', version: '1.18.27' }),
      configInput: async () => {
        throw new Error('the database is locked')
      },
      configRoot: () => root,
      childEnv: async () => ({})
    }).plan(CTX)
    expect(isRefusal(result)).toBe(true)
  })

  it('refuses when the collector has never heard of this agent', async () => {
    const others = configInput()
    others.agents = []
    const result = await launcher(others).plan(CTX)
    expect(isRefusal(result) && result.error).toMatch(/changed while the turn was starting/)
  })
})

describe('the Claude launcher', () => {
  const deps = {
    claudePath: async () => '/opt/homebrew/bin/claude',
    claudeAuth: async () => ({ state: 'logged_in' }),
    adapterEntry: () => '/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    nodeRuntime: () => ({
      command: '/Applications/Cinna.app/Contents/MacOS/Cinna',
      args: [],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }),
    claudeEnv: async () => ({ PATH: '/usr/bin', HOME: '/Users/x' }),
    systemPrompt: () => 'You are the pineapple agent.',
    model: () => 'sonnet',
    approval: () => 'ask' as const,
    folderAgents: () => ({})
  }

  it('ends every turn with a usage update that carries a cost, so its follow-ups need no quiet spell', () => {
    expect(createClaudeLauncher(deps).endsTurnsWithCostedUsage).toBe(true)
  })

  it('runs the adapter through this build’s own Node, with the user’s claude named', async () => {
    const p = plan(await createClaudeLauncher(deps).plan(CTX))
    expect(p.spec.command).toBe('/Applications/Cinna.app/Contents/MacOS/Cinna')
    expect(p.spec.args).toEqual([
      '/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
    ])
    expect(p.spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    // Left unset, the adapter runs a `claude` it ships itself.
    expect(p.spec.env.CLAUDE_CODE_EXECUTABLE).toBe('/opt/homebrew/bin/claude')
  })

  it('declares form elicitation, which is what keeps AskUserQuestion enabled', async () => {
    const p = plan(await createClaudeLauncher(deps).plan(CTX))
    expect(p.init.clientCapabilities?.elicitation).toEqual({ form: {} })
  })

  it('carries the folder’s prompt and the isolation pair as SDK options', async () => {
    const p = plan(await createClaudeLauncher(deps).plan(CTX))
    const options = (p.session.meta?.claudeCode as { options: Record<string, unknown> }).options
    expect(options.systemPrompt).toBe('You are the pineapple agent.')
    expect(options.model).toBe('sonnet')
    // `settingSources: []` alone leaves the user's own MCP connectors attached.
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.mcpServers).toEqual({})
    // Omitted rather than passed empty, so a folder without subagents hands the
    // adapter what it was handed before the option existed.
    expect('agents' in options).toBe(false)
  })

  it('offers the folder’s own subagents when it has some', async () => {
    const p = plan(
      await createClaudeLauncher({
        ...deps,
        folderAgents: () => ({ reviewer: { description: 'reviews', prompt: 'review' } })
      }).plan(CTX)
    )
    const options = (p.session.meta?.claudeCode as { options: Record<string, unknown> }).options
    expect(options.agents).toEqual({ reviewer: { description: 'reviews', prompt: 'review' } })
  })

  it('sets the session mode from the desktop’s approval choice, and only ever to two values', async () => {
    const ask = plan(await createClaudeLauncher(deps).plan(CTX))
    expect(ask.setup.modeId).toBe('default')
    const auto = plan(
      await createClaudeLauncher({ ...deps, approval: () => 'auto' as const }).plan(CTX)
    )
    expect(auto.setup.modeId).toBe('auto')
  })

  it('refuses when there is no Claude Code on this machine', async () => {
    const result = await createClaudeLauncher({ ...deps, claudePath: async () => null }).plan(CTX)
    expect(isRefusal(result) && result.error).toMatch(/no Claude Code installation was found/)
  })

  it('refuses a definite logged-out install', async () => {
    const result = await createClaudeLauncher({
      ...deps,
      claudeAuth: async () => ({ state: 'logged_out' })
    }).plan(CTX)
    expect(isRefusal(result) && result.error).toMatch(/not logged in/)
  })

  it('runs on an install whose login could not be determined', async () => {
    // A probe that could not answer is not evidence of a logged-out install,
    // and refusing a working engine on our own uncertainty is worse than not
    // checking. The turn's own error still catches a real refusal.
    const result = await createClaudeLauncher({
      ...deps,
      claudeAuth: async () => ({ state: 'unknown' })
    }).plan(CTX)
    expect(isRefusal(result)).toBe(false)
  })

  it('refuses in words when the adapter is missing from the installation', async () => {
    const result = await createClaudeLauncher({
      ...deps,
      adapterEntry: () => {
        throw new Error('not found')
      }
    }).plan(CTX)
    expect(isRefusal(result) && result.error).toMatch(/adapter is missing/)
  })

  it('still plans a turn when an input store throws', async () => {
    // A folder that moved, or a manifest half-written by an assistant. An agent
    // with no assembled prompt still answers; one whose approval could not be
    // read is asked about, which is the safe direction.
    const p = plan(
      await createClaudeLauncher({
        ...deps,
        systemPrompt: () => {
          throw new Error('the folder moved')
        },
        approval: () => {
          throw new Error('unreadable state')
        }
      }).plan(CTX)
    )
    const options = (p.session.meta?.claudeCode as { options: Record<string, unknown> }).options
    expect('systemPrompt' in options).toBe(false)
    expect(p.setup.modeId).toBe('default')
  })

  it('keys the spec on the adapter and the binary it drives', async () => {
    const first = plan(await createClaudeLauncher(deps).plan(CTX))
    const same = plan(await createClaudeLauncher(deps).plan(CTX))
    expect(same.spec.key).toBe(first.spec.key)
    const otherBinary = plan(
      await createClaudeLauncher({ ...deps, claudePath: async () => '/usr/bin/claude' }).plan(CTX)
    )
    expect(otherBinary.spec.key).not.toBe(first.spec.key)
  })
})
