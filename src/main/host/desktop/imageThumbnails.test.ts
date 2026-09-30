import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: vi.fn() } }))
import { nativeImageThumbnail } from './imageThumbnails'

function fakeImage(width: number, height: number, empty = false) {
  const resized: Array<{ width: number; height: number }> = []
  const image = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: (size: { width: number; height: number }) => (resized.push(size), image),
    toPNG: () => Buffer.from('png'),
    toJPEG: () => Buffer.from('jpeg')
  }
  return { image: image as unknown as Electron.NativeImage, resized }
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1])

describe('nativeImageThumbnail', () => {
  it('fits the longer side, keeps PNG for a PNG and JPEG otherwise', () => {
    const wide = fakeImage(1600, 800)
    expect(nativeImageThumbnail(PNG, 160, () => wide.image)).toEqual({ bytes: Buffer.from('png'), mimeType: 'image/png' })
    expect(wide.resized).toMatchObject([{ width: 160, height: 80 }])
    expect(nativeImageThumbnail(JPEG, 160, () => fakeImage(300, 600).image)?.mimeType).toBe('image/jpeg')
  })

  it('never enlarges a small image', () => {
    const tiny = fakeImage(40, 30)
    nativeImageThumbnail(PNG, 160, () => tiny.image)
    expect(tiny.resized).toEqual([])
  })

  it('returns null for bytes it cannot decode', () => {
    expect(nativeImageThumbnail(PNG, 160, () => fakeImage(0, 0, true).image)).toBeNull()
    expect(nativeImageThumbnail(PNG, 160, () => { throw new Error('bad') })).toBeNull()
  })
})
