import { describe, expect, it } from 'vitest'
import { insertPastedText, pasteIntent } from './composerPaste'

describe('pasteIntent', () => {
  it('lets text through', () => {
    expect(pasteIntent(['text/plain', 'text/html'])).toBe('text')
  })

  it('takes files when the clipboard has no text (a screenshot, a browser image)', () => {
    expect(pasteIntent(['Files'])).toBe('files')
    expect(pasteIntent(['text/html', 'Files'])).toBe('files')
  })

  it('asks main when files come with text: references attach, a picture of the text does not', () => {
    expect(pasteIntent(['text/plain', 'Files'])).toBe('ask')
    expect(pasteIntent(['text/plain', 'text/html', 'Files'])).toBe('ask')
  })
})

describe('insertPastedText', () => {
  it('replaces the selection at the caret and reports an input event', () => {
    const el = document.createElement('textarea')
    document.body.append(el)
    el.focus()
    el.value = 'hello world'
    el.setSelectionRange(6, 11)
    const inputs: string[] = []
    el.addEventListener('input', () => inputs.push(el.value))
    expect(insertPastedText(el, 'there')).toBe(true)
    expect(el.value).toBe('hello there')
    expect(el.selectionStart).toBe(11)
    expect(inputs).toEqual(['hello there'])
    expect(document.activeElement).toBe(el)
    el.remove()
  })

  it('drops the paste, and leaves focus alone, when the user moved elsewhere while main was asked', () => {
    const el = document.createElement('textarea')
    const other = document.createElement('input')
    document.body.append(el, other)
    el.value = 'hello'
    other.focus()
    const inputs: string[] = []
    el.addEventListener('input', () => inputs.push(el.value))
    expect(insertPastedText(el, ' world')).toBe(false)
    expect(el.value).toBe('hello')
    expect(inputs).toEqual([])
    expect(document.activeElement).toBe(other)
    el.remove()
    other.remove()
  })
})
