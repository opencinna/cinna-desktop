import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialogFooter, DialogShell } from './ShareDialogs'

/**
 * The shared dialog frame: a refusal goes under the buttons, whole, and only
 * when there is one; a centred dialog keeps its top where it opened, so the
 * refusal lengthens it downward and moves nothing above it (ux_rules rule 1).
 * jsdom lays nothing out, so the dialog's rect is stubbed.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Dialog({ error, hint, notice }: { error: string | null; hint?: string | null; notice?: string | null }): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <DialogShell title="Remove sharing" pending={false} onDismiss={() => {}} initialFocusRef={cancelRef}>
      <p>Body</p>
      <DialogFooter error={error} hint={hint} notice={notice}>
        <button ref={cancelRef} type="button">Cancel</button>
        <button type="button">Remove</button>
      </DialogFooter>
    </DialogShell>
  )
}

describe('DialogFooter', () => {
  it('is the buttons alone while healthy: no message room reserved', () => {
    render(createElement(Dialog, { error: null }))
    const footer = document.querySelector('[data-dialog-footer]')!
    expect(footer.children).toHaveLength(1)
    expect(footer.firstElementChild!.hasAttribute('data-dialog-buttons')).toBe(true)
    expect(footer.className).not.toMatch(/\bh-\d/)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a refusal after the buttons, whole, last in the dialog, with its hint in the same alert', () => {
    const long = 'Couldn’t reach the server. Check the connection and try again — nothing was changed on this computer or on the team’s side.'
    render(createElement(Dialog, { error: long, hint: 'Turn off the switch above.' }))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(`${long} Turn off the switch above.`)
    expect(alert.previousElementSibling!.contains(screen.getByRole('button', { name: 'Remove' }))).toBe(true)
    expect(screen.getByRole('dialog').lastElementChild!.lastElementChild).toBe(alert)
    expect(alert.className).not.toContain('line-clamp')
    expect(alert.hasAttribute('title')).toBe(false)
  })

  it('puts a notice in the same place, and drops a hint that has no error', () => {
    render(createElement(Dialog, { error: null, hint: 'Turn off the switch above.', notice: 'Saved.' }))
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Saved.')
    expect(status.previousElementSibling!.hasAttribute('data-dialog-buttons')).toBe(true)
    expect(screen.queryByText('Turn off the switch above.', { exact: false })).toBeNull()
  })
})

describe('DialogShell, centred', () => {
  it('pins the top where it opened, so a refusal grows it downward', () => {
    let top = 180
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const t = this.getAttribute('role') === 'dialog' ? top : 0
      return { top: t, left: 0, width: 0, height: 0, bottom: t, right: 0, x: 0, y: t, toJSON: () => ({}) } as DOMRect
    })
    const view = render(createElement(Dialog, { error: null }))
    const dialog = screen.getByRole('dialog')
    const overlay = dialog.parentElement!
    expect(overlay.className).toContain('items-start')
    expect(overlay.className).not.toContain('items-center')
    expect(dialog.style.marginTop).toBe('180px')

    // Taller now: centring would have moved it up. It stays.
    top = 160
    view.rerender(createElement(Dialog, { error: 'Refused.' }))
    expect(screen.getByRole('dialog').style.marginTop).toBe('180px')

    // A resize centres it afresh.
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('dialog').style.marginTop).toBe('160px')
  })
})
