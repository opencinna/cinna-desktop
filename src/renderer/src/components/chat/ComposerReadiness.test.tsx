import { act, render, renderHook, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The pure half of the composer's readiness refusal: which typed text is a
 * catalog `/run:` (main's grammar, not a looser one), and the example prompts
 * that go dim and inert while their agent is refused — without remounting.
 */

;(window as unknown as { api: unknown }).api = {}

import type { ComposerReadiness } from './ComposerReadiness'

afterEach(() => vi.useRealTimers())

const { isCatalogCommand, RefusableExamplePrompts, readinessNoticeItem, skillCredentialsNotice, credentialRows, useDropSettledPrompts } = await import('./ComposerReadiness')
const { useSkillCredentialPromptStore } = await import('../../stores/skillCredentialPrompt.store')
const { ComposerNoticePanel } = await import('./ComposerNoticePanel')

/** The readiness answer as the panel draws it: its one row. */
function ReadinessRow({ readiness }: { readiness: ComposerReadiness }): React.JSX.Element {
  const item = readinessNoticeItem(readiness, 'reason')
  return <ComposerNoticePanel notices={item ? [item] : []} />
}

const folder = { capabilities: { commands: 'catalog' } } as never
const remote = { capabilities: { commands: 'card' } } as never
const DOWN = {
  state: 'unreachable',
  reason: 'Could not reach the agent.',
  detail: 'ECONNREFUSED'
} as never

describe('isCatalogCommand', () => {
  it('matches a bare /run:<name> to a folder agent, surrounding space ignored', () => {
    expect(isCatalogCommand(folder, '/run:check')).toBe(true)
    expect(isCatalogCommand(folder, '  /run:status_refresh-2 ')).toBe(true)
  })

  it('does not match what main would hand to the engine instead', () => {
    for (const typed of ['/run:', '/run: check', '/run:check now', 'run:check', '/run:-x', 'x /run:check']) {
      expect(isCatalogCommand(folder, typed)).toBe(false)
    }
  })

  it('does not match for an agent whose commands are not a folder catalog', () => {
    expect(isCatalogCommand(remote, '/run:check')).toBe(false)
    expect(isCatalogCommand(null, '/run:check')).toBe(false)
  })
})

describe('RefusableExamplePrompts', () => {
  function gate(refusal: unknown, onSelect: () => void = vi.fn()): React.JSX.Element {
    return createElement(RefusableExamplePrompts, {
      refusal: refusal as never,
      children: createElement('button', { type: 'button', onClick: onSelect }, 'Summarise invoices')
    })
  }

  it('dims the prompts, makes them inert and says why while refused', () => {
    const { container } = render(gate(DOWN))
    const outer = container.firstElementChild as HTMLElement
    const inner = outer.firstElementChild as HTMLElement
    expect(outer.getAttribute('title')).toBe('ECONNREFUSED')
    expect(outer.getAttribute('aria-disabled')).toBe('true')
    expect(inner.hasAttribute('inert')).toBe(true)
    expect(inner.className).toContain('opacity-50')
  })

  it('holds the prompts the same way, with the hold as the reason, while sends are held', () => {
    const hold = "Drafting this agent's prompts — send when it finishes."
    const { container, rerender } = render(
      createElement(RefusableExamplePrompts, {
        refusal: null,
        hold,
        children: createElement('button', { type: 'button' }, 'Summarise invoices')
      })
    )
    const before = screen.getByText('Summarise invoices')
    const outer = container.firstElementChild as HTMLElement
    const inner = outer.firstElementChild as HTMLElement
    expect(outer.getAttribute('title')).toBe(hold)
    expect(outer.getAttribute('aria-disabled')).toBe('true')
    expect(inner.hasAttribute('inert')).toBe(true)
    expect(inner.className).toContain('opacity-50')
    // The hold lifting swaps classes, not the tree.
    rerender(gate(null))
    expect(screen.getByText('Summarise invoices')).toBe(before)
    expect(inner.hasAttribute('inert')).toBe(false)
  })

  it('leaves them live and unmarked when nothing is refused', () => {
    const onSelect = vi.fn()
    const { container } = render(gate(null, onSelect))
    const outer = container.firstElementChild as HTMLElement
    expect(outer.hasAttribute('title')).toBe(false)
    expect((outer.firstElementChild as HTMLElement).hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByText('Summarise invoices'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the same prompts mounted when a refusal arrives and clears', () => {
    const { rerender } = render(gate(null))
    const before = screen.getByText('Summarise invoices')
    rerender(gate(DOWN))
    expect(screen.getByText('Summarise invoices')).toBe(before)
    rerender(gate(null))
    expect(screen.getByText('Summarise invoices')).toBe(before)
  })
})

describe('composer recheck feedback', () => {
  it('shows the refresh icon and holds immediate checks for 600 ms without losing focus or duplicating requests', async () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const readiness: ComposerReadiness = {
      notice: { state: 'invalid', reason: 'Update local development tooling.' },
      refusal: { state: 'invalid', reason: 'Update local development tooling.' },
      blocksSend: true,
      text: 'Update local development tooling.',
      title: null,
      action: { label: 'Check again', pendingLabel: 'Checking…', pending: false, run }
    }
    render(<ReadinessRow readiness={readiness} />)
    const button = screen.getByRole('button', { name: 'Check again' })
    expect(button.querySelector('svg')?.classList.contains('lucide-refresh-cw')).toBe(true)
    button.focus()
    fireEvent.click(button)
    await act(async () => { await vi.advanceTimersByTimeAsync(599) })
    expect(screen.getByRole('button', { name: 'Checking…' })).toBe(button)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(run).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByRole('button', { name: 'Check again' }).getAttribute('aria-busy')).toBe('false')
  })
})

describe('Antigravity’s first login', () => {
  const login = (engine: string, pending = false): ComposerReadiness => ({
    notice: { state: 'not_logged_in', reason: `${engine} is not logged in.`, login: engine } as never,
    refusal: null,
    blocksSend: true,
    text: `${engine} is not logged in.`,
    title: null,
    action: { label: 'Log in', pendingLabel: 'Waiting for sign-in in your browser…', pending, run: vi.fn(), cancel: vi.fn() }
  })

  it('puts Google’s terms behind a (?) beside Log in, and keeps it while the sign-in runs', () => {
    const view = render(<ReadinessRow readiness={login('antigravity')} />)
    const tip = screen.getByRole('button', { name: 'About Antigravity’s terms' })
    // In the action row beside the button, not a line of prose in the warning.
    expect(tip.parentElement!.contains(screen.getByRole('button', { name: 'Log in' }))).toBe(true)
    // Before the button, whose label widens while the sign-in runs.
    expect(tip.compareDocumentPosition(screen.getByRole('button', { name: 'Log in' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/Google’s software/)).toBeNull()
    view.rerender(<ReadinessRow readiness={login('antigravity', true)} />)
    expect(screen.getByRole('button', { name: 'About Antigravity’s terms' })).toBeTruthy()
  })

  it('puts a login’s action on its own line, so its widening label never takes width from the sentence', () => {
    const view = render(<ReadinessRow readiness={login('codex')} />)
    const line = screen.getByText('codex is not logged in.')
    // Not in the sentence's flex row: the pending label and Cancel widen into free space below it.
    expect(line.parentElement!.contains(screen.getByRole('button', { name: 'Log in' }))).toBe(false)
    view.rerender(<ReadinessRow readiness={login('codex', true)} />)
    expect(line.parentElement!.contains(screen.getByRole('button', { name: 'Cancel' }))).toBe(false)
    // An action without a Cancel stays beside the sentence.
    view.rerender(<ReadinessRow readiness={{ ...login('codex'), action: { label: 'Check again', pendingLabel: 'Checking…', pending: false, run: vi.fn() } }} />)
    expect(line.parentElement!.contains(screen.getByRole('button', { name: 'Check again' }))).toBe(true)
  })

  it('says nothing of the kind for another engine’s login', () => {
    render(<ReadinessRow readiness={login('codex')} />)
    expect(screen.queryByRole('button', { name: 'About Antigravity’s terms' })).toBeNull()
  })
})

describe('skillCredentialsNotice', () => {
  const cred = (slot: string, filled: boolean | undefined) => ({ slot, type: 'api_token', description: null, ...(filled === undefined ? {} : { filled }) })
  const skill = (name: string, credentials: ReturnType<typeof cred>[], over: Record<string, unknown> = {}) =>
    ({ name, description: '', version: null, source: 'catalog', path: '', deliverable: true, issues: [], credentials, ...over })
  const agent = (skills: ReturnType<typeof skill>[]) => ({ id: 'folder:kit', skills }) as never
  function Row({ notice }: { notice: ReturnType<typeof skillCredentialsNotice> }): React.JSX.Element {
    return <ComposerNoticePanel notices={notice ? [notice] : []} />
  }

  it('names the one slot a prompted skill lacks, by the skill’s catalog title', () => {
    const folder = agent([skill('erp-orders', [cred('erp-api', false), cred('erp-ok', true)], { title: 'ERP Orders' })])
    const notice = skillCredentialsNotice(folder, ['erp-orders'], vi.fn(), vi.fn())!
    expect(notice).toMatchObject({ key: 'skill-credentials', tone: 'warning', title: 'ERP Orders needs a credential this agent doesn’t have: erp-api.' })
    render(<Row notice={notice} />)
    expect(screen.getByText('erp-api').tagName).toBe('CODE')
    expect(screen.getByText(/ERP Orders needs a credential this agent doesn’t have/)).toBeTruthy()
  })

  it('counts several, names the first prompted skill and lists them all in the title', () => {
    const folder = agent([
      skill('crm-sync', [cred('crm', false)], { source: 'authored', title: 'Ignored for an own skill' }),
      skill('erp-orders', [cred('erp-api', false), cred('erp-db', false)])
    ])
    const notice = skillCredentialsNotice(folder, ['erp-orders', 'crm-sync'], vi.fn(), vi.fn())!
    render(<Row notice={notice} />)
    expect(screen.getByText('erp-orders needs 2 credentials this agent doesn’t have.')).toBeTruthy()
    expect(notice.title).toBe('erp-orders needs 2 credentials this agent doesn’t have. crm-sync needs a credential this agent doesn’t have: crm.')
  })

  it('says nothing once filled, for a slot not judged, for an undeliverable or unprompted skill', () => {
    expect(skillCredentialsNotice(agent([skill('erp', [cred('erp-api', true)])]), ['erp'], vi.fn(), vi.fn())).toBeNull()
    expect(skillCredentialsNotice(agent([skill('erp', [cred('erp-api', undefined)])]), ['erp'], vi.fn(), vi.fn())).toBeNull()
    expect(skillCredentialsNotice(agent([skill('erp', [cred('erp-api', false)], { deliverable: false })]), ['erp'], vi.fn(), vi.fn())).toBeNull()
    expect(skillCredentialsNotice(agent([skill('erp', [cred('erp-api', false)])]), ['other'], vi.fn(), vi.fn())).toBeNull()
    expect(skillCredentialsNotice(agent([skill('erp', [cred('erp-api', false)])]), undefined, vi.fn(), vi.fn())).toBeNull()
    expect(skillCredentialsNotice(null, ['erp'], vi.fn(), vi.fn())).toBeNull()
    // The first prompted skill that still lacks something leads.
    const notice = skillCredentialsNotice(agent([skill('done', [cred('a', true)]), skill('erp', [cred('erp-api', false)])]), ['done', 'erp'], vi.fn(), vi.fn())
    expect(notice?.title).toBe('erp needs a credential this agent doesn’t have: erp-api.')
  })

  it('opens Finish setup without putting the prompt away; only the × does', () => {
    const finish = vi.fn()
    const dismiss = vi.fn()
    const notice = skillCredentialsNotice(agent([skill('erp', [cred('erp-api', false)])]), ['erp'], finish, dismiss)!
    render(<Row notice={notice} />)
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    expect(finish).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss skill credential prompt' }))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('has the skill-link offer’s two-line shape: the action under the text, a reserved line and a ×', () => {
    const notice = skillCredentialsNotice(agent([skill('erp', [cred('erp-api', false)])]), ['erp'], vi.fn(), vi.fn())!
    expect(notice).toMatchObject({ actionBelow: true, reserveActionLine: true, singleLine: true })
    const { container } = render(<Row notice={notice} />)
    const row = container.querySelector('li')!
    // Line one (icon, text, ×), then line two (the strut and Finish setup).
    expect(row.children).toHaveLength(2)
    expect(row.children[0].querySelector('button[aria-label="Dismiss skill credential prompt"]')).toBeTruthy()
    expect(row.children[1].textContent).toContain('Finish setup')
  })

  it('folds into the folder’s credentials row when there is one: no second row, the skill sentence in its tooltip', () => {
    const folderRow = { key: 'folder-credentials', tone: 'warning' as const, icon: (() => null) as never, text: 'Missing ACME_KEY.', title: 'Missing ACME_KEY.' }
    const prompt = skillCredentialsNotice(agent([skill('erp', [cred('erp-api', false)])]), ['erp'], vi.fn(), vi.fn())
    expect(credentialRows(folderRow, prompt)).toEqual({
      credentials: { ...folderRow, title: 'Missing ACME_KEY. erp needs a credential this agent doesn’t have: erp-api.' },
      skillCredentials: null
    })
    expect(credentialRows(folderRow, null)).toEqual({ credentials: folderRow, skillCredentials: null })
    expect(credentialRows(null, prompt)).toEqual({ credentials: null, skillCredentials: prompt })
  })
})

describe('useDropSettledPrompts', () => {
  const cred = (slot: string, filled: boolean) => ({ slot, type: 'api_token', description: null, filled })
  const skill = (name: string, credentials: ReturnType<typeof cred>[]) =>
    ({ name, description: '', version: null, source: 'catalog', path: '', deliverable: true, issues: [], credentials })
  const agent = (skills: ReturnType<typeof skill>[]) => ({ id: 'folder:kit', skills }) as never

  it('drops prompted skills that are gone or whose slots are all filled, and keeps those still lacking', () => {
    useSkillCredentialPromptStore.setState({ prompts: { 'folder:kit': ['erp', 'crm', 'gone'] }, settled: {} })
    const prompted = () => useSkillCredentialPromptStore.getState().prompts['folder:kit']
    const { rerender } = renderHook(({ folder }) => useDropSettledPrompts(folder, prompted()), {
      initialProps: { folder: agent([skill('erp', [cred('erp-api', false)]), skill('crm', [cred('crm', true)])]) }
    })
    expect(prompted()).toEqual(['erp'])
    // Filled later (by hand, or Finish setup): the prompt goes with it, and nothing raises it again.
    rerender({ folder: agent([skill('erp', [cred('erp-api', true)])]) })
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({})
  })

  it('leaves the prompt alone while the folder is not known', () => {
    useSkillCredentialPromptStore.setState({ prompts: { 'folder:kit': ['erp'] }, settled: {} })
    renderHook(() => useDropSettledPrompts(null, ['erp']))
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({ 'folder:kit': ['erp'] })
  })
})
