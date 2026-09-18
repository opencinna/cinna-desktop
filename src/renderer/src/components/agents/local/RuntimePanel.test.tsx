import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { WorkComplexity } from '../../../../../shared/modelFamilies'

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
    enabled: true,
    unsupported: false,
    defaultModelId: null as string | null
  },
  {
    id: 'p-anthropic-2',
    type: 'anthropic',
    name: 'My Anthropic',
    hasApiKey: true,
    enabled: true,
    unsupported: false,
    defaultModelId: null as string | null
  },
  {
    id: 'p-openai',
    type: 'openai',
    name: 'OpenAI',
    hasApiKey: true,
    enabled: true,
    unsupported: false,
    defaultModelId: null as string | null
  }
]

const MODELS = [
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', providerId: 'p-anthropic' },
  { id: 'gpt-5', name: 'GPT-5', providerId: 'p-openai' }
]

/**
 * Calls back like a real mutation would: the panel moves the view and stores the
 * picker preference in `onSuccess`, so that a refused write cannot leave the
 * checkbox, the visible picker and the file disagreeing. A fake that never calls
 * back would make every one of those assertions vacuous.
 */
let writeFails = false
const save = vi.fn(
  (_vars: unknown, options?: { onSuccess?: () => void; onError?: (e: Error) => void }) =>
    void (writeFails
      ? options?.onError?.(new Error('Could not write cinna-agent.json.'))
      : options?.onSuccess?.())
)
const setSetting = vi.fn()
/** The secrets line's "Add them in credentials/.env" — opens the file itself. */
const openCredentials = vi.fn()
let advanced = false
let settingsLoaded = true
let providers = PROVIDERS
let models: typeof MODELS | undefined = MODELS
let modelsFailed = false
let defaultMode: { providerId: string | null; modelId: string | null } | null = {
  providerId: 'p-anthropic',
  modelId: 'claude-sonnet-4-5'
}

/** The bare agent's writer: same choice, no stamp, its own channel. */
const saveBare = vi.fn(
  (_vars: unknown, options?: { onSuccess?: () => void; onError?: (e: Error) => void }) =>
    void (writeFails
      ? options?.onError?.(new Error('Could not save this agent’s local state.'))
      : options?.onSuccess?.())
)
vi.mock('../../../hooks/useLocalAgents', () => ({
  useOpenAgentCredentials: () => ({ mutate: openCredentials }),
  useSetLocalAgentRuntime: () => ({ mutate: save, isPending: false }),
  useSetBareAgentRuntime: () => ({ mutate: saveBare, isPending: false })
}))
vi.mock('../../../hooks/useChatModes', () => ({ useDefaultChatMode: () => ({ data: defaultMode }) }))
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ data: models, isError: modelsFailed })
}))
vi.mock('../../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
/**
 * Detection decides whether the Claude Agent option is offered at all, so it is
 * a fixture rather than a constant: an absent `claude` must mean an absent
 * option, never one that fails after the click.
 */
let claudeInstalled = true
/** `undefined` is a third state: detection has not answered yet. */
let codexInstalled = false
let codexAuth: { state: 'logged_in' | 'logged_out' | 'unknown' } = { state: 'logged_in' }
let toolsLoaded = true
/**
 * What `claude auth status` said, or `undefined` for the query still in flight.
 *
 * **Undefined by default, and that is the honest default**: detection and the
 * login are two queries, the second is a spawned process, and the panel has to
 * be right in the window where only the first has answered. Every test that
 * does not set this is therefore exercising that window.
 */
let claudeAuth:
  | { state: string; authMethod: string | null; subscriptionType: string | null; email: string | null }
  | undefined
vi.mock('../../../hooks/useLocalTools', () => ({
  useLocalTools: () => ({
    data: !toolsLoaded
      ? undefined
      : codexInstalled
        ? [{ id: 'codex', kind: 'cli-assistant', label: 'Codex', available: true, path: '/usr/local/bin/codex', version: '0.153.4', source: 'path' }]
        : claudeInstalled
        ? [{ id: 'claude', kind: 'cli-assistant', label: 'Claude Code', available: true, path: '/usr/local/bin/claude', version: '2.1.266', source: 'path' }]
        : []
  }),
  useClaudeAuth: () => ({ data: claudeAuth }),
  useCodexAuth: () => ({ data: codexAuth })
}))
vi.mock('../../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({
    data: settingsLoaded ? { localAgentsModelAdvanced: advanced } : undefined
  }),
  useSetAppSetting: () => ({ mutate: setSetting })
}))
/**
 * The engine's *binary* — all the panel knows about the engine since phase 3
 * of the agent runtime plan. There is no shared server to be running and no
 * shared config to have skipped this agent; a launcher refuses one agent at the
 * top of its own turn, and the panel's own credential and model rungs say the
 * things the skip list used to echo.
 */
let binary: { state: string; version?: string | null; path?: string; error?: string } = {
  state: 'ready',
  version: '1.0.0',
  path: '/usr/local/bin/opencode'
}
/**
 * This machine's Default Runtime, as main resolves it.
 *
 * A fixture with three settings, because the panel has three behaviours: the
 * AI-credentials default (what every build before the setting did), the Claude
 * Agent default — where an agent that declares *nothing* is a Claude agent —
 * and `undefined`, the window before main has answered, in which the panel may
 * claim neither.
 */
let defaultRuntime: { engine: string } | undefined = { engine: 'opencode' }
/** The managed Codex CLI's state — what decides whether Codex can run, not PATH detection. */
let codexBinary: Record<string, unknown> | undefined = { state: 'unresolved' }
vi.mock('../../../hooks/useEngine', () => ({
  useEngineBinary: () => ({ data: binary }),
  useCodexBinary: () => ({ data: codexBinary }),
  useDefaultRuntime: () => ({ data: defaultRuntime })
}))

const { RuntimePanel } = await import('./RuntimePanel')

function agent(runtime: Record<string, string> | null): LocalAgentDto {
  return {
    id: 'folder:a',
    kind: 'kit',
    readiness: 'ok',
    credentials: [],
    stamps: { 'cinna-agent.json': { size: 1, mtimeMs: 1 } },
    runtime
  } as unknown as LocalAgentDto
}

/**
 * A bare agent: no manifest, so no stamp — the panel must still be editable,
 * which is the whole point of it having controls at all.
 */
function bareAgent(runtime: Record<string, string> | null): LocalAgentDto {
  return {
    id: 'folder:external:r1:support',
    kind: 'bare',
    readiness: 'ok',
    credentials: [],
    stamps: {},
    runtime
  } as unknown as LocalAgentDto
}

beforeEach(() => {
  codexBinary = { state: 'unresolved' }
  codexInstalled = false
  codexAuth = { state: 'logged_in' }
  claudeInstalled = true
  toolsLoaded = true
  claudeAuth = undefined
  save.mockClear()
  saveBare.mockClear()
  setSetting.mockClear()
  openCredentials.mockReset()
  advanced = false
  settingsLoaded = true
  writeFails = false
  binary = { state: 'ready', version: '1.0.0', path: '/usr/local/bin/opencode' }
  providers = PROVIDERS
  models = MODELS
  modelsFailed = false
  defaultMode = { providerId: 'p-anthropic', modelId: 'claude-sonnet-4-5' }
})

/** What `commit` sent to the stamped write. */
/**
 * The three fields these tests are about: credential, model, tier.
 *
 * `engine` is deliberately dropped here rather than added to every expectation
 * below. The panel sends it on every save — it must, or a save about the model
 * would delete an engine choice the manifest already carries — but it is a
 * pass-through the tests in this helper's callers are not about. The two that
 * *are* about it read `save.mock.calls` directly, so the field cannot be
 * silently lost by a helper that never looked at it.
 */
function saved(): {
  credential: string | null
  modelId: string | null
  complexity: WorkComplexity | null
} {
  const [vars] = save.mock.calls[0] as [
    {
      runtime: {
        engine: string | null
        credential: string | null
        modelId: string | null
        complexity: WorkComplexity | null
      }
    }
  ]
  const { engine: _engine, ...rest } = vars.runtime
  void _engine
  return rest
}

describe('RuntimePanel', () => {
  it('drops the old credential’s model when the credential changes', () => {
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
    expect(saved()).toEqual({ credential: 'OpenAI', modelId: null, complexity: null })
  })

  it('keeps a model the registry has never listed — it is hand-written, not stale', () => {
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'some-gateway-model' })} />)
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
    expect(saved()).toEqual({ credential: 'OpenAI', modelId: 'some-gateway-model', complexity: null })
  })

  it('offers the default mode’s model only where it could actually run', () => {
    const { unmount } = render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
    expect(screen.getByText('Default — follows the Default runtime, on Claude Sonnet 4.5.')).toBeTruthy()
    unmount()

    // Same page, OpenAI credential: the mode's Anthropic model is not on offer,
    // because the engine could not build that pair. What Default names instead
    // is the Medium floor on *this* credential — the step that replaced an agent
    // that simply had nothing to run on.
    render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
    expect(screen.queryByRole('option', { name: /Claude Sonnet/ })).toBeNull()
    expect(screen.getByText('Default — follows the Default runtime, on GPT-5.')).toBeTruthy()
    expect(screen.queryByText(/No model set/)).toBeNull()
  })

  it('still says nothing can run when the credential lists no model any tier claims', () => {
    // The floor is not a promise that something is always found: a gateway
    // listing one unrecognisable id has no Medium model, and the dead end is
    // real again — so the panel has to say so rather than showing a blank
    // Default and letting the first turn fail.
    models = [{ id: 'deepseek-chat', name: 'DeepSeek Chat', providerId: 'p-openai' }]
    defaultMode = { providerId: 'p-openai', modelId: null }
    render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
    expect(screen.getByRole('option', { name: 'Default (none set)' })).toBeTruthy()
    expect(screen.getByText(/No model set/)).toBeTruthy()
  })

  it('keeps the default’s model on a second credential of the same type', () => {
    // A personal Anthropic key alongside the account-provisioned one: the model
    // id is the provider's, not the row's, so this pairing runs. Dropping it
    // would take a working agent off the air on an upgrade.
    render(<RuntimePanel agent={agent({ credential: 'My Anthropic' })} />)
    expect(screen.getByText('Default — follows the Default runtime, on Claude Sonnet 4.5.')).toBeTruthy()
    expect(screen.queryByText(/No model set/)).toBeNull()
  })

  it('falls through to the credential’s own default when the mode says “First available”', () => {
    defaultMode = { providerId: 'p-anthropic', modelId: null }
    providers = [{ ...PROVIDERS[0], defaultModelId: 'claude-sonnet-4-5' }, ...PROVIDERS.slice(1)]
    render(<RuntimePanel agent={agent(null)} />)
    expect(screen.getByText('Default — follows the Default runtime, on Claude Sonnet 4.5.')).toBeTruthy()
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
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
    expect(screen.getByText(/Dropped “Claude Sonnet 4.5” — OpenAI does not list it/)).toBeTruthy()
  })

  it('does not call a model foreign to a sibling credential of the same type', () => {
    // `My Anthropic` contributes no rows to the registry — a disabled-but-keyed
    // credential, or one whose listModels call just failed. Same catalogue, so
    // the model stays, and the panel cannot both lend it and call it foreign.
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'My Anthropic' } })
    expect(saved()).toEqual({ credential: 'My Anthropic', modelId: 'claude-sonnet-4-5', complexity: null })
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
        enabled: true,
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
    expect(screen.getByLabelText('Runs on')).toHaveProperty('disabled', false)
    expect(screen.getByText(/Could not load the model list/)).toBeTruthy()
  })

  it('edits nothing until the model registry has loaded', () => {
    // `useModels` is a network round trip per credential: until it lands, a
    // model the registry has not listed is indistinguishable from one that
    // belongs to another credential.
    models = undefined
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
    expect(screen.getByLabelText('Runs on')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Model')).toHaveProperty('disabled', true)
    expect(screen.getByText('Loading the model list…')).toBeTruthy()
  })

  it('keeps the model when reverting to a Default that resolves to nothing', () => {
    // No default runtime to compare against — clearing here would drop a choice
    // from a file the user commits, on a change they may be about to undo.
    defaultMode = null
    render(<RuntimePanel agent={agent({ credential: 'OpenAI', model: 'gpt-5' })} />)
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: '' } })
    expect(saved()).toEqual({ credential: null, modelId: 'gpt-5', complexity: null })
  })

  it('names the chosen credential’s own default model when it has one', () => {
    providers = [...PROVIDERS.slice(0, 2), { ...PROVIDERS[2], defaultModelId: 'gpt-5' }]
    render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
    expect(screen.getByText('Default — follows the Default runtime, on GPT-5.')).toBeTruthy()
    expect(screen.queryByText(/No model set/)).toBeNull()
  })

  /**
   * Work Complexity. The load-bearing claim is that the picker cannot
   * misrepresent the file: whichever of `model` / `complexity` the manifest
   * carries decides the view, and ticking Advanced converts rather than merely
   * switching, so the box and the file always agree.
   */
  describe('work complexity', () => {
    it('reports the model it resolves to, and flags a tier this credential cannot serve', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
      expect(screen.getByText('Default — follows the Default runtime, on Claude Sonnet 4.5.')).toBeTruthy()
      // Nothing Anthropic lists here is a haiku, and saying "Simple" with no
      // model behind it would be the catalogue's problem all over again.
      expect(screen.getByRole('option', { name: 'Simple (none listed)' })).toBeTruthy()
    })

    it('writes a tier and clears no credential doing it', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
      fireEvent.change(screen.getByLabelText('Work complexity'), { target: { value: 'medium' } })
      expect(saved()).toEqual({ credential: 'Anthropic', modelId: null, complexity: 'medium' })
    })

    it('keeps the tier when the credential changes — that is what makes it portable', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      expect(saved()).toEqual({ credential: 'OpenAI', modelId: null, complexity: 'medium' })
    })

    it('shows the model picker for an agent pinned to a model, whatever the preference says', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
      expect(screen.getByLabelText('Model')).toBeTruthy()
      expect(screen.queryByLabelText('Work complexity')).toBeNull()
    })

    it('shows the tier for an agent that names one, even with Advanced remembered', () => {
      advanced = true
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      expect(screen.getByLabelText('Work complexity')).toBeTruthy()
      expect(screen.queryByLabelText('Model')).toBeNull()
    })

    it('converts a pinned model to its tier when Advanced is unticked, and says so', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(saved()).toEqual({ credential: 'Anthropic', modelId: null, complexity: 'medium' })
      expect(screen.getByText(/Switched to Medium/)).toBeTruthy()
      expect(setSetting).toHaveBeenCalledWith({ key: 'localAgentsModelAdvanced', value: false })
    })

    it('pins the tier’s current model when Advanced is ticked, and says so', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(saved()).toEqual({
        credential: 'Anthropic',
        modelId: 'claude-sonnet-4-5',
        complexity: null
      })
      expect(screen.getByText(/Pinned “Claude Sonnet 4.5”/)).toBeTruthy()
    })

    it('remembers the preference without touching a manifest that declares neither', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(setSetting).toHaveBeenCalledWith({ key: 'localAgentsModelAdvanced', value: true })
      expect(save).not.toHaveBeenCalled()
    })

    /**
     * Re-render with the manifest the write produced — what the query
     * invalidation does after a save. Without it these two assert nothing: the
     * `agent` prop would still carry the choice that was just cleared, and the
     * manifest-derived view would answer correctly by accident.
     */
    const afterSave = (rerender: (ui: React.ReactElement) => void): void => {
      const runtime = saved()
      rerender(
        <RuntimePanel
          agent={agent({
            ...(runtime.credential ? { credential: runtime.credential } : {}),
            ...(runtime.modelId ? { model: runtime.modelId } : {}),
            ...(runtime.complexity ? { complexity: runtime.complexity } : {})
          })}
        />
      )
    }

    it('keeps the model picker when a choice leaves the manifest declaring nothing', () => {
      // The credential change drops the stale model, so the manifest now names
      // neither — and deriving the view from it would answer the user's click by
      // swapping the control they were working in for the other one.
      const { rerender } = render(
        <RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />
      )
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      expect(saved().modelId).toBeNull()
      afterSave(rerender)
      expect(screen.getByLabelText('Model')).toBeTruthy()
      expect(screen.queryByLabelText('Work complexity')).toBeNull()
    })

    it('keeps the tier picker when the tier is cleared to Default', () => {
      // The remembered preference is Advanced, so without the sticky view this
      // would flip to the model picker the moment the tier was cleared.
      advanced = true
      const { rerender } = render(
        <RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />
      )
      fireEvent.change(screen.getByLabelText('Work complexity'), { target: { value: '' } })
      expect(saved().complexity).toBeNull()
      afterSave(rerender)
      expect(screen.getByLabelText('Work complexity')).toBeTruthy()
      expect(screen.queryByLabelText('Model')).toBeNull()
    })

    it('makes Advanced unavailable, not springy, for a model no tier describes', () => {
      // A gateway id the classifier does not recognise — the ordinary case for
      // `openai_compatible`. The tier picker cannot represent this file at all,
      // so the checkbox is disabled with the reason beside it. A control that
      // snapped back told the user nothing and invited an identical second
      // click; it also had to instruct them to clear an id they cannot retype.
      render(<RuntimePanel agent={agent({ credential: 'OpenAI', model: 'my-private-llm-7b' })} />)
      expect(screen.getByRole('checkbox', { name: /Advanced/ })).toHaveProperty('disabled', true)
      expect(
        screen.getByText('Advanced stays on — “my-private-llm-7b” matches no work complexity.')
      ).toBeTruthy()
      expect(screen.getByLabelText('Model')).toBeTruthy()
      expect(screen.queryByLabelText('Work complexity')).toBeNull()
      expect(save).not.toHaveBeenCalled()
      expect(setSetting).not.toHaveBeenCalled()
      // The reserved line is one prioritised message, so a missing credential or
      // a refused write displaces the standing explanation. The tooltip is then
      // the only surface left that can say why the control is dead, and it must
      // not still be advertising the action it cannot perform.
      // Scoped to the control: the reserved line carries the same sentence in
      // its own `title`, and here both are present because nothing displaces it.
      expect(
        screen.getByRole('checkbox', { name: /Advanced/ }).closest('label')?.title
      ).toMatch(/matches no work complexity/)
    })

    it('overrides even a sticky tier view when the file names a model no tier fits', () => {
      // The sticky view normally wins, and here it must not: untick Advanced on
      // a convertible model (view = tier), then let an assistant rewrite the
      // manifest to a gateway id underneath. A tier picker over a *running*
      // pinned model is the misreport this panel exists to prevent, so the file
      // wins over the remembered view.
      const { rerender } = render(
        <RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />
      )
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      rerender(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      expect(screen.getByLabelText('Work complexity')).toBeTruthy()

      rerender(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'my-private-llm-7b' })} />)
      expect(screen.getByLabelText('Model')).toBeTruthy()
      expect(screen.queryByLabelText('Work complexity')).toBeNull()
      // Same render, not the next one: this is the panel's only path where a
      // control changes with no user action, so a frame showing the swapped
      // picker without the reason would be the misreport with extra steps.
      //
      // The earlier conversion's note used to hold the slot here and displace
      // this line — it described a write the file no longer reflected. A note
      // is now tied to the manifest state it is about, so a third-party edit
      // retires it and the standing explanation gets the slot it should have.
      expect(
        screen.getByText('Advanced stays on — “my-private-llm-7b” matches no work complexity.')
      ).toBeTruthy()
      expect(screen.queryByText(/Switched to Medium/)).toBeNull()
    })

    it('lets the tier picker back in once the unconvertible model is cleared', () => {
      // No instruction needed: clearing the model enables the checkbox on its
      // own, which is the whole reason the copy does not push a deletion.
      const { rerender } = render(
        <RuntimePanel agent={agent({ credential: 'OpenAI', model: 'my-private-llm-7b' })} />
      )
      rerender(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
      expect(screen.getByRole('checkbox', { name: /Advanced/ })).toHaveProperty('disabled', false)
    })

    it('does not write a tier the credential cannot serve, but still opens the picker', () => {
      // Anthropic here lists only a sonnet, so Complex resolves to nothing.
      // Writing through would delete the user's tier out of a file they commit;
      // refusing the *view* as well would spring the checkbox back under the
      // pointer and leave them nowhere to go. The model picker can represent
      // this file honestly — its tier names no model — so the view moves and the
      // line carries the tier the file still holds.
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'complex' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(save).not.toHaveBeenCalled()
      expect(screen.getByText(/Still Complex in the file/)).toBeTruthy()
      expect(screen.getByLabelText('Model')).toBeTruthy()
      expect(setSetting).toHaveBeenCalledWith({ key: 'localAgentsModelAdvanced', value: true })
    })

    it('says which tier the file still holds, outranking the resolution line', () => {
      // The Model select now reads `Default` over a manifest that says Complex.
      // This line is the only thing that says otherwise, so it must not be
      // replaced by the healthy-state resolution note on the next render.
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'complex' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(screen.queryByText(/follows your default chat mode/)).toBeNull()
    })

    it('does not write while the model registry is unavailable', () => {
      // A transient failure must not delete the tier, and the note must not
      // assert the credential lists no model for it — with no catalogue read,
      // the panel cannot know that.
      models = []
      modelsFailed = true
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(save).not.toHaveBeenCalled()
      expect(screen.getByText(/Still Medium in the file/)).toBeTruthy()
    })

    it('does not move the picker when the write is refused', () => {
      // A read-only folder. The manifest still says `complexity: medium`, so a
      // panel showing the Model select over it would misreport the agent.
      writeFails = true
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(save).toHaveBeenCalled()
      expect(screen.getByText(/Could not write/)).toBeTruthy()
      expect(screen.getByLabelText('Work complexity')).toBeTruthy()
      expect(screen.queryByLabelText('Model')).toBeNull()
      // …and the preference did not move either, so the next agent is unaffected.
      expect(setSetting).not.toHaveBeenCalled()
    })

    it('round-trips a pinned dated snapshot without re-deriving it', () => {
      // `bestInTier` prefers a stable alias, so re-deriving would trade the
      // snapshot the user deliberately pinned for a floating id — by way of a
      // control that only claims to change which picker is shown.
      models = [
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (2025-10-01)', providerId: 'p-anthropic' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', providerId: 'p-anthropic' }
      ]
      const { rerender } = render(
        <RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-haiku-4-5-20251001' })} />
      )
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(saved()).toEqual({ credential: 'Anthropic', modelId: null, complexity: 'simple' })
      rerender(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'simple' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      const [, second] = save.mock.calls as unknown as [unknown, [{ runtime: unknown }]]
      expect(second[0].runtime).toEqual({
        engine: null,
        credential: 'Anthropic',
        modelId: 'claude-haiku-4-5-20251001',
        complexity: null
      })
    })

    it('sends only the field the current view owns, so a both-set manifest still edits', () => {
      // The validator tolerates `model` + `complexity` together (a folder from a
      // newer tool), so such an agent is runnable — and used to make this picker
      // throw a refusal about a key the user cannot see.
      render(
        <RuntimePanel
          agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5', complexity: 'medium' })}
        />
      )
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'My Anthropic' } })
      const runtime = saved()
      expect(runtime.complexity).toBeNull()
      expect(runtime.modelId).toBe('claude-sonnet-4-5')
    })

    it('names the consequence, not just the model, so Default and a tier differ', () => {
      // They resolve to the same model here. What differs is that Default moves
      // when the default chat mode moves and a tier travels with the folder —
      // and that appeared nowhere while both read `… (Claude Sonnet 4.5)`.
      const { unmount } = render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
      expect(
        screen.getByText('Default — follows the Default runtime, on Claude Sonnet 4.5.')
      ).toBeTruthy()
      unmount()
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      expect(
        screen.getByText('Medium — the balanced default, on Claude Sonnet 4.5.')
      ).toBeTruthy()
    })

    it('waits for the remembered preference before choosing a picker', () => {
      // Rendering the tier and then flipping to the model select when the
      // settings query resolves would swap the control under the pointer.
      settingsLoaded = false
      advanced = true
      const { rerender } = render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
      // Neither picker, not a disabled wrong one: disabling stops interaction
      // but not the swap, and the swap is the rule-1 problem.
      expect(screen.queryByLabelText('Work complexity')).toBeNull()
      expect(screen.queryByLabelText('Model')).toBeNull()
      expect(screen.getByLabelText('Runs on')).toHaveProperty('disabled', true)

      settingsLoaded = true
      rerender(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
      // …and it resolves straight to the remembered one, never via the other.
      expect(screen.getByLabelText('Model')).toBeTruthy()
    })

    it('keeps the tier when the credential changes from the Advanced view', () => {
      // Reachable, and cruel: Complex resolves to nothing on Anthropic, so
      // ticking Advanced is a no-op that leaves the Model picker over a manifest
      // still saying `complexity: complex` — and the panel has just advised
      // "pick another complexity or another credential". Taking the second half
      // of that advice must not destroy the tier the note promised was still
      // there.
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'complex' })} />)
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(save).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Model')).toBeTruthy()
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      expect(saved()).toEqual({ credential: 'OpenAI', modelId: null, complexity: 'complex' })
    })

    it('breaks only a genuine both-set collision, in the visible view’s favour', () => {
      render(
        <RuntimePanel
          agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5', complexity: 'medium' })}
        />
      )
      // Model view: the model survives, the unseen tier is what gives way.
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'My Anthropic' } })
      expect(saved()).toEqual({
        credential: 'My Anthropic',
        modelId: 'claude-sonnet-4-5',
        complexity: null
      })
    })

    it('keeps a conversion note across its own write, and retires it on a foreign edit', () => {
      // The note sits at priority 2, above almost everything. It describes a
      // specific state of the file, so it has to survive the write it describes
      // (including the window before the query refetches) and stop the moment
      // somebody else's edit makes it untrue.
      const { rerender } = render(
        <RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} />
      )
      fireEvent.click(screen.getByRole('checkbox', { name: /Advanced/ }))
      expect(screen.getByText(/Switched to Medium/)).toBeTruthy()

      // The manifest catches up with what we wrote: still true, still shown.
      rerender(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'medium' })} />)
      expect(screen.getByText(/Switched to Medium/)).toBeTruthy()

      // A third state — an assistant edited the file — and the note goes.
      rerender(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'complex' })} />)
      expect(screen.queryByText(/Switched to Medium/)).toBeNull()
    })

    it('gives the reserved line to a binary this machine could not get', () => {
      // The one engine-level state left that a user can act on, and it takes
      // the slot the shared config's skip list used to fill.
      binary = { state: 'failed', error: 'Fix the engine path in Settings, or clear it.' }
      render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
      expect(screen.getByText('Fix the engine path in Settings, or clear it.')).toBeTruthy()
    })

    it('says there is no engine before it says anything about a credential', () => {
      // With no binary, "your default chat mode uses a switched-off credential"
      // is a true sentence about something that would not help — and the Engine
      // column is showing the failure in red at the same moment, so the line
      // below it talking about a credential left that cell explained only by a
      // hover title.
      binary = { state: 'failed', error: 'Fix the engine path in Settings, or clear it.' }
      render(<RuntimePanel agent={agent({ credential: 'Nonexistent' })} />)
      expect(screen.getByText('Fix the engine path in Settings, or clear it.')).toBeTruthy()
      expect(screen.queryByText(/no credential named/i)).toBeNull()
    })

    it('resolves a shared name to the same row the engine will, not the switched-off one', () => {
      // Two rows answering one reference is the ordinary state on an
      // account-provisioned machine. While the panel kept its own copy of the
      // tie-break, main learning to prefer an enabled row silently split the
      // two: the engine ran `On Anthropic` and this panel described `Off
      // Anthropic` — the wrong key, the wrong catalogue and a "switched off"
      // warning, on the one screen a user reads to find out what they are
      // billed for. Both sides call `findCredentialByReference` now.
      providers = [
        {
          id: 'p-off',
          type: 'anthropic',
          name: 'Shared',
          hasApiKey: true,
          enabled: false,
          unsupported: false,
          defaultModelId: null as string | null
        },
        {
          id: 'p-on',
          type: 'anthropic',
          name: 'Shared',
          hasApiKey: true,
          enabled: true,
          unsupported: false,
          defaultModelId: null as string | null
        }
      ]
      render(<RuntimePanel agent={agent({ credential: 'Shared' })} />)
      // The enabled row won, so there is nothing to warn about.
      expect(screen.queryByText(/is switched off/)).toBeNull()
    })

    it('says a switched-off credential is switched off, not short of a key', () => {
      // Two different remedies, and the wrong one sends the user looking for a
      // key they already have. The credential is fully usable — it is simply
      // off, which the engine now honours by leaving it out of the config
      // entirely (`collectEngineProviders`).
      providers = [...PROVIDERS, {
        id: 'p-off',
        type: 'anthropic',
        name: 'Paused Anthropic',
        hasApiKey: true,
        enabled: false,
        unsupported: false,
        defaultModelId: null as string | null
      }]
      render(<RuntimePanel agent={agent({ credential: 'Paused Anthropic' })} />)
      expect(
        screen.getByText(/This credential is switched off\. Turn it back on in Settings/)
      ).toBeTruthy()
      expect(screen.queryByText(/has no API key this app can use/)).toBeNull()
      expect(screen.queryByText(/not configured on this machine/)).toBeNull()
    })

    it('names a keyless credential rather than calling it unconfigured', () => {
      // It is configured; it just has no key this app can use. Resolving it to
      // nothing hid the message written for that case and pointed the tier
      // labels at the default credential's catalogue instead.
      providers = [...PROVIDERS, {
        id: 'p-dry',
        type: 'anthropic',
        name: 'Dry Anthropic',
        hasApiKey: false,
        enabled: true,
        unsupported: false,
        defaultModelId: null as string | null
      }]
      render(<RuntimePanel agent={agent({ credential: 'Dry Anthropic' })} />)
      expect(screen.getByText(/“Dry Anthropic” has no API key this app can use/)).toBeTruthy()
      expect(screen.queryByText(/not configured on this machine/)).toBeNull()
      // …and the select shows it, rather than rendering blank over a file that
      // plainly names a credential.
      expect(screen.getByLabelText('Runs on')).toHaveProperty('value', 'Dry Anthropic')
    })

    it('warns when the credential lists nothing in the tier the agent asks for', () => {
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'simple' })} />)
      // One vocabulary for the tiers: this sentence and "Still Complex in the
      // file" can occupy the same slot seconds apart.
      expect(screen.getByText(/Anthropic lists no model for Simple work/)).toBeTruthy()
    })

    /** An agent whose manifest declares one credential and has not got it. */
    function withSecret(): LocalAgentDto {
      return {
        ...agent({ credential: 'Anthropic' }),
        credentials: [
          {
            name: 'Vendor Portal',
            type: 'api_key',
            optional: false,
            envPrefix: 'VENDOR_PORTAL_',
            expectedKeys: ['VENDOR_PORTAL_TOKEN'],
            presentKeys: [],
            satisfied: false
          }
        ]
      } as unknown as LocalAgentDto
    }

    it('opens credentials/.env itself, not the folder it sits in', () => {
      render(<RuntimePanel agent={withSecret()} />)
      fireEvent.click(screen.getByText('Add them in credentials/.env'))
      expect(openCredentials.mock.calls[0][0]).toBe('folder:a')
    })

    it('says so when the click only revealed the file — the editor step did not happen', () => {
      openCredentials.mockImplementation(
        (_id: string, options?: { onSuccess?: (r: { created: boolean; revealed: boolean }) => void }) =>
          options?.onSuccess?.({ created: true, revealed: true })
      )
      render(<RuntimePanel agent={withSecret()} />)
      fireEvent.click(screen.getByText('Add them in credentials/.env'))
      expect(screen.getByText(/shown in the file manager/)).toBeTruthy()
    })

    it('stays silent when the file actually opened', () => {
      openCredentials.mockImplementation(
        (_id: string, options?: { onSuccess?: (r: { created: boolean; revealed: boolean }) => void }) =>
          options?.onSuccess?.({ created: true, revealed: false })
      )
      render(<RuntimePanel agent={withSecret()} />)
      fireEvent.click(screen.getByText('Add them in credentials/.env'))
      expect(screen.queryByText(/file manager/)).toBeNull()
    })

    it('reports a refused open rather than leaving the click inert', () => {
      openCredentials.mockImplementation(
        (_id: string, options?: { onError?: (e: Error) => void }) =>
          options?.onError?.(
            new Error(
              "Error invoking remote method 'local-agent:open-credentials': LocalAgentError: credentials/.env could not be created."
            )
          )
      )
      render(<RuntimePanel agent={withSecret()} />)
      fireEvent.click(screen.getByText('Add them in credentials/.env'))
      // Unwrapped: the IPC plumbing never reaches the user (ux_rules rule 6).
      expect(screen.getByText('credentials/.env could not be created.')).toBeTruthy()
    })

    it('reports a substituted model rather than rewriting the file', () => {
      models = [
        { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini', providerId: 'p-openai' },
        { id: 'gpt-5', name: 'GPT-5', providerId: 'p-openai' }
      ]
      render(<RuntimePanel agent={agent({ credential: 'OpenAI', model: 'gpt-5.4-mini' })} />)
      expect(screen.getByText(/“gpt-5.4-mini” is no longer listed. Running on “GPT-5.5 Mini”./))
        .toBeTruthy()
      expect(save).not.toHaveBeenCalled()
    })
  })

  describe('an engine the panel cannot yet change', () => {
    it('carries a declared engine through a save about something else', () => {
      // **The panel rewrites the whole `runtime` block**, so every save has to
      // carry the engine or it deletes the user's choice out of a file they
      // commit. Changing the *tier* is that case: it says nothing about which
      // engine runs the agent, so the engine must come through untouched.
      // (Changing the Runs-on select is no longer "something else" — that
      // control now sets the engine, and the two tests below cover it.)
      render(<RuntimePanel agent={agent({ engine: 'claude', complexity: 'complex' })} />)
      fireEvent.change(screen.getByLabelText('Work complexity'), { target: { value: 'simple' } })
      const [vars] = save.mock.calls[0] as [
        { runtime: { engine: string | null; complexity: string | null } }
      ]
      expect(vars.runtime.engine).toBe('claude')
      expect(vars.runtime.complexity).toBe('simple')
    })

    it('offers Claude Agent only where Claude Code is installed', () => {
      // An absent tool means an absent option, never one that fails after the
      // click (ux_rules rule 4).
      render(<RuntimePanel agent={agent(null)} />)
      expect(screen.getByRole('option', { name: 'Claude Agent' })).toBeTruthy()

      claudeInstalled = false
      cleanup()
      render(<RuntimePanel agent={agent(null)} />)
      expect(screen.queryByRole('option', { name: 'Claude Agent' })).toBeNull()
    })

    it('keeps the option for an agent already on it, with nothing installed', () => {
      // Otherwise the select renders blank over a manifest that plainly says
      // what the agent runs on — the same rule the credential list follows for
      // a credential that is configured but keyless.
      claudeInstalled = false
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.getByRole('option', { name: 'Claude Agent' })).toBeTruthy()
      expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('engine:claude')
    })

    it('switching to Claude clears the credential and keeps the tier', () => {
      // The credential cannot travel — `runtimeService.validate` refuses to
      // write both, because that path spends none. The *tier* does: `medium`
      // means the same thing on either engine, so the user's answer to "how
      // hard is this work" is not something a change of runtime should discard.
      render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'complex' })} />)
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'engine:claude' } })
      const [vars] = save.mock.calls[0] as [
        { runtime: { engine: string | null; credential: string | null; complexity: string | null } }
      ]
      expect(vars.runtime).toMatchObject({
        engine: 'claude',
        credential: null,
        complexity: 'complex'
      })
    })

    it('switching away from Claude clears the engine', () => {
      render(<RuntimePanel agent={agent({ engine: 'claude', complexity: 'medium' })} />)
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      const [vars] = save.mock.calls[0] as [
        { runtime: { engine: string | null; credential: string | null; complexity: string | null } }
      ]
      expect(vars.runtime).toMatchObject({
        engine: null,
        credential: 'OpenAI',
        complexity: 'medium'
      })
    })

    it('hides Advanced rather than offering a list with nothing in it', () => {
      // A control that lists nothing is worse than a control that is not there,
      // and there is no raw model catalogue on this path to list. Hidden from
      // inside the fixed-height row, so the panel keeps its footprint (rule 1).
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.queryByRole('checkbox', { name: /Advanced/ })).toBeNull()
      expect(screen.getByLabelText('Work complexity')).toBeTruthy()
    })

    it('says what it runs on, and what is missing when nothing is installed', () => {
      // `unknown` rather than the default `undefined`: this assertion is about
      // the install sentence, and the panel is deliberately silent until the
      // probe has answered something.
      claudeAuth = { state: 'unknown', authMethod: null, subscriptionType: null, email: null }
      render(<RuntimePanel agent={agent({ engine: 'claude', complexity: 'complex' })} />)
      // Both names in one sentence: the select says "Claude Agent", the column
      // beside it says "Claude Code", and nothing else ties them together.
      expect(
        screen.getByText(/Claude Agent runs on your own Claude Code install, on opus/)
      ).toBeTruthy()

      claudeInstalled = false
      cleanup()
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      // The full sentence lives in the reserved line; the Engine column only
      // names the state, because that column is fixed-width and cannot grow.
      expect(screen.getByText(/Claude Agent needs Claude Code\. Install it in Settings/)).toBeTruthy()
      expect(screen.getByText('Not installed')).toBeTruthy()
    })

    it('names the account and the plan that pays for it, once the probe has answered', () => {
      // The claim the panel could not make before `claude auth status` was
      // wired in: readiness was answerable only by spending a turn, so the line
      // said "install" — the weaker fact — and a logged-out machine read as
      // completely healthy until the first turn failed. The account is the half
      // a tier cannot supply: "Max plan" says a subscription pays and not which
      // one, on a machine that may hold more than one Claude login.
      claudeAuth = {
        state: 'logged_in',
        authMethod: 'claude.ai',
        subscriptionType: 'max',
        email: 'someone@example.com'
      }
      render(<RuntimePanel agent={agent({ engine: 'claude', complexity: 'complex' })} />)
      expect(
        screen.getByText(
          /Claude Agent runs on your own Claude Code login — someone@example\.com \(Max plan\), on opus/
        )
      ).toBeTruthy()
    })

    it.each([
      ['no plan', { subscriptionType: null, email: 'someone@example.com' }, /login — someone@example\.com, on sonnet/],
      ['no account', { subscriptionType: 'max', email: null }, /login \(Max plan\), on sonnet/],
      ['neither', { subscriptionType: null, email: null }, /login, on sonnet/]
    ])('says only what the CLI named when it reported %s', (_label, over, expected) => {
      // Four shapes, spelled out rather than assembled from optional fragments:
      // a stray dash or an empty parenthesis on the line that exists to say who
      // pays is worse than the shorter true sentence. Nothing is inferred —
      // an install authenticated some other way is still logged in.
      claudeAuth = { state: 'logged_in', authMethod: 'claude.ai', ...over }
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      const line = screen.getByText(expected)
      expect(line.textContent).not.toMatch(/—\s*\(|\(\s*\)|—\s*,/)
    })

    it('leads a logged-out machine with the remedy, because this line is measured to clip', () => {
      // Problem-first, the sentence needed 432px against 414px available at the
      // 800px minimum and lost `…in a ter|minal.` — the half rule 7 says has to
      // survive. The assertion is on the order, not just the presence.
      claudeAuth = { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null }
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      const line = screen.getByText(/not logged in/)
      expect(line.textContent).toMatch(/^Run `claude` in a terminal/)
      expect(line.textContent).toContain('that Claude Code install is not logged in')
      // The Engine column still reports what was *detected* — the install and
      // its version are facts, and the reserved line carries what they mean.
      expect(screen.getByText(/Claude Code 2\.1\.266/)).toBeTruthy()
    })

    it('marks the Engine dot as awaiting auth when the login is the thing missing', () => {
      // The one glanceable indicator in the row sat neutral grey above a red
      // sentence saying that install cannot run — silent about a state the app
      // had just gone and found out. Warning, not danger: the install is fine
      // and one command fixes it. Not green either, ever: one option away in
      // this same slot green means *the process is running*.
      claudeAuth = { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null }
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      const row = screen.getByText(/Claude Code 2\.1\.266/).closest('div')
      expect(row?.parentElement?.innerHTML).toContain('--color-warning')
    })

    it.each([
      ['the probe has not answered', undefined],
      ['the probe could not answer', { state: 'unknown', authMethod: null, subscriptionType: null, email: null }],
      ['the install is logged in', { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: null }]
    ])('leaves the dot muted when %s', (_label, answer) => {
      // Neither absence nor uncertainty is evidence, and a healthy login must
      // not go green here for the reason above.
      claudeAuth = answer as typeof claudeAuth
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      const row = screen.getByText(/Claude Code 2\.1\.266/).closest('div')
      const html = row?.parentElement?.innerHTML ?? ''
      expect(html).toContain('--color-text-muted')
      expect(html).not.toContain('--color-warning')
      expect(html).not.toContain('--color-success')
    })

    it('says nothing at all until the probe answers, rather than a sentence it will retract', () => {
      // The same rule as `toolsUnknown` one rung up. Filling the slot with the
      // reassuring install sentence meant a logged-out machine read healthy in
      // grey and was contradicted in red a tenth of a second later; the line is
      // reserved, so silence costs no movement and buys a sentence that is not
      // withdrawn.
      claudeAuth = undefined
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.queryByText(/runs on your own Claude Code/)).toBeNull()
      expect(screen.queryByText(/not logged in/)).toBeNull()
    })

    it('an answer of `unknown` is an answer: it gets the install sentence, not silence', () => {
      // Distinct from the state above, and the distinction is the point. The
      // probe ran and could not tell — a timeout, output this build cannot
      // read — and "runs on your own Claude Code install" is the true thing to
      // say about that machine. Blanking here would lose the only line that
      // says what the agent runs on.
      claudeAuth = { state: 'unknown', authMethod: null, subscriptionType: null, email: null }
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.getByText(/runs on your own Claude Code install, on sonnet/)).toBeTruthy()
      expect(screen.queryByText(/logged in/)).toBeNull()
    })

    it('names the opencode binary it found, and offers nothing to press', () => {
      // The row reports a *file*, not a process: since phase 3 each agent
      // spawns its own child per turn and the pool reaps it two minutes later,
      // so "running" would be true for a couple of minutes after a message and
      // false the rest of the time (ux_rules rules 2 and 12).
      render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
      expect(screen.getByText('opencode 1.0.0')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    })

    it('says what will happen rather than nothing, before anything has looked', () => {
      binary = { state: 'unresolved' }
      render(<RuntimePanel agent={agent({ credential: 'OpenAI' })} />)
      expect(screen.getByText('On the first message')).toBeTruthy()
    })

    it('does not report the opencode binary to an agent that never runs on it', () => {
      // A fact about something unrelated (ux_rules rule 9). It used to be worse
      // than unrelated — the row reported the shared server's state and offered
      // a Start button that changed nothing for this agent — and there is no
      // button on either engine now.
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.queryByText(/opencode/)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
      expect(screen.getByText(/Claude Code 2\.1\.266/)).toBeTruthy()
    })

    it('does not wait for the model registry it will never consult', () => {
      // There is no catalogue to resolve a tier against on this path, so gating
      // on one would leave both pickers disabled for ever — on precisely the
      // machine most likely to be using this engine: one with no AI credential
      // configured at all.
      models = undefined as never
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.getByLabelText('Runs on')).toHaveProperty('disabled', false)
      expect(screen.getByLabelText('Work complexity')).toHaveProperty('disabled', false)
    })

    it('can change the tier of an agent whose manifest also names a credential', () => {
      // **A manifest carrying both is legal to *read*** — the validator only
      // warns, because a folder written by a newer tool must keep running — and
      // the panel correctly shows no credential for it. But the tier's commit
      // was passing `declaredCredential` anyway, so the panel handed
      // `runtimeService.validate` the one pair it refuses, built from a control
      // that is not on screen. The write failed, the select snapped back, and
      // the tier was unchangeable for ever with nothing saying why.
      render(
        <RuntimePanel agent={agent({ engine: 'claude', credential: 'Anthropic' })} />
      )
      fireEvent.change(screen.getByLabelText('Work complexity'), { target: { value: 'complex' } })
      const [vars] = save.mock.calls[0] as [
        { runtime: { engine: string | null; credential: string | null; complexity: string | null } }
      ]
      expect(vars.runtime).toMatchObject({
        engine: 'claude',
        // Dropped, exactly as switching *to* Claude drops it: the panel stopped
        // showing it, so it must stop sending it.
        credential: null,
        complexity: 'complex'
      })
    })

    it('claims nothing about the machine before detection has answered', () => {
      // **"The query has not answered" and "the answer is no" are not the same
      // fact**, and collapsing them put the full red not-installed alarm on
      // screen for half a second on a machine that *has* Claude Code — the
      // default first visit for every agent on this engine, not an edge case.
      // Worse, the sentence names a remedy the user would satisfy by installing
      // something they already have (ux_rules rule 9, and rule 2's warning
      // about teaching people to skip alarms).
      toolsLoaded = false
      render(<RuntimePanel agent={agent({ engine: 'claude' })} />)
      expect(screen.queryByText(/not installed/i)).toBeNull()
      expect(screen.queryByText(/needs Claude Code/)).toBeNull()
      // The row keeps its place and says only that it is still looking.
      expect(screen.getByText('Checking…')).toBeTruthy()
    })

    it('says nothing in the reserved line while detection is unanswered', () => {
      // Rather than the healthy sentence, which would assert an install just as
      // wrongly as the alarm denies one.
      toolsLoaded = false
      render(<RuntimePanel agent={agent({ engine: 'claude', complexity: 'complex' })} />)
      expect(screen.queryByText(/Claude Agent runs on your own Claude Code install/)).toBeNull()
    })

    it('does not write back an engine value it does not recognise', () => {
      // The tolerant read, at the one layer that could turn a value a newer
      // tool wrote into one *this* build vouches for. Reading it as none and
      // clearing it is right: the agent falls to the default either way, and
      // echoing an unknown value back would be this desktop asserting it.
      render(<RuntimePanel agent={agent({ engine: 'future-engine' })} />)
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      const [vars] = save.mock.calls[0] as [{ runtime: { engine: string | null } }]
      expect(vars.runtime.engine).toBeNull()
    })
  })

  /**
   * A bare agent picks its runtime like any other; only the destination differs.
   * The panel used to be a second, control-less component for this kind, so the
   * assertions here are that the controls exist at all, that they write through
   * the channel with no stamp in it, and that the manifest one is left alone.
   */
  describe('a bare agent', () => {
    it('edits its runtime with no stamp to guard the write', () => {
      render(<RuntimePanel agent={bareAgent(null)} />)
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      expect(save).not.toHaveBeenCalled()
      const [vars] = saveBare.mock.calls[0] as [{ agentId: string; runtime: unknown }]
      expect(vars).toEqual({
        agentId: 'folder:external:r1:support',
        runtime: { engine: null, credential: 'OpenAI', modelId: null, complexity: null }
      })
    })

    it('opens on the runtime it was given, exactly as a manifest one does', () => {
      render(<RuntimePanel agent={bareAgent({ credential: 'OpenAI', model: 'gpt-5' })} />)
      expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('OpenAI')
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('gpt-5')
    })

    it('says where the choice is kept, and claims no more than that', () => {
      render(<RuntimePanel agent={bareAgent(null)} />)
      expect(screen.getByText(/This choice is kept in Cinna, not in the folder/)).toBeTruthy()
      // Not "nothing is written to the folder": the Prompts tab is a live
      // editor over AGENT.md, one tab away (ux_rules rule 9).
      expect(screen.queryByText(/nothing is written to the folder/i)).toBeNull()
    })

    it('never claims the manifest went stale — there is no manifest', () => {
      writeFails = true
      render(<RuntimePanel agent={bareAgent(null)} />)
      fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'OpenAI' } })
      expect(screen.getByText('Could not save this agent’s local state.')).toBeTruthy()
      expect(screen.queryByText(/cinna-agent.json changed on disk/)).toBeNull()
    })
  })
})

it('shows an unsupported manifest engine explicitly in Runs on', () => {
  render(<RuntimePanel agent={agent({ engine: 'gemini' })} />)
  expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('unsupported-engine')
  expect(screen.getByText('Unsupported engine: gemini')).toBeTruthy()
})


describe('runtime badges on the agent chat page', () => {
  it('names a verified Claude subscription and the selected model without editing controls', () => {
    claudeAuth = { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'me@example.com' }
    render(<RuntimePanel agent={agent({ engine: 'claude', complexity: 'complex' })} compact />)
    expect(screen.getByText('Claude Agent with subscription')).toBeTruthy()
    expect(screen.getByText('opus')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
  it('does not claim a subscription when authentication is unknown', () => {
    claudeAuth = undefined
    render(<RuntimePanel agent={agent({ engine: 'claude' })} compact />)
    expect(screen.getByText('Claude Agent')).toBeTruthy()
    expect(screen.queryByText(/with subscription/)).toBeNull()
  })
  it('uses the same credential and model as the full form', () => {
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', model: 'claude-sonnet-4-5' })} compact />)
    expect(screen.getByText('OpenCode with Anthropic')).toBeTruthy()
    expect(screen.getByTitle('Model: Claude Sonnet 4.5')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})


describe('Codex runtime', () => {
  it('selects Codex, clears the credential/model, and preserves complexity', () => {
    codexInstalled = true
    render(<RuntimePanel agent={agent({ credential: 'Anthropic', complexity: 'complex' })} />)
    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: 'engine:codex' } })
    expect((save.mock.calls[0][0] as { runtime: unknown }).runtime).toMatchObject({ engine: 'codex', credential: null, modelId: null, complexity: 'complex' })
  })
  it('runs without a provider catalogue and explains reasoning effort', () => {
    codexInstalled = true
    models = undefined
    providers = []
    render(<RuntimePanel agent={agent({ engine: 'codex', complexity: 'complex' })} />)
    expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('engine:codex')
    expect(screen.getByText(/high reasoning effort/)).toBeTruthy()
    expect(screen.queryByText('Advanced')).toBeNull()
    expect((screen.getByLabelText('Work complexity') as HTMLSelectElement).disabled).toBe(false)
  })
  it('shows the login remedy, and keeps an explicitly selected Codex visible when its install failed', () => {
    codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.155.0/codex', source: 'managed', version: 'codex-cli 0.155.0' }
    codexAuth = { state: 'logged_out' }
    const view = render(<RuntimePanel agent={agent({ engine: 'codex' })} />)
    expect(screen.getByText(/Run `codex login`/)).toBeTruthy()
    codexBinary = { state: 'failed', error: 'The downloaded Codex did not match its expected checksum.' }
    view.rerender(<RuntimePanel agent={agent({ engine: 'codex' })} />)
    expect((screen.getByLabelText('Runs on') as HTMLSelectElement).value).toBe('engine:codex')
    // The remedy is Cinna's own retry. 'Install it' would send the user to put
    // a codex on their PATH, which no spawned session runs on.
    expect(screen.getByText(/Try again in Settings → Agents → Runtime: Codex could not be installed/)).toBeTruthy()
    expect(screen.queryByText(/Codex CLI is needed/)).toBeNull()
    // The Engine cell agrees with the sentence beside it: Cinna installs this
    // CLI, so "Not installed" would name a step the user never had.
    expect(screen.getByText('Install failed')).toBeTruthy()
    expect(screen.queryByText('Not installed')).toBeNull()
  })
  it('raises no alarm on a machine with no codex on PATH: the managed CLI is what runs', () => {
    // Mutation: read PATH detection again and this machine — no `codex`
    // installed, nothing fetched yet — is told in red to install a CLI, and the
    // Codex option disappears from the picker for every agent not already on it.
    codexInstalled = false
    codexBinary = { state: 'unresolved' }
    const view = render(<RuntimePanel agent={agent({ engine: 'codex' })} />)
    expect(screen.queryByText(/is needed|could not be installed|Not installed/)).toBeNull()
    expect(screen.getByText('Codex 0.155.0 managed')).toBeTruthy()
    view.unmount()
    render(<RuntimePanel agent={agent({ credential: 'Anthropic' })} />)
    expect(screen.getByLabelText('Runs on').querySelector('option[value="engine:codex"]')).not.toBeNull()
  })
  it('names an explicit Codex path by its own version, not the pin', () => {
    codexBinary = { state: 'ready', path: '/opt/codex', source: 'configured', version: 'codex-cli 0.156.0' }
    render(<RuntimePanel agent={agent({ engine: 'codex' })} />)
    expect(screen.getByText('Codex 0.156.0')).toBeTruthy()
    expect(screen.queryByText(/managed/)).toBeNull()
  })
})


it('names the machine default separately from a pinned Codex runtime', () => {
  codexInstalled = true
  render(<RuntimePanel agent={agent({ engine: 'codex' })} />)
  const picker = screen.getByLabelText('Runs on') as HTMLSelectElement
  expect(picker.value).toBe('engine:codex')
  expect(picker.querySelector('option[value=""]')?.textContent).not.toContain('Codex')
})
