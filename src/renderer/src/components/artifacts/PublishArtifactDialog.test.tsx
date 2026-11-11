import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

/** A segment of a segmented group, by its words; `aria-pressed` says which one is chosen. */
function segment(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}
const pressed = (name: string): boolean => segment(name).getAttribute('aria-pressed') === 'true'

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
    // The list's place says it is reading, in the list's own surface.
    expect(document.querySelector('[data-artifact-files-block]')!.textContent).toBe('Reading…')
    // The named list itself is busy, so a wait on it by name sees the read.
    expect(screen.getByRole('list', { name: 'Files to publish' }).textContent).toBe('')
    expect(screen.getByRole('list', { name: 'Files to publish' }).getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('[data-artifact-total]')!.textContent).toBe('\u00a0')
    await act(async () => {})
    expect(inspect).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/reports/q3' })
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('q3')
    expect(screen.getByText('Mini-site · opens index.html')).toBeTruthy()
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent)
    expect(rows).toEqual(['.envsecret file', 'data.csv100 B', 'index.html2 KB'])
    expect(screen.getByRole('list', { name: 'Files to publish' }).hasAttribute('aria-busy')).toBe(false)
    expect(screen.getByText('.env').className).toContain('line-through')
    expect(screen.getByText('2 KB of 50 MB')).toBeTruthy()
    expect(screen.getByText('A new artifact on Acme')).toBeTruthy()
    const who = screen.getByRole('group', { name: 'Who can see it' })
    expect(within(who).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
      ['Only me', 'true'],
      ['Everyone', 'false'],
      ['Anyone with a link', 'false']
    ])
    // Short segments; the line under them says what the choice means and names the server, its whole text in the tooltip.
    const line = document.querySelector('[data-visibility-line]') as HTMLElement
    expect(line.textContent).toBe('Only you can open it on Acme')
    expect(line.title).toBe('Only you can open it on Acme')
    fireEvent.click(segment('Everyone'))
    expect(line.textContent).toBe('Everyone on Acme can open it')
    expect(line.title).toBe('Everyone on Acme can open it')
  })

  it('offers Update, preselected, for a path published before, and publishes with the choices', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'instance' } }) })
    let resolve: (value: ArtifactsPublishOutcome) => void = () => {}
    publish.mockReturnValue(new Promise((r) => { resolve = r }))
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(within(screen.getByRole('group', { name: 'Artifact' })).getAllByRole('button')).toHaveLength(2)
    expect(pressed('Update rev 3')).toBe(true)
    expect(pressed('New artifact')).toBe(false)
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Q3 churn')
    expect(pressed('Everyone')).toBe(true)
    fireEvent.click(segment('Anyone with a link'))
    expect(pressed('Anyone with a link')).toBe(true)
    expect(pressed('Everyone')).toBe(false)
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

  it('names the Update choice by its short words, the full title in its tooltip, under a visible Artifact label', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'A very long title of a quarterly report', revision: 3, visibility: 'private' } }) })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    // Its accessible name is what it shows (rule 10); the long title is in the tooltip.
    const update = segment('Update rev 3')
    expect(update.textContent).toBe('Update rev 3')
    expect(update.getAttribute('title')).toBe('Update “A very long title of a quarterly report” (rev 3)')
    // Labelled above, like every field: the group is named by the visible label.
    const group = screen.getByRole('group', { name: 'Artifact' })
    const label = document.getElementById(group.getAttribute('aria-labelledby')!)!
    expect(label.textContent).toBe('Artifact')
    expect(label.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('adopts the previous audience while the files load, a press on the pressed choice not counting as a pick', async () => {
    let answer: (value: unknown) => void = () => {}
    inspect.mockReturnValue(new Promise((r) => { answer = r }))
    render(<PublishArtifactDialog />)
    open()
    // Only me is pressed already: pressing it again is not a choice of the user's.
    expect(pressed('Only me')).toBe(true)
    fireEvent.click(segment('Only me'))
    await act(async () => {
      answer({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'instance' } }) })
    })
    expect(pressed('Everyone')).toBe(true)
  })

  it('keeps a real pick made while the files load over the previous audience', async () => {
    let answer: (value: unknown) => void = () => {}
    inspect.mockReturnValue(new Promise((r) => { answer = r }))
    render(<PublishArtifactDialog />)
    open()
    fireEvent.click(segment('Anyone with a link'))
    await act(async () => {
      answer({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'instance' } }) })
    })
    expect(pressed('Anyone with a link')).toBe(true)
  })

  it('offers a start page for a folder without index.html', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ kind: 'files', entry: null, entryCandidates: ['a.html', 'b.html'] }) })
    publish.mockResolvedValue({ ok: false, code: 'request_failed', message: 'x' })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    expect(screen.getByText('2 files')).toBeTruthy()
    // The picker has its own row, inside the list's fixed block, its label above it like Title's.
    const picker = screen.getByRole('button', { name: 'Start page' })
    expect(picker.closest('[data-artifact-files-block]')).toBeTruthy()
    expect(picker.previousElementSibling!.textContent).toBe('Start page')
    expect(picker.parentElement!.className).toContain('flex-col')
    expect(picker.closest('[data-artifact-kind]')).toBeNull()
    expect(picker.textContent).toBe('None — browse the files')
    fireEvent.click(picker)
    const menu = screen.getByRole('menu', { name: 'Start page' })
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['None — browse the files', 'a.html', 'b.html'])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'b.html' }))
    expect(picker.textContent).toBe('b.html')
    // The picker names the page; the kind line does not repeat it.
    expect(document.querySelector('[data-artifact-kind]')!.textContent).toBe('Mini-site')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ entry: 'b.html' }))
  })

  it('says a refusal inside the dialog and closes nothing; gone switches to New artifact', async () => {
    inspect.mockResolvedValue({ ok: true, inspection: inspection({ previous: { artifactId: ID, title: 'Q3 churn', revision: 3, visibility: 'private' } }) })
    publish.mockResolvedValue({ ok: false, code: 'gone', message: 'This artifact is no longer on the instance. Publish it as new instead.' })
    render(<PublishArtifactDialog />)
    open()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/no longer on the instance/)
    // Under the buttons, whole and last in the dialog: nothing above it moves.
    const footer = alert.closest('[data-dialog-footer]')!
    expect(footer.contains(screen.getByRole('button', { name: 'Publish' }))).toBe(true)
    expect(alert.previousElementSibling!.contains(screen.getByRole('button', { name: 'Publish' }))).toBe(true)
    expect(footer.lastElementChild).toBe(alert)
    expect(alert.className).not.toContain('line-clamp')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(pressed('New artifact')).toBe(true)
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
    fireEvent.click(segment('Everyone'))
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
