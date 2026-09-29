import { describe, expect, it, vi } from 'vitest'
const written = vi.hoisted(() => [] as string[])
vi.mock('electron', () => ({ clipboard: { writeText: (text: string) => void written.push(text) } }))
import { MAX_CLIPBOARD_TEXT_LENGTH, writeClipboardText } from './clipboard'

describe('writeClipboardText', () => {
  it("writes text to Electron's clipboard", () => {
    expect(writeClipboardText('line 1\nline 2')).toEqual({ success: true })
    expect(written).toEqual(['line 1\nline 2'])
  })

  it('refuses a non-string or oversized payload, and reports a failed write as data', () => {
    const write = vi.fn()
    expect(writeClipboardText(42, write)).toEqual({ success: false })
    expect(writeClipboardText('x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1), write)).toEqual({ success: false })
    expect(write).not.toHaveBeenCalled()
    expect(writeClipboardText('x', () => { throw new Error('no clipboard') })).toEqual({ success: false })
  })
})
