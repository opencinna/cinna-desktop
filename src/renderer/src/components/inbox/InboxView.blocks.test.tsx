import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEntry, InboxSnapshot } from '../../../../shared/inbox'

/**
 * The inbox renders the **transcript's own** ask components — the assertion the
 * phase asks for by name, made the only way that proves it: by mocking the
 * modules `MessageStream` imports from and watching them be the ones that
 * render.
 *
 * An ask has one rendering in this app. A second one would be a second place
 * for *Always allow* to promise something, and the two would drift the first
 * time either was touched — which is the failure this file exists to make
 * impossible to ship quietly.
 */

const captured = vi.hoisted(() => ({
  permission: null as Record<string, unknown> | null,
  question: null as Record<string, unknown> | null
}))

vi.mock('../chat/PermissionRequestBlock', () => ({
  PermissionRequestBlock: (props: Record<string, unknown>) => {
    captured.permission = props
    return createElement('div', { 'data-testid': 'permission-block' })
  }
}))

vi.mock('../chat/AskUserQuestionBlock', () => ({
  AskUserQuestionBlock: (props: Record<string, unknown>) => {
    captured.question = props
    return createElement('div', { 'data-testid': 'question-block' })
  }
}))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: {
    list: async (): Promise<InboxSnapshot> => ({ entries, unreadable: [] }),
    answer: async () => ({ ok: true })
  },
  // The screen's second half; covered in `RecentTasks.test.tsx`.
  tasks: { list: async () => [] },
  agents: {
    list: async () => [{ id: 'a1', name: 'Invoice Checker' }],
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

let entries: InboxEntry[] = []

const { InboxView } = await import('./InboxView')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  captured.permission = null
  captured.question = null
})

describe('InboxView — the blocks it renders', () => {
  it('hands a permission ask to PermissionRequestBlock, live and by request id', async () => {
    entries = [
      {
        requestId: 'per_1',
        source: 'local',
        taskId: 't1',
        taskTitle: 'Nightly check',
        chatId: 'c1',
        agentId: 'a1',
        request: {
          kind: 'permission',
          action: 'bash',
          resources: ['rm -rf build'],
          callId: 'call_9'
        },
        resume: 'reply',
        createdAt: new Date('2026-09-11T10:00:00Z')
      }
    ]
    render(createElement(InboxView), { wrapper })
    await screen.findByTestId('permission-block')
    expect(captured.permission).toEqual({
      // `savable` is OpenCode's `save[]`, which the block documents as
      // deliberately unread — an `InputRequest` does not carry it and nothing
      // here invents one.
      request: { action: 'bash', resources: ['rm -rf build'], savable: [], callId: 'call_9' },
      requestId: 'per_1',
      interactive: true,
      onAnswer: expect.any(Function)
    })
  })

  it('hands a question to AskUserQuestionBlock as a parked ask, not a composer turn', async () => {
    entries = [
      {
        requestId: 'que_1',
        source: 'local',
        taskId: 't2',
        taskTitle: 'Weekly digest',
        chatId: 'c2',
        agentId: 'a1',
        request: {
          kind: 'question',
          questions: [
            { question: 'Which invoice?', multiSelect: false, options: [{ label: 'The first' }] }
          ]
        },
        resume: 'reply',
        createdAt: new Date('2026-09-11T09:00:00Z')
      }
    ]
    render(createElement(InboxView), { wrapper })
    await screen.findByTestId('question-block')
    // `interactive: false` with a `liveRequestId` is the parked path — answered
    // by id, through the driver. `interactive: true` would route the answer
    // through the composer of a chat the user is not even looking at, and send
    // the agent a second prompt while the first turn was still waiting.
    expect(captured.question).toEqual({
      questions: [
        { question: 'Which invoice?', multiSelect: false, options: [{ label: 'The first' }] }
      ],
      interactive: false,
      chatId: 'c2',
      liveRequestId: 'que_1',
      onAnswerLocal: expect.any(Function)
    })
  })
})
