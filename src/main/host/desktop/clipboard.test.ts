import { describe, expect, it, vi } from 'vitest'
const written = vi.hoisted(() => [] as string[])
vi.mock('electron', () => ({
  clipboard: { writeText: async (text: string) => void written.push(text) },
  nativeImage: { createFromBuffer: () => ({ toPNG: () => Buffer.alloc(0) }) }
}))
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  clipboardHasFileRefs,
  readClipboardImagePng,
  readClipboardUriList,
  writeClipboardText,
  type ClipboardReader
} from './clipboard'

describe('writeClipboardText', () => {
  it("writes text to Electron's clipboard", async () => {
    expect(await writeClipboardText('line 1\nline 2')).toEqual({ success: true })
    expect(written).toEqual(['line 1\nline 2'])
  })

  it('refuses a non-string or oversized payload, and reports a failed write as data', async () => {
    const write = vi.fn(async () => {})
    expect(await writeClipboardText(42, write)).toEqual({ success: false })
    expect(await writeClipboardText('x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1), write)).toEqual({ success: false })
    expect(write).not.toHaveBeenCalled()
    expect(await writeClipboardText('x', () => { throw new Error('no clipboard') })).toEqual({ success: false })
  })

  // Electron 44+ writes asynchronously: the failure arrives as a rejection.
  it('reports a rejected write as data too', async () => {
    expect(await writeClipboardText('x', () => Promise.reject(new Error('no clipboard')))).toEqual({ success: false })
  })
})

/**
 * Electron 44+'s W3C-shaped clipboard: `read()` resolves to items, each with
 * `types` and `getType(type)` → Blob. What a Finder copy reads as, probed on
 * Electron 45: one item with `text/uri-list` (every file, CRLF-separated) and
 * raw `electron application/osclipboard;…` types beside it.
 */
function clipboardOf(...items: Record<string, string | Uint8Array>[]): ClipboardReader {
  return {
    read: async () =>
      items.map((entries) => ({
        types: Object.keys(entries),
        getType: async (type: string) => {
          if (!(type in entries)) throw new Error(`no ${type}`)
          const value = entries[type]
          return new Blob([typeof value === 'string' ? value : new Uint8Array(value)])
        }
      })) as never
  }
}

describe('reading the clipboard for a paste', () => {
  const FINDER_COPY = {
    'text/uri-list': 'file:///tmp/a.txt\r\nfile:///tmp/b%20c.txt',
    'electron application/osclipboard;format="NSFilenamesPboardType"': '<plist/>'
  }

  it('reads the file references as one text/uri-list', async () => {
    expect(await readClipboardUriList(clipboardOf(FINDER_COPY))).toBe('file:///tmp/a.txt\r\nfile:///tmp/b%20c.txt')
    expect(await readClipboardUriList(clipboardOf({ 'text/plain': 'hello' }))).toBeUndefined()
    expect(await readClipboardUriList(clipboardOf({ 'text/plain': 'hello' }, FINDER_COPY))).toContain('a.txt')
  })

  it('treats a read or a payload that fails as absent', async () => {
    const failing: ClipboardReader = { read: () => Promise.reject(new Error('no clipboard')) }
    expect(await readClipboardUriList(failing)).toBeUndefined()
    expect(await readClipboardImagePng(failing)).toBeNull()
    const lying: ClipboardReader = {
      read: async () => [{ types: ['text/uri-list', 'image/png'], getType: () => Promise.reject(new Error('gone')) }] as never
    }
    expect(await readClipboardUriList(lying)).toBeUndefined()
    expect(await readClipboardImagePng(lying)).toBeNull()
    expect(await clipboardHasFileRefs(lying)).toBe(false)
  })

  it('says files are referenced only for file:// URLs (a browser link copy is not a file)', async () => {
    expect(await clipboardHasFileRefs(clipboardOf(FINDER_COPY))).toBe(true)
    expect(await clipboardHasFileRefs(clipboardOf({ 'text/uri-list': 'https://example.com/a.png' }))).toBe(false)
    expect(await clipboardHasFileRefs(clipboardOf({ 'text/plain': 'cell', 'image/png': new Uint8Array([1]) }))).toBe(false)
  })

  it("returns the clipboard's image as PNG bytes, or null when it holds none", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(await readClipboardImagePng(clipboardOf({ 'text/plain': 'cell', 'image/png': png }))).toEqual(Buffer.from(png))
    expect(await readClipboardImagePng(clipboardOf({ 'text/plain': 'cell' }))).toBeNull()
    expect(await readClipboardImagePng(clipboardOf({ 'image/png': new Uint8Array(0) }))).toBeNull()
  })

  // Electron 45 on macOS already offers a TIFF-only pasteboard as image/png
  // (probed); another platform may list only another image type.
  it('converts another image type to PNG when the clipboard has no image/png', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff])
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const toPng = vi.fn((bytes: Buffer) => (bytes.equals(Buffer.from(jpeg)) ? png : Buffer.alloc(0)))
    expect(await readClipboardImagePng(clipboardOf({ 'text/plain': 'x' }, { 'image/jpeg': jpeg }), toPng)).toEqual(png)
    expect(toPng).toHaveBeenCalledTimes(1)
    // Undecodable (nativeImage cannot read TIFF), or a converter that throws: no image.
    expect(await readClipboardImagePng(clipboardOf({ 'image/tiff': new Uint8Array([0x4d, 0x4d]) }), toPng)).toBeNull()
    expect(await readClipboardImagePng(clipboardOf({ 'image/jpeg': jpeg }), () => { throw new Error('bad') })).toBeNull()
    // PNG present: no conversion.
    toPng.mockClear()
    expect(await readClipboardImagePng(clipboardOf({ 'image/png': png, 'image/jpeg': jpeg }), toPng)).toEqual(png)
    expect(toPng).not.toHaveBeenCalled()
  })
})
