import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionActivityChangedPayload,
  SessionActivityItem
} from '../../../../shared/sessionActivity'

/**
 * The session meta badges under the composer: Agents and Background while
 * something of their kind runs, Tasks while the chat has one.
 *
 * The activity feed is pushed, so the tests drive it the way main does — a
 * `session-activity:changed` payload into the listener the hook registered.
 */

const push = vi.hoisted(() => ({ listener: null as null | ((p: SessionActivityChangedPayload) => void) }))
const spies = vi.hoisted(() => ({
  getActivity: vi.fn(),
  listTasks: vi.fn()
}))

;(window as unknown as { api: unknown }).api = {
  app: { setTheme: async () => undefined },
  sessionActivity: {
    get: (chatId: string) => spies.getActivity(chatId),
    onChanged: (listener: (p: SessionActivityChangedPayload) => void) => {
      push.listener = listener
      return () => {
        if (push.listener === listener) push.listener = null
      }
    }
  },
  tasks: { list: (query: unknown) => spies.listTasks(query) }
}

const { SessionMetaBadges } = await import('./SessionMetaBadges')
const { HOVER_CLOSE_DELAY_MS } = await import('../ui/useHoverPopover')
const { useUIStore } = await import('../../stores/ui.store')

const T0 = new Date('2026-09-17T10:00:00Z')

function item(id: string, patch: Partial<SessionActivityItem> = {}): SessionActivityItem {
  return {
    id,
    kind: 'background',
    agentId: 'agent-1',
    title: `Process ${id}`,
    detail: null,
    state: 'running',
    startedAt: T0,
    endedAt: null,
    outputPath: null,
    canStop: false,
    ...patch
  }
}

function task(n: number) {
  return {
    id: `t${n}`,
    title: `Task ${n}`,
    status: 'completed',
    updatedAt: new Date('2026-09-17T09:00:00Z'),
    chatId: 'chat-1'
  }
}

/**
 * Mounted, with the first activity read settled and the push listener live, so
 * a pushed snapshot is not overwritten by the initial read landing after it.
 */
async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(createElement(SessionMetaBadges, { chatId: 'chat-1' }), { wrapper })
  await waitFor(() => {
    expect(client.getQueryState(['sessionActivity', 'chat-1'])?.status).toBe('success')
    expect(push.listener).not.toBeNull()
  })
}

/** TanStack notifies observers on a later tick, hence the async act. */
async function send(items: SessionActivityItem[], chatId = 'chat-1'): Promise<void> {
  await act(async () => {
    push.listener?.({ chatId, snapshot: { chatId, items } })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * By kind, not by name: jsdom applies no container query, so the split badges
 * and the collapsed Activity badge are all in the tree, and the collapsed one
 * says "2 subagents running" too when only subagents run.
 */
const byKind = (kind: string) => (): HTMLElement | null =>
  document.querySelector<HTMLElement>(`button[data-badge="${kind}"]`)
const agents = byKind('subagent')
const background = byKind('background')
const collapsed = byKind('all')

beforeEach(() => {
  spies.getActivity.mockReset().mockResolvedValue({ ok: true, snapshot: { chatId: 'chat-1', items: [] } })
  spies.listTasks.mockReset().mockResolvedValue([])
  push.listener = null
})

describe('the activity badges', () => {
  it('show nothing while nothing runs, even with ended items retained', async () => {
    spies.getActivity.mockResolvedValue({
      ok: true,
      snapshot: { chatId: 'chat-1', items: [item('a', { state: 'completed', endedAt: T0 })] }
    })
    await mount()
    expect(spies.getActivity).toHaveBeenCalledWith('chat-1')
    expect(agents()).toBeNull()
    expect(background()).toBeNull()
  })

  it('appear on a pushed snapshot with the running count as their name, and leave with the last one', async () => {
    await mount()
    await send([
      item('s1', { kind: 'subagent' }),
      item('s2', { kind: 'subagent' }),
      item('b1'),
      item('b2', { state: 'failed', endedAt: T0 })
    ])
    // Mutation: count every item of the kind rather than the running ones and
    // the Background badge announces two.
    expect(agents()?.getAttribute('aria-label')).toBe('2 subagents running')
    expect(agents()?.textContent).toBe('2')
    expect(background()?.getAttribute('aria-label')).toBe('1 background process running')
    expect(background()?.textContent).toBe('1')

    // Another chat's push changes nothing here.
    await send([], 'chat-2')
    expect(agents()).not.toBeNull()

    await send([
      item('s1', { kind: 'subagent', state: 'completed', endedAt: T0 }),
      item('s2', { kind: 'subagent', state: 'completed', endedAt: T0 }),
      item('b1')
    ])
    expect(agents()).toBeNull()
    expect(background()).not.toBeNull()
    expect(collapsed()?.getAttribute('aria-label')).toBe('1 background process running')
  })

  it('collapse into one Activity badge that counts and lists both kinds', async () => {
    await mount()
    await send([
      item('s1', { kind: 'subagent', title: 'Explore' }),
      item('b1', { title: 'npm test' }),
      item('b2', { title: 'npm run dev' }),
      item('s2', { kind: 'subagent', title: 'Plan', state: 'completed', endedAt: T0 })
    ])
    // The split and collapsed forms sit behind opposite container queries.
    expect(agents()?.className).toContain('@max-[40rem]/composer:hidden')
    expect(collapsed()?.className).toContain('@min-[40rem]/composer:hidden')
    expect(collapsed()?.getAttribute('aria-label')).toBe('1 subagent and 2 background processes running')
    expect(collapsed()?.textContent).toBe('3')
    fireEvent.mouseEnter(collapsed()!)
    const dialog = screen.getByRole('dialog', { name: 'Session activity' })
    const subagents = within(dialog).getByRole('region', { name: 'Subagents' })
    const processes = within(dialog).getByRole('region', { name: 'Background processes' })
    expect(within(subagents).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Explore'),
      expect.stringContaining('Plan')
    ])
    expect(within(processes).getAllByRole('listitem')).toHaveLength(2)
    expect(dialog.textContent).toContain('3 running · 1 ended')
  })

  it('list running items first, ended ones after, and explain a lost one', async () => {
    await mount()
    await send([
      item('run', { title: 'npm test', detail: 'Watching CI', outputPath: '/tmp/out.log' }),
      item('gone', { title: 'tail -f log', state: 'lost', endedAt: new Date(T0.getTime() + 3 * 60_000) }),
      item('done', { title: 'build', state: 'completed', endedAt: new Date(T0.getTime() + 65 * 60_000) })
    ])
    fireEvent.mouseEnter(background()!)
    const dialog = await screen.findByRole('dialog', { name: 'Background processes' })
    const rows = dialog.querySelectorAll('[data-state]')
    expect([...rows].map((row) => row.getAttribute('data-state'))).toEqual(['running', 'lost', 'completed'])
    expect(within(dialog).getByText('npm test')).toBeTruthy()
    expect(within(dialog).getByText('Watching CI')).toBeTruthy()
    expect(within(dialog).getByText('/tmp/out.log')).toBeTruthy()
    expect(rows[1].textContent).toContain('Lost · 3m')
    expect(rows[2].textContent).toContain('Completed · 1h 5m')
    // Mutation: drop the lost line and only the state word says anything.
    expect(within(rows[1] as HTMLElement).getByText("The agent's process ended before this finished.")).toBeTruthy()
    expect(rows[2].textContent).not.toContain('process ended')
    expect(dialog.textContent).toContain('1 running · 2 ended')
  })
})

describe('the popover', () => {
  async function openable(): Promise<HTMLElement> {
    await mount()
    await send([item('b1')])
    return background()!
  }
  const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Background processes' })

  it('opens on hover and closes after a delay the pointer can cross into it', async () => {
    const trigger = await openable()
    vi.useFakeTimers()
    try {
      fireEvent.mouseEnter(trigger)
      expect(dialog()).not.toBeNull()
      expect(dialog()?.getAttribute('role')).toBe('dialog')
      expect(trigger.getAttribute('aria-expanded')).toBe('true')

      fireEvent.mouseLeave(trigger)
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS - 50))
      fireEvent.pointerMove(dialog()!)
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2))
      expect(dialog()).not.toBeNull()

      fireEvent.mouseLeave(dialog()!)
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS))
      expect(dialog()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not count a popover that appeared under a still pointer as hovered', async () => {
    const trigger = await openable()
    vi.useFakeTimers()
    try {
      fireEvent.focus(trigger)
      // The popover paints under the pointer: an enter, but no movement.
      fireEvent.mouseEnter(dialog()!)
      fireEvent.blur(trigger)
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS))
      // Mutation: count mouseenter on the popover as hover and it stays open.
      expect(dialog()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets focus when a focused badge leaves, so a later hover closes on leave', async () => {
    const trigger = await openable()
    act(() => trigger.focus())
    expect(dialog()).not.toBeNull()
    // The last running item ends: the badge (and its focus) leaves with no blur.
    await send([item('b1', { state: 'completed', endedAt: T0 })])
    expect(background()).toBeNull()
    await send([item('b2')])
    const again = background()!
    vi.useFakeTimers()
    try {
      fireEvent.mouseEnter(again)
      expect(dialog()).not.toBeNull()
      fireEvent.mouseLeave(again)
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS))
      // Mutation: keep `focus` when the popover closes and it sticks open.
      expect(dialog()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes an Escape typed elsewhere while open, before the composer sees it', async () => {
    const trigger = await openable()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const composerKeys = vi.fn()
    textarea.addEventListener('keydown', composerKeys)
    try {
      textarea.focus()
      fireEvent.mouseEnter(trigger)
      expect(dialog()).not.toBeNull()
      fireEvent.keyDown(textarea, { key: 'Escape' })
      // Mutation: drop the document-level listener and both fail.
      expect(dialog()).toBeNull()
      expect(composerKeys).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(textarea)
      // Closed, the popover no longer takes Escape.
      fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(composerKeys).toHaveBeenCalledTimes(1)
    } finally {
      textarea.remove()
    }
  })

  it('moves focus into the list when pinned with Enter', async () => {
    const trigger = await openable()
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const list = await screen.findByLabelText('Background processes list')
    await waitFor(() => expect(document.activeElement).toBe(list))
    expect(list.getAttribute('tabindex')).toBe('0')
  })

  it('keeps counts two digits wide', async () => {
    const trigger = await openable()
    const count = trigger.querySelector('span')!
    expect(count.className).toContain('min-w-[2ch]')
    expect(count.className).toContain('tabular-nums')
  })

  it('opens on keyboard focus', async () => {
    const trigger = await openable()
    fireEvent.focus(trigger)
    expect(dialog()).not.toBeNull()
  })

  it('stays open when pinned by a click after the pointer leaves', async () => {
    const trigger = await openable()
    vi.useFakeTimers()
    try {
      fireEvent.mouseEnter(trigger)
      fireEvent.click(trigger)
      fireEvent.mouseLeave(trigger)
      act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 3))
      expect(dialog()).not.toBeNull()
      // A second click unpins and closes.
      fireEvent.click(trigger)
      expect(dialog()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes on Escape and stays closed while focus is handed back', async () => {
    const trigger = await openable()
    trigger.focus()
    fireEvent.click(trigger)
    expect(dialog()).not.toBeNull()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('the tasks badge', () => {
  const tasksBadge = (): HTMLElement | null => screen.queryByRole('button', { name: /tasks? in this chat$/ })

  it('is hidden while the chat has no tasks and asks for this chat’s root tasks', async () => {
    await mount()
    await waitFor(() => expect(spies.listTasks).toHaveBeenCalled())
    expect(spies.listTasks).toHaveBeenCalledWith({ chatId: 'chat-1', rootOnly: true })
    expect(tasksBadge()).toBeNull()
  })

  it('names its count and opens a task from its row', async () => {
    spies.listTasks.mockResolvedValue([task(1), task(2), task(3)])
    useUIStore.setState({ activeView: 'chat', activeTaskId: null })
    await mount()
    const badge = await screen.findByRole('button', { name: '3 tasks in this chat' })
    expect(badge.textContent).toBe('3')
    fireEvent.mouseEnter(badge)
    const dialog = screen.getByRole('dialog', { name: 'Tasks in this chat' })
    expect(within(dialog).getAllByRole('button', { name: /^Task \d — / })).toHaveLength(3)
    expect(within(dialog).queryByRole('button', { name: 'Open Inbox' })).toBeNull()
    expect(dialog.textContent).not.toContain('Showing')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Task 2 — completed' }))
    expect(useUIStore.getState().activeTaskId).toBe('t2')
    expect(useUIStore.getState().activeView).toBe('task')
    expect(screen.queryByRole('dialog', { name: 'Tasks in this chat' })).toBeNull()
  })

  it('shows ten rows and Open Inbox when there are more', async () => {
    spies.listTasks.mockResolvedValue(Array.from({ length: 12 }, (_v, i) => task(i)))
    useUIStore.setState({ activeView: 'chat' })
    await mount()
    const badge = await screen.findByRole('button', { name: '12 tasks in this chat' })
    fireEvent.mouseEnter(badge)
    const dialog = screen.getByRole('dialog', { name: 'Tasks in this chat' })
    expect(dialog.textContent).toContain('Showing 10 of 12')
    expect(within(dialog).getAllByRole('button', { name: /^Task \d+ — / })).toHaveLength(10)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Inbox' }))
    expect(useUIStore.getState().activeView).toBe('inbox')
  })

  it('hands focus back to the badge on Tab past the last row or Shift+Tab before the first', async () => {
    spies.listTasks.mockResolvedValue([task(1), task(2)])
    await mount()
    const badge = await screen.findByRole('button', { name: '2 tasks in this chat' })
    const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Tasks in this chat' })

    badge.focus()
    fireEvent.keyDown(badge, { key: 'Enter' })
    const first = await within(dialog()!).findByRole('button', { name: 'Task 1 — completed' })
    await waitFor(() => expect(document.activeElement).toBe(first))
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    // Mutation: drop the Tab handling and focus is left in a closed popover's place.
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(badge)

    fireEvent.keyDown(badge, { key: 'Enter' })
    const last = await within(dialog()!).findByRole('button', { name: 'Task 2 — completed' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(badge)
  })

  it('says one task in the singular', async () => {
    spies.listTasks.mockResolvedValue([task(1)])
    await mount()
    expect(await screen.findByRole('button', { name: '1 task in this chat' })).toBeTruthy()
  })
})

describe('order in the strip', () => {
  it('puts Agents, then Background, then Tasks', async () => {
    spies.listTasks.mockResolvedValue([task(1)])
    await mount()
    await screen.findByRole('button', { name: '1 task in this chat' })
    await send([item('b1'), item('s1', { kind: 'subagent' })])
    const strip = screen.getByTestId('session-meta-badges')
    expect([...strip.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      '1 subagent running',
      '1 background process running',
      '1 subagent and 1 background process running',
      '1 task in this chat'
    ])
  })
})
