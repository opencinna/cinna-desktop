import { describe, expect, it, vi } from 'vitest'
import { effectiveEngine, type AgentEngine, type RunsOnChoice } from '../../../shared/engine'
import type { AgentRuntimeRef } from '../../../shared/kit/manifest'
import {
  resolveBareRunsOn,
  resolveRunsOn,
  resolveVaultRunsOn,
  runsOnSourceLabel,
  runtimeForChoice,
  type RunsOnDeps
} from './runsOn'

/**
 * A stand-in for `runtimeService.resolve` with a credential list of two named
 * rows and a managed fallback: a named credential resolves to its row, none
 * to the fallback (what the Default runtime spends). Models: a declared one
 * wins; otherwise a tier per engine, so the conflict sides can name one.
 */
const CREDENTIALS: Record<string, string> = { OpenAI: 'p-openai', Anthropic: 'p-anthropic' }
const FALLBACK = { id: 'p-managed', name: 'Managed OpenAI' }

function depsFor(defaultEngine: AgentEngine): RunsOnDeps & { resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn((runtime: AgentRuntimeRef | null) => {
    const engine = effectiveEngine(runtime, defaultEngine)
    const ref = typeof runtime?.credential === 'string' ? runtime.credential : ''
    const id = ref !== '' ? (CREDENTIALS[ref] ?? FALLBACK.id) : FALLBACK.id
    const declared = typeof runtime?.model === 'string' ? runtime.model : null
    const opencode = engine === 'opencode'
    return {
      credentialId: opencode ? id : null,
      credentialName: opencode ? (ref !== '' && CREDENTIALS[ref] ? ref : FALLBACK.name) : null,
      modelId: declared ?? (opencode ? (runtime?.complexity === 'complex' ? 'gpt-5.5-pro' : 'gpt-5') : engine === 'claude' ? (runtime?.complexity === 'complex' ? 'opus' : 'sonnet') : null)
    }
  })
  return { defaultEngine, resolve }
}

const FILES: Array<[string, AgentRuntimeRef | null]> = [
  ['no runtime', null],
  ['complexity only', { complexity: 'medium' }],
  ['engine claude', { engine: 'claude', complexity: 'simple' }],
  ['engine codex', { engine: 'codex' }],
  ['engine antigravity', { engine: 'antigravity' }],
  ['engine opencode', { engine: 'opencode', complexity: 'complex' }],
  ['unknown engine', { engine: 'gemini' }],
  ['bare model', { model: 'gpt-5.5-pro' }],
  ['bare credential', { credential: 'OpenAI' }],
  ['credential + model', { credential: 'Anthropic', model: 'claude-sonnet-4-5' }]
]

const CHOICES: Array<RunsOnChoice | null> = [
  null,
  { kind: 'default' },
  { kind: 'engine', engine: 'claude' },
  { kind: 'engine', engine: 'codex' },
  { kind: 'engine', engine: 'antigravity' },
  { kind: 'engine', engine: 'opencode' },
  { kind: 'credential', name: 'OpenAI' }
]

const DEFAULTS: AgentEngine[] = ['claude', 'opencode']

interface Outcome { engine: AgentEngine; credentialId: string | null }

/** The file read alone — written out here, not through the resolver. */
function fileOutcome(file: AgentRuntimeRef | null, machine: AgentEngine): Outcome {
  const declared = typeof file?.engine === 'string' ? file.engine : ''
  const known = ['claude', 'codex', 'antigravity', 'opencode'].includes(declared)
  const engine: AgentEngine = known ? (declared as AgentEngine)
    : declared !== '' || file?.credential || file?.model ? 'opencode'
      : machine
  const credentialId = engine === 'opencode' ? (file?.credential ? CREDENTIALS[file.credential as string] : FALLBACK.id) : null
  return { engine, credentialId }
}

/** The stored choice alone. */
function choiceOutcome(choice: RunsOnChoice, machine: AgentEngine): Outcome {
  if (choice.kind === 'credential') return { engine: 'opencode', credentialId: CREDENTIALS[choice.name] }
  const engine = choice.kind === 'engine' ? choice.engine : machine
  return { engine, credentialId: engine === 'opencode' ? FALLBACK.id : null }
}

describe('resolveRunsOn — precedence and conflict, every choice × file shape × machine default', () => {
  for (const machine of DEFAULTS) {
    for (const [label, file] of FILES) {
      for (const choice of CHOICES) {
        const name = `default ${machine}, file ${label}, choice ${choice ? JSON.stringify(choice) : 'none'}`
        it(name, () => {
          const { effective, resolved } = resolveRunsOn(file, choice, depsFor(machine))
          const fromFile = fileOutcome(file, machine)
          expect(resolved.choice).toEqual(choice)
          if (choice === null) {
            // No choice: launch follows the file verbatim; a notice when it is not the default.
            expect(effective).toBe(file)
            expect(resolved.engine).toBe(fromFile.engine)
            expect(resolved.credentialId).toBe(fromFile.credentialId)
            expect(resolved.source).toBe(file?.engine || file?.credential || file?.model ? 'file' : 'default')
            if (fromFile.engine === machine) expect(resolved.conflict).toBeNull()
            else expect(resolved.conflict).toMatchObject({ kind: 'unrecorded', file: { engine: fromFile.engine }, app: { engine: machine } })
            return
          }
          const fromChoice = choiceOutcome(choice, machine)
          // The choice always decides what runs.
          expect(resolved.source).toBe('choice')
          expect(resolved.engine).toBe(fromChoice.engine)
          expect(resolved.credentialId).toBe(fromChoice.credentialId)
          // And the block a turn launches with resolves to exactly that.
          expect(effectiveEngine(effective, machine)).toBe(fromChoice.engine)
          const same = fromFile.engine === fromChoice.engine && fromFile.credentialId === fromChoice.credentialId
          if (same) {
            expect(resolved.conflict).toBeNull()
            expect(effective).toBe(file)
          } else {
            expect(resolved.conflict).toMatchObject({ kind: 'choice', file: { engine: fromFile.engine }, app: { engine: fromChoice.engine } })
            expect(effective).toEqual(runtimeForChoice(file, choice))
          }
        })
      }
    }
  }
})

describe('resolveRunsOn — the cases the report is about', () => {
  it('flags `engine: "opencode"` on a Claude-default machine with no choice, naming both models', () => {
    const { effective, resolved } = resolveRunsOn({ engine: 'opencode', complexity: 'complex' }, null, depsFor('claude'))
    // Launch still follows the file until the user answers.
    expect(effective).toEqual({ engine: 'opencode', complexity: 'complex' })
    expect(resolved).toEqual({
      engine: 'opencode',
      credentialId: FALLBACK.id,
      source: 'file',
      choice: null,
      conflict: {
        kind: 'unrecorded',
        file: { engine: 'opencode', credentialName: FALLBACK.name, modelId: 'gpt-5.5-pro' },
        app: { engine: 'claude', credentialName: null, modelId: 'opus' }
      }
    })
  })

  it('runs a stored Default on Claude over that file, keeping complexity, effort and unknown keys but not the model', () => {
    const file: AgentRuntimeRef = { engine: 'opencode', model: 'gpt-5.5-pro', effort: 'high', complexity: 'complex', permissions: { bash: 'ask' } }
    const { effective, resolved } = resolveRunsOn(file, { kind: 'default' }, depsFor('claude'))
    expect(effective).toEqual({ effort: 'high', complexity: 'complex', permissions: { bash: 'ask' } })
    expect(resolved.engine).toBe('claude')
    expect(resolved.conflict?.kind).toBe('choice')
    // The file itself is never touched.
    expect(file.engine).toBe('opencode')
    expect(file.model).toBe('gpt-5.5-pro')
  })

  it('writes the choice in each form: engine, credential, default', () => {
    const file: AgentRuntimeRef = { engine: 'codex', credential: 'X', model: 'm', complexity: 'simple' }
    expect(runtimeForChoice(file, { kind: 'engine', engine: 'claude' })).toEqual({ engine: 'claude', complexity: 'simple' })
    expect(runtimeForChoice(file, { kind: 'credential', name: 'OpenAI' })).toEqual({ credential: 'OpenAI', complexity: 'simple' })
    expect(runtimeForChoice(file, { kind: 'default' })).toEqual({ complexity: 'simple' })
    expect(runtimeForChoice({ engine: 'opencode' }, { kind: 'default' })).toBeNull()
    expect(runtimeForChoice(null, { kind: 'default' })).toBeNull()
  })

  it('compares outcomes, not keys: a stored Claude Agent over an engine-less file on a Claude machine is quiet', () => {
    const file = { complexity: 'medium' }
    const { effective, resolved } = resolveRunsOn(file, { kind: 'engine', engine: 'claude' }, depsFor('claude'))
    expect(resolved.conflict).toBeNull()
    expect(effective).toBe(file)
  })

  it('compares credentials on OpenCode: the same engine on another key is a conflict', () => {
    const { resolved } = resolveRunsOn({ credential: 'Anthropic' }, { kind: 'credential', name: 'OpenAI' }, depsFor('opencode'))
    expect(resolved.conflict).toMatchObject({ kind: 'choice', file: { credentialName: 'Anthropic' }, app: { credentialName: 'OpenAI' } })
  })

  it('asks for no credential when nothing runs on OpenCode and nothing disagrees', () => {
    const deps = depsFor('claude')
    resolveRunsOn({ complexity: 'simple' }, { kind: 'default' }, deps)
    expect(deps.resolve).not.toHaveBeenCalled()
  })
})

describe('bare and vault agents', () => {
  it('a bare agent has no conflict; its runtime is the app’s own', () => {
    expect(resolveBareRunsOn(null, depsFor('claude')).resolved).toEqual({ engine: 'claude', credentialId: null, source: 'default', choice: null, conflict: null })
    const picked = resolveBareRunsOn({ credential: 'OpenAI' }, depsFor('claude'))
    expect(picked.effective).toEqual({ credential: 'OpenAI' })
    expect(picked.resolved).toEqual({ engine: 'opencode', credentialId: 'p-openai', source: 'choice', choice: null, conflict: null })
    expect(resolveBareRunsOn({ complexity: 'simple' }, depsFor('codex')).resolved.source).toBe('default')
  })

  it('a vault agent runs on its vault engine', () => {
    expect(resolveVaultRunsOn('codex')).toEqual({ engine: 'codex', credentialId: null, source: 'choice', choice: null, conflict: null })
  })
})

describe('runsOnSourceLabel', () => {
  it('names the choice for the turn log', () => {
    expect(runsOnSourceLabel(resolveRunsOn(null, { kind: 'default' }, depsFor('claude')).resolved)).toBe('choice(default)')
    expect(runsOnSourceLabel(resolveRunsOn({ engine: 'opencode' }, { kind: 'default' }, depsFor('claude')).resolved)).toBe('choice(default),conflict')
    expect(runsOnSourceLabel(resolveRunsOn({ engine: 'codex' }, { kind: 'engine', engine: 'codex' }, depsFor('claude')).resolved)).toBe('choice(engine:codex)')
    expect(runsOnSourceLabel(resolveRunsOn({ credential: 'OpenAI' }, { kind: 'credential', name: 'OpenAI' }, depsFor('claude')).resolved)).toBe('choice(credential:OpenAI)')
    expect(runsOnSourceLabel(resolveRunsOn({ engine: 'opencode' }, null, depsFor('claude')).resolved)).toBe('file,unrecorded')
    expect(runsOnSourceLabel(resolveRunsOn(null, null, depsFor('claude')).resolved)).toBe('default')
  })
})
