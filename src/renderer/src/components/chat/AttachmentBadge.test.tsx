import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { AttachmentList } from './AttachmentBadge'
import { AgentAttachment } from './AgentAttachment'
import { THUMBNAIL_SIZE } from './AttachmentThumbnail'
import { _resetImageCache, attachmentImageRef, carryIngestedImages } from '../../utils/imageDataCache'

/** A badge is named for what its click does: the in-app preview, or a download. */

const files = [
  { id: 'a', filename: 'notes.md', size: 10, mimeType: 'text/markdown' },
  { id: 'b', filename: 'report.html', size: 10, mimeType: 'text/html' },
  { id: 'c', filename: 'archive.zip', size: 10, mimeType: 'application/zip' },
  // Named by its MIME type only.
  { id: 'd', filename: 'data', size: 10, mimeType: 'application/json' }
]

const names = (): string[] => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')

describe('attachment badge names', () => {
  it('say Preview for a file the click previews, and Download for the rest', () => {
    render(<AttachmentList attachments={files} variant="message" onClick={() => {}} previewsOnClick />)
    expect(names()).toEqual(['Preview notes.md', 'Preview report.html', 'Download archive.zip', 'Preview data'])
    expect(screen.getByRole('button', { name: 'Preview notes.md' }).getAttribute('title')).toBe('Preview notes.md (10 B)')
    expect(screen.getByRole('button', { name: 'Download archive.zip' }).getAttribute('title')).toBe(
      'Download archive.zip (10 B)'
    )
  })

  it('say Download for every file in a list whose click always downloads', () => {
    render(<AttachmentList attachments={files} variant="message" onClick={() => {}} />)
    expect(names()).toEqual(['Download notes.md', 'Download report.html', 'Download archive.zip', 'Download data'])
  })

  it("follow an agent's attachment the same way", () => {
    render(<AgentAttachment file={{ fileId: 'f1', filename: 'feed.xml', mimeType: 'application/xml', size: 0 }} />)
    expect(screen.getByRole('button', { name: 'Preview feed.xml' })).toBeTruthy()
  })
})

describe('image thumbnails', () => {
  const shot = { id: 'img-1', filename: 'shot.png', size: 2048, mimeType: 'image/png', source: 'local' as const }
  const doc = { id: 'doc-1', filename: 'notes.md', size: 10, mimeType: 'text/markdown', source: 'local' as const }
  let readThumbnail: ReturnType<typeof vi.fn>
  let readImage: ReturnType<typeof vi.fn>
  beforeEach(() => {
    _resetImageCache()
    readThumbnail = vi.fn()
    readImage = vi.fn()
    window.api = { files: { readThumbnail, readImage } } as never
  })
  const box = (): HTMLElement => screen.getByTestId('attachment-thumbnail')
  const expectFixedBox = (): void => {
    expect(box().style.width).toBe(`${THUMBNAIL_SIZE}px`)
    expect(box().style.height).toBe(`${THUMBNAIL_SIZE}px`)
  }

  it('hold a fixed box from the first paint, a placeholder until the small image arrives, and come before badges', async () => {
    let finish!: (value: unknown) => void
    readThumbnail.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const onClick = vi.fn()
    render(<AttachmentList attachments={[doc, shot]} variant="message" onClick={onClick} previewsOnClick thumbnailFor={attachmentImageRef} />)
    expectFixedBox()
    expect(box().dataset.state).toBe('loading')
    expect(box().querySelector('img')).toBeNull()
    expect(names()).toEqual(['Preview shot.png', 'Preview notes.md'])
    await act(async () => finish({ success: true, dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' }))
    expect(box().querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
    expectFixedBox()
    // The thumbnail read, never the full image.
    expect(readThumbnail).toHaveBeenCalledWith({ fileId: 'img-1', source: 'local' })
    expect(readImage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png' }))
    expect(onClick).toHaveBeenCalledWith(shot)
  })

  it('keep the box with a broken-image icon when main refuses the image, never turning into a badge', async () => {
    readThumbnail.mockResolvedValue({ success: false, error: 'No thumbnail for this image.' })
    render(<AttachmentList attachments={[shot]} variant="message" onClick={() => {}} previewsOnClick thumbnailFor={attachmentImageRef} />)
    await act(async () => {})
    expect(box().dataset.state).toBe('failed')
    expectFixedBox()
    expect(box().querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview shot.png' }).getAttribute('title')).toContain('shot.png')
  })

  it('show the same failed box when the bytes do not decode', async () => {
    readThumbnail.mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    render(<AttachmentList attachments={[shot]} variant="message" onClick={() => {}} thumbnailFor={attachmentImageRef} />)
    await act(async () => {})
    fireEvent.error(box().querySelector('img')!)
    expect(box().dataset.state).toBe('failed')
    expect(box().querySelector('img')).toBeNull()
    expectFixedBox()
  })

  it('are reused from the cache on a remount, with no second read', async () => {
    readThumbnail.mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    const first = render(<AttachmentList attachments={[shot]} variant="message" onClick={() => {}} thumbnailFor={attachmentImageRef} />)
    await act(async () => {})
    first.unmount()
    render(<AttachmentList attachments={[shot]} variant="message" onClick={() => {}} thumbnailFor={attachmentImageRef} />)
    expect(box().querySelector('img')).toBeTruthy()
    expect(readThumbnail).toHaveBeenCalledTimes(1)
  })

  it('read a composer file not sent yet by its path, with a remove button beside the preview one', async () => {
    readThumbnail.mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    const pending = { id: '/tmp/Pasted image.png', filename: 'Pasted image.png', size: 5, mimeType: 'image/png', source: 'pending' as const }
    const onRemove = vi.fn()
    render(<AttachmentList attachments={[pending]} variant="input" onClick={() => {}} onRemove={onRemove} thumbnailFor={attachmentImageRef} />)
    await act(async () => {})
    expect(readThumbnail).toHaveBeenCalledWith({ path: '/tmp/Pasted image.png' })
    const remove = screen.getByRole('button', { name: 'Remove Pasted image.png' })
    expect(remove.getAttribute('title')).toBe('Remove Pasted image.png')
    expect(remove.parentElement?.closest('button')).toBeNull()
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith('/tmp/Pasted image.png')
  })

  it('carry over from the composer path to the sent attachment, with no placeholder and no read', async () => {
    readThumbnail.mockResolvedValue({ success: true, dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    const pending = { id: '/tmp/p.png', filename: 'p.png', size: 5, mimeType: 'image/png', source: 'pending' as const }
    const composer = render(<AttachmentList attachments={[pending]} variant="input" thumbnailFor={attachmentImageRef} />)
    await act(async () => {})
    composer.unmount()
    const sent = { id: 'chat-file-1', filename: 'p.png', size: 5, mimeType: 'image/png', source: 'local' as const }
    carryIngestedImages([pending], [sent])
    render(<AttachmentList attachments={[sent]} variant="message" onClick={() => {}} thumbnailFor={attachmentImageRef} />)
    expect(box().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(readThumbnail).toHaveBeenCalledTimes(1)
  })

  it('stay badges in a list that asks for none (task attachments)', () => {
    render(<AttachmentList attachments={[shot]} variant="message" onClick={() => {}} />)
    expect(screen.queryByTestId('attachment-thumbnail')).toBeNull()
    expect(readThumbnail).not.toHaveBeenCalled()
  })
})

describe('composer badges', () => {
  const doc = { id: '/tmp/notes.md', filename: 'notes.md', size: 10, mimeType: 'text/markdown' }
  const zip = { id: '/tmp/a.zip', filename: 'a.zip', size: 10, mimeType: 'application/zip' }

  it('open a file the preview can show, with the remove button a sibling rather than nested', () => {
    const onClick = vi.fn()
    const onRemove = vi.fn()
    render(
      <AttachmentList
        attachments={[doc, zip]}
        variant="input"
        onClick={onClick}
        onRemove={onRemove}
        canClick={(a) => a.filename !== 'a.zip'}
        previewsOnClick
      />
    )
    const preview = screen.getByRole('button', { name: 'Preview notes.md' })
    const remove = screen.getByRole('button', { name: 'Remove notes.md' })
    expect(remove.getAttribute('title')).toBe('Remove notes.md')
    expect(preview.contains(remove)).toBe(false)
    expect(remove.parentElement?.closest('button')).toBeNull()
    fireEvent.click(preview)
    expect(onClick).toHaveBeenCalledWith(doc)
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith('/tmp/notes.md')
    expect(onClick).toHaveBeenCalledTimes(1)
    // Not previewable: not clickable, still removable.
    expect(screen.queryByRole('button', { name: /^(Preview|Download) a\.zip$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove a.zip' })).toBeTruthy()
  })
})
