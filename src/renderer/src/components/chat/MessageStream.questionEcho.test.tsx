vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart, ToolStream } from '../../../../shared/messageParts'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

const questions = [
  { question: 'Write this to Odoo as shown?', multiSelect: false, options: [{ label: 'Yes, apply with canary first' }] }
]

/**
 * What a Claude agent's answered question persists, in arrival order: the
 * adapter's own call, the desktop's question block, its decision, and the
 * tool's restatement of the answer.
 */
function answeredQuestion(
  opts: {
    callName?: string
    callInput?: Record<string, unknown>
    withCall?: boolean
    recordCall?: boolean
    echoStream?: ToolStream
  } = {}
): MessagePart[] {
  const { callName = 'AskUserQuestion', callInput, withCall = true, recordCall = true, echoStream = 'stdout' } = opts
  return [
    ...(withCall ? [{ kind: 'tool' as const, toolId: 'toolu_ask', toolName: callName, toolInput: callInput, text: callName }] : []),
    {
      kind: 'tool',
      toolId: 'que_acp_1',
      toolName: 'askuserquestion',
      toolInput: recordCall ? { questions, callId: 'toolu_ask' } : { questions },
      text: 'Asked a question.'
    },
    { kind: 'tool_result', toolId: 'que_acp_1', toolStream: 'stdout', text: 'Answered: Yes, apply with canary first.' },
    {
      kind: 'tool_result',
      toolId: 'toolu_ask',
      toolStream: echoStream,
      text: 'Your questions have been answered: "Write this to Odoo as shown?"="Yes, apply with canary first".'
    }
  ]
}

beforeEach(() => {
  data.messages = []
  // Every block inline, so a result that is rendered is never hidden in a group.
  useUIStore.setState({ verboseMode: true })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe("the AskUserQuestion tool's own result", () => {
  it('is folded into the question block it restates', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion() }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('A question asked')).toBeTruthy()
    expect(screen.getByText('Answered: Yes, apply with canary first.')).toBeTruthy()
    expect(screen.queryByText('Output')).toBeNull()
  })

  it('is folded in the compact transcript, leaving no dot behind', () => {
    useUIStore.setState({ verboseMode: false })
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion() }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Answered: Yes, apply with canary first.')).toBeTruthy()
    expect(screen.queryByText('Output')).toBeNull()
    expect(screen.queryByRole('button', { name: /steps?$/ })).toBeNull()
  })

  it('is folded while the turn is still streaming', () => {
    useChatStore.setState({
      isStreaming: true,
      streamingBlocks: answeredQuestion().map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part }))
    })
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Answered: Yes, apply with canary first.')).toBeTruthy()
    expect(screen.queryByText('Output')).toBeNull()
  })

  it('takes the call with it, so a call that kept its questions is not a second card', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion({ callInput: { questions } }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getAllByText('Write this to Odoo as shown?')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('stays when the call that asked was another tool, whose output is its own', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion({ callName: 'mcp__odoo__write' }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Output')).toBeTruthy()
  })

  it('stays when the named call is not in the transcript', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion({ withCall: false }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Output')).toBeTruthy()
  })

  it('stays when the call failed', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion({ echoStream: 'stderr' }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('stderr')).toBeTruthy()
  })

  it('stays on a question persisted without the call it came from', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: answeredQuestion({ recordCall: false }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Output')).toBeTruthy()
  })
})
