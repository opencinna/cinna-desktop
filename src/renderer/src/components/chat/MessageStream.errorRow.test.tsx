const openExternal = vi.hoisted(() => vi.fn(async (_url: string): Promise<{ success: boolean; error?: string }> => ({ success: true })))
vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} }, system: { openExternal } } }) })
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * An `error` row whose failure carried a provider's error body.
 *
 * An Antigravity turn that hit Gemini's free-tier quota saved the whole
 * `Internal error: … HTTP 429: [{ "error": { … } }]` blob as the row's `short`,
 * and the bubble drew it as its one-line headline. Pinned here: a row main
 * saved with a `title` shows that title and the provider's message in full,
 * a row saved before main did is read the same way, and an ordinary error is
 * drawn exactly as it was.
 */

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./transcriptAnchor', () => ({ holdCollapseAnchor: () => () => {} }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

const MESSAGE =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-flash\nPlease retry in 33.54910668s.'
const BODY = [{ error: {
  code: 429,
  message: MESSAGE,
  status: 'RESOURCE_EXHAUSTED',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '33s' }
  ]
} }]
/** As the Antigravity failure was stored: the same blob as `short` and `detail`. */
const BLOB = `Internal error: Provider request failed with HTTP 429: ${JSON.stringify(BODY, null, 2)}`
const PRETTY = `Internal error: Provider request failed with HTTP 429:\n${JSON.stringify(BODY, null, 2)}`

beforeEach(() => {
  data.messages = []
  openExternal.mockClear()
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

/** The `<p>` holding the provider's message, whose text spans its links. */
const messageParagraph = (): HTMLElement =>
  screen.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith('You exceeded your current quota'))

describe('an error row carrying a provider error', () => {
  it('reads a row saved before main extracted it: title, full message, no second wait', () => {
    // Mutation: drop the render-time `describeProviderError` fallback → the
    // blob is the headline again and none of these is on screen.
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: BLOB, detail: BLOB }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Quota or rate limit exceeded (429)')).toBeTruthy()
    expect(messageParagraph().textContent).toBe(MESSAGE)
    // The message already says "Please retry in 33.5…s": no line repeating it.
    // Mutation: drop the /retry in/ check → "Provider asked to wait 33s" too.
    expect(screen.queryByText(/Provider asked to wait/)).toBeNull()
    // The blob is no longer anywhere in the collapsed bubble.
    expect(screen.queryByText(/RESOURCE_EXHAUSTED/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === PRETTY)).toBeTruthy()
  })

  it('renders a row main saved with a title the same way', () => {
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: MESSAGE, detail: PRETTY, title: 'Quota or rate limit exceeded (429)', retryAfterSec: 33 }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Quota or rate limit exceeded (429)')).toBeTruthy()
    expect(messageParagraph().textContent).toBe(MESSAGE)
    expect(screen.queryByText(/Provider asked to wait/)).toBeNull()
  })

  it('shows the wait the provider asked for when its message does not say it', () => {
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: 'You exceeded your current quota.', detail: PRETTY, title: 'Quota or rate limit exceeded (429)', retryAfterSec: 33 }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('Provider asked to wait 33s')).toBeTruthy()
  })

  it('leaves a coded row without a title as Cinna wrote it', () => {
    // Mutation: run the render-time fallback on coded rows → a provider title.
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: BLOB, detail: BLOB, code: 'reply_cut_off' }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.queryByText('Quota or rate limit exceeded (429)')).toBeNull()
  })

  it('says so when a link fails to open', async () => {
    // Mutation: drop the result → the click fails silently.
    openExternal.mockResolvedValueOnce({ success: false, error: 'open_failed' })
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: MESSAGE, detail: PRETTY, title: 'Quota or rate limit exceeded (429)' }) }]
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getByRole('link', { name: 'https://ai.dev/rate-limit' }))
    await waitFor(() => expect(screen.getByText(/^Couldn.t open the link: /)).toBeTruthy())
  })

  it('opens the message’s links in the browser, without the sentence’s full stop', () => {
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: MESSAGE, detail: PRETTY, title: 'Quota or rate limit exceeded (429)' }) }]
    render(<MessageStream chatId="chat" />)
    const link = screen.getByRole('link', { name: 'https://ai.dev/rate-limit' })
    fireEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://ai.dev/rate-limit')
    expect(screen.getByRole('link', { name: 'https://ai.google.dev/gemini-api/docs/rate-limits' })).toBeTruthy()
    // No wait was saved, so no retry line.
    expect(screen.queryByText(/Provider asked to wait/)).toBeNull()
  })

  it('draws an ordinary error exactly as before', () => {
    data.messages = [{ id: 'e1', role: 'error', content: JSON.stringify({ short: 'The agent crashed.', detail: 'exit 1' }) }]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('The agent crashed.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText(/Provider asked to wait/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('exit 1')).toBeTruthy()
  })
})
