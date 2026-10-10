import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto, LocalAgentSkill } from '../../../../../shared/localAgents'

/**
 * The agent's Addons tab over the real attach modal: attached connectors draw
 * with Settings' own card, attaching from the picker and creating a new
 * connector both link it to this agent, and Detach only removes the link.
 */

const provider = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, transportType: 'streamable-http', url: `https://${id}.example.com/mcp`, enabled: true,
  hasAuth: false, authType: 'oauth', status: 'connected', tools: [], ...extra
})
let providers = [provider('jira', 'Atlassian'), provider('gh', 'GitHub', { status: 'error', error: 'HTTP 401' })]
let attached: string[] = []
const listMcpProviders = vi.fn(async () => [...attached])
const attachMcpProvider = vi.fn(async (_agent: string, id: string) => { attached = [...attached, id]; return { success: true as const } })
const detachMcpProvider = vi.fn(async (_agent: string, id: string) => { attached = attached.filter((a) => a !== id); return { success: true as const } })
const upsert = vi.fn(async (data: { name: string }) => {
  providers = [...providers, provider('new', data.name, { status: 'awaiting-auth' })]
  return { id: 'new', success: true }
})
const openPath = vi.fn(async (_input: { agentId: string; relPath?: string }) => ({ success: true as const }))
let shareStatuses: unknown[] = []
/** Set to a never-settling promise to hold the share statuses in loading. */
let statusesPending: Promise<never> | null = null
type Outcome = { ok: true; name: string; revisionNumber: number } | { ok: false; code: string; message: string }
const updateSkill = vi.fn<(agentId: string, name: string) => Promise<Outcome>>()
const removeSkill = vi.fn<(agentId: string, name: string) => Promise<Outcome>>()
const ensureSkills = vi.fn<(agentId: string) => Promise<unknown>>()
window.api = {
  localAgents: { listMcpProviders, attachMcpProvider, detachMcpProvider, openPath },
  mcp: { list: async () => providers, onStatusChanged: () => () => {}, upsert, agentsUsing: async () => [] },
  sharing: { statuses: () => statusesPending ?? Promise.resolve({ success: true, value: shareStatuses }) },
  catalogSkills: { update: updateSkill, remove: removeSkill, ensure: ensureSkills }
} as never

const { AgentAddonsTab, useAddonsBadge } = await import('./AgentAddonsTab')

function renderTab(extra: Partial<LocalAgentDto> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = { id: 'folder:a', kind: 'kit', skills: [], ...extra } as unknown as LocalAgentDto
  return render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent })))
}

beforeEach(() => {
  providers = [provider('jira', 'Atlassian'), provider('gh', 'GitHub', { status: 'error', error: 'HTTP 401' })]
  attached = []
  shareStatuses = []
  statusesPending = null
  vi.clearAllMocks()
})

describe('AgentAddonsTab', () => {
  it('attaches an existing connector from the picker and keeps the picker open', async () => {
    renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    // Only a problem wears a glyph on a picker card (ux_rules rule 13).
    expect(within(dialog).getByRole('img', { name: 'HTTP 401' })).toBeTruthy()
    expect(within(dialog).queryAllByRole('img')).toHaveLength(1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach Atlassian' }))
    await within(dialog).findByRole('button', { name: 'Atlassian attached' })
    expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'jira')
    // Drawn with Settings' card, which carries the row's Detach.
    await screen.findByRole('button', { name: 'Detach Atlassian from this agent' })
  })

  it('attaches a connector created from the picker, then closes on it', async () => {
    // Mutation: drop `onCreated` from AddCustomMcpForm and the new connector
    // lands in Settings → MCP without ever reaching this agent.
    renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    fireEvent.click(within(dialog).getByRole('button', { name: /custom mcp/i }))
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Jira Cloud' } })
    fireEvent.change(within(dialog).getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://mcp.atlassian.com/v1/sse' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'new'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByRole('button', { name: 'Detach Jira Cloud from this agent' })
  })

  it('keeps an open form when the user clicks outside the picker', async () => {
    renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    fireEvent.click(within(dialog).getByRole('button', { name: /custom mcp/i }))
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Half typed' } })
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect((screen.getByPlaceholderText('e.g., My MCP Server') as HTMLInputElement).value).toBe('Half typed')
    // The header button is the form's way back to the list, never a close.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to connectors' }))
    expect(screen.getByRole('dialog', { name: 'Attach MCP connector' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('e.g., My MCP Server')).toBeNull()
  })

  it('still attaches a connector whose create finishes after the picker closed', async () => {
    // TanStack drops mutate-level callbacks of an unmounted form; the attach
    // has to ride the promise. Mutation: go back to `mutate(…, { onSuccess })`
    // in AddCustomMcpForm and this fails.
    let finish!: () => void
    upsert.mockImplementationOnce(async (data: { name: string }) => {
      await new Promise<void>((resolve) => { finish = resolve })
      providers = [...providers, provider('new', data.name, { status: 'awaiting-auth' })]
      return { id: 'new', success: true }
    })
    const view = renderTab()
    await screen.findByText('No connectors attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach MCP connector' })
    fireEvent.click(within(dialog).getByRole('button', { name: /custom mcp/i }))
    fireEvent.change(within(dialog).getByPlaceholderText('e.g., My MCP Server'), { target: { value: 'Slow' } })
    fireEvent.change(within(dialog).getByPlaceholderText('https://mcp.example.com'), { target: { value: 'https://slow.example.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(upsert).toHaveBeenCalled())
    view.unmount()
    finish()
    await waitFor(() => expect(attachMcpProvider).toHaveBeenCalledWith('folder:a', 'new'))
  })

  it('detaches without deleting the connector', async () => {
    attached = ['jira']
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Detach Atlassian from this agent' }))
    await screen.findByText('No connectors attached.')
    expect(detachMcpProvider).toHaveBeenCalledWith('folder:a', 'jira')
    expect(providers.map((p) => p.id)).toContain('jira')
  })
})

describe('the Skills section', () => {
  const skill = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
    name, description: `${name} things.`, version: null, source: 'authored', path: `skills/${name}/SKILL.md`,
    deliverable: true, issues: [], credentials: [], ...extra
  })
  const SKILLS: LocalAgentSkill[] = [
    skill('broken', {
      description: '', deliverable: false,
      issues: [{ code: 'name_mismatch', message: 'The name in SKILL.md does not match the folder name.', severity: 'error' }]
    }),
    skill('leaky', {
      issues: [{ code: 'secrets', message: 'This skill holds files that look like credentials.', severity: 'warning', paths: ['scripts/.env'] }]
    }),
    skill('pdf-tools', { credentials: [{ slot: 'docs.example.com', type: 'api_token', description: null }] })
  ]

  it('lists each skill with its source, its state as a glyph naming the sentence, and its slots', async () => {
    renderTab({ skills: SKILLS })
    await screen.findByText('No connectors attached.')
    const section = screen.getByRole('heading', { name: 'Skills' }).closest('section')!
    const items = [...section.querySelector('ul')!.children] as HTMLElement[]
    expect(items.map((item) => within(item).getByTitle(/^(broken|leaky|pdf-tools)$/).textContent)).toEqual(['broken', 'leaky', 'pdf-tools'])
    for (const item of items) expect(within(item).getByText('Authored')).toBeTruthy()

    // Fine: a check, and no issue list.
    const fine = items[2]
    expect(within(fine).getByRole('img', { name: 'Every engine of this agent gets this skill' })).toBeTruthy()
    expect(within(fine).getByText('docs.example.com').tagName).toBe('CODE')
    // One card shell for the tab: the connector card's.
    for (const item of items) expect((item.firstElementChild as HTMLElement).className).toContain('bg-[var(--color-bg-secondary)]')
    expect(within(fine).queryByRole('list')).toBeNull()
    // Broken: the error is the glyph's name and the row's issue line.
    expect(within(items[0]).getByRole('img', { name: 'The name in SKILL.md does not match the folder name.' })).toBeTruthy()
    expect(within(items[0]).getAllByText('The name in SKILL.md does not match the folder name.')).toHaveLength(1)
    // A warning names the files that tripped it.
    expect(within(items[1]).getByRole('img', { name: 'This skill holds files that look like credentials.' })).toBeTruthy()
    expect(within(items[1]).getByText('scripts/.env').tagName).toBe('CODE')
  })

  it('draws a pinned catalog skill in the same row, from the catalog, with its version or revision and no reveal', async () => {
    const pin = (name: string, extra: Partial<LocalAgentSkill>): LocalAgentSkill => skill(name, {
      description: '', source: 'catalog', path: '', deliverable: false,
      issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }],
      packageId: `io.example.skill.${name}`, packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110', revisionNumber: 3, ...extra
    })
    renderTab({ skills: [pin('csv-export', { version: '1.2.0' }), pin('pdf-report', {}), skill('pdf-tools')] })
    await screen.findByText('No connectors attached.')
    const section = screen.getByRole('heading', { name: 'Skills' }).closest('section')!
    const items = [...section.querySelector('ul')!.children] as HTMLElement[]
    expect(items.map((item) => (item.firstElementChild as HTMLElement).className)).toEqual(
      items.map(() => expect.stringContaining('bg-[var(--color-bg-secondary)]'))
    )
    expect(within(items[0]).getByText('From the catalog')).toBeTruthy()
    expect(within(items[0]).queryByText('Authored')).toBeNull()
    // Labelled as the catalog and the Inbox label versions (rule 13).
    expect(within(items[0]).getByText('Version 3 (1.2.0)')).toBeTruthy()
    expect(within(items[1]).getByText('Version 3')).toBeTruthy()
    expect(within(items[0]).getByRole('img', { name: 'Not on this computer yet.' })).toBeTruthy()
    // No reveal: only the catalog row's own actions.
    await waitFor(() => expect(within(items[0]).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Download csv-export again',
      'Remove csv-export from this agent'
    ]))
    expect(within(items[2]).getByText('Authored')).toBeTruthy()
    expect(within(items[2]).queryByText(/^(Version|Revision) /)).toBeNull()
    expect(within(items[2]).getByRole('button', { name: 'Reveal SKILL.md of pdf-tools' })).toBeTruthy()
  })

  it('reveals a skill’s SKILL.md from its row', async () => {
    renderTab({ skills: SKILLS })
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal SKILL.md of pdf-tools' }))
    await waitFor(() => expect(openPath).toHaveBeenCalledWith({ agentId: 'folder:a', relPath: 'skills/pdf-tools/SKILL.md' }))
  })

  it('says there is none plainly — the info tip explains the layout — and has no section for a bare agent', async () => {
    const view = renderTab()
    await screen.findByText('No connectors attached.')
    expect(screen.getByText('No skills yet.')).toBeTruthy()
    view.unmount()
    renderTab({ kind: 'bare', skills: undefined })
    await screen.findByText('No connectors attached.')
    expect(screen.queryByRole('heading', { name: 'Skills' })).toBeNull()
  })

  it('counts skills on the tab badge, and a skill with any issue as needing attention', async () => {
    attached = ['gh']
    let badge: ReturnType<typeof useAddonsBadge> | null = null
    function Probe(): null {
      badge = useAddonsBadge('folder:a', SKILLS)
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    // One connector in error (gh) plus two skills with issues, of four addons.
    await waitFor(() => expect(badge).toEqual({ count: 4, problems: 3, skills: 3 }))
  })

  it('counts a deliverable skill with an unattached slot as needing attention, not one that is attached or unjudged', async () => {
    attached = []
    const slot = (filled?: boolean) => [{ slot: 'docs.example.com', type: 'api_token', description: null, ...(filled === undefined ? {} : { filled }) }]
    const skills = [
      skill('gap', { credentials: slot(false) }),
      skill('done', { credentials: slot(true) }),
      skill('raw', { credentials: slot() }),
      skill('off', { deliverable: false, credentials: slot(false) })
    ]
    let badge: ReturnType<typeof useAddonsBadge> | null = null
    function Probe(): null {
      badge = useAddonsBadge('folder:a', skills)
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await waitFor(() => expect(badge).toEqual({ count: 4, problems: 1, skills: 4 }))
  })

  it('does not count a catalog pin that is only not downloaded yet as needing attention', async () => {
    attached = []
    const pin = skill('csv-export', {
      description: '', source: 'catalog', path: '', deliverable: false,
      issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }],
      packageId: 'io.example.skill.csv-export', packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110', revisionNumber: 3
    })
    let badge: ReturnType<typeof useAddonsBadge> | null = null
    function Probe(): null {
      badge = useAddonsBadge('folder:a', [pin])
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await waitFor(() => expect(badge).toEqual({ count: 1, problems: 0, skills: 1 }))
  })

  it('puts declared slots on their own neutral Needs line, two chips then +N, never on the title line', async () => {
    // A ✓ followed by code reads as a connected credential (rule 13), and a
    // long slot list squeezed the name (rule 7).
    const slots = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example']
    renderTab({
      skills: [skill('many', { credentials: slots.map((slot) => ({ slot, type: 'api_token', description: null })) })]
    })
    const name = await screen.findByTitle('many')
    const titleLine = name.parentElement!
    expect(titleLine.querySelector('code')).toBeNull()
    const line = document.querySelector('[data-skill-slots]') as HTMLElement
    expect(within(line).getByText('Needs')).toBeTruthy()
    expect([...line.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['a.example', 'b.example'])
    expect(within(line).getByText('+4')).toBeTruthy()
    for (const slot of slots) expect(line.title).toContain(slot)
    expect(line.className).not.toMatch(/--color-(success|warning|danger)/)
  })

  it('marks each judged slot attached or not, and offers Finish setup on a deliverable skill with an unattached one', async () => {
    const onFinishSetup = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const agent = {
      id: 'folder:a', kind: 'kit',
      skills: [
        skill('docs', {
          credentials: [
            { slot: 'docs.example.com', type: 'api_token', description: null, filled: true, attachment: { credentialId: 'c1', state: 'ready' } },
            { slot: 'mail.example.com', type: 'api_token', description: null, filled: false, attachment: null }
          ]
        }),
        skill('done', { credentials: [{ slot: 'ok.example.com', type: 'api_token', description: null, filled: true }] }),
        skill('broken', {
          deliverable: false,
          credentials: [{ slot: 'never.example.com', type: 'api_token', description: null, filled: false }]
        })
      ]
    } as unknown as LocalAgentDto
    render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent, onFinishSetup })))
    await screen.findByText('No connectors attached.')
    const [docs, done, broken] = [...document.querySelectorAll('[data-skill-slots]')] as HTMLElement[]
    expect(within(docs).getByRole('img', { name: 'A credential for docs.example.com is attached' })).toBeTruthy()
    expect(within(docs).getByRole('img', { name: 'No credential for mail.example.com is attached yet' }).className).toContain('--color-warning')
    expect(docs.title).toContain('mail.example.com (api_token) · not attached')
    fireEvent.click(within(docs).getByRole('button', { name: 'Finish setup' }))
    expect(onFinishSetup).toHaveBeenCalledTimes(1)
    // All attached, or a skill no session gets (Finish setup does not list it): no way in.
    expect(within(done).queryByRole('button', { name: 'Finish setup' })).toBeNull()
    expect(within(broken).getByRole('img', { name: 'No credential for never.example.com is attached yet' })).toBeTruthy()
    expect(within(broken).queryByRole('button', { name: 'Finish setup' })).toBeNull()
  })

  it('clamps a long description to two lines with the full text on hover', async () => {
    const long = 'x'.repeat(600)
    renderTab({ skills: [skill('wordy', { description: long })] })
    const text = await screen.findByText(long)
    expect(text.className).toContain('line-clamp-2')
    expect(text.title).toBe(long)
  })

  it('shows a failed reveal inside that skill’s card, last', async () => {
    // Rule 6: an error by the control that caused it, not at the tab's foot.
    openPath.mockRejectedValueOnce(new Error('The folder is gone.'))
    renderTab({ skills: [skill('ledger'), skill('pdf-tools')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal SKILL.md of pdf-tools' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The folder is gone.')
    const card = screen.getByTitle('pdf-tools').closest('li')!.firstElementChild as HTMLElement
    expect(card.lastElementChild).toBe(alert)
    expect(screen.getByTitle('ledger').closest('li')!.contains(alert)).toBe(false)
  })
})

describe('the Skills section — a catalog skill’s actions', () => {
  const pin = (name: string, extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
    name, description: '', version: null, source: 'catalog', path: '/cache/x/SKILL.md', deliverable: true, issues: [],
    credentials: [], packageId: `io.example.skill.${name}`, packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110',
    revisionNumber: 2, latestRevision: 2, updatable: false, ...extra
  })
  const row = (name: string): HTMLElement =>
    screen.getAllByTitle(name).map((el) => el.closest('li') as HTMLElement).find(Boolean)!

  it('offers Update when the catalog has a newer version, named with that version, and updates in place', async () => {
    let finish!: (outcome: Outcome) => void
    updateSkill.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTab({ skills: [pin('erp-lookup', { latestRevision: 4, updatable: true }), pin('csv-export')] })
    const button = await screen.findByRole('button', { name: 'Update erp-lookup to Version 4' })
    expect(button.getAttribute('title')).toBe('Update erp-lookup to Version 4')
    // Current: no Update, no Try again — only Remove.
    expect(within(row('csv-export')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove csv-export from this agent'
    ])
    fireEvent.click(button)
    await waitFor(() => expect(updateSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    // Busy inside the row; the other row waits.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update erp-lookup to Version 4' }) as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Remove csv-export from this agent' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, code: 'hash_mismatch', message: 'The download did not match the published skill, so nothing was kept.' }))
    // The refusal is that row's last line, in main's sentence.
    const alert = within(row('erp-lookup')).getByRole('alert')
    expect(alert.textContent).toBe('The download did not match the published skill, so nothing was kept.')
    expect(row('erp-lookup').firstElementChild!.lastElementChild).toBe(alert)
    expect(within(row('csv-export')).queryByRole('alert')).toBeNull()
  })

  it('offers Try again when the pinned version is not here, and shows that row’s own failure', async () => {
    ensureSkills.mockResolvedValue({
      ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'download_failed', message: 'This version is not available to you.' }]
    })
    renderTab({
      skills: [pin('erp-lookup', { deliverable: false, issues: [{ code: 'download_failed', message: 'It could not be downloaded.', severity: 'warning' }] })]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Download erp-lookup again' }))
    await waitFor(() => expect(ensureSkills).toHaveBeenCalledWith('folder:a'))
    expect((await within(row('erp-lookup')).findByRole('alert')).textContent).toBe('This version is not available to you.')
  })

  it('removes only after the confirm inside the card, which says what is kept', async () => {
    let finish!: (outcome: Outcome) => void
    removeSkill.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderTab({ skills: [pin('erp-lookup')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove erp-lookup from this agent' }))
    const confirm = screen.getByRole('group', { name: 'Remove erp-lookup from this agent' })
    expect(row('erp-lookup').contains(confirm)).toBe(true)
    // The recoverable part first, then the consequence; not shared, so nothing about the team.
    expect(confirm.querySelector('p')!.textContent).toBe(
      'Remove erp-lookup from this agent? It stays in the catalog; you can add it again. erp-lookup stops being available to this agent in new chats.'
    )
    // Cancel closes it with nothing done.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(removeSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove erp-lookup from this agent' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove skill' }))
    await waitFor(() => expect(removeSkill).toHaveBeenCalledWith('folder:a', 'erp-lookup'))
    // Undismissable while it runs.
    expect((within(confirm).getByRole('button', { name: 'Removing…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(confirm).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, code: 'manifest_modified', message: 'cinna-agent.json changed while the skill was downloading. Try again.' }))
    // A refusal keeps the confirm open and says why, last in the card.
    expect(within(confirm).getByRole('button', { name: 'Remove skill' })).toBeTruthy()
    expect(within(row('erp-lookup')).getByRole('alert').textContent).toBe('cinna-agent.json changed while the skill was downloading. Try again.')
  })

  it('hides Update and Remove on an agent shared with the user to use only', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'use' } }]
    renderTab({
      skills: [pin('erp-lookup', { latestRevision: 4, updatable: true, issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }] })]
    })
    // Fetching what the team's version pins is still theirs (U7).
    await screen.findByRole('button', { name: 'Download erp-lookup again' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove erp-lookup from this agent' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Update erp-lookup to Version 4' })).toBeNull()
  })

  it('names a catalog row by its catalog title, with the folder name in its tooltip, everywhere on the row', async () => {
    renderTab({ skills: [pin('erp-lookup', { title: 'ERP lookup', latestRevision: 4, latestVersion: '2.0', updatable: true })] })
    const name = await screen.findByText('ERP lookup')
    expect(name.getAttribute('title')).toBe('ERP lookup — erp-lookup')
    expect(await screen.findByRole('button', { name: 'Update ERP lookup to Version 4 (2.0)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove ERP lookup from this agent' }))
    expect(screen.getByRole('group', { name: 'Remove ERP lookup from this agent' }).querySelector('p')!.textContent).toContain(
      'ERP lookup stops being available to this agent in new chats.'
    )
  })

  it('on a shared agent the user can edit, the confirm says a Remove reaches the team only once shared', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: 'edit' } }]
    renderTab({ skills: [pin('erp-lookup')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove erp-lookup from this agent' }))
    expect(screen.getByRole('group', { name: 'Remove erp-lookup from this agent' }).querySelector('p')!.textContent).toMatch(
      /in new chats\. Share changes to pass this on to the team\.$/
    )
  })

  it('offers no Update or Remove while the share status is still loading', async () => {
    statusesPending = new Promise<never>(() => undefined)
    renderTab({ skills: [pin('erp-lookup', { latestRevision: 4, updatable: true })] })
    await screen.findByText('erp-lookup')
    expect(screen.queryByRole('button', { name: 'Remove erp-lookup from this agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update erp-lookup to Version 4' })).toBeNull()
  })

  it('offers no Update or Remove on a Cinna team agent whose access the listing does not know', async () => {
    shareStatuses = [{ agentId: 'folder:a', remote: { kind: 'cinna', access: null } }]
    renderTab({ skills: [pin('erp-lookup', { latestRevision: 4, updatable: true })] })
    await screen.findByText('erp-lookup')
    // Settled, and still not offered.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('button', { name: 'Remove erp-lookup from this agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update erp-lookup to Version 4' })).toBeNull()
  })

  it('Try again whose failure is the sentence already on the row says it once', async () => {
    const sentence = 'This version is not available to you.'
    ensureSkills.mockResolvedValue({ ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'download_failed', message: sentence }] })
    renderTab({ skills: [pin('erp-lookup', { deliverable: false, issues: [{ code: 'download_failed', message: sentence, severity: 'warning' }] })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Download erp-lookup again' }))
    await waitFor(() => expect(ensureSkills).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByRole('button', { name: 'Download erp-lookup again' }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(row('erp-lookup')).queryByRole('alert')).toBeNull()
    expect(within(row('erp-lookup')).getAllByText(sentence)).toHaveLength(1)
  })
})
