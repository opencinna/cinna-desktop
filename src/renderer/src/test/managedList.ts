import { fireEvent, screen, within } from '@testing-library/react'

/**
 * Driving a compact managed list (`components/ui/ManagedList.tsx`) the way a
 * user does: find a row by its title, open its picker or its ⋯, pick in the
 * menu that opens. The menus are portaled, so they are found on the screen.
 */

/** The row whose title is exactly `title`. */
export function managedRow(container: HTMLElement, title: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-managed-row]'))
  const row = rows.find((candidate) =>
    Array.from(candidate.querySelectorAll('span')).some((span) => span.textContent === title)
  )
  if (!row) throw new Error(`No managed list row titled "${title}"`)
  return row
}

/** The row's value picker: the menu button that names itself by the value it shows. */
export function managedPicker(row: HTMLElement): HTMLButtonElement {
  const picker = within(row)
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-haspopup') === 'menu' && !button.hasAttribute('aria-label'))
  if (!picker) throw new Error('The row has no picker')
  return picker as HTMLButtonElement
}

/** Open the row's picker and choose `option` in the menu named `menuLabel`. */
export function pickInManagedPicker(row: HTMLElement, menuLabel: string, option: string): void {
  fireEvent.click(managedPicker(row))
  const menu = screen.getByRole('menu', { name: menuLabel })
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: option }))
}

/** Open the ⋯ named `menuLabel` and choose `item`. */
export function chooseInManagedMenu(container: HTMLElement, menuLabel: string, item: string): void {
  fireEvent.click(within(container).getByRole('button', { name: menuLabel }))
  const menu = screen.getByRole('menu', { name: menuLabel })
  fireEvent.click(within(menu).getByRole('menuitem', { name: item }))
}
