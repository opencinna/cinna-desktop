import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'
import { TablePreviewModal } from './TablePreviewModal'
import { useTablePreviewStore } from '../../stores/tablePreview.store'

/**
 * A table in a chat message — a markdown table, or a code block that reads as
 * one — carries a "Table actions" ⋯: Open as table, Download CSV.
 */

const PIPE_BLOCK = ['```', 'Odoo id | name | status', '41 | Acme | active', '42 | Beta | paused', '```'].join('\n')
const PLAIN_BLOCK = ['```bash', 'cat a.log | grep error', 'ps aux | grep node', '```'].join('\n')
const MARKDOWN_TABLE = '| Name | Value | Note |\n| --- | --- | --- |\n| a | 1 | first |\n| b | 2 | second |'

function renderReply(content: string) {
  return render(
    <>
      <MessageBubble role="assistant" content={content} />
      <TablePreviewModal />
    </>
  )
}

beforeEach(() => {
  useTablePreviewStore.setState({ rows: null, returnFocus: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('code block table actions', () => {
  it('offers the button on a block that reads as a table, and not on a plain one', () => {
    const { container } = renderReply(`${PIPE_BLOCK}\n\n${PLAIN_BLOCK}`)
    const buttons = screen.getAllByRole('button', { name: 'Table actions' })
    expect(buttons).toHaveLength(1)
    const pres = container.querySelectorAll('pre')
    expect(pres).toHaveLength(2)
    // Every fenced block is wrapped; only the table's wrapper holds a button, beside the pre.
    expect(buttons[0].parentElement?.contains(pres[0])).toBe(true)
    expect(pres[1].parentElement?.classList.contains('table-actions-host')).toBe(true)
    expect(pres[1].parentElement?.querySelector('button')).toBeNull()
    expect(buttons[0].getAttribute('aria-haspopup')).toBe('menu')
  })

  it('opens the menu, and Open as table shows the rows in the modal', () => {
    renderReply(PIPE_BLOCK)
    fireEvent.click(screen.getByRole('button', { name: 'Table actions' }))
    const menu = screen.getByRole('menu', { name: 'Table actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open as table', 'Download CSV'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open as table' }))
    expect(screen.queryByRole('menu')).toBeNull()
    const dialog = screen.getByRole('dialog', { name: 'Table' })
    expect(within(dialog).getByText('2 rows × 3 columns')).toBeTruthy()
    expect(within(dialog).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Odoo id', 'name', 'status'])
    expect(within(dialog).getByRole('cell', { name: 'Acme' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Toggle column filters and sorting' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Download CSV' })).toBeTruthy()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Download CSV saves the rows as CSV with a BOM', async () => {
    const blobs: Blob[] = []
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob)
      return 'blob:test'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderReply(PIPE_BLOCK)
    fireEvent.click(screen.getByRole('button', { name: 'Table actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download CSV' }))
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement
    expect(anchor.download).toMatch(/^table-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/)
    const bytes = new Uint8Array(await blobs[0].arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('Odoo id,name,status\r\n41,Acme,active\r\n42,Beta,paused')
  })
})

describe('markdown table header actions', () => {
  it('puts one button in the last header cell, and one on the wrapper for a table that scrolls', () => {
    const { container } = renderReply(MARKDOWN_TABLE)
    const headers = container.querySelectorAll('thead th')
    expect(headers).toHaveLength(3)
    expect(headers[2].querySelectorAll('button[aria-label="Table actions"]')).toHaveLength(1)
    expect(headers[2].classList.contains('table-actions-th')).toBe(true)
    expect(headers[0].querySelector('button')).toBeNull()
    expect(container.querySelector('tbody button')).toBeNull()
    // The wrapper hosts the hover and the stand-in shown only while the table scrolls (main.css).
    const host = container.querySelector('table')?.parentElement
    expect(host?.classList.contains('chat-table-host')).toBe(true)
    expect(host?.classList.contains('table-actions-host')).toBe(true)
    expect(host?.querySelectorAll(':scope > button.table-actions-wide')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Table actions' })).toHaveLength(2)
  })

  it('opens the table as rendered, read from the page', () => {
    const { container } = renderReply(MARKDOWN_TABLE)
    const trigger = container.querySelector('th button[aria-label="Table actions"]') as HTMLElement
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open as table' }))
    expect(useTablePreviewStore.getState().rows).toEqual([
      ['Name', 'Value', 'Note'],
      ['a', '1', 'first'],
      ['b', '2', 'second']
    ])
    const dialog = screen.getByRole('dialog', { name: 'Table' })
    expect(within(dialog).getByText('2 rows × 3 columns')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close table' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // Focus goes back to the button that opened it.
    expect(document.activeElement).toBe(trigger)
  })

  it('the wrapper button reads the same rows', () => {
    const { container } = renderReply(MARKDOWN_TABLE)
    fireEvent.click(container.querySelector('button.table-actions-wide') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open as table' }))
    expect(useTablePreviewStore.getState().rows?.[0]).toEqual(['Name', 'Value', 'Note'])
  })
})

describe('trigger events', () => {
  it('lets a press through, so another open menu closes, and a press on its own open menu closes it', () => {
    renderReply(PIPE_BLOCK)
    const button = screen.getByRole('button', { name: 'Table actions' })
    const outside = vi.fn()
    document.addEventListener('pointerdown', outside)
    fireEvent.pointerDown(button)
    expect(outside).toHaveBeenCalledTimes(1)
    document.removeEventListener('pointerdown', outside)
    fireEvent.click(button)
    expect(screen.getByRole('menu', { name: 'Table actions' })).toBeTruthy()
    // The press closes it (the menu's outside listener); the click that follows must not reopen it.
    fireEvent.pointerDown(button)
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('streaming code block', () => {
  it('keeps the same pre when a block becomes a table a chunk later', () => {
    const partial = ['```', 'Odoo id | name | status', '41 | Acme | active', '42 | Be'].join('\n')
    const { container, rerender } = render(<MessageBubble role="assistant" content={partial} isStreaming />)
    const pre = container.querySelector('pre')
    expect(screen.queryByRole('button', { name: 'Table actions' })).toBeNull()
    rerender(<MessageBubble role="assistant" content={`${partial}ta | paused\n43 | Gamma | active`} isStreaming />)
    expect(screen.getByRole('button', { name: 'Table actions' })).toBeTruthy()
    expect(container.querySelector('pre')).toBe(pre)
  })
})
