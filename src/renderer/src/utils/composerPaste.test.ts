import { describe, expect, it, vi } from 'vitest'
import { pasteIntent } from './composerPaste'

describe('pasteIntent', () => {
  it('lets text through without asking main', () => {
    const ask = vi.fn(() => true)
    expect(pasteIntent(['text/plain', 'text/html'], ask)).toBe('text')
    expect(ask).not.toHaveBeenCalled()
  })

  it('takes files when the clipboard has no text (a screenshot, a browser image)', () => {
    const ask = vi.fn(() => false)
    expect(pasteIntent(['Files'], ask)).toBe('files')
    expect(pasteIntent(['text/html', 'Files'], ask)).toBe('files')
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks main when files come with text: references attach, a picture of the text does not', () => {
    expect(pasteIntent(['text/plain', 'Files'], () => true)).toBe('files')
    expect(pasteIntent(['text/plain', 'text/html', 'Files'], () => false)).toBe('text')
  })
})
