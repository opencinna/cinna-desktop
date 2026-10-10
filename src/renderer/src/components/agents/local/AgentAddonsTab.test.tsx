import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
window.api = {
  localAgents: { listMcpProviders, attachMcpProvider, detachMcpProvider, openPath },
  mcp: { list: async () => providers, onStatusChanged: () => () => {}, upsert, agentsUsing: async () => [] }
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
    expect(within(items[0]).getByText('Version 1.2.0')).toBeTruthy()
    expect(within(items[1]).getByText('Revision 3')).toBeTruthy()
    expect(within(items[0]).getByRole('img', { name: 'Not on this computer yet.' })).toBeTruthy()
    expect(within(items[0]).queryByRole('button')).toBeNull()
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
