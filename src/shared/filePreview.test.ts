import { describe, expect, it } from 'vitest'
import { previewKindFor } from './filePreview'

describe('previewKindFor', () => {
  it('highlights python by extension, then by MIME', () => {
    expect(previewKindFor('train.py')).toBe('python')
    expect(previewKindFor('stubs.PYI')).toBe('python')
    expect(previewKindFor('script', 'text/x-python')).toBe('python')
  })

  it('lets the extension win over the MIME type', () => {
    expect(previewKindFor('notes.txt', 'text/x-python')).toBe('text')
  })
})
