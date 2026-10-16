import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Share changes dialog's two shapes — the Bring together step while both
 * sides moved, and the field pre-filled with the session's summary after
 * Finish — and the Discard confirm, which cannot be dismissed while it runs.
 */

const { DiscardAdoptionDialog, ShareChangesDialog } = await import('./ShareDialogs')
const { SHARE_UI_TEXT } = await import('../../../../utils/shareText')

const ok = <T,>(value: T) => ({ success: true as const, value })

let draftMessage: ReturnType<typeof vi.fn>

beforeEach(() => {
  draftMessage = vi.fn().mockResolvedValue(ok('An AI summary'))
  ;(window as unknown as { api: unknown }).api = { sharing: { draftMessage } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ShareChangesDialog — the Bring together step', () => {
  it('shows the sentence and Bring together in place of the field, and asks for no draft', () => {
    const onBringTogether = vi.fn()
    const onShare = vi.fn()
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        combineFirst: true,
        onBringTogether,
        bringTogetherPending: false,
        onShare,
        onCancel: vi.fn()
      })
    )
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })
    expect(dialog.textContent).toContain(SHARE_UI_TEXT.bringTogetherBanner)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: SHARE_UI_TEXT.share })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    expect(onBringTogether).toHaveBeenCalledTimes(1)
    expect(onShare).not.toHaveBeenCalled()
    expect(draftMessage).not.toHaveBeenCalled()
  })

  it('reads Bringing together… inside the button while it runs, and ignores Cancel then', () => {
    const onCancel = vi.fn()
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        combineFirst: true,
        onBringTogether: vi.fn(),
        bringTogetherPending: true,
        onShare: vi.fn(),
        onCancel
      })
    )
    const bring = screen.getByRole('button', { name: SHARE_UI_TEXT.bringingTogether }) as HTMLButtonElement
    expect(bring.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('ShareChangesDialog — pre-filled after Finish', () => {
  it('starts with the session’s summary, never asks for a draft, and sends it', () => {
    const onShare = vi.fn()
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        initialMessage: 'Kept one tax rule.',
        onShare,
        onCancel: vi.fn()
      })
    )
    const field = screen.getByLabelText(SHARE_UI_TEXT.shareChangesLabel) as HTMLTextAreaElement
    expect(field.value).toBe('Kept one tax rule.')
    expect(field.placeholder).toBe(SHARE_UI_TEXT.shareChangesEmptyPlaceholder)
    expect(draftMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    expect(onShare).toHaveBeenCalledWith('Kept one tax rule.')
  })

  it('asks for a draft when nothing is given', () => {
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        onShare: vi.fn(),
        onCancel: vi.fn()
      })
    )
    expect(draftMessage).toHaveBeenCalledWith('folder:alpha')
  })
})

describe('DiscardAdoptionDialog', () => {
  function mount(pending: boolean): { onDiscard: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
    const onDiscard = vi.fn()
    const onCancel = vi.fn()
    render(createElement(DiscardAdoptionDialog, { name: 'Alpha', pending, error: null, onDiscard, onCancel }))
    return { onDiscard, onCancel }
  }

  it('names the agent, says what is kept, and focuses Cancel', () => {
    const { onDiscard, onCancel } = mount(false)
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.discardTitle })
    expect(dialog.textContent).toContain(SHARE_UI_TEXT.discardBody('Alpha'))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.discardConfirm }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape and Cancel while it runs, and reads Discarding…', () => {
    const { onCancel } = mount(true)
    expect((screen.getByRole('button', { name: SHARE_UI_TEXT.discarding }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    expect(onCancel).not.toHaveBeenCalled()
  })
})
