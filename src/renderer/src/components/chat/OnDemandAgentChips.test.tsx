import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { OnDemandAgentChips } from './OnDemandAgentChips'
import { LOCAL_AGENTS_KEY } from '../../hooks/useLocalAgents'

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({
    data: [
      { id: 'a', name: 'Alpha', source: 'remote', enabled: true },
      { id: 'b', name: 'Beta', source: 'folder', enabled: true },
      { id: 'folder:c', name: 'Gamma', source: 'folder', enabled: true }
    ]
  }),
  useChatOnDemandAgents: () => ({ data: [] }),
  useRemoveOnDemandAgent: () => ({ mutateAsync: vi.fn() })
}))

const MARK = 'shadow-[inset_1px_0_0_var(--chip-border),inset_-1px_0_0_var(--chip-border)]'
/** The chip box itself (title, border, marks), not the button inside it. */
const chip = (name: string): HTMLElement => screen.getByText(name).closest('[title]') as HTMLElement
const FOLDERS = { roots: [], agents: [{ id: 'folder:c' }, { id: 'b' }], homeAccess: null }
;(window as unknown as { api: unknown }).api = { localAgents: { list: async () => FOLDERS } }
const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const client = new QueryClient()
  client.setQueryData(LOCAL_AGENTS_KEY, FOLDERS)
  return createElement(QueryClientProvider, { client }, children)
}

describe('new-chat coordination chips', () => {
  it('marks the coordinator by its sides alone, first in the row and in its own colour, with the role in the title', () => {
    const view = render(<OnDemandAgentChips pendingIds={['a', 'b']} onRemovePending={vi.fn()} />)
    const names = () => screen.getAllByRole('button', { name: /Remove agent/ }).map((button) => button.getAttribute('aria-label'))
    expect(names()).toEqual(['Remove agent Alpha', 'Remove agent Beta'])
    const colour = chip('Beta').style.getPropertyValue('--chip-border')
    view.rerender(<OnDemandAgentChips pendingIds={['a', 'b']} onRemovePending={vi.fn()} coordination={{ conductorId: 'b', conductorName: 'Beta' }} />)
    // Where the bound chip stands once the chat exists: nothing reorders on the first send.
    expect(names()).toEqual(['Remove agent Beta', 'Remove agent Alpha'])
    // Its own identity colour, as an attached chip and as the transcript show it — not the accent.
    expect(chip('Beta').style.getPropertyValue('--chip-border')).toBe(colour)
    expect(colour).not.toBe('var(--color-accent)')
    expect(chip('Beta').title).toBe('Beta — Coordinator')
    expect(chip('Alpha').title).toBe('Alpha — Participant')
    expect(chip('Beta').className).toContain(MARK)
    expect(chip('Alpha').className).not.toContain(MARK)
    // The ring means "addressed"; the coordinator no longer wears it.
    expect(chip('Beta').className).not.toContain('ring-2')
    expect(screen.queryByText('Coordinator')).toBeNull()
    expect(screen.queryByText('Participant')).toBeNull()
    // The role is in the chip button's name too, and the names are not selectable text.
    expect(screen.getByRole('button', { name: 'Beta — Coordinator' }).getAttribute('aria-haspopup')).toBe('menu')
    expect(chip('Beta').className).toContain('select-none')
  })

  it('shows a marked, non-removable Default runtime coordinator for remote-first selection', () => {
    render(<OnDemandAgentChips pendingIds={['a', 'b']} onRemovePending={vi.fn()} coordination={{ conductorId: null, conductorName: 'Default runtime' }} />)
    const runtime = chip('Default runtime')
    expect(runtime.title).toBe('Default runtime — Coordinator')
    expect(runtime.className).toContain(MARK)
    expect(screen.queryByRole('button', { name: 'Remove agent Default runtime' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /Remove agent/ }).map((button) => button.getAttribute('aria-label'))).toEqual(['Remove agent Alpha', 'Remove agent Beta'])
    // Nothing to go to or hand over: the hidden runtime has no menu.
    fireEvent.contextMenu(runtime, { clientX: 10, clientY: 10 })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('new-chat chip click', () => {
  it('opens the menu on a click on the chip, and the × removes without opening it', () => {
    const onRemovePending = vi.fn()
    render(
      <OnDemandAgentChips pendingIds={['a', 'b']} onRemovePending={onRemovePending}
        coordination={{ conductorId: 'b', conductorName: 'Beta' }}
        coordinatorMenu={{ conductorId: 'b', blockedReason: null, onSet: vi.fn() }} />,
      { wrapper }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent Alpha' }), { clientX: 10, clientY: 10, detail: 1 })
    expect(onRemovePending).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Beta — Coordinator' }), { clientX: 10, clientY: 10, detail: 1 })
    const menu = screen.getByRole('menu', { name: 'Agent Beta' })
    // The conductor has no action item: no separator above Go to Agent.
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Go to Agent', 'Open Agent Folder'])
    expect(within(menu).queryByRole('separator')).toBeNull()
  })
})

describe('new-chat chip menu', () => {
  it('sets the picked agent as coordinator, hidden on the conductor and disabled where it cannot conduct', async () => {
    const onSet = vi.fn()
    render(
      <OnDemandAgentChips pendingIds={['a', 'b', 'folder:c']} onRemovePending={vi.fn()}
        coordination={{ conductorId: 'b', conductorName: 'Beta' }}
        coordinatorMenu={{ conductorId: 'b', blockedReason: null, onSet }} />,
      { wrapper }
    )
    fireEvent.contextMenu(chip('Beta'), { clientX: 10, clientY: 10 })
    let menu = screen.getByRole('menu', { name: 'Agent Beta' })
    expect(within(menu).queryByRole('menuitem', { name: 'Set as Coordinator' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(chip('Alpha'), { clientX: 10, clientY: 10 })
    menu = screen.getByRole('menu', { name: 'Agent Alpha' })
    const disabled = within(menu).getByRole('menuitem', { name: 'Set as Coordinator' }) as HTMLButtonElement
    expect(disabled.disabled).toBe(true)
    // The reason is a line in the menu, reachable without a pointer: the arrow keys skip a disabled item.
    const reason = within(menu).getByText('Only a local agent can coordinate')
    expect(disabled.getAttribute('aria-describedby')).toBe(reason.id)
    expect(disabled.title).toBe('')
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.contextMenu(chip('Gamma'), { clientX: 10, clientY: 10 })
    menu = screen.getByRole('menu', { name: 'Agent Gamma' })
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Set as Coordinator', 'Go to Agent', 'Open Agent Folder'])
    // Nothing to address before the chat exists.
    expect(within(menu).getAllByRole('separator')).toHaveLength(1)
    expect(within(menu).getByRole('separator').previousElementSibling).toBe(within(menu).getByRole('menuitem', { name: 'Set as Coordinator' }))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Set as Coordinator' }))
    expect(onSet).toHaveBeenCalledWith('folder:c')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})
