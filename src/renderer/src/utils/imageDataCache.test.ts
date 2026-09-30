import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_THUMBNAIL_READS, _resetImageCache, loadImage } from './imageDataCache'

describe('thumbnail reads', () => {
  const finishes: Array<() => void> = []
  const readThumbnail = vi.fn(
    () => new Promise((resolve) => finishes.push(() => resolve({ success: true, dataUrl: 'data:,', mimeType: 'image/png' })))
  )
  beforeEach(() => {
    _resetImageCache()
    finishes.length = 0
    readThumbnail.mockClear()
    window.api = { files: { readThumbnail } } as never
  })

  it(`run at most ${MAX_THUMBNAIL_READS} at a time, the rest as slots free`, async () => {
    const loads = Array.from({ length: 6 }, (_, i) => loadImage({ type: 'attachment', fileId: `f${i}`, source: 'local' }, 'thumbnail'))
    await Promise.resolve()
    expect(readThumbnail).toHaveBeenCalledTimes(MAX_THUMBNAIL_READS)
    finishes.shift()!()
    await vi.waitFor(() => expect(readThumbnail).toHaveBeenCalledTimes(MAX_THUMBNAIL_READS + 1))
    while (finishes.length) {
      finishes.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect((await Promise.all(loads)).every((load) => load.ok)).toBe(true)
    expect(readThumbnail).toHaveBeenCalledTimes(6)
  })

  it('share one read for the same image', async () => {
    const ref = { type: 'path', path: '/tmp/a.png' } as const
    const both = [loadImage(ref, 'thumbnail'), loadImage(ref, 'thumbnail')]
    await Promise.resolve()
    finishes.shift()!()
    await Promise.all(both)
    expect(readThumbnail).toHaveBeenCalledTimes(1)
  })
})
