import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { PublishArtifactDialog, defaultArtifactTitle } from './PublishArtifactDialog'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactsSupportStore } from '../../hooks/useArtifacts'
import type { ArtifactInspection, ArtifactsPublishOutcome } from '../../../../shared/artifacts'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const LIMITS = { maxRevisionBytes: 50 * 1024 * 1024, maxRevisionFiles: 2000, maxFileBytes: 25 * 1024 * 1024 }
const inspection = (over: Partial<ArtifactInspection> = {}): ArtifactInspection => ({
  name: 'q3',
  relativePath: 'reports/q3',
  path: '/agent/reports/q3',
  isFolder: true,
  kind: 'site',
  entry: 'index.html',
  entryCandidates: [],
  files: [{ path: 'index.html', size: 2048 }, { path: 'data.csv', size: 100 }],
  excluded: [{ path: '.env', reason: 'secret file' }],
  size: 2148,
  overLimits: null,
  limits: LIMITS,
  instanceName: 'Acme',
  previous: null,
  ...over
})

const inspect = vi.fn()
const publish = vi.fn()
const answerApproval = vi.fn()

function open(): void {
  act(() => {
    useArtifactPublishStore.getState().open({ agentId: 'folder:a', path: '/agent/reports/q3', kind: 'dir', chatId: 'chat-1', messageId: 'm1' })
  })
}

beforeEach(() => {
  inspect.mockReset().mockResolvedValue({ ok: true, inspection: inspection() })
  publish.mockReset()
  answerApproval.mockReset()
  window.api = { artifacts: { inspect, publish, answerApproval } } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS } })
  useArtifactPublishStore.setState({ request: null, publishing: false, error: null, phase: null, operationId: null, warnings: {} })
})

describe('the Publish dialog', () => {
  it('lists what will be sent and what is left out, the kind and the total', async () => {
    render(<PublishArtifactDialog />)
    open()
    expect(screen.getByRole('dialog', { name: 'Publish to Cinna' })).toBeTruthy()
    // "Reading…" once, in the list; the kind and total lines hold their height empty.
    expect(screen.getAllByText('Reading…')).toHaveLength(1)
    expect(screen.getByRole('list', { name: 'Files to publish' }).textContent).toBe('Reading…')
    expect(document.querySelector('[data-artifact-total]')!.textContent).toBe('\u00a0')
    await act(async () => {})
    expect(inspect).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/reports/q3' })
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('q3')
    expect(screen.getByText('Mini-site · opens index.html')).toBeTruthy()
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent)
    expect(rows).toEqual(['.envsecret file', 'data.csv100 B', 'index.html2 KB'])
    expect(screen.getByText('.env').className).toContain('line-through')
    expect(screen.getByText('2 KB of 50 MB')).toBeTruthy()
    expect(screen.getByText('A new artifact on Acme')).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Only me' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('radio', { name: 'Everyone on Acme' })).toBeTruthy()
  })

  it('offers Update, preselected, for a path published before, and publishes with the choices', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'instance' } }) })
    let resolve: (value: ArtifactsPublishOutcome) => void = () => {}
    publish.mockReturnValue(new Promise((r) => { resolve = r }))
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect((screen.getByRole('radio', { name: 'Update “Q3 churn” (rev 3)' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Q3 churn')
    expect((screen.getByRole('radio', { name: 'Everyone on Acme' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Anyone with a link' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'folder:a', path: '/agent/reports/q3', title: 'Q3 churn', artifactId: ID, visibility: 'link', entry: null,
      anchor: { chatId: 'chat-1', messageId: 'm1' }
    }))
    // Undismissable while publishing; the button says the phase.
    act(() => useArtifactPublishStore.getState().setPhase(useArtifactPublishStore.getState().operationId!, 'uploading'))
    expect(screen.getByRole('button', { name: 'Uploading…' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => {
      resolve({ ok: true, artifact: { id: ID, title: 'Q3 churn', kind: 'site', revision: 4, visibility: 'instance', liveLinkCount: 1, url: 'u' }, excluded: [], link: { url: 'http://core.test/s/tok' } })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    // The link is Share…'s to list now; nothing about it is held for the card.
    expect(useArtifactPublishStore.getState().warnings[ID]).toBeUndefined()
  })

  it('keeps Publish disabled over the limits, saying why with the size in the total line', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ overLimits: { files: true, size: false, perFile: [] } }) })
    const { unmount } = render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(screen.getByText('More than 2,000 files — over the 2,000-file limit')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()

    inspect.mockResolvedValue({ ok: true, inspection: inspection({ size: 90 * 1024 * 1024, overLimits: { files: false, size: true, perFile: [] } }) })
    const second = render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(screen.getByText('At least 90 MB — over the 50 MB limit')).toBeTruthy()
    second.unmount()

    inspect.mockResolvedValue({ ok: true, inspection: inspection({ files: [{ path: 'big.bin', size: 30 * 1024 * 1024 }], overLimits: { files: false, size: false, perFile: ['big.bin'] } }) })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(screen.getByText('big.bin is 30 MB — over the 25 MB per-file limit')).toBeTruthy()
  })

  it('an empty title disables Publish and the total line says so', async () => {
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  ' } })
    expect(screen.getByText('Add a title to publish')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('is top-anchored, so a refusal only lengthens it downward', async () => {
    render(<PublishArtifactDialog />)
    open()
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement
    expect(overlay.className).toContain('items-start')
    expect(overlay.className).not.toContain('items-center')
  })

  it('gives the truncated Update choice its full words as a tooltip', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'A very long title of a quarterly report', revision: 3, visibility: 'private' } }) })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    const label = screen.getByRole('radio', { name: 'Update “A very long title of a quarterly report” (rev 3)' }).closest('label')!
    expect(label.getAttribute('title')).toBe('Update “A very long title of a quarterly report” (rev 3)')
  })

  it('offers a start page for a folder without index.html', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ kind: 'files', entry: null, entryCandidates: ['a.html', 'b.html'] }) })
    publish.mockResolvedValue({ ok: false, code: 'request_failed', message: 'x' })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(screen.getByText('2 files')).toBeTruthy()
    // The picker has its own row, inside the list's fixed block.
    expect(screen.getByRole('combobox').closest('[data-artifact-files-block]')).toBeTruthy()
    expect(screen.getByRole('combobox').closest('[data-artifact-kind]')).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b.html' } })
    // The picker names the page; the kind line does not repeat it.
    expect(document.querySelector('[data-artifact-kind]')!.textContent).toBe('Mini-site')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entry: 'b.html' }))
  })

  it('says a refusal inside the dialog and closes nothing; gone switches to Publish as new', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'private' } }) })
    publish.mockResolvedValue({ ok: false, code: 'gone', message: 'This artifact is no longer on the instance. Publish it as new instead.' })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    })
    expect(screen.getByRole('alert').textContent).toMatch(/no longer on the instance/)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Publish as new' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says why inside the list when the path cannot be published', async () => {
    inspect.mockResolvedValue({ ok: false, code: 'path_refused', message: 'Only files and folders inside the agent’s folder can be published.' })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toMatch(/inside the agent’s folder/)
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Edit… on an agent’s request starts from it and answers it instead of publishing', async () => {
    answerApproval.mockResolvedValue({ ok: true, artifact: { id: ID }, link: { url: 'http://core/s/t' } })
    render(<PublishArtifactDialog />)
    act(() => {
      useArtifactPublishStore.getState().open({
        agentId: 'folder:a', path: '/agent/reports/q3', kind: 'dir', chatId: 'chat-1', messageId: null,
        approval: { requestId: 'art_tc1', title: 'Agent title', description: 'Agent words', entry: null, agentName: 'Analyst' }
      })
    })
    await act(async () => {})
    expect(screen.getByRole('dialog', { name: 'Publish for Analyst' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy()
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Agent title')
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Agent words')
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone on Acme' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    })
    expect(publish).not.toHaveBeenCalled()
    expect(answerApproval).toHaveBeenCalledWith({
      requestId: 'art_tc1', decision: 'publish',
      edits: { title: 'Agent title', description: 'Agent words', entry: null, artifactId: null, visibility: 'instance' }
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useArtifactPublishStore.getState().warnings[ID]).toBeUndefined()
  })

  it('titles a file without its extension and a folder by its name', () => {
    expect(defaultArtifactTitle('/a/report.final.md', 'file')).toBe('report.final')
    expect(defaultArtifactTitle('/a/q3', 'dir')).toBe('q3')
  })
})
