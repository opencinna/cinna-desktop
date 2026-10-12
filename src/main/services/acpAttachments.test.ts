import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AcpConnection } from '../agents/drivers/acp/types'
import type { MessageAttachment } from '../../shared/attachments'
const fixtures = vi.hoisted(() => ({ files: new Map<string, string>(), media: vi.fn() }))
vi.mock('./fileStore', () => ({
  attachmentToMediaPart: fixtures.media,
  resolveFileStore: () => ({ read: async ({ attachment }: { attachment: MessageAttachment }) => {
    const text = fixtures.files.get(attachment.id)
    if (text === undefined) throw new Error('not found')
    return { bytes: Buffer.from(text), mimeType: attachment.mimeType, filename: attachment.filename }
  } })
}))
const { buildAcpPrompt, uploadName } = await import('./acpAttachments')
const caps = (image: boolean): AcpConnection => ({ initialized: { agentCapabilities: { promptCapabilities: { image, embeddedContext: true } } } }) as AcpConnection
const pdf = (id: string, filename = 'LTX API Receipt_59,50_USD.pdf'): MessageAttachment => ({ id, filename, mimeType: 'application/pdf', size: 4, source: 'local' })
let uploads: string
beforeEach(() => { vi.clearAllMocks(); fixtures.files.clear(); uploads = join(mkdtempSync(join(tmpdir(), 'cinna-acp-att-')), 'uploads') })
afterEach(() => rmSync(join(uploads, '..'), { recursive: true, force: true }))

describe('ACP attachments into an uploads folder', () => {
  it('sends the text alone when nothing is attached', async () => {
    expect(await buildAcpPrompt('u', { wireContent: 'hi' }, caps(true), uploads)).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('copies a PDF there and lists its path, never a blob resource', async () => {
    fixtures.files.set('a', '%PDF-1')
    const prompt = await buildAcpPrompt('u', { wireContent: 'read this', attachments: [pdf('a')] }, caps(true), uploads)
    const path = join(uploads, 'LTX_API_Receipt_59,50_USD.pdf')
    expect(prompt).toEqual([{ type: 'text', text: `Uploaded files:\n- ${path}\n---\n\nread this` }])
    expect(readFileSync(path, 'utf8')).toBe('%PDF-1')
    expect(fixtures.media).not.toHaveBeenCalled()
  })

  it('reuses a file with the same bytes and suffixes a different one', async () => {
    fixtures.files.set('a', 'one'); fixtures.files.set('b', 'two')
    await buildAcpPrompt('u', { wireContent: 'x', attachments: [pdf('a', 'r.pdf')] }, caps(false), uploads)
    const again = await buildAcpPrompt('u', { wireContent: 'x', attachments: [pdf('a', 'r.pdf'), pdf('b', 'r.pdf')] }, caps(false), uploads)
    expect((again[0] as { text: string }).text).toContain(`- ${join(uploads, 'r.pdf')}\n- ${join(uploads, 'r_1.pdf')}\n`)
    expect(readdirSync(uploads).sort()).toEqual(['r.pdf', 'r_1.pdf'])
    expect(readFileSync(join(uploads, 'r_1.pdf'), 'utf8')).toBe('two')
  })

  it('also sends an image natively when the engine takes images', async () => {
    fixtures.files.set('i', 'png')
    const image: MessageAttachment = { id: 'i', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local' }
    expect(await buildAcpPrompt('u', { wireContent: 'x', attachments: [image] }, caps(true), uploads)).toContainEqual({ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' })
    expect(await buildAcpPrompt('u', { wireContent: 'x', attachments: [image] }, caps(false), uploads)).toHaveLength(1)
  })

  it('names an unreadable file instead of dropping it', async () => {
    const prompt = await buildAcpPrompt('u', { wireContent: 'x', attachments: [pdf('missing', 'gone.pdf')] }, caps(true), uploads)
    expect(prompt).toEqual([{ type: 'text', text: 'Uploaded files:\n- gone.pdf (could not be read by this runtime)\n---\n\nx' }])
  })

  it('keeps a hostile name inside the folder and a non-Latin one readable', async () => {
    expect(uploadName('../../etc/passwd')).toBe('etcpasswd')
    expect(uploadName('.hidden')).toBe('hidden')
    expect(uploadName('Счёт  2026.pdf')).toBe('Счёт_2026.pdf')
    fixtures.files.set('h', 'x')
    await buildAcpPrompt('u', { wireContent: 'x', attachments: [pdf('h', '../../escape.pdf')] }, caps(false), uploads)
    expect(readdirSync(uploads)).toEqual(['escape.pdf'])
  })
})

describe('ACP attachments inline, for an engine that cannot open files', () => {
  it('sends extracted text and copies nothing', async () => {
    fixtures.media.mockResolvedValue({ kind: 'text', text: 'Invoice 42', mimeType: 'application/pdf' })
    const prompt = await buildAcpPrompt('u', { wireContent: 'read', attachments: [pdf('a', 'r.pdf')] }, caps(true), null)
    expect(prompt).toEqual([{ type: 'text', text: 'read' }, { type: 'text', text: '[Attachment: r.pdf]\nInvoice 42' }])
    expect(fixtures.media).toHaveBeenCalledWith(pdf('a', 'r.pdf'), expect.objectContaining({ userId: 'u', nativeMimeTypes: [] }))
    expect(() => readdirSync(uploads)).toThrow()
  })

  it('sends an image natively and marks what it cannot read', async () => {
    const image: MessageAttachment = { id: 'i', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local' }
    fixtures.media.mockResolvedValueOnce({ kind: 'image', bytes: Buffer.from('png'), mimeType: 'image/png' }).mockResolvedValueOnce(null)
    const prompt = await buildAcpPrompt('u', { wireContent: 'x', attachments: [image, pdf('z', 'z.bin')] }, caps(true), null)
    expect(prompt).toContainEqual({ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' })
    expect(prompt).toContainEqual({ type: 'text', text: '[Attachment z.bin could not be read by this runtime.]' })
  })
})
