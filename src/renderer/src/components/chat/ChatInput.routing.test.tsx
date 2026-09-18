import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
const activity = vi.hoisted(() => ({ current: [] as unknown }))
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
      if (ns === 'sessionActivity') return namespace({ get: async () => activity.current })
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
  it('says Remote for a directly added A2A agent', async () => {
    await mount({ router: 'direct', agentId: 'a-1' })
    expect(badge()?.getAttribute('aria-label')).toBe('Remote agent connection')
    expect(badge()?.textContent).toContain('Remote')
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

describe('the session meta badges', () => {
  it('sit left of the router badge, in the cluster that never wraps', async () => {
    activity.current = {
      ok: true,
      snapshot: {
        chatId: 'chat-1',
        items: [{
          id: 'b1', kind: 'background', agentId: 'a-1', title: 'npm test', detail: null, state: 'running',
          startedAt: new Date(), endedAt: null, outputPath: null, canStop: false
        }]
      }
    }
    try {
      await mount({ router: 'direct', agentId: 'a-1' })
      // The split badge and the collapsed one (jsdom applies no container query).
      const running = await screen.findAllByRole('button', { name: '1 background process running' })
      expect(running).toHaveLength(2)
      const router = badge()!
      for (const b of running) {
        // Mutation: render the strip after RouterBadge and this is PRECEDING.
        expect(b.compareDocumentPosition(router) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(router.closest('.shrink-0')?.contains(b)).toBe(true)
      }
      // The row is the container the badges collapse by.
      expect(router.closest('.shrink-0')?.parentElement?.className).toContain('@container/composer')
    } finally {
      activity.current = []
    }
  })
})

describe('agent chip width', () => {
  // The chip row never wraps (ux_rules §1): a session badge arriving on the
  // right would otherwise fold it and move the textarea mid-typing.
  it('keeps the chip row on one line, shrinking chips and scrolling the rest', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    const strip = screen.getByTestId('composer-chips')
    const cluster = strip.parentElement!
    // Mutation: put `flex-wrap` back on either and this fails.
    for (const box of [cluster, strip]) {
      expect(box.className).toContain('flex-nowrap')
      expect(box.className).toContain('min-w-0')
      expect(box.className).not.toMatch(/(^|\s)flex-wrap(\s|$)/)
    }
    expect(strip.className).toContain('overflow-x-auto')
    expect(strip.className).toContain('[scrollbar-width:none]')
    // The plus menu opens an absolutely positioned menu: outside the scroller.
    const plus = screen.getByRole('button', { name: 'Add to chat' })
    expect(strip.contains(plus)).toBe(false)
    expect(cluster.contains(plus)).toBe(true)
    for (const agentName of ['Research', 'Builder']) {
      const box = chip(agentName).closest('div')!
      expect(strip.contains(box)).toBe(true)
      expect(box.className).toContain('min-w-[4.5rem]')
      expect(box.className).toContain('shrink')
    }
  })

  // A long name must not widen the left cluster past what leaves room for the
  // session badges at 800 px; the name stays whole for the ear and the hover.
  it('caps the bound agent chip and keeps its full name', async () => {
    await mount({ router: 'direct', agentId: 'a-1' })
    const name = await screen.findByText('Research')
    const chip = name.closest('div')!
    expect(chip.className).toContain('max-w-[12rem]')
    expect(chip.getAttribute('title')).toBe('Research')
    expect(name.className).toContain('truncate')
  })

  it('caps the attached agent chips and keeps their full names', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    for (const agentName of ['Research', 'Builder']) {
      const button = chip(agentName)
      const text = within(button).getByText(agentName)
      expect(text.className).toContain('truncate')
      expect(text.getAttribute('title')).toBe(agentName)
      expect(button.closest('div')!.className).toContain('max-w-[12rem]')
      expect(button.getAttribute('aria-label')).toContain(`“${agentName}”`)
    }
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
    screen.getByRole('menuitem', { name: /Coordinate by/ })

  it('is offered in a chat that has an agent to coordinate', async () => {
    await mount({ router: 'human', attached: ['a-1', 'a-2'] })
    openMenu()
    expect(toggle().textContent).toContain('Coordinate by Default runtime')
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

  it.each([['a-1', 'a-2'], []])('never offers a way back after coordination (%j)', async (...attached) => {
    await mount({ router: 'coordinator', attached: attached.filter((item): item is string => typeof item === 'string') })
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /Coordinate by/ })).toBeNull()
    expect(spies.setRouter).not.toHaveBeenCalled()
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

describe('healthy composer routing', () => {
  it.each(['human', 'coordinator', 'direct'] as const)('shows no readiness warning for a healthy %s chat', async (router) => {
    await mount({ router, agentId: router === 'direct' ? 'a-1' : null, attached: ['a-1', 'a-2'] })
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(document.querySelector('[data-readiness-line]')).toBeNull()
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
