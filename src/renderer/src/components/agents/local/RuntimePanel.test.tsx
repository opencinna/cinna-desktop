import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The "Runs with" pickers, where the credential and the model have to agree.
 *
 * A model id only means something to the credential that lists it: the engine
 * builds `<credential>/<model>` verbatim, so an OpenAI credential paired with
 * `claude-sonnet-4-5` is a config that saves cleanly here and fails on the
 * agent's first turn. Both assertions below are about that pairing —
 *
 * 1. switching the credential drops a model the registry says belonged to the
 *    old one (and keeps a hand-written id the registry has never listed), and
 * 2. the `Default (…)` label names the model *this* credential would run,
 *    which is the default chat mode's only while the credential is too.
 */

const PROVIDERS = [
  {
    id: 'p-anthropic',
    type: 'anthropic',
    name: 'Anthropic',
    hasApiKey: true,
    unsupported: false,
    defaultModelId: null as string | null
  },
  {
    id: 'p-anthropic-2',
    type: 'anthropic',
    name: 'My Anthropic',
    hasApiKey: true,
    unsupported: false,
    defaultModelId: null as string | null
  },
  {
    id: 'p-openai',
    type: 'openai',
    name: 'OpenAI',
    hasApiKey: true,
    unsupported: false,
    defaultModelId: null as string | null
  }
]

const MODELS = [
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', providerId: 'p-anthropic' },
  { id: 'gpt-5', name: 'GPT-5', providerId: 'p-openai' }
]

const save = vi.fn()
let providers = PROVIDERS
let models: typeof MODELS | undefined = MODELS
let modelsFailed = false
let defaultMode: { providerId: string | null; modelId: string | null } | null = {
  providerId: 'p-anthropic',
  modelId: 'claude-sonnet-4-5'
}

vi.mock('../../../hooks/useLocalAgents', () => ({
  useOpenAgentPath: () => ({ mutate: vi.fn() }),
  useSetLocalAgentRuntime: () => ({ mutate: save, isPending: false })
}))
vi.mock('../../../hooks/useChatModes', () => ({ useDefaultChatMode: () => ({ data: defaultMode }) }))
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ data: models, isError: modelsFailed })
}))
vi.mock('../../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
vi.mock('../../../hooks/useEngine', () => ({
  useEngineSkips: () => ({ data: { agents: [] } }),
  useEngineState: () => ({ data: { status: 'running', version: '1.0.0' } }),
  useStartEngine: () => ({ mutate: vi.fn(), isPending: false })
}))

const { RuntimePanel } = await import('./RuntimePanel')

function agent(runtime: Record<string, string> | null): LocalAgentDto {
  return {
    id: 'folder:a',
    readiness: 'ok',
    credentials: [],
    stamps: { 'cinna-agent.json': { size: 1, mtimeMs: 1 } },
    runtime
  } as unknown as LocalAgentDto
}

beforeEach(() => {
  save.mockClear()
  providers = PROVIDERS
  models = MODELS
  modelsFailed = false
  defaultMode = { providerId: 'p-anthropic', modelId: 'claude-sonnet-4-5' }
})

/** What `commit` sent to the stamped write. */
function saved(): { credential: string | null; modelId: string | null } {
  const [vars] = save.mock.calls[0] as [{ runtime: { credential: string | null; modelId: string | null } }]
  return vars.runtime
}

describe('RuntimePanel', () => {
  it('drops the old credential’s model when the credential changes', () => {
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'OpenAI' } })
    expect(saved()).toEqual({ credential: 'OpenAI', modelId: null })
  })

  it('keeps a model the registry has never listed — it is hand-written, not stale', () => {
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'some-gateway-model' })} />)
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'OpenAI' } })
    expect(saved()).toEqual({ credential: 'OpenAI', modelId: 'some-gateway-model' })
  })

  it('offers the default mode’s model only where it could actually run', () => {
    const { unmount } = render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
    expect(screen.getByRole('option', { name: 'Default (Claude Sonnet 4.5)' })).toBeTruthy()
    unmount()

    // Same page, OpenAI credential: the mode's Anthropic model is not on offer,
    // and the panel says so rather than showing a Default the engine cannot build.
    render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
    expect(screen.queryByRole('option', { name: /Claude Sonnet/ })).toBeNull()
    expect(screen.getByRole('option', { name: 'Default (none set)' })).toBeTruthy()
    expect(screen.getByText(/No model set/)).toBeTruthy()
  })

  it('keeps the default’s model on a second credential of the same type', () => {
    // A personal Anthropic key alongside the account-provisioned one: the model
    // id is the provider's, not the row's, so this pairing runs. Dropping it
    // would take a working agent off the air on an upgrade.
    render(<RuntimePanel agent={agent({ credential: 'My Anthropic' })} />)
    expect(screen.getByRole('option', { name: 'Default (Claude Sonnet 4.5)' })).toBeTruthy()
    expect(screen.queryByText(/No model set/)).toBeNull()
  })

  it('falls through to the credential’s own default when the mode says “First available”', () => {
    defaultMode = { providerId: 'p-anthropic', modelId: null }
    providers = [{ ...PROVIDERS[0], defaultModelId: 'claude-sonnet-4-5' }, ...PROVIDERS.slice(1)]
    render(<RuntimePanel agent={agent(null)} />)
    expect(screen.getByRole('option', { name: 'Default (Claude Sonnet 4.5)' })).toBeTruthy()
    expect(screen.queryByText(/No model set/)).toBeNull()
  })

  it('names the model that does not belong to the credential already in the file', () => {
    // What the old bug wrote. The pair saves cleanly and fails at the first
    // turn, so the panel has to say so on open — not only on a change.
    render(<RuntimePanel agent={agent({ credential: 'OpenAI', model: 'claude-sonnet-4-5' })} />)
    expect(screen.getByText(/Pick a model OpenAI lists/)).toBeTruthy()
  })

  it('says why the model it dropped is gone', () => {
    // The clear rewrites a file the user commits; doing it wordlessly is the
    // silent-failure case ux_rules rule 6 is about.
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'OpenAI' } })
    expect(screen.getByText(/Dropped “Claude Sonnet 4.5” — OpenAI does not list it/)).toBeTruthy()
  })

  it('does not call a model foreign to a sibling credential of the same type', () => {
    // `My Anthropic` contributes no rows to the registry — a disabled-but-keyed
    // credential, or one whose listModels call just failed. Same catalogue, so
    // the model stays, and the panel cannot both lend it and call it foreign.
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'My Anthropic' } })
    expect(saved()).toEqual({ credential: 'My Anthropic', modelId: 'claude-sonnet-4-5' })
    expect(screen.queryByText(/Pick a model/)).toBeNull()
  })

  it('says the default credential cannot run rather than sending the user after models', () => {
    defaultMode = { providerId: 'p-oauth', modelId: 'claude-sonnet-4-5' }
    providers = [
      ...PROVIDERS,
      {
        id: 'p-oauth',
        type: 'anthropic',
        name: 'Managed Anthropic',
        hasApiKey: false,
        unsupported: true,
        defaultModelId: null
      }
    ]
    render(<RuntimePanel agent={agent(null)} />)
    expect(screen.getByText(/has no API key this app can use/)).toBeTruthy()
  })

  it('keeps the panel usable when the model registry fails to load', () => {
    models = undefined
    modelsFailed = true
    render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
    expect(screen.getByLabelText('Credential')).toHaveProperty('disabled', false)
    expect(screen.getByText(/Could not load the model list/)).toBeTruthy()
  })

  it('edits nothing until the model registry has loaded', () => {
    // `useModels` is a network round trip per credential: until it lands, a
    // model the registry has not listed is indistinguishable from one that
    // belongs to another credential.
    models = undefined
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    expect(screen.getByLabelText('Credential')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Model')).toHaveProperty('disabled', true)
    expect(screen.getByText('Loading the model list…')).toBeTruthy()
  })

  it('keeps the model when reverting to a Default that resolves to nothing', () => {
    // No default runtime to compare against — clearing here would drop a choice
    // from a file the user commits, on a change they may be about to undo.
    defaultMode = null
    render(<RuntimePanel agent={agent({ credential: 'OpenAI', model: 'gpt-5' })} />)
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: '' } })
    expect(saved()).toEqual({ credential: null, modelId: 'gpt-5' })
  })

  it('names the chosen credential’s own default model when it has one', () => {
    providers = [...PROVIDERS.slice(0, 2), { ...PROVIDERS[2], defaultModelId: 'gpt-5' }]
    render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
    expect(screen.getByRole('option', { name: 'Default (GPT-5)' })).toBeTruthy()
    expect(screen.queryByText(/No model set/)).toBeNull()
  })
})
