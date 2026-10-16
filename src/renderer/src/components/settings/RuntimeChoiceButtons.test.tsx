import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeChoiceButtons } from './RuntimeChoiceButtons'

const props = { selected: 'claude' as const, tools: [], installing: null, onSelect: vi.fn(), onInstall: vi.fn() }

/**
 * jsdom does no layout, so the shape is asserted where it is decided: the
 * buttons sit in a grid of equal columns and none of them grows to fill a row.
 * A wrapping flex row with `flex-1` laid four buttons out as three plus one
 * stretched across the whole second row (ux_rules rule 12).
 */
function expectEqualCells(count: number, wide: string): void {
  const buttons = screen.getAllByRole('button')
  expect(buttons).toHaveLength(count)
  // The Default Runtime choice is a cell itself; a runtime is a button filling
  // its own positioned cell, which a chip shares.
  const cells = buttons.map((button) => (button.parentElement!.className.includes('relative') ? button.parentElement! : button))
  const grid = cells[0].parentElement!
  expect(cells.every((cell) => cell.parentElement === grid)).toBe(true)
  expect(grid.children).toHaveLength(count)
  expect(grid.className).toMatch(/\bgrid\b/)
  expect(grid.className).toContain('grid-cols-2')
  expect(grid.className).toContain(wide)
  expect(grid.className).not.toContain('flex-wrap')
  expect(grid.parentElement!.className).toContain('@container')
  for (const element of [...buttons, ...cells]) {
    expect(element.className).not.toMatch(/\bflex-1\b/)
    expect(element.className).not.toMatch(/min-w-\[/)
  }
}

describe('RuntimeChoiceButtons', () => {
  it('lays the four runtimes out as equal cells, two a row or all four', () => {
    render(<RuntimeChoiceButtons {...props} />)
    expectEqualCells(4, '@2xl:grid-cols-4')
  })

  it('does the same with Default Runtime as a fifth choice, three a row before all five', () => {
    render(<RuntimeChoiceButtons {...props} defaultChoice={{ description: 'Claude Agent', onSelect: vi.fn() }} />)
    expectEqualCells(5, '@xl:grid-cols-3 @4xl:grid-cols-5')
  })

  it('a card click only selects: a runtime that is not on disk never installs from the card', () => {
    const onSelect = vi.fn()
    const onInstall = vi.fn()
    const onChip = vi.fn()
    render(
      <RuntimeChoiceButtons {...props} selected="opencode" onSelect={onSelect} onInstall={onInstall} onChip={onChip}
        codexBinary={{ state: 'unresolved' }} claudeBinary={{ state: 'unresolved' }} antigravityBinary={{ state: 'unresolved' }}
        chips={{ codex: { kind: 'install' }, claude: { kind: 'install' } }} />
    )
    const codex = screen.getByRole('button', { name: /^Codex/ })
    expect(codex.textContent).toBe('CodexNot installed')
    fireEvent.click(codex)
    expect(onSelect).toHaveBeenCalledWith('codex')
    expect(onInstall).not.toHaveBeenCalled()
    expect(onChip).not.toHaveBeenCalled()
    // Unselected cards carry no chip, whatever they were handed.
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it.each([
    [{ kind: 'install' as const }, 'Install'],
    [{ kind: 'retry' as const }, 'Retry'],
    [{ kind: 'log_in' as const }, 'Log in']
  ])('something missing: a primary button centred over the selected card on a scrim, named by its text: %s', (chip, name) => {
    const onChip = vi.fn()
    const onSelect = vi.fn()
    render(<RuntimeChoiceButtons {...props} selected="claude" onSelect={onSelect} onChip={onChip} chips={{ claude: chip }} />)
    const button = screen.getByRole('button', { name })
    // Over the card, never inside its button: the select button stays reachable underneath.
    const card = screen.getByRole('button', { name: /^Claude Agent/ })
    expect(card.contains(button)).toBe(false)
    const scrim = button.parentElement!
    expect(scrim.className).toContain('runtime-card-scrim')
    expect(scrim.className).toContain('inset-0')
    expect(scrim.parentElement).toBe(card.parentElement)
    expect(button.className).toContain('bg-[var(--color-accent)]')
    // The scrim itself does nothing: the card is already selected.
    fireEvent.click(scrim)
    expect(onChip).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(onChip).toHaveBeenCalledWith('claude')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('progress sits in the same centred spot as status, not a button, with the sub-line following the phase', () => {
    const { rerender } = render(<RuntimeChoiceButtons {...props} selected="codex" codexBinary={{ state: 'unresolved' }} chips={{ codex: { kind: 'installing', percent: 42 } }} />)
    expect(screen.getByRole('status').textContent).toBe('Installing 42%')
    expect(screen.getByRole('status').parentElement!.className).toContain('runtime-card-scrim')
    // The phase, not the bytes, decides the sub-line: no "Not installed" under a running install.
    expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('CodexInstalling…')
    rerender(<RuntimeChoiceButtons {...props} selected="codex" codexBinary={{ state: 'unresolved' }} chips={{ codex: { kind: 'installing', percent: null } }} />)
    expect(screen.getByRole('status').textContent).toBe('Installing…')
    expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('CodexInstalling…')
    rerender(<RuntimeChoiceButtons {...props} selected="codex" chips={{ codex: { kind: 'logging_in' } }} />)
    expect(screen.getByRole('status').textContent).toBe('Logging in…')
    expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('CodexLogging in…')
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  it('a double-click on a card never presses the chip that appears under the pointer', () => {
    const onChip = vi.fn()
    const onSelect = vi.fn()
    const view = render(<RuntimeChoiceButtons {...props} selected="opencode" onSelect={onSelect} onChip={onChip} codexBinary={{ state: 'unresolved' }} />)
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }), { detail: 1 })
    expect(onSelect).toHaveBeenCalledWith('codex')
    // The section writes the selection and hands the chip in.
    view.rerender(<RuntimeChoiceButtons {...props} selected="codex" onSelect={onSelect} onChip={onChip} codexBinary={{ state: 'unresolved' }} chips={{ codex: { kind: 'install' } }} />)
    const install = screen.getByRole('button', { name: 'Install' })
    fireEvent.click(install, { detail: 2 })
    // Even a single click arriving right after the selection is too soon.
    fireEvent.click(install, { detail: 1 })
    expect(onChip).not.toHaveBeenCalled()
    const now = Date.now()
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 500)
    fireEvent.click(install, { detail: 1 })
    later.mockRestore()
    expect(onChip).toHaveBeenCalledWith('codex')
  })

  it('Custom OpenCode carries Add credential when it is selected', () => {
    const onChip = vi.fn()
    render(<RuntimeChoiceButtons {...props} selected="opencode" onChip={onChip} chips={{ opencode: { kind: 'add_credential' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add credential' }))
    expect(onChip).toHaveBeenCalledWith('opencode')
  })

  it('reserves no label room: the overlay never touches the card layout', () => {
    render(<RuntimeChoiceButtons {...props} selected="claude" chips={{ claude: { kind: 'log_in' } }} />)
    for (const name of [/^Claude Agent/, /^Codex/, /^Antigravity/, /^Custom OpenCode/]) {
      const [labelLine, subLine] = Array.from(screen.getByRole('button', { name }).children)
      expect(labelLine.className).not.toMatch(/\bpr-/)
      expect(subLine.className).not.toMatch(/\bpr-/)
    }
  })

  it('all set: a green dot named Ready in the corner, and no scrim', () => {
    render(<RuntimeChoiceButtons {...props} selected="claude" chips={{ claude: { kind: 'ready' } }} />)
    const dot = screen.getByRole('img', { name: 'Ready' })
    expect(dot.className).toContain('bg-[var(--color-success)]')
    expect(dot.getAttribute('title')).toBe('Ready')
    expect(document.querySelector('.runtime-card-scrim')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  it('an unselected card shows no dot and no overlay, whatever it was handed', () => {
    render(<RuntimeChoiceButtons {...props} selected="claude" chips={{ codex: { kind: 'ready' }, antigravity: { kind: 'install' } }} />)
    expect(screen.queryByRole('img', { name: 'Ready' })).toBeNull()
    expect(document.querySelector('.runtime-card-scrim')).toBeNull()
  })
})
