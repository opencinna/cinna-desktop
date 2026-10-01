import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatRouter } from '../../../../shared/chatRouting'

/**
 * The agent chips' right-click menu and the coordinator mark.
 *
 * "Set as Coordinator" moved here from the router badge. The chip that
 * coordinates carries a mark that does not change its size (ux_rules §1), the
 * bound and attached chips are one component (§13), and a refused pick keeps
 * the menu open with the reason in it (§6) — even though the optimistic move
 * unmounts the chip the menu was opened on.
 */

const agentList = vi.hoisted(() => ({ current: [] as unknown[] }))
const chatDetail = vi.hoisted(() => ({ current: null as unknown }))
const onDemandAgents = vi.hoisted(() => ({ current: [] as Array<{ agentId: string; pendingAnnounce: boolean }> }))
const spies = vi.hoisted(() => ({
  list: vi.fn(async () => agentList.current),
  get: vi.fn(async () => chatDetail.current),
  onDemandAgentList: vi.fn(async () => onDemandAgents.current),
  setCoordinator: vi.fn(async (_chatId: string, _agentId: string) => ({ success: true })),
  openPath: vi.fn(async (_input: { agentId: string }) => ({ success: true as const }))
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

;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return namespace({
          list: spies.list,
          checkReadiness: async () => null,
          listCliCommands: async () => []
        })
      }
      if (ns === 'chat') {
        return namespace({
          get: spies.get,
          listOnDemandAgents: spies.onDemandAgentList,
          setCoordinator: spies.setCoordinator
        })
      }
      if (ns === 'localAgents') return namespace({ openPath: spies.openPath, list: async () => FOLDERS })
      if (ns === 'sessionActivity') return namespace({ get: async () => [] })
      return namespace({})
    }
  }
)

Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useUIStore } = await import('../../stores/ui.store')
const { LOCAL_AGENTS_KEY } = await import('../../hooks/useLocalAgents')
const { presetForAgentId } = await import('../../utils/agentColors')

const FOLDER = 'folder:planner'
const FOLDER_2 = 'folder:coder'
const REMOTE = 'remote-1'
/** The folder scan: what makes a chip's agent one with a folder to open. */
const FOLDERS = { roots: [], agents: [{ id: FOLDER }, { id: FOLDER_2 }], homeAccess: null }

function agent(id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    description: null,
    protocol: 'a2a',
    cardUrl: null,
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
    readiness: { state: 'ok', reason: null },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra
  }
}

interface MountOptions {
  router: ChatRouter
  agentId?: string | null
  attached?: string[]
  activeRunId?: string | null
  taskHeld?: boolean
}

async function mount(opts: MountOptions): Promise<QueryClient> {
  agentList.current = [
    agent(FOLDER, 'Planner', { source: 'folder', driver: 'acp', protocol: 'acp', acpTransport: 'stdio' }),
    agent(FOLDER_2, 'Coder', { source: 'folder', driver: 'acp', protocol: 'acp', acpTransport: 'stdio' }),
    agent(REMOTE, 'Helper', { source: 'remote' })
  ]
  onDemandAgents.current = (opts.attached ?? []).map((agentId) => ({ agentId, pendingAnnounce: false }))
  chatDetail.current = {
    id: 'chat-1',
    router: opts.router,
    agentId: opts.agentId ?? null,
    activeRunId: opts.activeRunId ?? null,
    taskHeld: opts.taskHeld ?? false,
    modeId: null,
    providerId: null,
    modelId: null,
    messages: []
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], agentList.current)
  client.setQueryData(['chat', 'chat-1'], chatDetail.current)
  client.setQueryData(['chat-on-demand-agent', 'chat-1'], onDemandAgents.current)
  client.setQueryData(LOCAL_AGENTS_KEY, FOLDERS)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(createElement(ChatInput, { chatId: 'chat-1' }), { wrapper })
  await waitFor(() => expect(spies.list).toHaveBeenCalled())
  return client
}

/** The chip element itself: the box that carries the title, border and marks. */
const chipOf = (name: string): HTMLElement => {
  const strip = screen.getByTestId('composer-chips')
  let el: HTMLElement | null = within(strip).getByText(name)
  while (el && el.parentElement !== strip) el = el.parentElement
  if (!el) throw new Error(`no chip ${name}`)
  return el
}
const openMenuOn = (name: string): HTMLElement => {
  fireEvent.contextMenu(chipOf(name), { clientX: 40, clientY: 40 })
  return screen.getByRole('menu', { name: `Agent ${name}` })
}
const item = (menu: HTMLElement, name: string): HTMLButtonElement =>
  within(menu).getByRole('menuitem', { name }) as HTMLButtonElement

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.getState().reset()
  spies.setCoordinator.mockImplementation(async () => ({ success: true }))
})

describe('the agent chip menu', () => {
  it('offers Set as Coordinator, Go to Agent and Open Agent Folder on a local folder agent', async () => {
    await mount({ router: 'human', attached: [FOLDER, REMOTE] })
    const menu = openMenuOn('Planner')
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Set as Coordinator', 'Go to Agent', 'Open Agent Folder'
    ])
    expect(item(menu, 'Set as Coordinator').disabled).toBe(false)
  })

  it('disables Set as Coordinator on an agent that cannot conduct, and has no folder for it', async () => {
    await mount({ router: 'human', attached: [FOLDER, REMOTE] })
    const menu = openMenuOn('Helper')
    const set = item(menu, 'Set as Coordinator')
    expect(set.disabled).toBe(true)
    expect(set.getAttribute('aria-describedby')).toBe(within(menu).getByText('Only a local agent can coordinate').id)
    expect(within(menu).queryByRole('menuitem', { name: 'Open Agent Folder' })).toBeNull()
    expect(item(menu, 'Go to Agent')).toBeTruthy()
  })

  it('disables Set as Coordinator while a turn runs, with main\'s own reason under it', async () => {
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2], activeRunId: 'run-1' })
    const menu = openMenuOn('Coder')
    const set = item(menu, 'Set as Coordinator')
    expect(set.disabled).toBe(true)
    // Visible from the menu's first frame, not a tooltip the keyboard cannot reach.
    expect(within(menu).getByText('Interrupt the session before changing who answers.').id).toBe(set.getAttribute('aria-describedby'))
  })

  it('disables Set as Coordinator while an autonomous task holds the chat', async () => {
    await mount({ router: 'coordinator', agentId: FOLDER, attached: [FOLDER_2], taskHeld: true })
    const menu = openMenuOn('Coder')
    expect(item(menu, 'Set as Coordinator').disabled).toBe(true)
    expect(within(menu).getByText('Stop the autonomous task before changing who coordinates it.')).toBeTruthy()
  })

  it('offers no Set as Coordinator on the current coordinator, and marks only its chip', async () => {
    await mount({ router: 'coordinator', agentId: FOLDER, attached: [FOLDER_2] })
    const conductor = chipOf('Planner')
    const participant = chipOf('Coder')
    expect(conductor.title).toBe('Planner — Coordinator')
    expect(conductor.className).toContain('shadow-[inset_1px_0_0_var(--chip-border),inset_-1px_0_0_var(--chip-border)]')
    // Its own identity colour, not the accent: the mark and the title carry the role.
    expect(conductor.style.getPropertyValue('--chip-border')).toBe(presetForAgentId(FOLDER).border)
    // The coordinator leads the row.
    expect(screen.getByTestId('composer-chips').firstElementChild).toBe(conductor)
    // The name has no title of its own, which would hide the chip's role on hover.
    expect(within(conductor).getByText('Planner').closest('[title]')).toBe(conductor)
    expect(conductor.className).not.toContain('ring-2')
    expect(participant.className).not.toContain('inset_1px')
    // No visible role label: the mark and the title carry it.
    expect(screen.queryByText('Coordinator')).toBeNull()
    expect(screen.queryByText('Participant')).toBeNull()

    const menu = openMenuOn('Planner')
    expect(within(menu).queryByRole('menuitem', { name: 'Set as Coordinator' })).toBeNull()
    expect(item(menu, 'Open Agent Folder')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(item(openMenuOn('Coder'), 'Set as Coordinator').disabled).toBe(false)
  })

  it('keeps the addressed ring and the coordinator mark apart in a human chat', async () => {
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2] })
    const addressed = chipOf('Planner')
    expect(addressed.className).toContain('ring-2')
    expect(addressed.className).not.toContain('inset_1px')
  })

  it('makes the agent coordinator, moving it to the bound chip at once, and closes', async () => {
    let resolve: (value: { success: boolean }) => void = () => undefined
    spies.setCoordinator.mockImplementation(() => new Promise((r) => { resolve = r }))
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2] })
    fireEvent.click(item(openMenuOn('Coder'), 'Set as Coordinator'))
    await waitFor(() => expect(spies.setCoordinator).toHaveBeenCalledWith('chat-1', FOLDER_2))
    // Optimistic: the chosen agent is the bound, marked chip before main answers.
    await waitFor(() => expect(chipOf('Coder').title).toBe('Coder — Coordinator'))
    expect(chipOf('Coder').dataset.coordinator).toBe('true')
    expect(screen.getByRole('menu', { name: 'Agent Coder' })).toBeTruthy()
    chatDetail.current = { ...(chatDetail.current as object), router: 'coordinator', agentId: FOLDER_2 }
    onDemandAgents.current = [{ agentId: FOLDER, pendingAnnounce: false }]
    await act(async () => resolve({ success: true }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('keeps the menu open with the reason when main refuses, and rolls the chips back', async () => {
    let reject: (err: Error) => void = () => undefined
    spies.setCoordinator.mockImplementation(() => new Promise((_resolve, r) => { reject = r }))
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2] })
    fireEvent.click(item(openMenuOn('Coder'), 'Set as Coordinator'))
    // The optimistic move unmounts the attached chip the menu was opened on.
    await waitFor(() => expect(chipOf('Coder').title).toBe('Coder — Coordinator'))
    await act(async () => reject(
      new Error("Error invoking remote method 'chat:set-coordinator': Error: Stop the autonomous task before changing who coordinates it.")
    ))
    const menu = screen.getByRole('menu', { name: 'Agent Coder' })
    expect((await within(menu).findByRole('alert')).textContent).toBe('Stop the autonomous task before changing who coordinates it.')
    // Rolled back: Coder is an attached, addressable chip again, and unmarked.
    await waitFor(() => expect(screen.getByRole('button', { name: /“Coder”/ })).toBeTruthy())
    expect(chipOf('Coder').dataset.coordinator).toBeUndefined()
  })

  it('goes to the agent page and closes', async () => {
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2] })
    fireEvent.click(item(openMenuOn('Coder'), 'Go to Agent'))
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(useUIStore.getState().activeLocalAgentId).toBe(FOLDER_2)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the agent folder, and keeps the menu open when that fails', async () => {
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2] })
    fireEvent.click(item(openMenuOn('Coder'), 'Open Agent Folder'))
    await waitFor(() => expect(spies.openPath).toHaveBeenCalledWith({ agentId: FOLDER_2 }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    spies.openPath.mockRejectedValueOnce(new Error('The folder is gone.'))
    fireEvent.click(item(openMenuOn('Coder'), 'Open Agent Folder'))
    expect((await screen.findByRole('alert')).textContent).toBe('The folder is gone.')
    expect(screen.getByRole('menu', { name: 'Agent Coder' })).toBeTruthy()
  })

  it('opens from the keyboard on a focused chip and hands focus back on Escape', async () => {
    await mount({ router: 'human', attached: [FOLDER, FOLDER_2] })
    const remove = screen.getByRole('button', { name: 'Remove agent Coder' })
    remove.focus()
    fireEvent.keyDown(remove, { key: 'F10', shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Agent Coder' })
    expect(document.activeElement).toBe(item(menu, 'Set as Coordinator'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(remove)
  })

  it('opens with the ContextMenu key on the bound chip, which is focusable for it', async () => {
    await mount({ router: 'direct', agentId: FOLDER })
    const bound = screen.getByRole('group', { name: 'Planner' })
    expect(bound.tabIndex).toBe(0)
    bound.focus()
    fireEvent.keyDown(bound, { key: 'ContextMenu' })
    const menu = screen.getByRole('menu', { name: 'Agent Planner' })
    // A direct chat has no coordinator yet: its own agent can become one.
    expect(item(menu, 'Set as Coordinator').disabled).toBe(false)
  })
})
