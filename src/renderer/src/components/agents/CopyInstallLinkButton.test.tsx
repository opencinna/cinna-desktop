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
window.api = {
  clipboard: { writeText },
  catalog: { item: vi.fn(() => new Promise(() => {})) },
  system: { openExternal: vi.fn() }
} as never

const { CopyInstallLinkButton, COPIED_REVERT_MS, COPY_INSTALL_LINK_FAILED } = await import('./CopyInstallLinkButton')
const { SkillRow } = await import('./local/SkillRow')
const { CatalogItemDetailView } = await import('./CatalogItemViews')
const { CatalogSurfaceProvider } = await import('./catalogSurface')
const { useAuthStore } = await import('../../stores/auth.store')

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
