import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatRouter } from '../../../../shared/chatRouting'

/**
 * The composer refuses a send to an agent its driver says is not ready, and
 * says why.
 *
 * Refused: the agent a message goes straight to — the one the chat's router
 * answers with, or a new chat's first-picked agent when the router it would
 * create is not `coordinator` — when its readiness is an answer that is not
 * `ok`. Not refused: an answer of `null` (never checked, or a check that could
 * not tell), an agent the local model conducts as a tool, and a bare catalog
 * `/run:` (a script on this machine, not a turn). The line never depends on
 * what is typed.
 */

const agentList = vi.hoisted(() => ({ current: [] as unknown[] }))
/** What `chat.get` answers: a refetch on mount must not replace the seeded chat. */
const chatDetail = vi.hoisted(() => ({ current: null as unknown }))
const spies = vi.hoisted(() => ({
  list: vi.fn(async () => agentList.current),
  agentSend: vi.fn(),
  llmSend: vi.fn(),
  checkReadiness: vi.fn(async () => null as unknown),
  cinnaReauth: vi.fn(async () => ({ success: true }) as unknown),
  notesList: vi.fn(async () => [] as unknown[]),
  engineLogin: vi.fn(async (_engine: string) => ({ outcome: 'logged_in', command: null }) as unknown),
  engineLoginCancel: vi.fn(async (_engine: string) => true),
  engineLoginRunning: vi.fn(async (): Promise<Record<'claude' | 'codex', 'preparing' | 'waiting' | null>> => ({ claude: null, codex: null })),
  clipboardWrite: vi.fn(async (_text: string) => ({ success: true })),
  notesGet: vi.fn(async () => null as unknown)
}))

/** A namespace with named methods, every other method a harmless default. */
function namespace(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target
        ? target[method]
        : method.startsWith('on')
          ? () => () => undefined
          : async () => []
  })
}

const api: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return namespace({
          list: spies.list,
          onRemoteSyncComplete: () => () => undefined,
          onReadinessChanged: () => () => undefined,
          checkReadiness: spies.checkReadiness,
          listCliCommands: async () => [],
          sendMessage: spies.agentSend,
          cancelMessage: async () => ({ success: true })
        })
      }
      if (ns === 'chat') return namespace({ get: async () => chatDetail.current })
      if (ns === 'llm') return namespace({ sendMessage: spies.llmSend })
      if (ns === 'auth') return namespace({ cinnaReauth: spies.cinnaReauth })
      if (ns === 'notes') return namespace({ list: spies.notesList, get: spies.notesGet })
      if (ns === 'clipboard') return namespace({ writeText: spies.clipboardWrite })
      if (ns === 'localTools') {
        return namespace({
          engineLogin: spies.engineLogin,
          engineLoginCancel: spies.engineLoginCancel,
          engineLoginRunning: spies.engineLoginRunning
        })
      }
      return namespace({})
    }
  }
)
;(window as unknown as { api: unknown }).api = api

// jsdom implements no layout, so the popup's keyboard-scroll call is absent.
Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')

const DOWN = { state: 'unreachable', reason: 'Could not reach the agent.' }

function agent(readiness: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Invoices',
    description: null,
    protocol: 'a2a',
    cardUrl: 'http://127.0.0.1:9/card',
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    hasAccessToken: false,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'local',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    localPath: null,
    localRootId: null,
    driver: 'a2a',
    capabilities: { attachments: 'none', commands: 'card', auth: 'none' },
    readiness,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

/** A folder agent: its `/` commands come from its catalog. */
function catalogAgent(readiness: unknown): Record<string, unknown> {
  return agent(readiness, {
    id: 'folder:alpha',
    driver: 'opencode',
    capabilities: { attachments: 'none', commands: 'catalog', auth: 'none', cwd: true }
  })
}

function clientWith(chat: Record<string, unknown> | null): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], agentList.current)
  if (chat) client.setQueryData(['chat', 'chat-1'], chat)
  return client
}

function mountActive(target: Record<string, unknown>, router: ChatRouter = 'direct'): void {
  agentList.current = [target]
  chatDetail.current = {
    id: 'chat-1',
    // A coordinated chat detaches its root, so the agent under test is only
    // bound where the router is `direct` — the same shape the row has in the app.
    agentId: router === 'direct' ? target.id : null,
    router,
    modeId: null,
    providerId: null,
    modelId: null,
    messages: []
  }
  const client = clientWith(chatDetail.current as Record<string, unknown>)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(createElement(ChatInput, { chatId: 'chat-1' }), { wrapper })
}

function mountNew(
  target: Record<string, unknown>,
  router: ChatRouter,
  onNewChat: (message: string) => void
): void {
  agentList.current = [target]
  const client = clientWith(null)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(
    createElement(ChatInput, {
      chatId: null,
      selectedAgent: target as never,
      pendingAgentIds: [target.id as string],
      routerInfo: { router, agentName: 'Invoices', answererName: 'Invoices' },
      onNewChat
    }),
    { wrapper }
  )
}

function typeAndEnter(text: string): void {
  const box = screen.getByRole('combobox')
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

const send = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  agentList.current = []
  chatDetail.current = null
  spies.list.mockClear()
  spies.agentSend.mockReset()
  spies.llmSend.mockReset()
  spies.checkReadiness.mockReset()
  spies.checkReadiness.mockResolvedValue(null)
  spies.engineLogin.mockReset()
  spies.engineLogin.mockResolvedValue({ outcome: 'logged_in', command: null })
  spies.engineLoginCancel.mockClear()
  spies.engineLoginRunning.mockReset()
  spies.engineLoginRunning.mockResolvedValue({ claude: null, codex: null })
  spies.clipboardWrite.mockClear()
  spies.cinnaReauth.mockReset()
  spies.cinnaReauth.mockResolvedValue({ success: true })
  spies.notesList.mockReset()
  spies.notesList.mockResolvedValue([])
  spies.notesGet.mockReset()
})

describe('composer readiness refusal', () => {
  it('refuses a direct agent chat whose agent is not ready, and says why', async () => {
    mountActive(agent(DOWN))
    expect(screen.getByText('Could not reach the agent.')).toBeTruthy()

    typeAndEnter('hello')
    expect(send().disabled).toBe(true)
    expect(send().getAttribute('aria-describedby')).toBe(
      screen.getByText('Could not reach the agent.').getAttribute('id')
    )
    await tick()
    expect(spies.agentSend).not.toHaveBeenCalled()
    expect(spies.llmSend).not.toHaveBeenCalled()
    // Nothing was cleared: the message waits for the agent.
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('refuses a new chat going straight to one agent that is not ready', () => {
    const onNewChat = vi.fn()
    mountNew(agent(DOWN), 'direct', onNewChat)
    typeAndEnter('hello')
    expect(onNewChat).not.toHaveBeenCalled()
    expect(screen.getByText('Could not reach the agent.')).toBeTruthy()
    expect(send().disabled).toBe(true)
  })

  it('warns about missing credentials on a folder agent without refusing the send', () => {
    const reason = 'Add the credentials for Vendor in credentials/.env.'
    mountActive(catalogAgent({ state: 'credentials_needed', reason }))
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    expect(send().disabled).toBe(false)
    expect(send().title).not.toBe(reason)
  })

  it('leaves Send live on a new chat whose agent lacks credentials', () => {
    const onNewChat = vi.fn()
    mountNew(catalogAgent({ state: 'credentials_needed', reason: 'Add the credentials.' }), 'direct', onNewChat)
    expect(screen.getByText('Add the credentials.')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    expect(send().disabled).toBe(false)
    typeAndEnter('hello')
    expect(onNewChat).toHaveBeenCalledWith('hello', undefined, undefined)
  })

  it('still refuses an agent with no folder whose token was rejected', () => {
    const onNewChat = vi.fn()
    mountNew(agent({ state: 'credentials_needed', reason: 'The agent refused its access token (401).' }), 'direct', onNewChat)
    typeAndEnter('hello')
    expect(onNewChat).not.toHaveBeenCalled()
    expect(send().disabled).toBe(true)
  })

  it('never refuses on an answer that has not come yet', () => {
    const onNewChat = vi.fn()
    mountNew(agent(null), 'direct', onNewChat)
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    typeAndEnter('hello')
    expect(onNewChat).toHaveBeenCalledWith('hello', undefined, undefined)
  })

  it('sends to an agent that is ready', () => {
    const onNewChat = vi.fn()
    mountNew(agent({ state: 'ok', reason: null }), 'direct', onNewChat)
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    typeAndEnter('hello')
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('does not refuse when the local model conducts the agent as a tool', () => {
    const onNewChat = vi.fn()
    mountNew(agent(DOWN), 'coordinator', onNewChat)
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
    typeAndEnter('hello')
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('does not refuse a coordinated chat whose agent is not ready', () => {
    mountActive(agent(DOWN), 'coordinator')
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    expect(send().disabled).toBe(false)
  })

  it('keeps the reason where it is while the user types', () => {
    mountActive(agent(DOWN))
    const before = screen.getByText('Could not reach the agent.')
    const box = screen.getByRole('combobox')
    for (const value of ['h', 'he', '', '/run:check', 'hello']) {
      fireEvent.change(box, { target: { value } })
      expect(screen.getByText('Could not reach the agent.')).toBe(before)
    }
  })

  it('shows the full warning and recovery action above the input', () => {
    mountNew(agent(DOWN), 'direct', vi.fn())
    const reason = screen.getByText('Could not reach the agent.')
    const warning = reason.closest('[role="status"]') as HTMLElement
    expect(warning).toBeTruthy()
    expect(warning.contains(screen.getByRole('button', { name: 'Check again' }))).toBe(true)
    expect(warning.compareDocumentPosition(screen.getByRole('combobox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(reason.className).not.toContain('truncate')
  })

  it('shows no warning panel when a direct agent is ready', () => {
    mountNew(agent({ state: 'ok', reason: null }), 'direct', vi.fn())
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(document.querySelector('[data-readiness-line]')).toBeNull()
  })

  it('shows the raw error as the tooltip when the driver kept one', () => {
    mountActive(agent({ ...DOWN, detail: 'connect ECONNREFUSED 127.0.0.1:9' }))
    expect(screen.getByText('Could not reach the agent.').getAttribute('title')).toBe(
      'connect ECONNREFUSED 127.0.0.1:9'
    )
    expect(send().getAttribute('title')).toBe('connect ECONNREFUSED 127.0.0.1:9')
  })

  describe('a catalog /run: always runs', () => {
    it('lets a bare /run: through to a folder agent that is not ready', () => {
      const onNewChat = vi.fn()
      mountNew(catalogAgent(DOWN), 'direct', onNewChat)
      typeAndEnter('/run:check')
      expect(onNewChat).toHaveBeenCalledWith('/run:check', undefined, undefined)
    })

    it('enables Send for it, and the notice stays', () => {
      mountActive(catalogAgent(DOWN))
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '/run:check' } })
      expect(send().disabled).toBe(false)
      expect(screen.getByText('Could not reach the agent.')).toBeTruthy()
    })

    it('still refuses a message that only starts with /run:', () => {
      const onNewChat = vi.fn()
      mountNew(catalogAgent(DOWN), 'direct', onNewChat)
      typeAndEnter('/run:check please')
      expect(onNewChat).not.toHaveBeenCalled()
      expect(send().disabled).toBe(true)
    })

    it('still refuses /run: to an agent whose commands are not a folder catalog', () => {
      const onNewChat = vi.fn()
      mountNew(agent(DOWN), 'direct', onNewChat)
      typeAndEnter('/run:check')
      expect(onNewChat).not.toHaveBeenCalled()
    })
  })

  it('still pastes a picked note on a double Enter, which sends nothing', async () => {
    spies.notesList.mockResolvedValue([{ id: 'n1', title: 'Template', body: 'Dear team,' }])
    spies.notesGet.mockResolvedValue({ id: 'n1', title: 'Template', body: 'Dear team,' })
    mountActive(agent(DOWN))
    // `?` opens the picker only once there are notes to pick from.
    await waitFor(() => expect(spies.notesList).toHaveBeenCalled())
    await tick()
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: '?' } })
    await waitFor(() => expect(screen.getByText('Template')).toBeTruthy())
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('Dear team,'))
    expect(spies.agentSend).not.toHaveBeenCalled()
  })

  it('checks again on request, and lets the message through once the agent is ready', async () => {
    mountActive(agent(DOWN))
    // Let the list's own mount-time refetch land first, so the only thing that
    // can bring the new answer on screen is the re-read after the check.
    await waitFor(() => expect(spies.list).toHaveBeenCalled())
    await tick()
    expect(screen.getByText('Could not reach the agent.')).toBeTruthy()
    spies.checkReadiness.mockImplementation(async () => {
      agentList.current = [agent({ state: 'ok', reason: null })]
      return { state: 'ok', reason: null }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(spies.checkReadiness).toHaveBeenCalledWith('agent-1'))
    await waitFor(() => expect(screen.queryByText('Could not reach the agent.')).toBeNull())

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    expect(send().disabled).toBe(false)
  })

  it('keeps focus on Check again while it runs, and does not run it twice', async () => {
    let finish!: (value: unknown) => void
    spies.checkReadiness.mockImplementation(
      () => new Promise((resolve) => (finish = resolve))
    )
    mountActive(agent(DOWN))
    const action = screen.getByRole('button', { name: 'Check again' })
    action.focus()
    fireEvent.click(action)
    await waitFor(() => expect(screen.getByText('Checking…')).toBeTruthy())

    const pending = screen.getByRole('button', { name: /Checking/ })
    expect(pending.hasAttribute('disabled')).toBe(false)
    expect(pending.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(pending)
    fireEvent.click(pending)
    await tick()
    expect(spies.checkReadiness).toHaveBeenCalledTimes(1)
    finish(null)
  })

  /** Check again that clears the refusal: the next list read answers `ok`. */
  async function clearingCheck(): Promise<HTMLElement> {
    mountActive(agent(DOWN))
    await waitFor(() => expect(spies.list).toHaveBeenCalled())
    await tick()
    spies.checkReadiness.mockImplementation(async () => {
      agentList.current = [agent({ state: 'ok', reason: null })]
      return { state: 'ok', reason: null }
    })
    return screen.getByRole('button', { name: 'Check again' })
  }

  it('hands focus to the message box when Check again clears the refusal and removes itself', async () => {
    const action = await clearingCheck()
    action.focus()
    fireEvent.click(action)
    await waitFor(() => expect(screen.queryByText('Could not reach the agent.')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('takes no focus from elsewhere when a refusal clears', async () => {
    const action = await clearingCheck()
    const elsewhere = document.body.appendChild(document.createElement('input'))
    fireEvent.click(action)
    elsewhere.focus()
    await waitFor(() => expect(screen.queryByText('Could not reach the agent.')).toBeNull())
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('keeps the reason when a check fails, and says so in the line and on Send alike', async () => {
    spies.checkReadiness.mockRejectedValue(new Error('No handler registered'))
    mountActive(agent(DOWN))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    const line = await screen.findByText(/Couldn't check again/)
    expect(line.textContent).toContain('Could not reach the agent.')
    expect(line.textContent).toContain('No handler registered')
    expect(send().getAttribute('title')).toBe(line.textContent)
    expect(send().getAttribute('aria-describedby')).toBe(line.getAttribute('id'))
  })

  it('offers Re-authenticate, not Check again, for an expired Cinna session', async () => {
    mountActive(
      agent(
        { state: 'not_logged_in', reason: 'Your Cinna session has expired.' },
        { source: 'remote', capabilities: { attachments: 'cinna', commands: 'card', auth: 'cinna' } }
      )
    )
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Re-authenticate' }))
    await waitFor(() => expect(spies.cinnaReauth).toHaveBeenCalledTimes(1))
    expect(spies.checkReadiness).not.toHaveBeenCalled()
  })

  it('offers Check again for a login the desktop cannot renew', () => {
    mountActive(
      agent(
        { state: 'not_logged_in', reason: 'Claude Code is not logged in.' },
        { driver: 'claude', capabilities: { attachments: 'none', commands: 'catalog', auth: 'cli' } }
      )
    )
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Re-authenticate' })).toBeNull()
  })
  describe('Log in, for a CLI engine the readiness names', () => {
    const loggedOut = (engine: 'claude' | 'codex'): Record<string, unknown> =>
      agent(
        { state: 'not_logged_in', reason: "Claude Code is not logged in. Choose Log in above the message box or on the agent's Settings tab.", login: engine },
        { driver: 'acp', capabilities: { attachments: 'none', commands: 'catalog', auth: 'none', cwd: true } }
      )

    it('offers Log in instead of Check again, and runs that engine’s login', async () => {
      mountActive(loggedOut('codex'))
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      await waitFor(() => expect(spies.engineLogin).toHaveBeenCalledWith('codex'))
      expect(spies.checkReadiness).not.toHaveBeenCalled()
    })

    it('waits on the browser with a Cancel beside it, and a second press starts nothing', async () => {
      let finish!: (value: unknown) => void
      spies.engineLogin.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      mountActive(loggedOut('claude'))
      // The mount's own read of the running flag has answered (a re-read asked
      // while it is still in flight joins it).
      await waitFor(() => expect(spies.engineLoginRunning).toHaveBeenCalled())
      await act(tick)
      // Before main says the CLI runs, the login is getting its binary ready.
      spies.engineLoginRunning.mockResolvedValue({ claude: 'preparing', codex: null })
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      expect(await screen.findByRole('button', { name: 'Getting Claude Code ready…' })).toBeTruthy()
      spies.engineLoginRunning.mockResolvedValue({ claude: 'waiting', codex: null })
      const pending = await screen.findByRole('button', { name: 'Waiting for sign-in in your browser…' }, { timeout: 4000 })
      fireEvent.click(pending)
      expect(spies.engineLogin).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(spies.engineLoginCancel).toHaveBeenCalledWith('claude'))
      spies.engineLoginRunning.mockResolvedValue({ claude: null, codex: null })
      finish({ outcome: 'cancelled', command: "'/opt/claude' auth login" })
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
      // A cancel is the user's own choice: nothing to explain.
      expect(screen.queryByText(/Couldn't log in/)).toBeNull()
    })

    it('says a sign-in that did not finish, with the terminal command', async () => {
      spies.engineLogin.mockResolvedValue({ outcome: 'timeout', command: "'/opt/claude' auth login" })
      mountActive(loggedOut('claude'))
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      const line = await screen.findByText(/Couldn't log in/)
      // The shared lead, and no command spliced into the prose…
      expect(line.textContent).toContain("Couldn't log in — Sign-in timed out.")
      expect(line.textContent).not.toContain('auth login')
      expect(send().getAttribute('title')).toBe(line.textContent)
      // …it is a second action after Log in, copied through main's clipboard.
      await screen.findByRole('button', { name: 'Copy command' })
      const buttons = screen.getAllByRole('button').map((b) => b.textContent)
      expect(buttons.indexOf('Copy command')).toBe(buttons.indexOf('Log in') + 1)
      fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
      await waitFor(() => expect(spies.clipboardWrite).toHaveBeenCalledWith("'/opt/claude' auth login"))
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    })

    it('says why a login that could not prepare its binary failed, with no command to copy', async () => {
      spies.engineLogin.mockResolvedValue({ outcome: 'failed', command: null, reason: 'Claude Code could not be installed.' })
      mountActive(loggedOut('claude'))
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      const line = await screen.findByText(/Couldn't log in/)
      expect(line.textContent).toContain("Couldn't log in — Sign-in didn't finish: Claude Code could not be installed.")
      expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
    })
  })
})
