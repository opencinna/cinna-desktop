import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPreviewModal, artifactFileView } from './ArtifactPreviewModal'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.store'
import { useAuthStore } from '../../stores/auth.store'
import type { ArtifactDetail, PublishedArtifact } from '../../../../shared/artifacts'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const BASE = 'cinna-preview://art-tok/'
const site: PublishedArtifact = { id: ID, title: 'Q3 at a glance', kind: 'site', revision: 2, visibility: 'private', liveLinkCount: 0, url: `http://core.test/artifact/${ID}` }
const files: PublishedArtifact = { ...site, title: 'Q3 numbers', kind: 'files' }
const owned: ArtifactDetail = { ...site, isOwner: true, ownerName: 'Ann', grantCount: 0, links: [] }

const openArtifact = vi.fn()
const release = vi.fn()
const readArtifactText = vi.fn()
const openExternal = vi.fn()
const detailCall = vi.fn()

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ArtifactPreviewModal /></QueryClientProvider>)
}

beforeEach(() => {
  openArtifact.mockReset()
  readArtifactText.mockReset().mockResolvedValue({ ok: true, text: '# Summary\n\nAll good.', truncated: false })
  release.mockReset().mockResolvedValue({ success: true })
  openExternal.mockReset().mockResolvedValue({ success: true })
  detailCall.mockReset().mockResolvedValue({ ok: true, detail: { ...site, isOwner: false, ownerName: 'Bob', grantCount: 0, links: [] } })
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  window.api = {
    htmlPreview: { openArtifact, release, readArtifactText },
    artifacts: { detail: detailCall, createLink: vi.fn(), revokeLink: vi.fn(), setVisibility: vi.fn() },
    system: { openExternal },
    clipboard: { writeText: vi.fn().mockResolvedValue({ success: true }) }
  } as never
  useArtifactPreviewStore.setState({ artifact: null, origin: null, instanceName: undefined })
})

async function open(artifact: PublishedArtifact): Promise<void> {
  await act(async () => {
    useArtifactPreviewStore.getState().open(artifact, 'Acme', null)
  })
}

describe('the artifact preview', () => {
  it('shows a site’s start page in the sandboxed frame, and releases its token on close', async () => {
    openArtifact.mockResolvedValue({ ok: true, token: 'art-tok', baseUrl: BASE, entry: 'pages/index.html', files: [], revision: 4 })
    renderModal()
    await open(site)
    expect(openArtifact).toHaveBeenCalledWith(ID)
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`${BASE}pages/index.html`)
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' }).textContent).toContain('rev 4')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(release).toHaveBeenCalledWith('art-tok')
  })

  it('lists files on the left and shows the chosen one on the right, each in its own style', async () => {
    openArtifact.mockResolvedValue({
      ok: true,
      token: 'art-tok',
      baseUrl: BASE,
      entry: null,
      revision: 1,
      files: [
        { path: 'summary.md', size: 20, mime: 'text/markdown' },
        { path: 'data/q3.csv', size: 20, mime: 'text/csv' },
        { path: 'charts/q3 chart.png', size: 2048, mime: 'image/png' },
        { path: 'data.zip', size: 10, mime: 'application/zip' }
      ]
    })
    renderModal()
    await open(files)
    const frame = (): HTMLIFrameElement => screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement
    // Markdown is rendered from the text main read through the token, not framed raw.
    expect(readArtifactText).toHaveBeenCalledWith('art-tok', 'summary.md')
    expect((await screen.findByRole('heading', { name: 'Summary' })).tagName).toBe('H1')
    expect(screen.queryByTestId('artifact-preview-frame')).toBeNull()
    // A CSV is a table.
    readArtifactText.mockResolvedValue({ ok: true, text: 'region,total\nEU,12\nUS,30\n', truncated: false })
    fireEvent.click(screen.getByRole('button', { name: /data\/q3\.csv/ }))
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('region')
    expect(screen.getByRole('cell', { name: '30' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /charts\/q3 chart\.png/ }))
    expect(frame().getAttribute('src')).toBe(`${BASE}charts/q3%20chart.png`)
    fireEvent.click(screen.getByRole('button', { name: /data\.zip/ }))
    expect(screen.queryByTestId('artifact-preview-frame')).toBeNull()
    expect(screen.getByText('No preview for this file type.')).toBeTruthy()
  })

  it('says a deleted artifact is gone, and a failure offers the browser, closing nothing', async () => {
    openArtifact.mockResolvedValue({ ok: false, code: 'gone', message: 'gone' })
    renderModal()
    await open(site)
    expect(screen.getByText('This artifact was deleted on Acme.')).toBeTruthy()
    openArtifact.mockResolvedValue({ ok: false, code: 'request_failed', message: 'Cinna couldn’t be reached.' })
    await open(site)
    const dialog = screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' })
    expect(dialog.textContent).toContain('Could not open the preview. Open it in the browser instead.')
    const buttons = screen.getAllByRole('button', { name: /Open in browser/ })
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1])
    })
    expect(openExternal).toHaveBeenCalledWith(site.url)
    expect(screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' })).toBeTruthy()
  })

  it('ignores an answer for a file no longer shown, and says a failed read in the pane', async () => {
    openArtifact.mockResolvedValue({
      ok: true,
      token: 'art-tok',
      baseUrl: BASE,
      entry: null,
      revision: 1,
      files: [
        { path: 'old.md', size: 20, mime: 'text/markdown' },
        { path: 'new.md', size: 20, mime: 'text/markdown' },
        { path: 'broken.json', size: 20, mime: 'application/json' }
      ]
    })
    let answerOld: (value: unknown) => void = () => {}
    readArtifactText.mockImplementation((_token: string, path: string) =>
      path === 'old.md'
        ? new Promise((resolve) => {
            answerOld = resolve
          })
        : path === 'new.md'
          ? Promise.resolve({ ok: true, text: '# New', truncated: false })
          : Promise.resolve({ ok: false, code: 'not_found', message: 'This file is no longer in the artifact.' })
    )
    renderModal()
    await open(files)
    expect(screen.getByText('Loading file…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /new\.md/ }))
    expect(await screen.findByRole('heading', { name: 'New' })).toBeTruthy()
    await act(async () => {
      answerOld({ ok: true, text: '# Old', truncated: false })
    })
    expect(screen.queryByRole('heading', { name: 'Old' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'New' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /broken\.json/ }))
    expect(await screen.findByText('This file is no longer in the artifact.')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Preview of Q3 numbers' })).toBeTruthy()
  })

  it('offers Share… to the owner only, first in the header so its arrival moves nothing', async () => {
    openArtifact.mockResolvedValue({ ok: true, token: 'art-tok', baseUrl: BASE, entry: 'index.html', files: [], revision: 2 })
    const viewer = renderModal()
    await open(site)
    await waitFor(() => expect(detailCall).toHaveBeenCalledWith(ID))
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Share…' })).toBeNull()
    viewer.unmount()

    detailCall.mockResolvedValue({ ok: true, detail: owned })
    renderModal()
    await open(site)
    const share = await screen.findByRole('button', { name: 'Share…' })
    const actions = share.parentElement as HTMLElement
    expect(actions.firstElementChild).toBe(share)
    expect(share.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('Share… opens the card’s popover inside the preview: a press in it keeps both open, Escape closes it first and the preview next', async () => {
    openArtifact.mockResolvedValue({ ok: true, token: 'art-tok', baseUrl: BASE, entry: 'index.html', files: [], revision: 2 })
    detailCall.mockResolvedValue({ ok: true, detail: owned })
    const now = vi.spyOn(Date, 'now')
    renderModal()
    await open(site)
    // Past the guard against the second half of the double-click that opened it.
    now.mockReturnValue(Date.now() + 10_000)
    fireEvent.click(await screen.findByRole('button', { name: 'Share…' }))
    const popover = await screen.findByRole('dialog', { name: 'Share Q3 at a glance' })
    const preview = screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' })
    // Portaled into the preview, so the modal dialog contains it.
    expect(preview.contains(popover)).toBe(true)
    await waitFor(() => expect((within(popover).getByRole('radio', { name: 'Only me' }) as HTMLInputElement).disabled).toBe(false))
    fireEvent.mouseDown(within(popover).getByRole('radio', { name: 'Only me' }))
    expect(screen.getByRole('dialog', { name: 'Share Q3 at a glance' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Share Q3 at a glance' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Preview of Q3 at a glance' })).toBeNull()
    now.mockRestore()
  })

  it('a press outside the preview while Share… is open closes only Share…', async () => {
    openArtifact.mockResolvedValue({ ok: true, token: 'art-tok', baseUrl: BASE, entry: 'index.html', files: [], revision: 2 })
    detailCall.mockResolvedValue({ ok: true, detail: owned })
    const now = vi.spyOn(Date, 'now')
    renderModal()
    await open(site)
    now.mockReturnValue(Date.now() + 10_000)
    fireEvent.click(await screen.findByRole('button', { name: 'Share…' }))
    await screen.findByRole('dialog', { name: 'Share Q3 at a glance' })
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Share Q3 at a glance' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Preview of Q3 at a glance' })).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Preview of Q3 at a glance' })).toBeNull()
    now.mockRestore()
  })

  it('picks how a file is shown by its name, then its type', () => {
    expect(artifactFileView(BASE, { path: 'a/index.html', size: 1, mime: 'text/html; charset=utf-8' })).toEqual({ type: 'frame', url: `${BASE}a/index.html` })
    expect(artifactFileView(BASE, { path: 'd.json', size: 1, mime: 'application/json' })).toEqual({ type: 'text', kind: 'json' })
    expect(artifactFileView(BASE, { path: 'notes.md', size: 1, mime: 'text/plain' })).toEqual({ type: 'text', kind: 'markdown' })
    expect(artifactFileView(BASE, { path: 'q.tsv', size: 1, mime: 'text/tab-separated-values' })).toEqual({ type: 'text', kind: 'csv' })
    expect(artifactFileView(BASE, { path: 'run.py', size: 1, mime: 'text/x-python' })).toEqual({ type: 'text', kind: 'python' })
    expect(artifactFileView(BASE, { path: 'pyproject.toml', size: 1, mime: 'application/toml' })).toEqual({ type: 'text', kind: 'text' })
    expect(artifactFileView(BASE, { path: 'c.svg', size: 1, mime: 'image/svg+xml' })).toEqual({ type: 'frame', url: `${BASE}c.svg` })
    expect(artifactFileView(BASE, { path: 'clip.mp4', size: 1, mime: 'video/mp4' })).toEqual({ type: 'frame', url: `${BASE}clip.mp4` })
    expect(artifactFileView(BASE, { path: 'r.pdf', size: 1, mime: 'application/pdf' })).toEqual({ type: 'none' })
  })
})
