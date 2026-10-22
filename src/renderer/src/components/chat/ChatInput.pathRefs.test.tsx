import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunStartResult } from '../../../../shared/ipcPayloads'
import type { ComposerPathRef } from '../../../../shared/pathMentions'

/**
 * Reference chips ("Mention in Cinna", Reference in a new chat): shown in the
 * attachment row, removable, counted as content for Send, sent as lines naming
 * each path on both send paths, and cleared only once the send is dispatched.
 */

const run = vi.hoisted(() => ({
  start: vi.fn(async (): Promise<RunStartResult> => ({ kind: 'queued', queuedId: 'q-1' }))
}))

function namespace(methods: Record<string, unknown> = {}): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target ? target[method] : method.startsWith('on') ? () => () => undefined : async () => []
  })
}
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  { get: (_t, ns: string) => (ns === 'run' ? namespace(run) : namespace()) }
)

const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useComposerDraftStore, composerDraftKey } = await import('../../stores/composerDraft.store')

const NEW_DRAFT = composerDraftKey(undefined, 'dashboard')
const CHAT_DRAFT = composerDraftKey(undefined, 'chat:chat-1')
const FOLDER: ComposerPathRef = { path: '/Users/me/Projects/site', displayPath: '~/Projects/site', kind: 'dir' }
const FILE: ComposerPathRef = { path: '/Users/me/notes/plan.md', displayPath: '~/notes/plan.md', kind: 'file' }

function wrapperWith(client: QueryClient) {
  return ({ children }: { children: ReactNode }): React.JSX.Element => createElement(QueryClientProvider, { client }, children)
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
}

function mountChat(): void {
  const client = newClient()
  client.setQueryData(['chat', 'chat-1'], {
    id: 'chat-1', router: 'direct', agentId: null, modeId: null, providerId: null, modelId: null, messages: [], activeRunId: null
  })
  render(createElement(ChatInput, { chatId: 'chat-1' }), { wrapper: wrapperWith(client) })
}

const box = (): HTMLTextAreaElement => screen.getByRole('combobox') as HTMLTextAreaElement
const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
const chips = (key: string): ComposerPathRef[] | undefined => useComposerDraftStore.getState().drafts[key]?.pathRefs

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.getState().reset()
  useComposerDraftStore.setState({ drafts: {} })
})

describe('reference chips', () => {
  it('render as the basename with the display path as tooltip, and the X removes one', () => {
    useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [FOLDER, FILE] }))
    render(createElement(ChatInput, { chatId: null, onNewChat: vi.fn() }), { wrapper: wrapperWith(newClient()) })
    const badges = screen.getAllByTestId('path-ref-badge')
    expect(badges.map((badge) => badge.textContent)).toEqual(['site', 'plan.md'])
    expect(badges.map((badge) => badge.getAttribute('title'))).toEqual(['~/Projects/site', '~/notes/plan.md'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove site' }))
    expect(screen.getAllByTestId('path-ref-badge').map((badge) => badge.textContent)).toEqual(['plan.md'])
    expect(chips(NEW_DRAFT)).toEqual([FILE])
  })

  it('cut a long name like an attachment, keeping the extension, and name the X in its tooltip', () => {
    const long: ComposerPathRef = { path: '/w/quarterly-financial-report-final.xlsx', displayPath: '/w/quarterly-financial-report-final.xlsx', kind: 'file' }
    useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [long] }))
    render(createElement(ChatInput, { chatId: null, onNewChat: vi.fn() }), { wrapper: wrapperWith(newClient()) })
    expect(screen.getByTestId('path-ref-badge').textContent).toBe('quarterly-financia….xlsx')
    const remove = screen.getByRole('button', { name: 'Remove quarterly-financial-report-final.xlsx' })
    expect(remove.getAttribute('title')).toBe('Remove quarterly-financial-report-final.xlsx')
  })

  it('count as content: Send is enabled on the new-chat screen with chips and no text', () => {
    render(createElement(ChatInput, { chatId: null, onNewChat: vi.fn() }), { wrapper: wrapperWith(newClient()) })
    expect(sendButton().disabled).toBe(true)
    act(() => useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [FILE] })))
    expect(sendButton().disabled).toBe(false)
  })

  it('start a new chat with the text, a blank line and one line per chip, then clear', async () => {
    useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [FOLDER, FILE] }))
    const onNewChat = vi.fn(async () => true)
    render(createElement(ChatInput, { chatId: null, onNewChat }), { wrapper: wrapperWith(newClient()) })
    fireEvent.change(box(), { target: { value: 'Look at these' } })
    fireEvent.keyDown(box(), { key: 'Enter' })

    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    expect((onNewChat.mock.calls[0] as unknown[])[0]).toBe(
      'Look at these\n\nReferenced folder: `/Users/me/Projects/site`\nReferenced file: `/Users/me/notes/plan.md`'
    )
    await waitFor(() => expect(chips(NEW_DRAFT)).toEqual([]))
    expect(screen.queryByTestId('path-ref-badge')).toBeNull()
  })

  it('send chips alone as just the lines', async () => {
    useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [FILE] }))
    const onNewChat = vi.fn(async () => true)
    render(createElement(ChatInput, { chatId: null, onNewChat }), { wrapper: wrapperWith(newClient()) })
    fireEvent.click(sendButton())
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    expect((onNewChat.mock.calls[0] as unknown[])[0]).toBe('Referenced file: `/Users/me/notes/plan.md`')
  })

  it('stay when the new chat could not be started', async () => {
    useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [FILE] }))
    const onNewChat = vi.fn(async () => false)
    render(createElement(ChatInput, { chatId: null, onNewChat }), { wrapper: wrapperWith(newClient()) })
    fireEvent.change(box(), { target: { value: 'Hi' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(chips(NEW_DRAFT)).toEqual([FILE])
    expect(box().value).toBe('Hi')
  })

  it('keep only the chips added while the new chat was being started, not the ones sent', async () => {
    useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [FILE] }))
    let finish!: (sent: boolean) => void
    const onNewChat = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    render(createElement(ChatInput, { chatId: null, onNewChat }), { wrapper: wrapperWith(newClient()) })
    fireEvent.click(sendButton())
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    act(() => useComposerDraftStore.getState().update(NEW_DRAFT, (draft) => ({ pathRefs: [...draft.pathRefs, FOLDER] })))
    await act(async () => finish(true))
    expect(chips(NEW_DRAFT)).toEqual([FOLDER])
  })

  it('go with a message in an open chat, and clear once it is dispatched', async () => {
    mountChat()
    act(() => useComposerDraftStore.getState().update(CHAT_DRAFT, () => ({ pathRefs: [FOLDER] })))
    fireEvent.change(box(), { target: { value: 'And this folder' } })
    fireEvent.keyDown(box(), { key: 'Enter' })

    await waitFor(() => expect(run.start).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1', content: 'And this folder\n\nReferenced folder: `/Users/me/Projects/site`'
    })))
    await waitFor(() => expect(chips(CHAT_DRAFT)).toEqual([]))
    expect(box().value).toBe('')
  })
})
