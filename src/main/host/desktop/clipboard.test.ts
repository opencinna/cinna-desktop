import { describe, expect, it, vi } from 'vitest'
const written = vi.hoisted(() => [] as string[])
vi.mock('electron', () => ({ clipboard: { writeText: (text: string) => void written.push(text) } }))
import { MAX_CLIPBOARD_TEXT_LENGTH, readClipboardFileSources, readClipboardImagePng, writeClipboardText } from './clipboard'

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

describe('reading the clipboard for a paste', () => {
  const formats = (map: Record<string, string>) => ({
    read: (format: string) => map[format] ?? '',
    readBuffer: (format: string) => Buffer.from(map[format] ?? '', 'utf16le')
  })

  it('reads the macOS file URL and filenames plist, and nothing else', () => {
    const cb = formats({ 'public.file-url': 'file:///tmp/a.png', NSFilenamesPboardType: '<array/>', 'text/uri-list': 'x' })
    expect(readClipboardFileSources('darwin', cb)).toEqual({ fileUrl: 'file:///tmp/a.png', filenamesPlist: '<array/>' })
  })

  it('reads text/uri-list on Linux and FileNameW on Windows', () => {
    expect(readClipboardFileSources('linux', formats({ 'text/uri-list': 'file:///home/a' }))).toEqual({ uriList: 'file:///home/a' })
    const win = readClipboardFileSources('win32', formats({ FileNameW: 'C:\\a.png\0' }))
    expect(win.fileNameW?.toString('utf16le')).toBe('C:\\a.png\0')
    expect(readClipboardFileSources('win32', formats({}))).toEqual({})
  })

  it('treats a format read that throws as absent', () => {
    const cb = { read: () => { throw new Error('no such format') }, readBuffer: () => { throw new Error('no') } }
    expect(readClipboardFileSources('darwin', cb)).toEqual({ fileUrl: undefined, filenamesPlist: undefined })
    expect(readClipboardFileSources('win32', cb)).toEqual({})
  })

  it("returns the clipboard's image as PNG bytes, or null when it holds none", () => {
    const png = Buffer.from([0x89, 0x50])
    expect(readClipboardImagePng({ readImage: () => ({ isEmpty: () => false, toPNG: () => png }) as never })).toBe(png)
    expect(readClipboardImagePng({ readImage: () => ({ isEmpty: () => true, toPNG: () => png }) as never })).toBeNull()
  })
})
