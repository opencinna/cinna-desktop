import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from '../chat/MessageBubble'
import { ArtifactCard } from './ArtifactCard'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactsSupportStore } from '../../hooks/useArtifacts'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import type { ArtifactDetail, PublishedArtifact } from '../../../../shared/artifacts'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const LIMITS = { maxRevisionBytes: 1, maxRevisionFiles: 1, maxFileBytes: 1 }
const artifact: PublishedArtifact = {
  id: ID, title: 'Q3 churn', kind: 'site', revision: 3, visibility: 'private', liveLinkCount: 0, url: `http://core.test/artifact/${ID}`
}
const detail: ArtifactDetail = { ...artifact, isOwner: true, ownerName: 'Ann', grantCount: 0, links: [] }
const ORIGINS = ['http://core.test']

const detailCall = vi.fn()
const writeText = vi.fn()
const openExternal = vi.fn()
const createLink = vi.fn()
const revokeLink = vi.fn()
const setVisibility = vi.fn()

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  detailCall.mockReset().mockResolvedValue({ ok: true, detail })
  writeText.mockReset().mockResolvedValue({ success: true })
  openExternal.mockReset().mockResolvedValue({ success: true })
  createLink.mockReset()
  revokeLink.mockReset()
  setVisibility.mockReset()
  window.api = {
    app: { setTheme: async () => {} },
    clipboard: { writeText },
    system: { openExternal },
    artifacts: { detail: detailCall, createLink, revokeLink, setVisibility }
  } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS, linkOrigins: ORIGINS } })
  useArtifactPublishStore.setState({ freshLinks: {}, warnings: {} })
})

describe('a link to an artifact page in agent text', () => {
  const text = `Published: [the dashboard](http://core.test/artifact/${ID}/) — have a look.`

  it('renders a skeleton at once, then the card once main has read it', async () => {
    let answer!: (value: unknown) => void
    detailCall.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const { container } = wrap(<MessageBubble role="assistant" content={text} />)
    // The card's frame while it loads — not the link, which would swap for a taller card.
    expect(container.querySelector('[data-artifact-card-skeleton]')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'the dashboard' })).toBeNull()
    await act(async () => answer({ ok: true, detail }))
    expect(await screen.findByRole('group', { name: 'Artifact Q3 churn' })).toBeTruthy()
    expect(container.querySelector('[data-artifact-card-skeleton]')).toBeNull()
    expect(screen.queryByRole('link', { name: 'the dashboard' })).toBeNull()
    expect(screen.getByText('rev 3 · only you')).toBeTruthy()
    expect(detailCall).toHaveBeenCalledWith(ID)
  })

  it('keeps the card while it reads again, never flashing back to the link', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><MessageBubble role="assistant" content={text} /></QueryClientProvider>)
    await screen.findByRole('group', { name: 'Artifact Q3 churn' })
    let answer!: (value: unknown) => void
    detailCall.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    await act(async () => { void client.invalidateQueries() })
    expect(detailCall).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('group', { name: 'Artifact Q3 churn' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'the dashboard' })).toBeNull()
    await act(async () => answer({ ok: true, detail: { ...detail, revision: 4 } }))
    expect(screen.getByText('rev 4 · only you')).toBeTruthy()
  })

  it('reads only a link on the profile’s server or a frontend core named; any other host stays a link', async () => {
    useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS, linkOrigins: ['https://core.example', 'https://web.example'] } })
    wrap(<MessageBubble role="assistant" content={`[evil](https://evil.example/artifact/${ID}) [web](https://web.example/artifact/${ID}) [lookalike](https://web.example.evil/artifact/${ID})`} />)
    expect(await screen.findByRole('group', { name: 'Artifact Q3 churn' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'evil' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'lookalike' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'web' })).toBeNull()
    expect(detailCall).toHaveBeenCalledTimes(1)
  })

  it('stays the ordinary link when the read fails', async () => {
    detailCall.mockResolvedValue({ ok: false, code: 'gone', message: 'gone' })
    wrap(<MessageBubble role="assistant" content={text} />)
    await waitFor(() => expect(detailCall).toHaveBeenCalled())
    // The skeleton gives way to the link once the read has failed.
    expect(await screen.findByRole('link', { name: 'the dashboard' })).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.querySelector('[data-artifact-card-skeleton]')).toBeNull()
  })

  it('is never read while artifacts are unsupported, and other paths are plain links', async () => {
    useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: false, limits: LIMITS } })
    wrap(<MessageBubble role="assistant" content={`${text} [list](http://core.test/artifacts/${ID}) [deep](http://core.test/artifact/${ID}/x)`} />)
    await act(async () => {})
    expect(screen.getByRole('link', { name: 'the dashboard' })).toBeTruthy()
    useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, limits: LIMITS, linkOrigins: ORIGINS } })
    await act(async () => {})
    expect(await screen.findByRole('group', { name: 'Artifact Q3 churn' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'list' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'deep' })).toBeTruthy()
    expect(detailCall).toHaveBeenCalledTimes(1)
  })

  it('offers no Share… on someone else’s artifact', async () => {
    detailCall.mockResolvedValue({ ok: true, detail: { ...detail, isOwner: false, visibility: 'instance' } })
    wrap(<MessageBubble role="assistant" content={text} />)
    await screen.findByRole('group', { name: 'Artifact Q3 churn' })
    expect(screen.getByText('rev 3 · everyone on Acme')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Share Q3 churn' })).toBeNull()
  })
})

describe('the card', () => {
  it('copies the core page URL, and says so when the clipboard refuses', async () => {
    wrap(<ArtifactCard artifact={artifact} instanceName="Acme" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link to Q3 churn' }))
    })
    expect(writeText).toHaveBeenCalledWith(artifact.url)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    writeText.mockResolvedValue({ success: false })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }))
    })
    expect(screen.getByRole('alert').textContent).toMatch(/clipboard refused/)
  })

  it('opens the page in the browser and says why when it could not', async () => {
    openExternal.mockResolvedValue({ success: false, error: 'No browser' })
    wrap(<ArtifactCard artifact={artifact} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Q3 churn' }))
    })
    expect(openExternal).toHaveBeenCalledWith(artifact.url)
    expect(screen.getByRole('alert').textContent).toBe('No browser')
  })

  it('says who can see it and how many public links, as two facts', () => {
    const { rerender } = wrap(<ArtifactCard artifact={artifact} instanceName="Acme" />)
    expect(screen.getByText('rev 3 · only you')).toBeTruthy()
    rerender(<QueryClientProvider client={new QueryClient()}><ArtifactCard artifact={{ ...artifact, liveLinkCount: 1 }} instanceName="Acme" /></QueryClientProvider>)
    expect(screen.getByText('rev 3 · only you · 1 public link')).toBeTruthy()
    rerender(<QueryClientProvider client={new QueryClient()}><ArtifactCard artifact={{ ...artifact, visibility: 'instance', liveLinkCount: 3 }} instanceName="Acme" /></QueryClientProvider>)
    expect(screen.getByText('rev 3 · everyone on Acme · 3 public links')).toBeTruthy()
  })

  it('names its buttons after the artifact, keeping the visible labels', () => {
    wrap(<ArtifactCard artifact={artifact} />)
    expect(screen.getByRole('button', { name: 'Open Q3 churn' }).textContent).toBe('Open')
    expect(screen.getByRole('button', { name: 'Copy link to Q3 churn' }).textContent).toBe('Copy link')
    expect(screen.getByRole('button', { name: 'Share Q3 churn' }).textContent).toBe('Share…')
  })

  it('shows a link created at publish once', () => {
    useArtifactPublishStore.setState({ freshLinks: { [ID]: { url: 'http://core.test/s/tok' } } })
    wrap(<ArtifactCard artifact={{ ...artifact, liveLinkCount: 1 }} />)
    expect(screen.getByText('http://core.test/s/tok')).toBeTruthy()
    expect(screen.getByText('rev 3 · only you · 1 public link')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide this link' }))
    expect(screen.queryByText('http://core.test/s/tok')).toBeNull()
  })

  it('Share… focuses the checked choice, and Escape closes it back onto Share…', async () => {
    wrap(<ArtifactCard artifact={artifact} instanceName="Acme" />)
    const share = screen.getByRole('button', { name: 'Share Q3 churn' })
    fireEvent.click(share)
    await screen.findByRole('dialog', { name: 'Share Q3 churn' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Only me' })))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Share Q3 churn' })).toBeNull()
    expect(document.activeElement).toBe(share)
  })

  it('revoking asks in the row; a revoked link stays in place, marked, until the popover closes', async () => {
    const links = [
      { id: 'l1', tokenPrefix: 'ab12', label: null, createdAt: '2026-10-16T10:00:00Z', expiresAt: null, live: true, needsCode: false },
      { id: 'l2', tokenPrefix: 'cd34', label: null, createdAt: '2026-10-16T11:00:00Z', expiresAt: null, live: true, needsCode: false }
    ]
    detailCall.mockResolvedValue({ ok: true, detail: { ...detail, liveLinkCount: 2, links } })
    // Core answers with the first link revoked, sorted after the live one.
    revokeLink.mockResolvedValue({ ok: true, detail: { ...detail, liveLinkCount: 1, links: [links[1], { ...links[0], live: false }] } })
    wrap(<ArtifactCard artifact={artifact} instanceName="Acme" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share Q3 churn' }))
    const popover = await screen.findByRole('dialog', { name: 'Share Q3 churn' })
    await screen.findByText('ab12…')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link ab12' }))
    // Asked, not done.
    expect(revokeLink).not.toHaveBeenCalled()
    expect(popover.textContent).toContain('Revoke?')
    expect(popover.textContent).toContain('People with this link lose access.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(popover.textContent).not.toContain('Revoke?')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link ab12' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeLink).toHaveBeenCalledWith(ID, 'l1')
    const rows = [...popover.querySelectorAll('[data-artifact-link]')]
    expect(rows.map((row) => [row.textContent?.slice(0, 5), row.getAttribute('data-artifact-link')])).toEqual([['ab12…', 'revoked'], ['cd34…', 'live']])
    expect(rows[0].textContent).toContain('Revoked')
    expect(rows[0].querySelector('button')).toBeNull()
    // Closed and opened again: the revoked link is gone.
    fireEvent.keyDown(window, { key: 'Escape' })
    detailCall.mockResolvedValue({ ok: true, detail: { ...detail, liveLinkCount: 1, links: [links[1]] } })
    fireEvent.click(screen.getByRole('button', { name: 'Share Q3 churn' }))
    await screen.findByText('cd34…')
    expect(screen.queryByText('ab12…')).toBeNull()
  })

  it('Share… reads core, switches visibility, creates a link shown once, and revokes one', async () => {
    const linked: ArtifactDetail = {
      ...detail,
      liveLinkCount: 1,
      links: [{ id: 'l1', tokenPrefix: 'ab12', label: null, createdAt: '2026-10-16T10:00:00Z', expiresAt: null, live: true, needsCode: false }]
    }
    setVisibility.mockResolvedValue({ ok: true, detail: { ...detail, visibility: 'instance' } })
    createLink.mockResolvedValue({ ok: true, link: { url: 'http://core.test/s/new' }, detail: linked })
    revokeLink.mockResolvedValue({ ok: false, code: 'request_failed', message: 'Could not reach Cinna.' })
    wrap(<ArtifactCard artifact={artifact} instanceName="Acme" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share Q3 churn' }))
    const popover = await screen.findByRole('dialog', { name: 'Share Q3 churn' })
    await waitFor(() => expect((screen.getByRole('radio', { name: 'Only me' }) as HTMLInputElement).disabled).toBe(false))
    expect(popover.textContent).toContain('None yet')
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Everyone on Acme' }))
    })
    expect(setVisibility).toHaveBeenCalledWith(ID, 'instance')
    expect((screen.getByRole('radio', { name: 'Everyone on Acme' }) as HTMLInputElement).checked).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    })
    expect(screen.getByText('http://core.test/s/new')).toBeTruthy()
    expect(screen.getByText('ab12…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link ab12' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeLink).toHaveBeenCalledWith(ID, 'l1')
    expect(screen.getByRole('alert').textContent).toBe('Could not reach Cinna.')
    // The popover stays open on a refusal.
    expect(screen.getByRole('dialog', { name: 'Share Q3 churn' })).toBeTruthy()
  })
})
