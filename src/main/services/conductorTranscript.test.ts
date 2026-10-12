import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AcpConnection } from '../agents/drivers/acp/types'
const fixtures = vi.hoisted(() => ({ messages: [] as Record<string, unknown>[], read: vi.fn() }))
vi.mock('../db/chats', () => ({ chatRepo: { listMessages: () => fixtures.messages, getOwned: () => ({ agentId: 'root' }) } }))
vi.mock('./fileStore', () => ({ resolveFileStore: () => ({ read: fixtures.read }), attachmentToMediaPart: vi.fn() }))
const { replayTranscript } = await import('./conductorTranscript')
const connection = { initialized: { agentCapabilities: { promptCapabilities: { image: true } } } } as AcpConnection
const attachment = { id: 'file', filename: 'notes.pdf', mimeType: 'application/pdf', size: 32, source: 'local' }
let cwd: string
beforeEach(() => { vi.clearAllMocks(); fixtures.messages = []; cwd = mkdtempSync(join(tmpdir(), 'cinna-transcript-')) })
afterEach(() => rmSync(cwd, { recursive: true, force: true }))
describe('fresh session transcript', () => {
  it('replays the full attributed conversation and historical files without repeating the current turn', async () => {
    fixtures.messages = [
      { id: 'one', role: 'user', content: 'x'.repeat(5000), attachments: [attachment] },
      { id: 'two', role: 'tool', content: 'specialist answer', sourceAgentId: 'specialist', toolCallId: 'original', toolName: 'delegate' },
      { id: 'current', role: 'user', content: 'continue' }
    ]
    fixtures.read.mockResolvedValue({ bytes: Buffer.from('%PDF'), mimeType: 'application/pdf', filename: 'notes.pdf' })
    const blocks = await replayTranscript('chat', 'current', connection, 'profile', 'root', join(cwd, 'app-data', 'uploads'))
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    const path = join(cwd, 'app-data', 'uploads', 'notes.pdf')
    expect(text).toContain('x'.repeat(5000))
    expect(text).toContain(`Uploaded files:\n- ${path}\n---`)
    expect(readFileSync(path, 'utf8')).toBe('%PDF')
    expect(text).toContain('[tool agent=specialist tool_call=original tool=delegate]')
    expect(text).not.toContain('[user]\ncontinue')
    expect(fixtures.read).toHaveBeenCalledWith({ userId: 'profile', attachment })
  })
  it('leaves a participant to its catch-up packet', async () => {
    fixtures.messages = [{ id: 'one', role: 'user', content: 'earlier' }, { id: 'current', role: 'user', content: 'now' }]
    expect(await replayTranscript('chat', 'current', connection, 'profile', 'participant', null)).toEqual([])
  })
  it('replays historical images as native blocks when supported', async () => {
    fixtures.messages = [{ id: 'one', role: 'user', content: 'image', attachments: [{ ...attachment, filename: 'a.png', mimeType: 'image/png' }] }, { id: 'current', role: 'user', content: 'now' }]
    fixtures.read.mockResolvedValue({ bytes: Buffer.from('image'), mimeType: 'image/png', filename: 'a.png' })
    expect(await replayTranscript('chat', 'current', connection, 'profile', 'root', join(cwd, 'app-data', 'uploads'))).toContainEqual({ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' })
  })
})
