import { describe, it, expect } from 'vitest'
import { buildCatchUpPacket, withCatchUp, CATCH_UP_CAP } from './threadContextService'
import type { MessageRow } from '../db/messages'

/**
 * What an agent is told about the part of the conversation it missed.
 *
 * The packet is the substrate a `human`-routed chat stands on: without it,
 * addressing agent B after agent A answered sends B a question about something
 * it has never seen. Pure over rows, so it is tested over rows.
 */

const NAMES = new Map([
  ['a-1', 'Research'],
  ['a-2', 'Builder']
])

let order = 0

function row(over: Partial<MessageRow>): MessageRow {
  return {
    id: `m-${++order}`,
    chatId: 'chat-1',
    role: 'user',
    content: '',
    toolCallId: null,
    toolName: null,
    toolInput: null,
    toolCalls: null,
    toolError: null,
    toolProvider: null,
    toolAgentId: null,
    parts: null,
    attachments: null,
    addressedAgentId: null,
    sourceAgentId: null,
    sortOrder: order,
    createdAt: new Date(),
    ...over
  } as MessageRow
}

const user = (content: string, addressedAgentId: string | null = null): MessageRow =>
  row({ role: 'user', content, addressedAgentId })
const reply = (content: string, sourceAgentId: string): MessageRow =>
  row({ role: 'assistant', content, sourceAgentId })

describe('buildCatchUpPacket', () => {
  it('gives an agent the whole thread on its first turn', () => {
    // No cursor row means "has seen nothing", which is exactly true of an agent
    // brought into a chat that already has a history.
    const messages = [
      user('what changed in the billing code?', 'a-1'),
      reply('Three files, all in invoices/.', 'a-1'),
      user('now implement it', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })
    expect(packet).toContain('[user] what changed in the billing code?')
    expect(packet).toContain('[Research] Three files, all in invoices/.')
    // The message being sent right now is addressed to this agent, so it is not
    // part of what it missed — it is what it is being asked.
    expect(packet).not.toContain('now implement it')
  })

  it('says nothing when the agent has missed nothing', () => {
    const first = user('hello', 'a-1')
    const answer = reply('hi', 'a-1')
    const packet = buildCatchUpPacket({
      messages: [first, answer, user('and again', 'a-1')],
      agentId: 'a-1',
      cursorMessageId: answer.id,
      names: NAMES
    })
    // Null, not an empty string: the caller sends the user's text unchanged
    // rather than with an empty preamble on top of it.
    expect(packet).toBeNull()
    expect(withCatchUp(packet, 'and again')).toBe('and again')
  })

  it('carries the gap from the cursor forward', () => {
    const seen = reply('I looked at the schema.', 'a-2')
    const messages = [
      user('take a look', 'a-2'),
      seen,
      user('what did the other one say?', 'a-1'),
      reply('It said the schema is fine.', 'a-1'),
      user('and you?', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: seen.id,
      names: NAMES
    })
    expect(packet).toContain('[user] what did the other one say?')
    expect(packet).toContain('[Research] It said the schema is fine.')
    expect(packet).not.toContain('I looked at the schema.')
  })

  it('drops the agent’s own turns out of a gap that contains them', () => {
    // Two ways this happens for real, and neither is exotic: a chat that
    // existed before there were cursors has none for the agent that has been
    // answering in it, and a **stopped** turn persists what it streamed without
    // advancing the cursor. Both leave the agent's own words inside its own
    // gap, where its session already holds them.
    const messages = [
      user('take a look', 'a-2'),
      reply('I looked at the schema.', 'a-2'),
      user('what did the other one say?', 'a-1'),
      reply('It said the schema is fine.', 'a-1'),
      user('and you?', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })
    expect(packet).toContain('[Research] It said the schema is fine.')
    // Its own reply, and the message that prompted it.
    expect(packet).not.toContain('I looked at the schema.')
    expect(packet).not.toContain('take a look')
  })

  it('names a tool without repeating its payload', () => {
    const messages = [
      user('go', 'a-1'),
      row({
        role: 'tool_call',
        content: 'wrote 412 lines',
        toolName: 'write',
        toolAgentId: 'a-1',
        toolInput: { filePath: '/tmp/x', content: 'x'.repeat(5000) }
      }),
      row({ role: 'tool_call', content: '', toolName: 'bash', toolAgentId: 'a-1', toolError: true }),
      user('your turn', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })
    expect(packet).toContain('[Research] used write')
    expect(packet).toContain('[Research] used bash (failed)')
    expect(packet).not.toContain('xxxx')
  })

  it('carries an agent_transition notice and drops an error row', () => {
    const messages = [
      row({ role: 'agent_transition', content: 'Switched to the review agent.', sourceAgentId: 'a-1' }),
      row({ role: 'error', content: JSON.stringify({ short: 'Could not reach the agent.' }) }),
      user('your turn', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })
    expect(packet).toContain('[note] Switched to the review agent.')
    // A stream that dropped is not something that happened in the conversation,
    // and its content is a JSON envelope.
    expect(packet).not.toContain('Could not reach')
  })

  it('names attachments without their bytes', () => {
    const messages = [
      row({
        role: 'user',
        content: 'here it is',
        attachments: [
          { id: 'f1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 10, source: 'cinna' },
          { id: 'f2', filename: 'notes.md', mimeType: 'text/markdown', size: 3, source: 'cinna' }
        ] as MessageRow['attachments']
      }),
      user('your turn', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })
    expect(packet).toContain('[user] here it is (attached: invoice.pdf, notes.md)')
  })

  it('drops the oldest lines when the cap is exceeded, and says so', () => {
    const messages = [
      ...Array.from({ length: 40 }, (_, i) => reply(`${i}:${'x'.repeat(300)}`, 'a-1')),
      user('your turn', 'a-2')
    ]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })!
    expect(packet.length).toBeLessThan(CATCH_UP_CAP + 400)
    expect(packet).toContain('[…earlier messages dropped to fit]')
    // The newest survives, the oldest does not: what the next agent most needs
    // is what was just said.
    expect(packet).toContain('39:')
    expect(packet).not.toContain('\n[Research] 0:')
  })

  it('replays the whole thread when the cursor names a message the chat no longer has', () => {
    // The safe side of the failure: re-reading context costs tokens, missing the
    // message the agent is being asked about costs the answer.
    const messages = [reply('Three files.', 'a-1'), user('your turn', 'a-2')]
    const packet = buildCatchUpPacket({
      messages,
      agentId: 'a-2',
      cursorMessageId: 'm-does-not-exist',
      names: NAMES
    })
    expect(packet).toContain('[Research] Three files.')
  })

  it('labels an agent it has no name for without dropping what it said', () => {
    const packet = buildCatchUpPacket({
      messages: [reply('I checked.', 'a-9'), user('your turn', 'a-2')],
      agentId: 'a-2',
      cursorMessageId: null,
      names: NAMES
    })
    expect(packet).toContain('[agent] I checked.')
  })
})

describe('withCatchUp', () => {
  it('puts the packet in front of the user’s text', () => {
    expect(withCatchUp('CONTEXT', 'do the thing')).toBe('CONTEXT\n\ndo the thing')
  })
})
