import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpConnection } from '../agents/drivers/acp/types'
const fixtures = vi.hoisted(() => ({ messages: [] as Record<string, unknown>[], media: vi.fn() }))
vi.mock('../db/chats', () => ({ chatRepo: { listMessages: () => fixtures.messages } }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: fixtures.media }))
const { replayTranscript } = await import('./conductorTranscript')
const connection = { initialized: { agentCapabilities: { promptCapabilities: { image: true } } } } as AcpConnection
const attachment = { id: 'file', filename: 'notes.pdf', mimeType: 'application/pdf', size: 32, source: 'local' }
beforeEach(() => { vi.clearAllMocks(); fixtures.messages = [] })
describe('fresh session transcript', () => {
  it('replays the full attributed conversation and historical PDF text without repeating the current turn', async () => {
    fixtures.messages = [
      { id: 'one', role: 'user', content: 'x'.repeat(5000), attachments: [attachment] },
      { id: 'two', role: 'tool', content: 'specialist answer', sourceAgentId: 'specialist', toolCallId: 'original', toolName: 'delegate' },
      { id: 'current', role: 'user', content: 'continue' }
    ]
    fixtures.media.mockResolvedValue({ kind: 'text', text: 'Extracted PDF', mimeType: 'application/pdf' })
    const blocks = await replayTranscript('chat', 'current', connection, 'profile')
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    expect(text).toContain('x'.repeat(5000))
    expect(text).toContain('[Attachment: notes.pdf]\nExtracted PDF')
    expect(text).toContain('[tool agent=specialist tool_call=original tool=delegate]')
    expect(text).not.toContain('[user]\ncontinue')
    expect(fixtures.media).toHaveBeenCalledWith(attachment, expect.objectContaining({ userId: 'profile', nativeMimeTypes: [] }))
  })
  it('replays historical images as native blocks when supported', async () => {
    fixtures.messages = [{ id: 'one', role: 'user', content: 'image', attachments: [{ ...attachment, mimeType: 'image/png' }] }, { id: 'current', role: 'user', content: 'now' }]
    fixtures.media.mockResolvedValue({ kind: 'image', bytes: Buffer.from('image'), mimeType: 'image/png' })
    expect(await replayTranscript('chat', 'current', connection, 'profile')).toContainEqual({ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' })
  })
})
