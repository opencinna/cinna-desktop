import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../stores/fileDownload.store', () => ({
  useFileDownloadStore: (select: (s: { download: () => void; downloadingIds: Set<string> }) => unknown) =>
    select({ download: () => {}, downloadingIds: new Set() })
}))

import { FilePreviewModal } from './FilePreviewModal'
import { useFilePreviewStore } from '../../stores/filePreview.store'

/**
 * The html kind of the file preview: the page in a sandboxed frame main
 * serves, a Rendered / Source toggle, and Open in browser.
 */

const page: AgentFileRef = {
  text: 'out/report.html',
  path: '/agent/out/report.html',
  displayPath: 'out/report.html',
  kind: 'file',
  inside: true
}
const other: AgentFileRef = { ...page, text: 'out/other.html', path: '/agent/out/other.html', displayPath: 'out/other.html' }
const agentTarget = (ref: AgentFileRef = page) => ({ type: 'agentFile' as const, agentId: 'folder:a', ref })
const SOURCE = '<html><style>h1 { color: red }</style><body><h1>Hi</h1><script>const n = 1</script></body></html>'

type OpenState = Partial<ReturnType<typeof useFilePreviewStore.getState>>

function open(state: OpenState): void {
  act(() => {
    useFilePreviewStore.getState().close()
    useFilePreviewStore.setState({ ...state, openSeq: useFilePreviewStore.getState().openSeq + 1 })
  })
}

const card = (): HTMLElement => document.querySelector<HTMLElement>('[tabindex="-1"]')!
const frame = (): HTMLIFrameElement | null => document.querySelector('iframe')
/** Lets the `html-preview:open` promise settle. */
const settle = () => act(async () => {})

let openCalls: unknown[]
let released: string[]
let issued: number
const htmlOpen = vi.fn()
const release = vi.fn()
const filesOpenInBrowser = vi.fn()
/** A test may stub the action; the store keeps functions across `close()`. */
const storeOpenInBrowser = useFilePreviewStore.getState().openInBrowser

beforeEach(() => {
  useFilePreviewStore.setState({ openInBrowser: storeOpenInBrowser })
  openCalls = []
  released = []
  issued = 0
  htmlOpen.mockReset().mockImplementation(async (input: unknown) => {
    openCalls.push(input)
    const token = `tok${++issued}`
    return { success: true, token, url: `cinna-preview://${token}/report.html` }
  })
  release.mockReset().mockImplementation(async (token: string) => {
    released.push(token)
    return { success: true }
  })
  filesOpenInBrowser.mockReset().mockResolvedValue({ success: true })
  window.api = {
    htmlPreview: { open: htmlOpen, release },
    files: { openInBrowser: filesOpenInBrowser }
  } as never
  act(() => useFilePreviewStore.getState().close())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the rendered page', () => {
  it('loads the served URL in a frame with exactly the preview sandbox', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    expect(openCalls).toEqual([{ type: 'agentFile', agentId: 'folder:a', path: '/agent/out/report.html' }])
    const iframe = frame()!
    expect(iframe.getAttribute('src')).toBe('cinna-preview://tok1/report.html')
    const tokens = iframe.getAttribute('sandbox')!.split(/\s+/).sort()
    expect(tokens).toEqual(
      ['allow-forms', 'allow-modals', 'allow-scripts', 'allow-top-navigation-by-user-activation'].sort()
    )
    expect(tokens).not.toContain('allow-same-origin')
    // No popups (a script could open them without a click), and a top navigation only inside one.
    expect(tokens.some((token) => token.startsWith('allow-popups'))).toBe(false)
    expect(tokens).not.toContain('allow-top-navigation')
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.getAttribute('title')).toBe('report.html')
  })

  it('releases the token when the preview closes', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    expect(released).toEqual([])
    act(() => useFilePreviewStore.getState().close())
    // No `animate` in jsdom: the exit ends at once, and the frame unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frame()).toBeNull()
    expect(released).toEqual(['tok1'])
  })

  it('releases the old token when another file opens, and serves the new one', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    open({ target: agentTarget(other), kind: 'html', text: SOURCE })
    await settle()
    expect(released).toEqual(['tok1'])
    expect(frame()!.getAttribute('src')).toBe('cinna-preview://tok2/report.html')
  })

  it('releases a token that arrives after the preview closed', async () => {
    let answer: (value: unknown) => void = () => {}
    htmlOpen.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    act(() => useFilePreviewStore.getState().close())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => answer({ success: true, token: 'late', url: 'cinna-preview://late/report.html' }))
    expect(released).toEqual(['late'])
  })

  it("says why when main refuses the page, in the body", async () => {
    htmlOpen.mockResolvedValueOnce({ success: false, code: 'needs_consent', error: 'Cinna needs your approval.' })
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    expect(frame()).toBeNull()
    expect(screen.getByText(/Couldn.t render the page: Cinna needs your approval\./)).toBeTruthy()
  })

  it('gets a wider card of a fixed height, which a text file does not', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE, isLoading: true })
    // Already while loading, so nothing resizes when the page arrives.
    expect(card().classList.contains('max-w-6xl')).toBe(true)
    expect(card().classList.contains('h-[80vh]')).toBe(true)
    open({ target: agentTarget({ ...page, path: '/agent/a.txt' }), kind: 'text', text: 'x' })
    expect(card().classList.contains('max-w-3xl')).toBe(true)
    expect(card().classList.contains('h-[80vh]')).toBe(false)
  })
})

describe('Rendered / Source', () => {
  const button = (name: string): HTMLElement => screen.getByRole('button', { name })

  it('starts Rendered, shows the highlighted markup on Source, and keeps the frame loaded', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy()
    expect(button('Rendered').getAttribute('aria-pressed')).toBe('true')
    expect(button('Source').getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('code-preview')).toBeNull()

    fireEvent.click(button('Source'))
    expect(button('Source').getAttribute('aria-pressed')).toBe('true')
    const code = screen.getByTestId('code-preview')
    expect(code.textContent).toBe(SOURCE)
    // The tags, and the embedded style and script in their own grammars.
    expect(code.querySelector('.hljs-tag')).not.toBeNull()
    expect(code.querySelector('.language-css, .hljs-selector-tag')).not.toBeNull()
    expect(code.querySelector('.language-javascript, .hljs-keyword')).not.toBeNull()
    // Still mounted, hidden: switching back does not reload the page.
    expect(frame()!.closest('.hidden')).not.toBeNull()
    expect(htmlOpen).toHaveBeenCalledTimes(1)

    fireEvent.click(button('Rendered'))
    expect(frame()!.closest('.hidden')).toBeNull()
    expect(htmlOpen).toHaveBeenCalledTimes(1)
  })

  it('shows the truncation notice on Source only', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE, truncated: true })
    await settle()
    expect(screen.queryByText(/Preview truncated/)).toBeNull()
    fireEvent.click(button('Source'))
    expect(screen.getByText(/Preview truncated/)).toBeTruthy()
  })

  it('starts Rendered again on the next open', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    fireEvent.click(button('Source'))
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    expect(button('Rendered').getAttribute('aria-pressed')).toBe('true')
  })

  it('is not offered for other kinds', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget({ ...page, path: '/agent/a.txt' }), kind: 'text', text: 'x' })
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull()
  })
})

describe('Open in browser', () => {
  it('is in the ⋯ menu for an html agent file, between Open and Open folder', async () => {
    const openInBrowser = vi.fn(() => Promise.resolve())
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    act(() => useFilePreviewStore.setState({ openInBrowser }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
    const menu = screen.getByRole('menu', { name: 'File actions' })
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent)).toEqual([
      'Open',
      'Open in browser',
      'Open folder'
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in browser' }))
    expect(openInBrowser).toHaveBeenCalledTimes(1)
  })

  it('closes the ⋯ menu when the page takes focus, and not when the app merely loses it', async () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget(), kind: 'html', text: SOURCE })
    await settle()
    const tick = (): Promise<void> => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
    fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
    // The app window loses focus to another app: the menu stays.
    act(() => void window.dispatchEvent(new Event('blur')))
    await tick()
    expect(screen.getByRole('menu', { name: 'File actions' })).toBeTruthy()
    // A press inside the page: focus goes to the frame, and the window blurs.
    act(() => frame()!.focus())
    expect(document.activeElement).toBe(frame())
    act(() => void window.dispatchEvent(new Event('blur')))
    await tick()
    expect(screen.queryByRole('menu', { name: 'File actions' })).toBeNull()
    expect(useFilePreviewStore.getState().target).not.toBeNull()
  })

  it('is not in the ⋯ menu for another kind', () => {
    render(<FilePreviewModal />)
    open({ target: agentTarget({ ...page, path: '/agent/a.txt' }), kind: 'text', text: 'x' })
    fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Open in browser' })).toBeNull()
  })

  it('is a header button beside Download for an html attachment, and a failure says why under the header', async () => {
    filesOpenInBrowser.mockResolvedValueOnce({ success: false, code: 'launch_failed', error: 'No browser could open this file.' })
    const attachment = { id: 'f1', filename: 'report.html', size: 1, mimeType: 'text/html', source: 'local' as const }
    render(<FilePreviewModal />)
    open({ target: { type: 'attachment', attachment }, attachment, kind: 'html', text: SOURCE })
    await settle()
    expect(openCalls).toEqual([
      { type: 'attachment', fileId: 'f1', source: 'local', filename: 'report.html', mimeType: 'text/html' }
    ])
    expect(screen.getByRole('button', { name: 'Download report.html' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open report.html in browser' }))
    await settle()
    expect(filesOpenInBrowser).toHaveBeenCalledWith({ fileId: 'f1', filename: 'report.html', source: 'local' })
    expect(screen.getByRole('alert').textContent).toBe('No browser could open this file.')
    // The preview stays open.
    expect(useFilePreviewStore.getState().target).not.toBeNull()
  })

  it('is not a header button for another attachment kind', () => {
    const attachment = { id: 'f2', filename: 'a.txt', size: 1, mimeType: 'text/plain' }
    render(<FilePreviewModal />)
    open({ target: { type: 'attachment', attachment }, attachment, kind: 'text', text: 'x' })
    expect(screen.queryByRole('button', { name: /in browser/ })).toBeNull()
  })
})
