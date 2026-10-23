import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Settings → Local Agents → "Claude Agent signs in with": Subscription | API
 * Token. API Token is offered only when an Anthropic AI credential can carry
 * the turns; the credential select appears only when there is a choice; the
 * line under the controls is filled in every state (ux_rules rules 1 and 12).
 */

let appSettings: Record<string, unknown> = {}
let providers: Array<Record<string, unknown>> | undefined = []
let defaultMode: Record<string, unknown> | null = null
const setAppSetting = vi.fn()

vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
vi.mock('../../hooks/useChatModes', () => ({ useDefaultChatMode: () => ({ data: defaultMode }) }))
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings }),
  useSetAppSetting: () => ({ mutate: setAppSetting, isPending: false })
}))

const { ClaudeAuthModeRow, NO_ANTHROPIC_CREDENTIAL } = await import('./ClaudeAuthModeRow')

const anthropic = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Key ${id}`, type: 'anthropic', enabled: true, hasApiKey: true, unsupported: false, managed: false, ...over
})
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement

beforeEach(() => {
  appSettings = { claudeAuthMode: 'subscription', claudeApiCredentialId: '', localAgentsDefaultCredentialId: '' }
  providers = []
  defaultMode = null
  setAppSetting.mockReset()
})

describe('ClaudeAuthModeRow', () => {
  it('disables API Token with a hover tooltip when no Anthropic AI credential exists', () => {
    providers = [
      { ...anthropic('openai'), type: 'openai' },
      anthropic('off', { enabled: false }),
      anthropic('keyless', { hasApiKey: false }),
      anthropic('oauth', { unsupported: true, managed: true })
    ]
    render(<ClaudeAuthModeRow />)
    const api = button('API Token')
    expect(api.disabled).toBe(true)
    expect(api.parentElement?.getAttribute('title')).toBe(NO_ANTHROPIC_CREDENTIAL)
    expect(button('Subscription').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(api)
    expect(setAppSetting).not.toHaveBeenCalled()
    expect(screen.getByText('Turns run on your own Claude login and its plan.')).toBeTruthy()
  })

  it('offers API Token when a credential qualifies — an admin-shared managed one counts — and writes the mode', () => {
    providers = [anthropic('shared', { managed: true })]
    render(<ClaudeAuthModeRow />)
    const api = button('API Token')
    expect(api.disabled).toBe(false)
    expect(api.getAttribute('title')).toBeNull()
    expect(api.parentElement?.getAttribute('title') ?? null).toBeNull()
    fireEvent.click(api)
    expect(setAppSetting).toHaveBeenCalledWith({ key: 'claudeAuthMode', value: 'api_key' })
  })

  it('in API mode with one credential: no select, and the line names who is billed', () => {
    appSettings = { ...appSettings, claudeAuthMode: 'api_key' }
    providers = [anthropic('one')]
    render(<ClaudeAuthModeRow />)
    expect(button('API Token').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('Turns bill to the owner of “Key one”.')).toBeTruthy()
  })

  it('in API mode with several: a select showing the credential in force (the Default AI one when Anthropic), and a pick is saved', () => {
    appSettings = { ...appSettings, claudeAuthMode: 'api_key', localAgentsDefaultCredentialId: 'two' }
    providers = [anthropic('one'), anthropic('two')]
    render(<ClaudeAuthModeRow />)
    const select = screen.getByRole('combobox', { name: 'Anthropic credential for Claude Agent' }) as HTMLSelectElement
    expect(select.value).toBe('two')
    fireEvent.change(select, { target: { value: 'one' } })
    expect(setAppSetting).toHaveBeenCalledWith({ key: 'claudeApiCredentialId', value: 'one' })
  })

  it('a chosen credential that is gone stays visible as unavailable, with a warning that turns will not run', () => {
    appSettings = { ...appSettings, claudeAuthMode: 'api_key', claudeApiCredentialId: 'gone' }
    providers = [anthropic('one'), anthropic('gone', { enabled: false })]
    render(<ClaudeAuthModeRow />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('gone')
    expect(screen.getByRole('option', { name: 'Key gone — unavailable' })).toBeTruthy()
    const status = screen.getByText('The chosen credential is gone — Claude Agent turns will not run.')
    expect(status.className).toContain('text-[var(--color-warning)]')
  })

  it('in API mode with no credential left: the mode can still be switched back, and the line warns', () => {
    appSettings = { ...appSettings, claudeAuthMode: 'api_key' }
    providers = []
    render(<ClaudeAuthModeRow />)
    expect(screen.getByText(`${NO_ANTHROPIC_CREDENTIAL} — Claude Agent turns will not run.`)).toBeTruthy()
    fireEvent.click(button('Subscription'))
    expect(setAppSetting).toHaveBeenCalledWith({ key: 'claudeAuthMode', value: 'subscription' })
  })

  it('keeps the segments and the status line in fixed slots in every state', () => {
    // Mutation: put the select back beside the segments and the group's parent is no longer the label row.
    providers = undefined
    const { container, rerender } = render(<ClaudeAuthModeRow />)
    const line = (): Element => container.querySelector('p')!.parentElement!
    const group = (): Element => screen.getByRole('group', { name: 'Claude Agent signs in with' })
    expect(line().className).toContain('h-8')
    const segmentsParent = group().parentElement
    appSettings = { ...appSettings, claudeAuthMode: 'api_key' }
    providers = [anthropic('one'), anthropic('two')]
    rerender(<ClaudeAuthModeRow />)
    expect(line().className).toContain('h-8')
    // The select arrives on the status line, never beside the segments.
    expect(screen.getByRole('combobox').parentElement).toBe(line())
    expect(group().parentElement).toBe(segmentsParent)
    expect(segmentsParent?.contains(screen.getByRole('combobox'))).toBe(false)
  })
})
