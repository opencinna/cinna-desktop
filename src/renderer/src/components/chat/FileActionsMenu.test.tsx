import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileActionsMenu } from './FileActionsMenu'

const props = { pendingAction: null, fileGone: false, onOpen: vi.fn(), onReveal: vi.fn(), dismissed: false } as const

const openMenu = (): HTMLElement => {
  fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
  return screen.getByRole('menu', { name: 'File actions' })
}

describe('FileActionsMenu', () => {
  it('puts Publish… last, under a separator after Open folder, and runs it', () => {
    const onPublish = vi.fn()
    render(<FileActionsMenu {...props} onPublish={onPublish} />)
    const menu = openMenu()
    const items = [...menu.children].map((el) => el.getAttribute('role') === 'separator' ? '—' : el.textContent)
    expect(items).toEqual(['Open', 'Open folder', '—', 'Publish…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publish…' }))
    expect(onPublish).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('has no Publish… or separator when the file cannot be published, and disables Publish… for a file that has gone', () => {
    const { unmount } = render(<FileActionsMenu {...props} />)
    expect(openMenu().querySelector('[role="separator"]')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Publish…' })).toBeNull()
    unmount()

    render(<FileActionsMenu {...props} fileGone onPublish={vi.fn()} />)
    openMenu()
    expect(screen.getByRole('menuitem', { name: 'Publish…' })).toHaveProperty('disabled', true)
  })
})
