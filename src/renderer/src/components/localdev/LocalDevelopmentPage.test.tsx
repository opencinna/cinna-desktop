import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/auth.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import type { DevelopmentContext } from '../../../../shared/developmentSession'
import { LocalDevelopmentPage } from './LocalDevelopmentPage'
import { LocalDevStatusButton } from './LocalDevStatusButton'

const mocks = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => undefined } } as unknown as typeof window.api
  return { start: vi.fn(), markdown: vi.fn(), settings: vi.fn() }
})
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: mocks.start }) }))
vi.mock('../../hooks/useAppSettings', () => ({ useSetAppSetting: () => ({ mutate: vi.fn() }), useAppSettings: () => { mocks.settings(); return { data: { localAgentsDefaultEngine: 'claude' } } } }))
vi.mock('../../hooks/useEngine', () => ({ useDefaultRuntime: () => ({ data: { engine: 'claude' } }), useCodexBinary: () => ({ data: { state: 'unresolved' } }), useClaudeBinary: () => ({ data: { state: 'unresolved' } }) }))
vi.mock('../../hooks/useLocalTools', () => ({ useClaudeAuth: () => ({ data: { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max' } }), useLocalTools: () => ({ data: [] }), useInstallRuntimeTool: () => ({}), useToolInstallPlan: () => null }))
vi.mock('react-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-markdown')>()
  return { ...original, default: (props: Parameters<typeof original.default>[0]) => {
    mocks.markdown()
    return original.default(props)
  } }
})
const ready = { phase: 'ready', workspacePath: '/accounts/alice', cliVersion: '1.2', cinnaBinPath: '/bin/cinna', protocol: 'json' } as const
const context = {
  profileId: 'alice', accountName: 'Alice', serverUrl: 'https://cinna.example', workspacePath: ready.workspacePath,
  cliVersion: ready.cliVersion, runtime: { launcher: 'claude', modelId: 'opus' }, complexity: 'complex',
  documents: [{ path: 'CLAUDE.md', content: '# Account guide\nUse cinna-cli to build agents.' }],
  instructions: 'Build using the active Cinna account.', blocker: null
} as DevelopmentContext
let sessionContext = vi.fn()
let prepareSession = vi.fn()
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><LocalDevelopmentPage /></QueryClientProvider>)
}
beforeEach(() => {
  mocks.markdown.mockClear()
  mocks.settings.mockClear()
  mocks.start.mockReset().mockResolvedValue(undefined)
  sessionContext = vi.fn().mockResolvedValue(context)
  prepareSession = vi.fn().mockResolvedValue({ agentId: 'builder' })
  window.api = { localDev: { sessionContext, prepareSession } } as unknown as typeof window.api
  useAuthStore.getState().setCurrentUser({ id: 'alice', username: 'alice@example.com', displayName: 'Alice', type: 'cinna_user', hasPassword: false, cinnaServerUrl: context.serverUrl })
  useLocalDevStore.setState({ state: ready, subscribed: true, drafts: {}, pageMode: 'chat' })
  useChatStore.setState({ sendError: null })
  useUIStore.setState({ activeView: 'local-development' })
})

describe('Local Development entry', () => {
  it.each([false, true])('actually rechecks CLI capabilities and clears the blocker (runtime settings: %s)', async (settingsOpen) => {
    sessionContext.mockResolvedValue({ ...context, setupTarget: 'local-dev', blocker: 'Cinna CLI needs JSON support.' })
    renderPage()
    await screen.findByText('Cinna CLI needs JSON support.')
    if (settingsOpen) fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    sessionContext.mockResolvedValue(context)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(sessionContext).toHaveBeenCalledWith(true))
    await waitFor(() => expect(screen.queryByText('Cinna CLI needs JSON support.')).toBeNull())
  })
  it('opens Default local development settings for a CLI compatibility blocker', async () => {
    sessionContext.mockResolvedValue({ ...context, setupTarget: 'local-dev', blocker: 'Cinna CLI 0.4.0 or later is required. Installed: 0.3.0.' })
    useUIStore.setState({ settingsTab: 'profile-local-dev' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Local Development settings' }))
    expect(useUIStore.getState().settingsTab).toBe('local-dev')
    expect(useUIStore.getState().activeView).toBe('settings')
  })
  it('restores the draft after navigating away and remounting the page', async () => {
    const first = renderPage()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Build my helper later' } })
    first.unmount()
    renderPage()
    expect(await screen.findByRole('textbox')).toHaveProperty('value', 'Build my helper later')
    expect(screen.getByRole('textbox')).toHaveProperty('selectionStart', 'Build my helper later'.length)
    expect(screen.getByRole('textbox')).toHaveProperty('selectionEnd', 'Build my helper later'.length)
  })
  it('keeps the draft when opening Settings and returning to Start chat', async () => {
    renderPage()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Build my helper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Local Development Runtime' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Build my helper')
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })
  it('opens the build page directly from the ready footer icon', () => {
    useLocalDevStore.setState({ pageMode: 'settings' })
    useUIStore.setState({ activeView: 'chat' })
    render(<LocalDevStatusButton />)
    fireEvent.click(screen.getByRole('button', { name: /Local development is ready/ }))
    expect(useUIStore.getState().activeView).toBe('local-development')
    expect(useLocalDevStore.getState().pageMode).toBe('chat')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('focuses the ready composer with the exact account, runtime and actual CLI guide', async () => {
    renderPage()
    const input = await screen.findByRole('textbox', { name: 'Describe the agent you want to build' })
    expect(document.activeElement).toBe(input)
    expect(screen.getByText('cinna.example')).toHaveProperty('title', context.serverUrl)
    expect(screen.getByRole('group', { name: 'Runtime summary' }).textContent).toBe('Claude Agent with subscriptionopus')
    expect(screen.queryByText(/Runtime ·/)).toBeNull()
    expect(screen.queryByText('Cinna workspace connected')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    screen.getByRole('button', { name: 'Build guide' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Build guide' }))
    fireEvent.click(screen.getByRole('button', { name: 'CLAUDE.md' }))
    expect(await screen.findByRole('heading', { name: 'Account guide' })).toBeTruthy()
    expect(prepareSession).not.toHaveBeenCalled()
    expect(screen.getByRole('navigation', { name: 'Table of contents' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Build guide' }))
  })
  it('keeps Markdown parsing and workspace checks off the typing path, even with a guide open', async () => {
    sessionContext.mockResolvedValue({ ...context, documents: [
      { path: 'CLAUDE.md', content: '# Account guide\n' + 'A paragraph of CLI instructions.\n\n'.repeat(1000) },
      { path: 'context/README.md', content: '# Another guide\nNever opened.' }
    ] })
    renderPage()
    const input = await screen.findByRole('textbox') as HTMLTextAreaElement
    expect(input.classList.contains('resize-none')).toBe(true)
    expect(mocks.markdown).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    screen.getByRole('button', { name: 'Build guide' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Build guide' }))
    fireEvent.click(screen.getByRole('button', { name: 'CLAUDE.md' }))
    await screen.findByRole('heading', { name: 'Account guide' })
    const parses = mocks.markdown.mock.calls.length
    const renders = mocks.settings.mock.calls.length
    const checks = sessionContext.mock.calls.length
    const message = 'Build an agent that summarizes my documents and checks its status on Cinna.'
    for (let index = 1; index <= message.length; index++) {
      fireEvent.change(input, { target: { value: message.slice(0, index) } })
    }
    expect(input.value).toBe(message)
    expect(useLocalDevStore.getState().drafts.alice).toBe(message)
    expect(mocks.markdown).toHaveBeenCalledTimes(parses)
    expect(mocks.settings).toHaveBeenCalledTimes(renders)
    expect(sessionContext).toHaveBeenCalledTimes(checks)
  })
  it('grows automatically up to the chat input height limit and shrinks when cleared', async () => {
    renderPage()
    const input = await screen.findByRole('textbox') as HTMLTextAreaElement
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 300 })
    fireEvent.change(input, { target: { value: 'Several lines\nof a long\nbuild request' } })
    expect(input.style.height).toBe('180px')
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 96 })
    fireEvent.change(input, { target: { value: '' } })
    expect(input.style.height).toBe('96px')
  })
  it('inserts starters without sending and routes the first message to the prepared local assistant', async () => {
    renderPage()
    await screen.findByRole('textbox')
    fireEvent.click(screen.getByRole('button', { name: 'Improve an existing agent' }))
    expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start building' }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['builder'], mode: null, providerId: null, mcpIds: [] })))
    expect(prepareSession).toHaveBeenCalledWith({ profileId: 'alice', workspacePath: context.workspacePath, serverUrl: context.serverUrl, runtime: context.runtime, complexity: context.complexity })
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useLocalDevStore.getState().drafts.alice).toBe('')
  })
  it('keeps the draft and stays on the page when preparation fails', async () => {
    prepareSession.mockRejectedValue(new Error('Account token expired. Repair local development.'))
    renderPage()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Build a research agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start building' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Account token expired. Repair local development.')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Build a research agent')
    expect(useUIStore.getState().activeView).toBe('local-development')
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('moves from installation to the composer without another entry click', async () => {
    useLocalDevStore.setState({ state: { phase: 'installing', step: 'Installing cinna-cli', tasks: [{ id: 'cinna-cli', label: 'cinna-cli', status: 'active' }] } })
    renderPage()
    expect(screen.getByText('Installing cinna-cli')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(sessionContext).not.toHaveBeenCalled()
    act(() => useLocalDevStore.setState({ state: ready }))
    expect(await screen.findByRole('textbox')).toBeTruthy()
  })
  it('shows runtime remediation above a disabled composer when login is missing', async () => {
    sessionContext.mockResolvedValue({ ...context, blocker: 'Claude is not logged in. Run claude login, then check again.' })
    renderPage()
    await screen.findByText(/Claude is not logged in/)
    expect(screen.getByRole('textbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Start building' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('alert').compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Build a helper' } })
    fireEvent.submit(screen.getByRole('textbox').closest('form')!)
    expect(prepareSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open Runtime settings' }))
    expect(screen.getByRole('heading', { name: 'Local Development Runtime' })).toBeTruthy()
  })
  it('does not send a prepared request after switching profiles', async () => {
    let resolve!: (value: { agentId: string }) => void
    prepareSession.mockImplementation(() => new Promise((done) => { resolve = done }))
    renderPage()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Build for Alice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start building' }))
    act(() => useAuthStore.getState().setCurrentUser({ ...useAuthStore.getState().currentUser!, id: 'bob' }))
    await act(async () => resolve({ agentId: 'builder' }))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(useLocalDevStore.getState().drafts.alice).toBe('Build for Alice')
  })
})

/**
 * Exit `11` from cinna-cli, which no Repair clears: the folder on disk belongs
 * to the account that was signed in before, and every retry mints a token for
 * the one signed in now. The detail is cinna-cli's own, verbatim — it is what
 * a developer who re-authenticated against another account actually reads.
 */
const MISMATCH_DETAIL =
  "Token belongs to a different account than this workspace. Run 'cinna account setup' in a new directory to connect it."
const mismatch = { phase: 'attention', reason: 'account_mismatch', detail: MISMATCH_DETAIL } as const
const expired = { phase: 'attention', reason: 'token_expired', detail: 'Your Cinna session expired. Sign in again, then Repair.' } as const

describe('an account workspace that needs attention', () => {
  let reconnectWorkspace = vi.fn()
  let repair = vi.fn()
  let cinnaReauth = vi.fn()
  beforeEach(() => {
    reconnectWorkspace = vi.fn().mockResolvedValue(ready)
    repair = vi.fn().mockResolvedValue(mismatch)
    cinnaReauth = vi.fn().mockResolvedValue({ success: true, user: { id: 'alice' } })
    window.api = {
      localDev: { sessionContext, prepareSession, reconnectWorkspace, repair },
      auth: { cinnaReauth }
    } as unknown as typeof window.api
  })

  it('offers Reconnect before the Repair that cannot fix a mismatch, and takes the state main sends back', async () => {
    useLocalDevStore.setState({ state: mismatch })
    renderPage()
    expect(screen.getByText(MISMATCH_DETAIL)).toBeTruthy()
    const reconnect = screen.getByRole('button', { name: 'Reconnect workspace' })
    const retry = screen.getByRole('button', { name: 'Retry setup' })
    // Ahead of Repair, not instead of it: Repair is still the right button for
    // every other reason, and removing a user's escape hatch is not the fix.
    expect(reconnect.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Says the terminal cinna-cli pointed at is not needed, and that the
    // button that looks like the fix is not one.
    expect(screen.getByText(/No terminal needed/)).toBeTruthy()
    expect(screen.getByText(/Retry setup cannot fix this one/)).toBeTruthy()
    // The one consequence of renaming the folder that a Develop row cannot survive.
    expect(screen.getByText(/keep pointing at the old folder/)).toBeTruthy()
    fireEvent.click(reconnect)
    await waitFor(() => expect(reconnectWorkspace).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useLocalDevStore.getState().state).toEqual(ready))
    expect(repair).not.toHaveBeenCalled()
  })

  it('marks only the action that is running, without resizing a single button', async () => {
    let finish!: () => void
    reconnectWorkspace.mockImplementation(() => new Promise<typeof ready>((done) => { finish = () => done(ready) }))
    useLocalDevStore.setState({ state: mismatch })
    renderPage()
    const labels = screen.getAllByRole('button').map((button) => button.textContent)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect workspace' }))
    // The row is `flex-wrap`, so a button that widened into "Reconnecting…"
    // would re-wrap it and move the composer under the pointer (§1). The
    // spinner names the running action instead, and every label holds still.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect workspace' }).querySelector('.animate-spin')).toBeTruthy())
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(labels)
    // One `busy` flag for three buttons would have all three claim the click.
    expect(screen.getByRole('button', { name: 'Retry setup' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Retry setup' }).querySelector('.animate-spin')).toBeNull()
    expect(screen.getByRole('button', { name: 'Re-authenticate' }).querySelector('.animate-spin')).toBeNull()
    await act(async () => finish())
  })

  it('leaves the other ways out reachable while the browser has the user', async () => {
    // `startOAuthCallback` waits ten minutes. Disabling Reconnect and Retry
    // setup behind a tab the user may simply have closed is a trap whose only
    // escape — navigate away and back — nobody would guess.
    cinnaReauth.mockReturnValue(new Promise(() => {}))
    useLocalDevStore.setState({ state: mismatch })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-authenticate' })).toHaveProperty('disabled', true))
    expect(screen.getByRole('button', { name: 'Reconnect workspace' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Retry setup' })).toHaveProperty('disabled', false)
    // A short local action still locks the row, as before.
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect workspace' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry setup' })).toHaveProperty('disabled', true))
  })

  it('re-authenticates in place from the page and reports a mismatched sign-in without losing the notice', async () => {
    cinnaReauth.mockResolvedValue({ success: false, error: 'Signed in as bob@example.com, but this account is alice@example.com.' })
    useLocalDevStore.setState({ state: expired })
    renderPage()
    // No Reconnect here: the workspace is this account's, only its token is dead.
    expect(screen.queryByRole('button', { name: 'Reconnect workspace' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }))
    await waitFor(() => expect(cinnaReauth).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Signed in as bob@example.com, but this account is alice@example.com.')).toBeTruthy()
    expect(screen.getByText(expired.detail)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Re-authenticate' })).toHaveProperty('disabled', false)
  })
})
