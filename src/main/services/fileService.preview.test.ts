import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Image previews and previews by path: an attachment is read through the same
 * ownership gates as its text, an image is refused rather than cut above the
 * cap, and a path is read only when the user surfaced it (dialog, drop, paste).
 */

const rows = vi.hoisted(() => new Map<string, { storagePath: string }>())
vi.mock('../auth/chatScope', () => ({
  visibleChat: vi.fn(),
  // Only rows the profile may see come back; anyone else's id is unknown.
  visibleChatFile: (userId: string, id: string) => (userId === 'me' ? rows.get(id) : undefined)
}))
const cinnaRead = vi.hoisted(() => vi.fn())
vi.mock('./cinnaFileService', () => ({ cinnaFileService: { readBytes: cinnaRead } }))
vi.mock('./fileStore', () => ({ localFileStore: {}, FileStoreError: class extends Error {}, guessLocalMime: () => 'x' }))
const thumbnail = vi.hoisted(() => vi.fn())
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { images: { thumbnail } } }))

const { _resetThumbnailCache, pathPreview, readImageAttachment, readThumbnail, sniffPreviewImageMime } = await import('./fileService')
const { pathGuard } = await import('./pathGuard')
const { IMAGE_TOO_LARGE_ERROR, MAX_IMAGE_PREVIEW_BYTES, THUMBNAIL_MAX_SIDE, THUMBNAIL_ORIGINAL_MAX_BYTES } = await import(
  '../../shared/filePreview'
)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cinna-preview-'))
  rows.clear()
  cinnaRead.mockReset()
  pathGuard._reset()
  thumbnail.mockReset()
  _resetThumbnailCache()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sniffPreviewImageMime', () => {
  it('names the image by its bytes, not its name', () => {
    expect(sniffPreviewImageMime(PNG)).toBe('image/png')
    expect(sniffPreviewImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffPreviewImageMime(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(sniffPreviewImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffPreviewImageMime(Buffer.from('BM\0\0'))).toBe('image/bmp')
    expect(sniffPreviewImageMime(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(sniffPreviewImageMime(Buffer.from('<html><body><svg></svg></body></html>'))).toBeNull()
    expect(sniffPreviewImageMime(Buffer.from('just text'))).toBeNull()
  })
})

describe('readImageAttachment', () => {
  it("returns a local attachment the profile owns as a data URL, and nobody else's", async () => {
    const file = join(dir, 'shot.png')
    await writeFile(file, PNG)
    rows.set('att-1', { storagePath: file })
    expect(await readImageAttachment({ userId: 'me', attachmentId: 'att-1', source: 'local' })).toEqual({
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      mimeType: 'image/png'
    })
    await expect(readImageAttachment({ userId: 'someone-else', attachmentId: 'att-1', source: 'local' })).rejects.toMatchObject({
      code: 'not_found'
    })
  })

  it('refuses a local image over the cap before reading it', async () => {
    const file = join(dir, 'huge.png')
    await writeFile(file, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES)]))
    rows.set('big', { storagePath: file })
    await expect(readImageAttachment({ userId: 'me', attachmentId: 'big', source: 'local' })).rejects.toMatchObject({
      code: 'too_large',
      message: IMAGE_TOO_LARGE_ERROR
    })
  })

  it('reads a Cinna image with the cap and refuses one the read had to cut', async () => {
    cinnaRead.mockResolvedValueOnce({ bytes: PNG, truncated: false })
    expect((await readImageAttachment({ userId: 'me', attachmentId: 'f1', source: 'cinna' })).mimeType).toBe('image/png')
    expect(cinnaRead).toHaveBeenCalledWith('me', 'f1', MAX_IMAGE_PREVIEW_BYTES)
    cinnaRead.mockResolvedValueOnce({ bytes: PNG, truncated: true })
    await expect(readImageAttachment({ userId: 'me', attachmentId: 'f2', source: 'cinna' })).rejects.toMatchObject({
      code: 'too_large'
    })
  })

  it('refuses bytes that are not an image', async () => {
    cinnaRead.mockResolvedValueOnce({ bytes: Buffer.from('%PDF-1.7'), truncated: false })
    await expect(readImageAttachment({ userId: 'me', attachmentId: 'f3', source: 'cinna' })).rejects.toMatchObject({
      code: 'not_previewable'
    })
  })
})

describe('pathPreview', () => {
  it('reads nothing at a path the user never surfaced', async () => {
    const file = join(dir, 'secret.txt')
    await writeFile(file, 'do not read')
    await expect(pathPreview.readText(file, 100)).rejects.toMatchObject({ code: 'not_allowed' })
    await expect(pathPreview.readImage(file)).rejects.toMatchObject({ code: 'not_allowed' })
    await expect(pathPreview.readText('relative.txt', 100)).rejects.toMatchObject({ code: 'not_allowed' })
    await expect(pathPreview.readText(42, 100)).rejects.toMatchObject({ code: 'not_allowed' })
  })

  it('reads a surfaced text file up to the cap, flagging the cut', async () => {
    const file = join(dir, 'notes.md')
    await writeFile(file, '# Title\nbody')
    pathGuard.record(file)
    expect(await pathPreview.readText(file, 100)).toEqual({ text: '# Title\nbody', truncated: false })
    expect(await pathPreview.readText(file, 7)).toEqual({ text: '# Title', truncated: true })
  })

  it('reads a surfaced image as a data URL, and refuses a surfaced folder', async () => {
    const file = join(dir, 'Pasted image.png')
    await writeFile(file, PNG)
    pathGuard.record(file)
    expect((await pathPreview.readImage(file)).dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    pathGuard.record(dir)
    await expect(pathPreview.readImage(dir)).rejects.toMatchObject({ code: 'not_a_file' })
  })
})

describe('readThumbnail', () => {
  const small = { bytes: Buffer.from('tiny'), mimeType: 'image/jpeg' }

  it('scales an attachment through the host, once, and remembers it', async () => {
    cinnaRead.mockResolvedValue({ bytes: PNG, truncated: false })
    thumbnail.mockReturnValue(small)
    const first = await readThumbnail({ userId: 'me', attachmentId: 'f1', source: 'cinna' })
    expect(first).toEqual({ dataUrl: `data:image/jpeg;base64,${small.bytes.toString('base64')}`, mimeType: 'image/jpeg' })
    expect(thumbnail).toHaveBeenCalledWith(PNG, THUMBNAIL_MAX_SIDE)
    expect(await readThumbnail({ userId: 'me', attachmentId: 'f1', source: 'cinna' })).toEqual(first)
    expect(cinnaRead).toHaveBeenCalledTimes(1)
  })

  it('keeps the attachment gates: another profile gets nothing, an oversized image is refused', async () => {
    const file = join(dir, 'shot.png')
    await writeFile(file, PNG)
    rows.set('att-1', { storagePath: file })
    await expect(readThumbnail({ userId: 'someone-else', attachmentId: 'att-1', source: 'local' })).rejects.toMatchObject({ code: 'not_found' })
    cinnaRead.mockResolvedValue({ bytes: PNG, truncated: true })
    await expect(readThumbnail({ userId: 'me', attachmentId: 'big', source: 'cinna' })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('reads a path only when the user surfaced it', async () => {
    const file = join(dir, 'p.png')
    await writeFile(file, PNG)
    await expect(readThumbnail({ path: file })).rejects.toMatchObject({ code: 'not_allowed' })
    pathGuard.record(file)
    thumbnail.mockReturnValue(small)
    expect((await readThumbnail({ path: file })).mimeType).toBe('image/jpeg')
  })

  it('sends a small image the host cannot scale as it is, and refuses a large one', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    cinnaRead.mockResolvedValueOnce({ bytes: svg, truncated: false })
    expect((await readThumbnail({ userId: 'me', attachmentId: 'logo', source: 'cinna' })).mimeType).toBe('image/svg+xml')
    // SVG is never handed to the host.
    expect(thumbnail).not.toHaveBeenCalled()
    thumbnail.mockReturnValue(null)
    cinnaRead.mockResolvedValueOnce({ bytes: Buffer.concat([PNG, Buffer.alloc(THUMBNAIL_ORIGINAL_MAX_BYTES)]), truncated: false })
    await expect(readThumbnail({ userId: 'me', attachmentId: 'odd', source: 'cinna' })).rejects.toMatchObject({ code: 'not_previewable' })
  })
})
