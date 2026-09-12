import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatRouter } from '../../../../shared/chatRouting'

/**
 * The composer says who answers, and lets the user change it.
 *
 * The rule under test is `ux_rules.md` rule 1 as much as the routing: **the
 * badge and the chips move only on a gesture the user made.** The addressed
 * agent changes when a chip is clicked or an agent is picked from `@` — never
 * while the user types, which is what a mention parsed out of the text would
 * have meant.
 */

const agentList = vi.hoisted(() => ({ current: [] as unknown[] }))
const chatDetail = vi.hoisted(() => ({ current: null as unknown }))
const onDemandAgents = vi.hoisted(() => ({ current: [] as Array<{ agentId: string }> }))
const spies = vi.hoisted(() => ({
  list: vi.fn(async () => agentList.current),
  onDemandAgentList: vi.fn(async () => onDemandAgents.current),
  setRouter: vi.fn(async () => ({ success: true })),
  runSend: vi.fn().mockResolvedValue('run-1'),
  addOnDemandAgent: vi.fn(async () => ({ success: true }))
}))

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
          checkReadiness: async () => null,
          listCliCommands: async () => []
        })
      }
      if (ns === 'chat') {
        return namespace({
          get: async () => chatDetail.current,
          listOnDemandAgents: spies.onDemandAgentList,
          setRouter: spies.setRouter,
          addOnDemandAgent: spies.addOnDemandAgent
        })
      }
      if (ns === 'run') return namespace({ start: spies.runSend, cancel: () => undefined })
      return namespace({})
    }
  }
)
;(window as unknown as { api: unknown }).api = api

Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')

function agent(
  id: string,
  name: string,
  readiness: unknown = { state: 'ok', reason: null }
): Record<string, unknown> {
  return {
    id,
    name,
    description: null,
    protocol: 'a2a',
    cardUrl: 'http://127.0.0.1:9/card',
    endpointUrl: null,
    hasAccessToken: false,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'local',
    remoteTargetType: null,
    remoteTargetId: null,
    localPath: null,
    localRootId: null,
    driver: 'a2a',
    capabilities: { attachments: 'none', commands: 'card', auth: 'none' },
    readiness,
    createdAt: new Date('2026-01-01T00:00:00Z')
  }
}

const DOWN = { state: 'unreachable', reason: 'Could not reach the agent.' }

interface MountOptions {
  router: ChatRouter
  agentId?: string | null
  attached?: string[]
  messages?: Array<Record<string, unknown>>
  /** Readiness per agent id; anything unnamed is `ok`. */
  readiness?: Record<string, unknown>
}

async function mount(opts: MountOptions): Promise<void> {
  agentList.current = [
    agent('a-1', 'Research', opts.readiness?.['a-1'] ?? { state: 'ok', reason: null }),
    agent('a-2', 'Builder', opts.readiness?.['a-2'] ?? { state: 'ok', reason: null })
  ]
  onDemandAgents.current = (opts.attached ?? []).map((agentId) => ({ agentId }))
  chatDetail.current = {
    id: 'chat-1',
    router: opts.router,
    agentId: opts.agentId ?? null,
    modeId: null,
    providerId: null,
    modelId: null,
    messages: opts.messages ?? []
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], agentList.current)
  client.setQueryData(['chat', 'chat-1'], chatDetail.current)
  client.setQueryData(['chat-on-demand-agent', 'chat-1'], onDemandAgents.current)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(createElement(ChatInput, { chatId: 'chat-1' }), { wrapper })
  await waitFor(() => expect(spies.list).toHaveBeenCalled())
}

const badge = (): HTMLElement | null => screen.queryByRole('status')
const chip = (name: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`“${name}”`) })

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.getState().reset()
})

describe('the composer badge — who answers', () => {
  it('says Direct in a chat with one bound agent', async () => {
    await mount({ router: 'direct', agentId: 'a-1' })
    expect(badge()?.getAttribute('aria-label')).toBe('Direct agent connection')
    expect(badge()?.textContent).toContain('Direct')
  })

  it('shows no badge in a plain chat with the local model', async () => {
    // Nothing is being routed. A pill saying so would be chrome on the most
    // common chat in the app.
    await mount({ router: 'direct', agentId: null })
    expect(badge()).toBeNull()
  })

  it('says You route in a chat with several agents', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    expect(badge()?.getAttribute('aria-label')).toBe('You route this chat')
    expect(badge()?.textContent).toContain('You route')
  })

  it('says Model when the local model coordinates', async () => {
    await mount({ router: 'coordinator', attached: ['a-1', 'a-2'] })
    expect(badge()?.getAttribute('aria-label')).toBe('Coordinated by your local model')
    expect(badge()?.textContent).toContain('Model routes')
  })
})

describe('addressing a human chat', () => {
  it('marks the agent that would answer before the user has picked anyone', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    // The first attached, which is what main falls back to as well.
    expect(chip('Research').getAttribute('aria-pressed')).toBe('true')
    expect(chip('Builder').getAttribute('aria-pressed')).toBe('false')
  })

  it('is sticky: the agent the last message addressed answers the next one', async () => {
    await mount({
      router: 'human',
      attached: ['a-1', 'a-2'],
      messages: [{ id: 'm-1', role: 'user', content: 'go', addressedAgentId: 'a-2' }]
    })
    expect(chip('Builder').getAttribute('aria-pressed')).toBe('true')
  })

  it('moves the address when a chip is clicked', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    fireEvent.click(chip('Builder'))
    await waitFor(() => expect(chip('Builder').getAttribute('aria-pressed')).toBe('true'))
    expect(chip('Research').getAttribute('aria-pressed')).toBe('false')
  })

  it('sends to the agent the user addressed', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    fireEvent.click(chip('Builder'))
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: 'now build it' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(spies.runSend).toHaveBeenCalled())
    expect(spies.runSend.mock.calls[0][0]).toMatchObject({ addressedAgentId: 'a-2' })
  })

  it('changes nothing about who answers while the user types', async () => {
    // Rule 1: the composer may not move, or re-point, per keystroke. A mention
    // parsed out of the text would do exactly that.
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    const box = screen.getByRole('combobox')
    for (const value of ['h', 'he', '@Builder', '@Builder do it', '']) {
      fireEvent.change(box, { target: { value } })
      expect(chip('Research').getAttribute('aria-pressed')).toBe('true')
      expect(chip('Builder').getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('offers no addressing at all in a coordinated chat', async () => {
    // The chips are a list of what the model can call, not an address book.
    await mount({ router: 'coordinator', attached: ['a-1', 'a-2'] })
    expect(screen.queryByRole('button', { name: /Address your next message/ })).toBeNull()
  })
})

describe('the coordinate toggle', () => {
  const openMenu = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
  }
  const toggle = (): HTMLElement =>
    screen.getByRole('menuitemcheckbox', { name: /Let the model coordinate/ })

  it('is offered in a chat that has an agent to coordinate', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    openMenu()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('is not offered in a plain chat with the local model', async () => {
    await mount({ router: 'direct', agentId: null })
    openMenu()
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  })

  it('hands the chat to the model', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    openMenu()
    fireEvent.click(toggle())
    await waitFor(() => expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'coordinator'))
  })

  it('gives it back to the user, not to nobody', async () => {
    await mount({ router: 'coordinator', attached: ['a-1', 'a-2'] })
    openMenu()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle())
    await waitFor(() => expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'human'))
  })

  it('goes back to direct when there is no agent left to route between', async () => {
    await mount({ router: 'coordinator', attached: [] })
    openMenu()
    fireEvent.click(toggle())
    await waitFor(() => expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'direct'))
  })
})

describe('refusing a send in a human chat', () => {
  it('refuses on the addressed agent, not on the first one in the list', async () => {
    // The readiness that matters is the one belonging to whoever this message
    // is going to. `a-1` answers first, and it is fine.
    await mount({ router: 'human', attached: ['a-1', 'a-2'], readiness: { 'a-2': DOWN } })
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
  })

  it('moves the refusal when — and only when — the user addresses the refused agent', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'], readiness: { 'a-2': DOWN } })
    const box = screen.getByRole('combobox')
    // Rule 1: typing may not make the notice appear.
    for (const value of ['b', 'bu', '@Builder', '']) {
      fireEvent.change(box, { target: { value } })
      expect(screen.queryByText('Could not reach the agent.')).toBeNull()
    }
    // The chip click is the gesture, and the notice follows it.
    fireEvent.click(chip('Builder'))
    await waitFor(() => expect(screen.getByText('Could not reach the agent.')).toBeTruthy())
  })

  it('blocks the send to a refused agent', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'], readiness: { 'a-2': DOWN } })
    fireEvent.click(chip('Builder'))
    await waitFor(() => expect(screen.getByText('Could not reach the agent.')).toBeTruthy())
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: 'now build it' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(spies.runSend).not.toHaveBeenCalled()
  })
})

describe("the composer height across a router change", () => {
  const readinessSlot = (): Element | null => document.querySelector('[data-readiness-line]')

  it('keeps the readiness slot in a chat that has an agent, whoever is answering', async () => {
    // The slot is a fixed-height line under the controls row. Gating it on the
    // agent that would answer made it vanish the moment the user handed the
    // chat to the model — lifting the whole composer 21px under their cursor.
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    expect(readinessSlot()).toBeTruthy()
  })

  it('keeps it in a coordinated chat too, where no agent answers', async () => {
    await mount({ router: 'coordinator', attached: ['a-1', 'a-2'] })
    expect(readinessSlot()).toBeTruthy()
  })

  it('keeps it in a direct chat with a bound agent', async () => {
    await mount({ router: 'direct', agentId: 'a-1' })
    expect(readinessSlot()).toBeTruthy()
  })

  it('does not reserve it in a plain chat with the local model', async () => {
    // Nothing about an agent can ever be said here, and the transition into
    // this state needs an agent added, which moves the chip strip anyway.
    await mount({ router: 'direct', agentId: null })
    expect(readinessSlot()).toBeNull()
  })
})

describe('the model picker', () => {
  const modelPicker = (): HTMLElement | null =>
    screen.queryByRole('button', { name: /model/i })

  it('is offered in a plain chat with the local model', async () => {
    await mount({ router: 'direct', agentId: null })
    expect(modelPicker()).toBeTruthy()
  })

  it('is not offered in a chat the user routes between agents', async () => {
    // The badge says no model is involved; a model picker beside it would be
    // two surfaces disagreeing about the same chat.
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    expect(modelPicker()).toBeNull()
  })
})

describe('bringing a second agent into a direct chat with @', () => {
  /** Type `@`, then click the agent's row in the popup. */
  async function mentionAgent(name: string): Promise<void> {
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: '@' } })
    const option = await screen.findByText(name, { selector: '[role="option"] *, [role="option"]' })
    fireEvent.click(option.closest('[role="option"]') ?? option)
  }

  it('addresses the agent it brings in, not whoever answered before', async () => {
    // The chat is still `direct` at click time — the switch to `human` is the
    // consequence of the pick, not its precondition. Reading the *current*
    // router here meant the address was never set on exactly this transition,
    // and every earlier user row carries the old root, so the sticky default
    // sent the message the user typed for B straight back to A.
    await mount({
      router: 'direct',
      agentId: 'a-1',
      messages: [{ id: 'm-1', role: 'user', content: 'go', addressedAgentId: 'a-1' }]
    })
    await mentionAgent('Builder')
    await waitFor(() =>
      expect(useChatStore.getState().addressedAgentByChat['chat-1']).toBe('a-2')
    )
    expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'human')
    expect(spies.addOnDemandAgent).toHaveBeenCalledWith('chat-1', 'a-2')
  })

  it('addresses nobody in a plain chat with the local model, which the agent joins as a tool', async () => {
    // The model is the counterparty the user has been talking to; an agent
    // arriving is something it can call, not a replacement for it.
    await mount({ router: 'direct', agentId: null })
    await mentionAgent('Builder')
    await waitFor(() => expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'coordinator'))
    expect(useChatStore.getState().addressedAgentByChat['chat-1']).toBeUndefined()
  })
})
