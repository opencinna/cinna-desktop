import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../stores/fileDownload.store', () => ({
  useFileDownloadStore: (select: (s: { download: () => void; downloadingIds: Set<string> }) => unknown) =>
    select({ download: () => {}, downloadingIds: new Set() })
}))

import { FilePreviewModal } from './FilePreviewModal'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { _resetImageCache } from '../../utils/imageDataCache'

/**
 * Images preview in the modal; a composer file previews without a Download,
 * by its path when it is not sent yet; a newer open always wins.
 */

const readImage = vi.fn()
const readPreview = vi.fn()
const readPreviewPath = vi.fn()
let decodes: Array<() => void>

beforeEach(() => {
  _resetImageCache()
  readImage.mockReset()
  readPreview.mockReset()
  readPreviewPath.mockReset()
  window.api = { files: { readImage, readPreview, readPreviewPath } } as never
  decodes = []
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: () => new Promise<void>((resolve) => decodes.push(resolve))
  })
})
afterEach(() => {
  act(() => useFilePreviewStore.getState().close())
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode
})

const shot = { id: 'att-1', filename: 'shot.png', size: 10, mimeType: 'image/png', source: 'local' as const }
const flush = (): Promise<void> => act(async () => {})

describe('the image preview', () => {
  it('reads the image as a data URL and settles only once it has decoded', async () => {
    readImage.mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    render(<FilePreviewModal />)
    act(() => void useFilePreviewStore.getState().openPreview(shot, 'image'))
    await flush()
    expect(readImage).toHaveBeenCalledWith({ fileId: 'att-1', source: 'local' })
    // Fetched, not yet decoded: still loading, so the entrance waits for the final card.
    expect(screen.getByText('Loading preview…')).toBeTruthy()
    expect(screen.queryByTestId('image-preview')).toBeNull()
    await act(async () => decodes.forEach((resolve) => resolve()))
    expect(screen.getByTestId('image-preview').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(screen.getByRole('button', { name: 'Download shot.png' })).toBeTruthy()
  })

  it("says why an image over the cap is not shown", async () => {
    readImage.mockResolvedValue({ success: false, error: 'Image too large to preview — download it instead.' })
    render(<FilePreviewModal />)
    act(() => void useFilePreviewStore.getState().openPreview(shot, 'image'))
    await flush()
    expect(screen.getByText("Couldn't load preview: Image too large to preview — download it instead.")).toBeTruthy()
  })

  it('offers no Download for a file opened from the composer', async () => {
    readPreview.mockResolvedValue({ success: true, text: 'hello', truncated: false })
    render(<FilePreviewModal />)
    act(() => void useFilePreviewStore.getState().openPreview({ ...shot, filename: 'a.txt', mimeType: 'text/plain' }, 'text', { composer: true }))
    await flush()
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull()
  })

  it('reads a composer file not sent yet by its path, and drops a slower earlier open', async () => {
    let finishFirst!: (value: unknown) => void
    readPreviewPath
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ success: true, text: 'second', truncated: false })
    render(<FilePreviewModal />)
    const store = useFilePreviewStore.getState()
    act(() => void store.openPathPreview({ path: '/Users/me/first.md', filename: 'first.md', mimeType: 'text/markdown' }, 'text'))
    act(() => void store.openPathPreview({ path: '/Users/me/second.txt', filename: 'second.txt', mimeType: 'text/plain' }, 'text'))
    await flush()
    expect(readPreviewPath).toHaveBeenNthCalledWith(1, { path: '/Users/me/first.md' })
    await act(async () => finishFirst({ success: true, text: 'first', truncated: false }))
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second.txt')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull()
  })

  it('reads a composer image not sent yet by its path', async () => {
    readImage.mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,BBBB', mimeType: 'image/png' })
    render(<FilePreviewModal />)
    act(() => void useFilePreviewStore.getState().openPathPreview({ path: '/tmp/p.png', filename: 'p.png', mimeType: 'image/png' }, 'image'))
    await flush()
    await act(async () => decodes.forEach((resolve) => resolve()))
    expect(readImage).toHaveBeenCalledWith({ path: '/tmp/p.png' })
    expect(screen.getByTestId('image-preview').getAttribute('src')).toBe('data:image/png;base64,BBBB')
  })
})
