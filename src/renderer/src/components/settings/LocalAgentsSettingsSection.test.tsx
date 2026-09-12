import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Settings → Local Agents, the shape of its cards: under every control there
 * is a one-line status that is filled in every state, or a message rendered
 * only while it applies, last in its card — and never an empty slot. The
 * standing explanations are behind the `(?)` tips (ux_rules rules 1 and 12).
 */

const mutation = (): { mutate: ReturnType<typeof vi.fn>; isPending: boolean; variables: undefined } => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined
})

const HEALTHY_SETTINGS = {
  localAgentsDefaultEngine: 'opencode',
  localAgentsEnginePath: '',
  localAgentsDefaultCredentialId: '',
  taskRunnerConcurrency: 2
}
const READY_BINARY = {
  state: 'ready',
  path: '/usr/local/bin/opencode',
  source: 'path',
  version: '1.2.3'
}
let appSettings: Record<string, unknown> = HEALTHY_SETTINGS
let binary: Record<string, unknown> = READY_BINARY
let providers: Array<Record<string, unknown>> = []
beforeEach(() => {
  appSettings = HEALTHY_SETTINGS
  binary = READY_BINARY
  providers = []
  setAppSetting.mockReset()
})

vi.mock('../../hooks/useLocalAgents', () => ({
  useAddAgentRoot: mutation,
  useAgentsHome: () => ({ data: { path: '/home/dev/Agents', guarded: false } }),
  useLocalAgents: () => ({ data: { roots: [], homeAccess: 'ready' }, isLoading: false }),
  useRemoveAgentRoot: mutation,
  useRescanLocalAgents: mutation
}))
vi.mock('../../hooks/useLocalTools', () => ({
  useDefaultTool: () => ({ tool: null, launchable: [], autoOpen: false }),
  useInstallRuntimeTool: mutation,
  useLocalTools: () => ({ data: [] }),
  useOpenIn: mutation,
  useRefreshLocalTools: mutation,
  useSetDefaultTool: () => vi.fn(),
  useToolInstallPlans: () => ({ data: [] })
}))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
vi.mock('../../hooks/useChatModes', () => ({
  useDefaultChatMode: () => ({ data: { name: 'Personal' } })
}))
vi.mock('../../hooks/useEngine', () => ({
  useEngineBinary: () => ({ data: binary }),
  useResolveEngineBinary: mutation
}))
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings, isError: false }),
  useSetAppSetting: () => ({ mutate: setAppSetting, isPending: false, variables: undefined })
}))

const { LocalAgentsSettingsSection } = await import('./LocalAgentsSettingsSection')

describe('LocalAgentsSettingsSection', () => {
  it('reports the ready binary on one line and renders no credential or path message when healthy', () => {
    render(<LocalAgentsSettingsSection />)

    expect(screen.getByText('Ready — opencode 1.2.3, your own installation.')).toBeTruthy()
    expect(screen.queryByText(/agents pinned to it will not run/)).toBeNull()
    expect(screen.queryByText(/default chat mode\.$/)).toBeNull()
    expect(screen.queryByText(/Used from the next agent run/)).toBeNull()
  })

  it('warns about a switched-off pinned credential without claiming a fallback', () => {
    appSettings = { ...appSettings, localAgentsDefaultCredentialId: 'p1' }
    providers = [{ id: 'p1', name: 'Team', type: 'openai', enabled: false, hasApiKey: true }]
    render(<LocalAgentsSettingsSection />)

    // The name is the part that may truncate; the sentence never does.
    const sentence = screen.getByText('is switched off — agents pinned to it will not run.')
    expect(sentence.parentElement?.textContent).toBe(
      'Team is switched off — agents pinned to it will not run.'
    )
    expect(sentence.previousElementSibling?.className).toContain('truncate')
  })

  it('reports a failed resolve in the danger tone, with Try again beside it', () => {
    binary = { state: 'failed', error: 'opencode could not be downloaded.' }
    render(<LocalAgentsSettingsSection />)

    const status = screen.getByText('opencode could not be downloaded.')
    expect(status.className).toContain('text-[var(--color-danger)]')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('says a vanished pin falls through to the chat mode, and only then', () => {
    appSettings = { ...appSettings, localAgentsDefaultCredentialId: 'gone' }
    providers = []
    render(<LocalAgentsSettingsSection />)

    expect(
      screen.getByText('Pinned credential is gone — agents use your default chat mode.')
    ).toBeTruthy()
  })

  it('notes a saved path the status line does not describe yet, last in its card', () => {
    appSettings = { ...appSettings, localAgentsEnginePath: '/opt/opencode' }
    render(<LocalAgentsSettingsSection />)

    expect(
      screen.getByText('Used from the next agent run. The status above is still the old path.')
    ).toBeTruthy()
  })

  it('discards a half-typed OpenCode path on Escape instead of saving it', () => {
    // Escape resets the field and blurs it; the blur commits synchronously with
    // the closure's value, so without the discard flag this *saved* the typed
    // path — the opposite of what Escape means.
    appSettings = { ...appSettings, localAgentsEnginePath: '/opt/opencode' }
    render(<LocalAgentsSettingsSection />)
    const input = screen.getByLabelText('OpenCode path', { exact: true }) as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '/tmp/half-typ' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(document.activeElement).not.toBe(input)
    expect(input.value).toBe('/opt/opencode')
    expect(setAppSetting).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'localAgentsEnginePath' }),
      expect.anything()
    )
  })

  it('keeps the Developer Tools explanations behind their tips', () => {
    render(<LocalAgentsSettingsSection />)

    expect(screen.queryByText(/What else Cinna found installed/)).toBeNull()
    expect(screen.queryByText(/Open-in button uses this tool/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'About Detected on this machine' }))
    expect(screen.getByText(/What else Cinna found installed globally/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'About Open agents with' }))
    expect(screen.getByText(/Open-in button uses this tool/)).toBeTruthy()
    expect(screen.getByLabelText('Open agents with').tagName).toBe('SELECT')
  })
})
