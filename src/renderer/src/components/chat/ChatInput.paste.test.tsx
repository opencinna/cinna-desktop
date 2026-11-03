import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'

/**
 * Pasting into the composer: files and images attach the way a drop does, text
 * pastes natively — a long one as a chip sent before the typed text — and a
 * paste of files the composer cannot take says so.
 */

const files = {
  clipboardHasFileRefs: vi.fn(() => false),
  pasteFromClipboard: vi.fn(),
  resolvePaths: vi.fn(),
  readThumbnail: vi.fn(async () => ({ success: false, error: 'no' }))
}
function namespace() {
  return new Proxy({}, { get: (_target, method: string) => method.startsWith('on') ? () => () => {} : async () => [] })
}
window.api = new Proxy({}, { get: (_target, name: string) => (name === 'files' ? files : namespace()) }) as never
const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useComposerDraftStore, composerDraftKey } = await import('../../stores/composerDraft.store')
const { PASTE_MAX_CHARS } = await import('../../../../shared/pastedText')

function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Fire a paste carrying `types`; true when the composer took it over (default prevented). */
function paste(types: string[]): boolean {
  const box = screen.getByRole('combobox')
  const notPrevented = fireEvent.paste(box, { clipboardData: { types, getData: () => 'Q3 report.pdf', files: [] } })
  return !notPrevented
}

const PASTED = '/userData/tmp/pasted/Pasted image 2026-09-30 at 14.00.00.png'

beforeEach(() => {
  useChatStore.getState().reset()
  useComposerDraftStore.setState({ drafts: {} })
  useAuthStore.setState({ currentUser: { id: 'u1', type: 'cinna_user' } as never })
  files.clipboardHasFileRefs.mockReset().mockReturnValue(false)
  files.pasteFromClipboard.mockReset().mockResolvedValue({ success: true, paths: [PASTED] })
  files.resolvePaths.mockReset().mockResolvedValue({
    success: true,
    files: [{ id: PASTED, filename: 'Pasted image 2026-09-30 at 14.00.00.png', size: 3, mimeType: 'image/png', source: 'pending' }]
  })
})

describe('pasting into the composer', () => {
  it('attaches an image-only clipboard the way a drop does', async () => {
    render(<ChatInput chatId={null} />, { wrapper })
    expect(paste(['Files'])).toBe(true)
    await waitFor(() => expect(files.resolvePaths).toHaveBeenCalledWith({ paths: [PASTED] }))
    expect(files.clipboardHasFileRefs).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Preview Pasted image 2026-09-30 at 14.00.00.png' })).toBeTruthy()
  })

  it('leaves plain text to the native paste, asking main nothing', () => {
    render(<ChatInput chatId={null} />, { wrapper })
    expect(paste(['text/plain', 'text/html'])).toBe(false)
    expect(files.clipboardHasFileRefs).not.toHaveBeenCalled()
    expect(files.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('pastes the text of an Excel copy, whose picture of the cells is not a file', () => {
    render(<ChatInput chatId={null} />, { wrapper })
    expect(paste(['text/plain', 'text/html', 'Files'])).toBe(false)
    expect(files.clipboardHasFileRefs).toHaveBeenCalledTimes(1)
    expect(files.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('attaches the files of a Finder copy rather than pasting their names', async () => {
    files.clipboardHasFileRefs.mockReturnValue(true)
    render(<ChatInput chatId={null} />, { wrapper })
    expect(paste(['text/plain', 'Files'])).toBe(true)
    await waitFor(() => expect(files.pasteFromClipboard).toHaveBeenCalledTimes(1))
  })

  it('names the missing destination on the new-chat screen when there is no text to paste', async () => {
    useAuthStore.setState({ currentUser: null })
    render(<ChatInput chatId={null} />, { wrapper })
    expect(paste(['Files'])).toBe(true)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Add an AI provider or sign in to attach files.')
    expect(files.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('lets the text through, with no error, when files cannot be taken but text came with them', () => {
    useAuthStore.setState({ currentUser: null })
    render(<ChatInput chatId={null} />, { wrapper })
    expect(paste(['text/plain', 'Files'])).toBe(false)
    expect(files.clipboardHasFileRefs).not.toHaveBeenCalled()
    expect(files.pasteFromClipboard).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('attaches both of two pastes made back to back, the second after the first upload ends', async () => {
    const second = '/userData/tmp/pasted/Pasted image 2026-09-30 at 14.00.00 (2).png'
    files.pasteFromClipboard.mockResolvedValueOnce({ success: true, paths: [PASTED] }).mockResolvedValueOnce({ success: true, paths: [second] })
    let finishFirst!: () => void
    const pending = (path: string) => ({ id: path, filename: path.split('/').pop()!, size: 3, mimeType: 'image/png', source: 'pending' })
    files.resolvePaths
      .mockImplementationOnce(({ paths }: { paths: string[] }) =>
        new Promise((resolve) => (finishFirst = () => resolve({ success: true, files: paths.map(pending) })))
      )
      .mockImplementationOnce(async ({ paths }: { paths: string[] }) => ({ success: true, files: paths.map(pending) }))
    render(<ChatInput chatId={null} />, { wrapper })
    await act(async () => void paste(['Files']))
    await waitFor(() => expect(files.resolvePaths).toHaveBeenCalledTimes(1))
    await act(async () => void paste(['Files']))
    await waitFor(() => expect(files.pasteFromClipboard).toHaveBeenCalledTimes(2))
    expect(files.resolvePaths).toHaveBeenCalledTimes(1)
    await act(async () => finishFirst())
    await waitFor(() => expect(files.resolvePaths).toHaveBeenLastCalledWith({ paths: [second] }))
    expect(await screen.findByRole('button', { name: 'Preview Pasted image 2026-09-30 at 14.00.00.png' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Preview Pasted image 2026-09-30 at 14.00.00 (2).png' })).toBeTruthy()
  })

  it("shows main's refusal of a pasted folder", async () => {
    files.pasteFromClipboard.mockResolvedValue({ success: false, error: 'Folders and unresolved files cannot be attached', code: 'not_a_file' })
    render(<ChatInput chatId={null} />, { wrapper })
    await act(async () => void paste(['Files']))
    expect(await screen.findByText('Folders and unresolved files cannot be attached')).toBeTruthy()
    expect(files.resolvePaths).not.toHaveBeenCalled()
  })
})

describe('a long text paste becomes a chip', () => {
  const NEW_DRAFT = composerDraftKey(undefined, 'new-chat')
  const lines = (n: number, first = 'Dear Anna,'): string => [first, ...Array.from({ length: n - 1 }, (_, i) => `line ${i + 2}`)].join('\n')
  const EMAIL = lines(20)
  const box = (): HTMLTextAreaElement => screen.getByRole('combobox') as HTMLTextAreaElement
  // Every draft's, so a signed-in profile's key cannot hide a chip.
  const draftPastes = () => Object.values(useComposerDraftStore.getState().drafts).flatMap((draft) => draft.pastes)

  /** Paste `text` as text/plain (plus `extra` types); true when the composer took it over. */
  function pasteText(text: string, extra: string[] = []): boolean {
    const data: Record<string, string> = { 'text/plain': text, 'text/html': `<p>${text}</p>` }
    return !fireEvent.paste(box(), { clipboardData: { types: ['text/plain', ...extra], getData: (type: string) => data[type] ?? '', files: [] } })
  }

  function mountNew(onNewChat = vi.fn(async () => true)) {
    render(<ChatInput chatId={null} onNewChat={onNewChat} />, { wrapper })
    return onNewChat
  }

  beforeEach(() => {
    useAuthStore.setState({ currentUser: null })
  })

  it('chips at 20 lines and leaves 19 to the native paste', () => {
    mountNew()
    expect(pasteText(lines(19))).toBe(false)
    expect(draftPastes()).toEqual([])
    expect(pasteText(EMAIL)).toBe(true)
    expect(draftPastes()).toEqual([{ id: expect.any(String), text: EMAIL }])
    const chip = screen.getByTestId('paste-badge')
    expect(chip.textContent).toContain('Dear Anna,')
    expect(chip.textContent).toContain('· 20 lines')
  })

  it('chips one line of 2,000 characters, showing its size in characters', () => {
    mountNew()
    expect(pasteText('x'.repeat(1_999))).toBe(false)
    expect(pasteText('x'.repeat(2_000))).toBe(true)
    expect(screen.getByTestId('paste-badge').textContent).toContain('· 2,000 chars')
  })

  it('reads text/plain only, normalised: CRLF as LF, blank edge lines dropped', () => {
    mountNew()
    expect(pasteText(`\r\n\r\n${EMAIL.replace(/\n/g, '\r\n')}\r\n\r\n`)).toBe(true)
    expect(draftPastes()[0].text).toBe(EMAIL)
  })

  it('pastes inline over a selection', () => {
    mountNew()
    fireEvent.change(box(), { target: { value: 'replace me' } })
    box().setSelectionRange(0, 7)
    expect(pasteText(EMAIL)).toBe(false)
    expect(draftPastes()).toEqual([])
  })

  it('pastes inline after Cmd+Shift+V', () => {
    mountNew()
    fireEvent.keyDown(box(), { key: 'V', metaKey: true, shiftKey: true })
    expect(pasteText(EMAIL)).toBe(false)
    expect(draftPastes()).toEqual([])
    // Only that one paste: the next Cmd+V chips again.
    expect(pasteText(EMAIL)).toBe(true)
  })

  it('pastes inline into a trigger token being typed', () => {
    mountNew()
    for (const token of ['@', 'see #', '/', 'ask ?']) {
      fireEvent.change(box(), { target: { value: token } })
      box().setSelectionRange(token.length, token.length)
      expect(pasteText(EMAIL)).toBe(false)
    }
    expect(draftPastes()).toEqual([])
  })

  it('refuses a paste over the size cap with one sentence, and makes no chip', () => {
    mountNew()
    expect(pasteText('x'.repeat(PASTE_MAX_CHARS + 1))).toBe(true)
    expect(draftPastes()).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe('This paste is too long to send as text — attach it as a file instead.')
  })

  it('drops the over-cap sentence once a paste chips, or a chip is removed', () => {
    mountNew()
    pasteText('x'.repeat(PASTE_MAX_CHARS + 1))
    expect(screen.getByRole('alert')).toBeTruthy()
    pasteText(EMAIL)
    expect(screen.queryByRole('alert')).toBeNull()

    pasteText('x'.repeat(PASTE_MAX_CHARS + 1))
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview pasted text Dear Anna,' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves an unrelated attach error alone when a paste chips', () => {
    mountNew()
    pasteText(EMAIL)
    const key = Object.keys(useComposerDraftStore.getState().drafts)[0]
    act(() => useComposerDraftStore.getState().update(key, (draft) => ({ files: { ...draft.files, error: 'shot.png is too large' } })))
    pasteText(lines(21, 'Other'))
    expect(screen.getByRole('alert').textContent).toBe('shot.png is too large')
    fireEvent.click(screen.getByRole('button', { name: 'Preview pasted text Other' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('alert').textContent).toBe('shot.png is too large')
  })

  it('never chips the names of a Finder copy', async () => {
    useAuthStore.setState({ currentUser: { id: 'u1', type: 'cinna_user' } as never })
    files.clipboardHasFileRefs.mockReturnValue(true)
    render(<ChatInput chatId={null} />, { wrapper })
    expect(pasteText(EMAIL, ['Files'])).toBe(true)
    await waitFor(() => expect(files.pasteFromClipboard).toHaveBeenCalledTimes(1))
    expect(draftPastes()).toEqual([])
  })

  it('pastes a Finder copy\'s long names inline when files cannot be taken', () => {
    files.clipboardHasFileRefs.mockReturnValue(true)
    mountNew()
    expect(pasteText(EMAIL, ['Files'])).toBe(false)
    expect(files.clipboardHasFileRefs).toHaveBeenCalledTimes(1)
    expect(draftPastes()).toEqual([])
  })

  it('chips the long text of an Excel copy', () => {
    useAuthStore.setState({ currentUser: { id: 'u1', type: 'cinna_user' } as never })
    render(<ChatInput chatId={null} />, { wrapper })
    expect(pasteText(EMAIL, ['Files'])).toBe(true)
    expect(files.pasteFromClipboard).not.toHaveBeenCalled()
    expect(draftPastes()).toHaveLength(1)
  })

  it('makes two chips of the same text pasted twice', () => {
    mountNew()
    pasteText(EMAIL)
    pasteText(EMAIL)
    expect(screen.getAllByTestId('paste-badge')).toHaveLength(2)
  })

  it('sends the pastes first, then the typed text, then the reference lines, and clears the chips', async () => {
    const onNewChat = mountNew()
    pasteText(EMAIL)
    pasteText(lines(25, 'Second'))
    act(() => useComposerDraftStore.getState().update(NEW_DRAFT, () => ({ pathRefs: [{ path: '/w/a.txt', displayPath: '/w/a.txt', kind: 'file' }] })))
    fireEvent.change(box(), { target: { value: 'decline politely' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    expect((onNewChat.mock.calls[0] as unknown[])[0]).toBe(
      `<pasted_text lines="20">\n${EMAIL}\n</pasted_text>\n\n<pasted_text lines="25">\n${lines(25, 'Second')}\n</pasted_text>\n\n` +
        'decline politely\n\nReferenced file: `/w/a.txt`'
    )
    await waitFor(() => expect(draftPastes()).toEqual([]))
    expect(screen.queryByTestId('paste-badge')).toBeNull()
  })

  it('sends a chip alone', async () => {
    const onNewChat = mountNew()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    pasteText(EMAIL)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(onNewChat).toHaveBeenCalledWith(`<pasted_text lines="20">\n${EMAIL}\n</pasted_text>`, undefined, undefined))
  })

  it('keeps a chip pasted while the send is in flight', async () => {
    let finish!: (sent: boolean) => void
    const onNewChat = mountNew(vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve })))
    pasteText(EMAIL)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    pasteText(lines(30, 'Late'))
    await act(async () => finish(true))
    expect(draftPastes().map((p) => p.text)).toEqual([lines(30, 'Late')])
  })

  it('takes the chip back on Cmd+Z right after the paste, and leaves undo native after an edit', () => {
    mountNew()
    pasteText(EMAIL)
    fireEvent.keyDown(box(), { key: 'Meta', metaKey: true })
    expect(fireEvent.keyDown(box(), { key: 'z', metaKey: true })).toBe(false)
    expect(draftPastes()).toEqual([])

    pasteText(EMAIL)
    fireEvent.change(box(), { target: { value: 'typed' } })
    expect(fireEvent.keyDown(box(), { key: 'z', metaKey: true })).toBe(true)
    expect(draftPastes()).toHaveLength(1)
  })

  it('previews a chip; Insert as text puts it at the start, before a blank line, and drops the chip', () => {
    mountNew()
    fireEvent.change(box(), { target: { value: 'reply politely' } })
    pasteText(EMAIL)
    fireEvent.click(screen.getByRole('button', { name: 'Preview pasted text Dear Anna,' }))
    expect(screen.getByRole('dialog', { name: 'Pasted text' }).textContent).toContain('line 20')
    fireEvent.click(screen.getByRole('button', { name: 'Insert as text' }))
    expect(box().value).toBe(`${EMAIL}\n\nreply politely`)
    expect(draftPastes()).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('inserts into an empty composer with no blank line, and Remove drops the chip', () => {
    mountNew()
    pasteText(EMAIL)
    pasteText(lines(21, 'Other'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview pasted text Dear Anna,' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert as text' }))
    expect(box().value).toBe(EMAIL)
    fireEvent.click(screen.getByRole('button', { name: 'Preview pasted text Other' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(draftPastes()).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps Send, not Stop, while a turn runs and a chip waits', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(['chat', 'chat-1'], {
      id: 'chat-1', router: 'direct', agentId: null, modeId: null, providerId: null, modelId: null, messages: [], activeRunId: 'run-1'
    })
    render(<QueryClientProvider client={client}><ChatInput chatId="chat-1" /></QueryClientProvider>)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    pasteText(EMAIL)
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('removes a chip with its X without opening the preview', () => {
    mountNew()
    pasteText(EMAIL)
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text Dear Anna,' }))
    expect(draftPastes()).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
