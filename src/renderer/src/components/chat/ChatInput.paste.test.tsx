import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'

/**
 * Pasting into the composer: files and images attach the way a drop does, text
 * pastes natively, and a paste of files the composer cannot take says so.
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
const { useComposerDraftStore } = await import('../../stores/composerDraft.store')

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
