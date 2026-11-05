import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedList,
  ManagedListAvatar,
  ManagedListFooterLink,
  ManagedListIconButton,
  ManagedListMenu,
  ManagedListMessage,
  ManagedListPicker,
  ManagedListRow,
  managedListInitials
} from './ManagedList'

/**
 * The compact managed list: a row's parts, the in-row confirm that replaces
 * only that row's title and controls, the picker named by its value with a
 * checked current option, the ⋯ menu, and a message inside the surface.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const OPTIONS = [
  { value: 'use', label: 'Can use', description: 'Use it' },
  { value: 'edit', label: 'Can edit', description: 'Change it' }
] as const

describe('ManagedList', () => {
  it('lays a row out as glyph, title with its meta, second line and controls', () => {
    render(
      <ManagedList>
        <ManagedListRow
          lead={<ManagedListAvatar name="Anna Petrova" />}
          title="Anna Petrova"
          meta="anna@example.test"
          sub="shared by Bob"
          trailing={
            <ManagedListIconButton title="Notes" aria-label="Notes for Anna">
              x
            </ManagedListIconButton>
          }
        />
      </ManagedList>
    )
    const row = screen.getByRole('listitem')
    expect(row.hasAttribute('data-two-line')).toBe(true)
    expect(row.textContent).toBe('APAnna Petrovaanna@example.testshared by Bobx')
    // The icon button carries its own name and tooltip.
    const button = within(row).getByRole('button', { name: 'Notes for Anna' })
    expect(button.getAttribute('title')).toBe('Notes')
    // No border of its own: the surface's hairline is the only separator.
    expect(row.className).not.toMatch(/\bborder\b/)
  })

  it('shows a message inside the surface instead of an empty list', () => {
    const { container } = render(<ManagedList message={<ManagedListMessage>Loading…</ManagedListMessage>} />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('.managed-list')?.textContent).toBe('Loading…')
  })

  it('asks in the row: the title becomes the question and the controls Cancel and the action, nothing else changes', () => {
    const onConfirm = vi.fn()
    function Harness(): React.JSX.Element {
      const [asking, setAsking] = useState(false)
      return (
        <ManagedList>
          <ManagedListRow
            title="Bob"
            meta="bob@example.test"
            trailing={
              <button type="button" onClick={() => setAsking(true)}>
                Remove…
              </button>
            }
            confirm={
              asking
                ? { text: 'Remove Bob’s access?', action: 'Remove', cancel: 'Cancel', pending: false, onConfirm, onCancel: () => setAsking(false) }
                : null
            }
          />
          <ManagedListRow title="Carol" />
        </ManagedList>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    const [bob, carol] = screen.getAllByRole('listitem')
    expect(bob.hasAttribute('data-confirming')).toBe(true)
    // The action's label is laid out twice (with and without the spinner) to hold its width; one is hidden.
    expect(bob.textContent).toBe('Remove Bob’s access?CancelRemoveRemove')
    expect(within(bob).getAllByRole('button')).toHaveLength(2)
    expect(carol.textContent).toBe('Carol')
    fireEvent.click(within(bob).getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(within(bob).getByRole('button', { name: 'Cancel' }))
    expect(bob.hasAttribute('data-confirming')).toBe(false)
    expect(bob.textContent).toBe('Bobbob@example.testRemove…')
  })

  it('holds the confirm while it runs: both buttons disabled, the action busy with a spinner', () => {
    render(
      <ManagedList>
        <ManagedListRow
          title="Bob"
          confirm={{ text: 'Remove?', action: 'Remove', cancel: 'Cancel', pending: true, onConfirm: vi.fn(), onCancel: vi.fn() }}
        />
      </ManagedList>
    )
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    const remove = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    expect(remove.getAttribute('aria-busy')).toBe('true')
    expect(remove.querySelector('svg.animate-spin')).not.toBeNull()
  })

  it('holds the action’s width: the spinner’s copy of the label is always laid out, only its visibility swaps', () => {
    const row = (pending: boolean): React.JSX.Element => (
      <ManagedList>
        <ManagedListRow
          title="Bob"
          confirm={{ text: 'Remove?', action: 'Remove', cancel: 'Cancel', pending, onConfirm: vi.fn(), onCancel: vi.fn() }}
        />
      </ManagedList>
    )
    const { rerender } = render(row(false))
    const copies = (): HTMLElement[] =>
      Array.from(screen.getByRole('button', { name: 'Remove' }).querySelectorAll<HTMLElement>('.col-start-1'))
    expect(copies()).toHaveLength(2)
    expect(copies()[1].querySelector('svg')).not.toBeNull()
    expect(copies().map((copy) => copy.classList.contains('invisible'))).toEqual([false, true])
    rerender(row(true))
    expect(copies()).toHaveLength(2)
    expect(copies().map((copy) => copy.classList.contains('invisible'))).toEqual([true, false])
  })

  it('moves focus to Cancel when a row asks, takes Escape in the row as Cancel, and gives focus back to the row’s control', () => {
    const outside = vi.fn()
    window.addEventListener('keydown', outside)
    function Harness(): React.JSX.Element {
      const [asking, setAsking] = useState(false)
      return (
        <ManagedList>
          <ManagedListRow
            title="Bob"
            trailing={
              <>
                <button type="button">Can use</button>
                <button type="button" onClick={() => setAsking(true)}>
                  Actions
                </button>
              </>
            }
            confirm={
              asking
                ? { text: 'Remove?', action: 'Remove', cancel: 'Cancel', pending: false, onConfirm: vi.fn(), onCancel: () => setAsking(false) }
                : null
            }
          />
        </ManagedList>
      )
    }
    try {
      render(<Harness />)
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      // Escape answered the row's question and went no further.
      expect(screen.getByRole('listitem').hasAttribute('data-confirming')).toBe(false)
      expect(outside).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions' }))
      // The same after Cancel itself.
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions' }))
      // Outside a question, Escape is not the row's.
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(outside).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', outside)
    }
  })

  it('keeps a two-line row’s glyph and controls on its first line whether its extra content is open or not', () => {
    const sideClasses = (): string[] => {
      const row = screen.getByRole('listitem')
      return [row.firstElementChild!.className, row.lastElementChild!.className]
    }
    const row = (open: boolean, sub?: string): React.JSX.Element => (
      <ManagedList>
        <ManagedListRow
          lead={<span>•</span>}
          title="Version 3"
          sub={sub}
          trailing={<ManagedListIconButton title="Notes" aria-label="Notes">n</ManagedListIconButton>}
        >
          {open && <p>Notes</p>}
        </ManagedListRow>
      </ManagedList>
    )
    const { rerender } = render(row(false, 'shared by Ann'))
    const closed = sideClasses()
    for (const className of closed) expect(className).toMatch(/\bself-start\b.*h-\[1lh\]/)
    rerender(row(true, 'shared by Ann'))
    expect(sideClasses()).toEqual(closed)
    // Without a second line, but with content that may open: the same, open or closed.
    rerender(row(false))
    const bare = sideClasses()
    rerender(row(true))
    expect(sideClasses()).toEqual(bare)
    cleanup()
    // A one-line row centres them.
    render(
      <ManagedList>
        <ManagedListRow lead={<span>•</span>} title="Bob" trailing={<button type="button">x</button>} />
      </ManagedList>
    )
    for (const className of sideClasses()) expect(className).toContain('self-center')
  })

  it('takes initials from the first two words', () => {
    expect(managedListInitials('Anna Petrova')).toBe('AP')
    expect(managedListInitials('  you ')).toBe('Y')
    expect(managedListInitials('Everyone with the admin role')).toBe('EW')
  })

  it('names the picker by the value it shows, checks the current option, and reports only a change', () => {
    const onChange = vi.fn()
    render(<ManagedListPicker value="use" options={[...OPTIONS]} onChange={onChange} menuLabel="Access for Bob" />)
    const picker = screen.getByRole('button', { name: 'Can use' })
    expect(picker.getAttribute('aria-haspopup')).toBe('menu')
    expect(picker.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(picker)
    expect(picker.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu', { name: 'Access for Bob' })
    // Named by its label; the line under it is its description.
    const use = within(menu).getByRole('menuitemradio', { name: 'Can use' })
    expect(use.getAttribute('aria-checked')).toBe('true')
    expect(use).toHaveProperty('textContent', 'Can useUse it')
    expect(document.getElementById(use.getAttribute('aria-describedby')!)?.textContent).toBe('Use it')
    // The checked option takes focus, and the arrows move between them.
    expect(document.activeElement).toBe(use)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: 'Can edit' }))

    fireEvent.click(use)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(picker)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Can edit' }))
    expect(onChange).toHaveBeenCalledWith('edit')
  })

  it('opens on the current value, and in a row is described by the row’s title', () => {
    render(
      <ManagedList>
        <ManagedListRow
          title="Bob"
          trailing={<ManagedListPicker value="edit" options={[...OPTIONS]} onChange={vi.fn()} menuLabel="Access for Bob" />}
        />
      </ManagedList>
    )
    const picker = screen.getByRole('button', { name: 'Can edit' })
    expect(document.getElementById(picker.getAttribute('aria-describedby')!)?.textContent).toBe('Bob')
    fireEvent.click(picker)
    const menu = screen.getByRole('menu', { name: 'Access for Bob' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitemradio', { name: 'Can edit' }))
  })

  it('closes a menu on Escape and puts focus back on its trigger', () => {
    render(<ManagedListPicker value="use" options={[...OPTIONS]} onChange={vi.fn()} menuLabel="Access for Bob" />)
    const picker = screen.getByRole('button', { name: 'Can use' })
    fireEvent.click(picker)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(picker)
  })

  it('closes an open menu on a press on its own trigger rather than opening it again', () => {
    render(<ManagedListPicker value="use" options={[...OPTIONS]} onChange={vi.fn()} menuLabel="Access for Bob" />)
    const picker = screen.getByRole('button', { name: 'Can use' })
    fireEvent.click(picker)
    expect(screen.getByRole('menu')).toBeTruthy()
    // The real sequence: the press (which closes it from outside), then the click.
    act(() => {
      fireEvent.pointerDown(picker)
      document.dispatchEvent(new Event('pointerdown'))
    })
    fireEvent.click(picker)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(picker)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('opens the ⋯ with its right edge at the trigger’s, a danger item in the danger tone', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const menu = this.getAttribute('role') === 'menu'
      const width = menu ? 176 : 28
      const left = menu ? 0 : 500
      return { x: left, y: 100, left, top: 100, right: left + width, bottom: 128, width, height: menu ? 40 : 28, toJSON: () => ({}) } as DOMRect
    })
    const onSelect = vi.fn()
    render(
      <ManagedListMenu
        label="Actions for Bob"
        items={[{ label: 'Remove access…', tone: 'danger', onSelect }]}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Actions for Bob' })
    expect(trigger.getAttribute('title')).toBe('Actions for Bob')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Actions for Bob' })
    expect(menu.style.left).toBe(`${528 - 176}px`)
    const item = within(menu).getByRole('menuitem', { name: 'Remove access…' })
    expect(item.className).toContain('--color-danger')
    fireEvent.click(item)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('puts a footer link under the surface', () => {
    const onClick = vi.fn()
    const { container } = render(
      <ManagedList footer={<ManagedListFooterLink onClick={onClick}>Show all (8)</ManagedListFooterLink>}>
        <ManagedListRow title="Version 8" />
      </ManagedList>
    )
    const link = screen.getByRole('button', { name: 'Show all (8)' })
    expect(container.querySelector('.managed-list')?.contains(link)).toBe(false)
    expect(link.className).toContain('--color-accent')
    fireEvent.click(link)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders the chrome scale a step smaller', () => {
    const { container } = render(
      <ManagedList scale="chrome">
        <ManagedListRow title="Version 3" />
      </ManagedList>
    )
    expect(container.querySelector('.managed-list')?.getAttribute('data-scale')).toBe('chrome')
    expect(screen.getByText('Version 3').className).toContain('text-[11px]')
  })

  it('sets the settings scale on the settings type table: 14 the name, 13 the controls, nothing under 11', () => {
    const { container } = render(
      <ManagedList footer={<ManagedListFooterLink onClick={vi.fn()}>Show all (8)</ManagedListFooterLink>}>
        <ManagedListRow
          lead={<ManagedListAvatar name="Bob Stone" />}
          title="Bob"
          sub="shared by Ann"
          trailing={<ManagedListPicker value="use" options={[...OPTIONS]} onChange={vi.fn()} menuLabel="Access for Bob" />}
        />
      </ManagedList>
    )
    expect(screen.getByText('Bob').className).toContain('text-[14px]')
    expect(screen.getByText('shared by Ann').className).toContain('text-[13px]')
    expect(screen.getByRole('button', { name: 'Can use' }).className).toContain('text-[13px]')
    expect(screen.getByRole('button', { name: 'Show all (8)' }).className).toContain('text-[13px]')
    expect(screen.getByText('BS').className).toContain('text-[11px]')
    expect(container.innerHTML).not.toMatch(/text-\[(9|10|10\.5|11\.5|12\.5|13\.5)px\]/)
  })
})
