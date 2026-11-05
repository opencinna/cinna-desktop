import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentSkill } from '../../../../shared/localAgents'
import type { CatalogItem } from '../../../../shared/catalogItems'

/**
 * Copy install link (skill links, D4) on each surface: a catalog skill's
 * detail (the Catalog dialog and Settings), a catalog pin's row and an own
 * skill shared to the catalog on the Addons tab. It writes the https form for
 * the active account's server, says Copied in place for a moment, and says so
 * when the clipboard refuses. Never on a marketplace pin or an unshared skill.
 */

vi.mock('../settings/CatalogCardCredentials', () => ({ CatalogCardCredentials: () => null }))

const writeText = vi.fn<(text: string) => Promise<{ success: boolean }>>()
/** Main's answer for the server's web app origin; by default it has nothing better than the stored one. */
const installOrigin = vi.fn<() => Promise<{ origin: string | null; fromDiscovery: boolean }>>()
window.api = {
  clipboard: { writeText },
  skillLinks: { installOrigin },
  catalog: { item: vi.fn(() => new Promise(() => {})) },
  system: { openExternal: vi.fn() }
} as never

const { CopyInstallLinkButton, COPIED_REVERT_MS, COPY_INSTALL_LINK_FAILED } = await import('./CopyInstallLinkButton')
const { SkillRow } = await import('./local/SkillRow')
const { CatalogItemDetailView } = await import('./CatalogItemViews')
const { CatalogSurfaceProvider } = await import('./catalogSurface')
const { useAuthStore } = await import('../../stores/auth.store')
const { useSkillInstallLink } = await import('./CopyInstallLinkButton')
const { renderHook, waitFor } = await import('@testing-library/react')

const LINK = 'https://cinna.test/get/skill/test.erp'
const LABEL = 'Copy install link for ERP lookup'
/** An own skill's row names it by its folder name. */
const ROW_LABEL = 'Copy install link for erp-lookup'

function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const skill = (over: Partial<LocalAgentSkill>): LocalAgentSkill =>
  ({ name: 'erp-lookup', description: '', version: null, source: 'authored', path: 'skills/erp-lookup/SKILL.md', deliverable: true, issues: [], credentials: [], ...over }) as LocalAgentSkill

const row = (s: LocalAgentSkill) => render(createElement(SkillRow, { skill: s, revealError: null, onReveal: vi.fn() }), { wrapper })

beforeEach(() => {
  writeText.mockReset().mockResolvedValue({ success: true })
  installOrigin.mockReset().mockResolvedValue({ origin: 'https://cinna.test', fromDiscovery: true })
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user', cinnaServerUrl: 'https://cinna.test/' } as never })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CopyInstallLinkButton', () => {
  it('copies, says Copied for a moment, then goes back', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    render(<CopyInstallLinkButton link={LINK} name="ERP lookup" onError={onError} />)
    const button = screen.getByRole('button', { name: LABEL })
    await act(async () => fireEvent.click(button))
    expect(writeText).toHaveBeenCalledWith(LINK)
    expect(onError).toHaveBeenCalledWith(null)
    expect(button.getAttribute('title')).toBe('Copied')
    // The name stays put, so nothing that finds the button loses it.
    expect(screen.getByRole('button', { name: LABEL })).toBe(button)
    act(() => vi.advanceTimersByTime(COPIED_REVERT_MS))
    expect(button.getAttribute('title')).toBe(LABEL)
  })

  it('says so when the clipboard refuses, and never says Copied', async () => {
    writeText.mockResolvedValue({ success: false })
    const onError = vi.fn()
    render(<CopyInstallLinkButton link={LINK} name="ERP lookup" onError={onError} variant="bare" />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: LABEL })))
    expect(onError).toHaveBeenCalledWith(COPY_INSTALL_LINK_FAILED)
    expect(screen.getByRole('button', { name: LABEL }).getAttribute('title')).not.toBe('Copied')
  })
})

describe('on the Addons tab', () => {
  it('a catalog pin’s row copies its package’s link on the active server', async () => {
    row(skill({ source: 'catalog', packageId: 'test.erp', packageUuid: 'u1', title: 'ERP lookup', path: '' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: LABEL })))
    expect(writeText).toHaveBeenCalledWith(LINK)
  })

  it('an own skill shared to the catalog copies its package’s link', async () => {
    row(skill({ shared: { packageUuid: 'u1', packageId: 'test.erp', revisionNumber: 2 } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: ROW_LABEL })))
    expect(writeText).toHaveBeenCalledWith(LINK)
  })

  it('a refused copy is the row’s error line', async () => {
    writeText.mockResolvedValue({ success: false })
    row(skill({ shared: { packageUuid: 'u1', packageId: 'test.erp', revisionNumber: 2 } }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: ROW_LABEL })))
    expect(screen.getByRole('alert').textContent).toBe(COPY_INSTALL_LINK_FAILED)
  })

  it.each([
    ['an unshared own skill', skill({ shared: null })],
    ['a marketplace pin', skill({ source: 'marketplace', entryUuid: 'e1', path: '' })]
  ])('is not offered on %s', (_label, s) => {
    row(s)
    expect(screen.queryByRole('button', { name: /^Copy install link/ })).toBeNull()
  })

  it('is not offered without a Cinna account', () => {
    useAuthStore.setState({ currentUser: { id: 'local', type: 'local_user' } as never })
    row(skill({ source: 'catalog', packageId: 'test.erp', path: '' }))
    expect(screen.queryByRole('button', { name: /^Copy install link/ })).toBeNull()
  })
})

describe('on a catalog skill’s detail', () => {
  const item = (kind: 'skill' | 'agent'): CatalogItem =>
    ({ kind, uuid: 'u1', id: 'test.erp', name: 'erp-lookup', display_name: 'ERP lookup', description: null, maintainers: [], access: 'use', install_count: 0, required_credential_specs: [] }) as unknown as CatalogItem
  const view = (kind: 'skill' | 'cloud_agent') => ({
    item: item(kind === 'skill' ? 'skill' : 'agent'),
    kind,
    name: 'ERP lookup',
    people: null,
    version: null,
    specs: [],
    cloud: null,
    desktop: null,
    usedBy: [],
    skillTargets: []
  })

  it.each(['dialog', 'settings'] as const)('in the %s, copies the link and shows a refusal under the header', async (surface) => {
    render(
      <CatalogSurfaceProvider value={surface}>
        <CatalogItemDetailView view={view('skill') as never} action={null} error={null} onBack={vi.fn()} />
      </CatalogSurfaceProvider>,
      { wrapper }
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: LABEL })))
    expect(writeText).toHaveBeenCalledWith(LINK)
    writeText.mockResolvedValue({ success: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: LABEL })))
    expect(screen.getByRole('alert').textContent).toBe(COPY_INSTALL_LINK_FAILED)
  })

  it('is not offered on an agent', () => {
    render(<CatalogItemDetailView view={view('cloud_agent') as never} action={null} error={null} onBack={vi.fn()} />, { wrapper })
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull()
  })
})

describe('useSkillInstallLink', () => {
  const BACKEND = 'http://localhost:8000/'
  const backendProfile = () => useAuthStore.setState({ currentUser: { id: 'p2', type: 'cinna_user', cinnaServerUrl: BACKEND } as never })

  it('names the server’s web app once main answers, on a profile signed in on the backend', async () => {
    backendProfile()
    installOrigin.mockResolvedValue({ origin: 'http://localhost:5173', fromDiscovery: true })
    const { result } = renderHook(() => useSkillInstallLink('test.erp'), { wrapper })
    // There from the first render, on the stored origin, so the button never appears late.
    expect(result.current).toBe('http://localhost:8000/get/skill/test.erp')
    await waitFor(() => expect(result.current).toBe('http://localhost:5173/get/skill/test.erp'))
    expect(installOrigin).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['main has no origin', () => installOrigin.mockResolvedValue({ origin: null, fromDiscovery: false })],
    ['main refuses', () => installOrigin.mockRejectedValue(new Error('not activated'))]
  ])('keeps the stored origin when %s', async (_label, arrange) => {
    backendProfile()
    arrange()
    const { result } = renderHook(() => useSkillInstallLink('test.erp'), { wrapper })
    await waitFor(() => expect(installOrigin).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current).toBe('http://localhost:8000/get/skill/test.erp')
  })

  it('a row on a split-origin server copies the web app’s link', async () => {
    backendProfile()
    installOrigin.mockResolvedValue({ origin: 'http://localhost:5173', fromDiscovery: true })
    row(skill({ source: 'catalog', packageId: 'test.erp', packageUuid: 'u1', title: 'ERP lookup', path: '' }))
    await waitFor(() => expect(installOrigin).toHaveBeenCalled())
    await act(async () => {})
    await act(async () => fireEvent.click(screen.getByRole('button', { name: LABEL })))
    expect(writeText).toHaveBeenCalledWith('http://localhost:5173/get/skill/test.erp')
  })

  it('asks main nothing without a package id to link', () => {
    backendProfile()
    const { result } = renderHook(() => useSkillInstallLink(null), { wrapper })
    expect(result.current).toBeNull()
    expect(installOrigin).not.toHaveBeenCalled()
  })

  describe('how long an answer stands', () => {
    /** One client for every mount, as the app has: a later mount reads what an earlier one fetched. */
    const shared = () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
    const later = (ms: number) => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + ms)
    }
    afterEach(() => vi.restoreAllMocks())

    it('a fallback after a failed discovery is asked again once it is 30 s old', async () => {
      backendProfile()
      installOrigin.mockResolvedValueOnce({ origin: 'http://localhost:8000', fromDiscovery: false })
      installOrigin.mockResolvedValue({ origin: 'http://localhost:5173', fromDiscovery: true })
      const sharedWrapper = shared()
      const first = renderHook(() => useSkillInstallLink('test.erp'), { wrapper: sharedWrapper })
      await waitFor(() => expect(installOrigin).toHaveBeenCalledTimes(1))
      await act(async () => {})
      first.unmount()
      later(31_000)
      const { result } = renderHook(() => useSkillInstallLink('test.erp'), { wrapper: sharedWrapper })
      await waitFor(() => expect(result.current).toBe('http://localhost:5173/get/skill/test.erp'))
      expect(installOrigin).toHaveBeenCalledTimes(2)
    })

    it('an answer the server gave stands for the session', async () => {
      backendProfile()
      installOrigin.mockResolvedValue({ origin: 'http://localhost:5173', fromDiscovery: true })
      const sharedWrapper = shared()
      const first = renderHook(() => useSkillInstallLink('test.erp'), { wrapper: sharedWrapper })
      await waitFor(() => expect(first.result.current).toBe('http://localhost:5173/get/skill/test.erp'))
      first.unmount()
      later(60 * 60_000)
      const { result } = renderHook(() => useSkillInstallLink('test.erp'), { wrapper: sharedWrapper })
      await act(async () => {})
      expect(result.current).toBe('http://localhost:5173/get/skill/test.erp')
      expect(installOrigin).toHaveBeenCalledTimes(1)
    })
  })

  it('asks main nothing without a Cinna account', () => {
    useAuthStore.setState({ currentUser: { id: 'local', type: 'local_user' } as never })
    const { result } = renderHook(() => useSkillInstallLink('test.erp'), { wrapper })
    expect(result.current).toBeNull()
    expect(installOrigin).not.toHaveBeenCalled()
  })
})
