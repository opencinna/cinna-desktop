import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ComposerPlusMenu } from './ComposerPlusMenu'

/**
 * The [+] menu's Actions sub-menu: its row exists only when an action is
 * offered, sits right after Add agents / MCP, opens a sub-view with a back
 * header, and a disabled Improvement request stays visible, says why, and
 * does nothing on click.
 */

const base = {
  canAttachFiles: false,
  onAttachFiles: () => {},
  hasCapabilities: true,
  onOpenCapabilityPicker: () => {}
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
}

describe('ComposerPlusMenu Actions', () => {
  it('has no Actions row without an action', () => {
    render(<ComposerPlusMenu {...base} />)
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /Actions/ })).toBeNull()
  })

  it('shows the button for an action alone, with nothing else to offer', () => {
    render(<ComposerPlusMenu {...base} hasCapabilities={false} actions={{ improvementRequest: { disabled: false, onOpen: () => {} } }} />)
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()
  })

  it('places Actions right after Add agents / MCP and opens Improvement request from its sub-view', () => {
    const onOpen = vi.fn()
    render(<ComposerPlusMenu {...base} autonomousRun={{ disabled: false, onStart: () => {} }}
      actions={{ improvementRequest: { disabled: false, onOpen } }} />)
    openMenu()
    const rows = screen.getAllByRole('menuitem').map((row) => row.textContent)
    expect(rows.indexOf('Actions')).toBe(rows.indexOf('Add agents / MCP') + 1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Add agents / MCP' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Improvement request…' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('goes back to the root from the sub-view header', () => {
    render(<ComposerPlusMenu {...base} actions={{ improvementRequest: { disabled: false, onOpen: () => {} } }} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    expect(screen.getByRole('menuitem', { name: 'Add agents / MCP' })).toBeTruthy()
  })

  it('keeps a disabled Improvement request visible with its reason, and ignores a click', () => {
    const onOpen = vi.fn()
    render(<ComposerPlusMenu {...base} actions={{ improvementRequest: { disabled: true, reason: 'Wait for the reply', onOpen } }} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Actions' }))
    const item = screen.getByRole('menuitem', { name: 'Improvement request…' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.getAttribute('title')).toBe('Wait for the reply')
    fireEvent.click(item)
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
