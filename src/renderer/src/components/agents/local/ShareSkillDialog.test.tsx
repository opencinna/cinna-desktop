import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto, LocalAgentSkill } from '../../../../../shared/localAgents'
import type { SkillPublishOutcome, SkillPublishPreviewOutcome } from '../../../../../shared/skillPublish'

/**
 * Share a skill, from the agent's Skills section: the row's icon action, its
 * "Version N" and Shared badge, and the dialog over the preview — loading, a
 * refused preview, the credential choices (and what a later version carries
 * over), first share against a later version (the row's or the preview's
 * word), Everyone over Can use, busy, and a refusal that closes nothing.
 */

const preview = vi.fn<(agentId: string, name: string) => Promise<SkillPublishPreviewOutcome>>()
const publish = vi.fn<(input: unknown) => Promise<SkillPublishOutcome>>()
window.api = {
  localAgents: { listMcpProviders: async () => [], openPath: async () => ({ success: true }) },
  mcp: { list: async () => [], onStatusChanged: () => () => {}, agentsUsing: async () => [] },
  sharing: {
    statuses: async () => ({ success: true, value: [] }),
    searchPeople: async () => ({ success: true, value: [{ userId: 'u-bob', email: 'bob@x.test', name: 'Bob' }] })
  },
  catalogSkills: {},
  catalog: { items: async () => ({ success: true, value: null }) },
  skillPublish: { preview, publish }
} as never

const { AgentAddonsTab } = await import('./AgentAddonsTab')

const READY: SkillPublishPreviewOutcome = {
  ok: true,
  preview: {
    name: 'erp-lookup',
    version: '1.0.0',
    packageId: 'test.cinna.skill.erp-lookup',
    packageIdDisambiguated: false,
    packageUuid: null,
    isRepublish: false,
    nextRevisionNumber: 1,
    credentials: [
      {
        slot: 'erp.example.com',
        type: 'api_token',
        description: null,
        candidates: [{ id: 'cred-1', name: 'ERP token', type: 'api_token', canProvideAs: ['publisher'] }],
        current: null
      }
    ],
    canProvide: true,
    providersCarried: true
  }
}

/** A later version's preview: the package exists, with what its latest version carried. */
function later(over: Partial<Extract<SkillPublishPreviewOutcome, { ok: true }>['preview']> = {}, current: string | null = null): SkillPublishPreviewOutcome {
  const base = (READY as Extract<SkillPublishPreviewOutcome, { ok: true }>).preview
  return {
    ok: true,
    preview: {
      ...base,
      packageUuid: 'u',
      isRepublish: true,
      nextRevisionNumber: 4,
      credentials: base.credentials.map((slot) => ({ ...slot, current })),
      ...over
    }
  }
}

function skill(over: Partial<LocalAgentSkill> = {}): LocalAgentSkill {
  return {
    name: 'erp-lookup',
    description: 'Look things up.',
    version: null,
    source: 'authored',
    path: 'skills/erp-lookup/SKILL.md',
    deliverable: true,
    issues: [],
    credentials: [{ slot: 'erp.example.com', type: 'api_token', description: null }],
    shared: null,
    shareable: true,
    ...over
  }
}

function renderTab(skills: LocalAgentSkill[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const agent = { id: 'folder:a', kind: 'kit', skills } as unknown as LocalAgentDto
  return render(createElement(QueryClientProvider, { client }, createElement(AgentAddonsTab, { agent })))
}

async function openDialog(name = 'Share erp-lookup…', title = 'Share erp-lookup'): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('dialog', { name: title })
}

beforeEach(() => {
  vi.clearAllMocks()
  preview.mockResolvedValue(READY)
})

describe('the Skills row', () => {
  it('offers Share on a shareable own skill, and nothing when it is not shareable', async () => {
    const view = renderTab([skill()])
    expect(await screen.findByRole('button', { name: 'Share erp-lookup…' })).toBeTruthy()
    view.unmount()
    renderTab([skill({ shareable: false })])
    await screen.findByText('erp-lookup')
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull()
  })

  it('shows Version N and a Shared badge once shared, and offers a new version', async () => {
    renderTab([skill({ shared: { packageUuid: 'u', packageId: 'test.cinna.skill.erp-lookup', revisionNumber: 3 } })])
    expect(await screen.findByText('Version 3')).toBeTruthy()
    expect(screen.getByText('Shared').getAttribute('title')).toBe('In the catalog as test.cinna.skill.erp-lookup')
    expect(screen.queryByText(/·/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Share a new version of erp-lookup…' })).toBeTruthy()
  })
})

describe('ShareSkillDialog', () => {
  it('holds every row while the preview loads, with Share and the slot choice disabled', async () => {
    preview.mockReturnValue(new Promise(() => {}))
    renderTab([skill()])
    const dialog = await openDialog()
    expect(preview).toHaveBeenCalledWith('folder:a', 'erp-lookup')
    expect(within(dialog).getAllByText('Loading…')).toHaveLength(2)
    expect((within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }) as HTMLSelectElement).disabled).toBe(true)
    expect((within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refused preview as the dialog’s error and does not offer Share', async () => {
    preview.mockResolvedValue({ ok: false, code: 'not_publisher', message: 'Ask a maintainer for edit access.' })
    renderTab([skill()])
    const dialog = await openDialog()
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Ask a maintainer for edit access.')
    expect((within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the version and catalog id, picks no credential by default, and sends the choices made', async () => {
    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 1, version: '1.0.0', packageUuid: 'u', packageId: 'p', recorded: true })
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByText('Version 1 (1.0.0)')
    expect(within(dialog).getByText('test.cinna.skill.erp-lookup').tagName).toBe('CODE')
    const select = within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }) as HTMLSelectElement
    expect(select.disabled).toBe(false)
    expect([...select.options].map((option) => option.textContent)).toEqual(['Each person connects their own', 'ERP token'])
    expect(select.value).toBe('')
    expect(within(dialog).queryByText(/not kept/)).toBeNull()
    fireEvent.change(select, { target: { value: 'cred-1' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'First cut' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Everyone on this server can use it' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(publish).toHaveBeenCalledWith({
      agentId: 'folder:a',
      name: 'erp-lookup',
      releaseNotes: 'First cut',
      people: [],
      everyone: true,
      publisherCredentials: [{ slot: 'erp.example.com', credentialId: 'cred-1' }]
    })
  })

  it('asks who can use it on a first share only; a later version says access stays', async () => {
    const view = renderTab([skill()])
    let dialog = await openDialog()
    expect(within(dialog).getByText('Who can use it')).toBeTruthy()
    expect(within(dialog).getByRole('list', { name: 'People' })).toBeTruthy()
    expect(within(dialog).queryByText('People who can use it keep access.')).toBeNull()
    view.unmount()

    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 4, version: '1.0.3', packageUuid: 'u', packageId: 'p', recorded: true })
    renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    dialog = await openDialog('Share a new version of erp-lookup…', 'Share a new version of erp-lookup')
    expect(within(dialog).getByText('People who can use it keep access.')).toBeTruthy()
    expect(within(dialog).queryByText('Who can use it')).toBeNull()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    await within(dialog).findByText('Version 1 (1.0.0)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    // No access in a later version's request.
    expect(publish.mock.calls[0][0]).toEqual({ agentId: 'folder:a', name: 'erp-lookup', releaseNotes: '', publisherCredentials: [] })
  })

  it('is a later version when the preview finds the package, though the row was not shared', async () => {
    let answer!: (outcome: SkillPublishPreviewOutcome) => void
    preview.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 4, version: '1.0.3', packageUuid: 'u', packageId: 'p', recorded: true })
    renderTab([skill()])
    const dialog = await openDialog()
    // Until the preview says, who can use it is not yet a choice.
    expect((within(dialog).getByRole('checkbox', { name: 'Everyone on this server can use it' }) as HTMLInputElement).disabled).toBe(true)
    expect((within(dialog).getByLabelText('Find a person', { selector: 'input' }) as HTMLInputElement).disabled).toBe(true)
    answer(later())
    expect(await screen.findByRole('dialog', { name: 'Share a new version of erp-lookup' })).toBeTruthy()
    expect(screen.queryByText('Who can use it')).toBeNull()
    expect(screen.getByText('People who can use it keep access.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0][0]).toEqual({ agentId: 'folder:a', name: 'erp-lookup', releaseNotes: '', publisherCredentials: [] })
  })

  it('starts a later version from what the last one provided, and says when that could not be carried', async () => {
    preview.mockResolvedValue(later({}, 'cred-1'))
    const view = renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    let dialog = await openDialog('Share a new version of erp-lookup…', 'Share a new version of erp-lookup')
    await within(dialog).findByText('Version 4 (1.0.0)')
    const select = within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }) as HTMLSelectElement
    expect(select.value).toBe('cred-1')
    expect(select.title).toBe('ERP token')
    expect(within(dialog).queryByText(/not kept/)).toBeNull()
    view.unmount()

    preview.mockResolvedValue(later({ providersCarried: false }))
    const again = renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    dialog = await openDialog('Share a new version of erp-lookup…', 'Share a new version of erp-lookup')
    expect(await within(dialog).findByText('Credentials you provided for the last version are not kept unless you pick them again.')).toBeTruthy()
    again.unmount()

    // An editor who did not first share it: core refuses their credentials, so none is offered.
    preview.mockResolvedValue(later({ canProvide: false, providersCarried: false }))
    renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    dialog = await openDialog('Share a new version of erp-lookup…', 'Share a new version of erp-lookup')
    expect(await within(dialog).findByText('Credentials the first sharer provided are not kept — each person connects their own.')).toBeTruthy()
    const only = within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }) as HTMLSelectElement
    expect([...only.options].map((option) => option.textContent)).toEqual(['Each person connects their own'])
  })

  it('strikes a person at Can use while Everyone is ticked, in place, and does not send them', async () => {
    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 1, version: '1.0.0', packageUuid: 'u', packageId: 'p', recorded: true })
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByText('Version 1 (1.0.0)')
    fireEvent.change(within(dialog).getByLabelText('Find a person', { selector: 'input' }), { target: { value: 'bo' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Bob <bob@x.test>' }))
    const list = within(dialog).getByRole('list', { name: 'People' })
    expect(within(list).getByText('Bob <bob@x.test>').className).not.toContain('line-through')
    expect(within(dialog).queryByText('Everyone can use it — Can use is not sent')).toBeNull()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Everyone on this server can use it' }))
    const name = within(list).getByText('Bob <bob@x.test>')
    expect(name.className).toContain('line-through')
    expect(name.getAttribute('title')).toBe('Bob <bob@x.test>: everyone can already use it, so Can use is not sent')
    expect(within(dialog).getByText('Everyone can use it — Can use is not sent')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0][0]).toMatchObject({ everyone: true, people: [{ userId: 'u-bob', access: 'use' }] })
  })

  it('pins its top and scrolls its fields between the heading and the buttons', async () => {
    renderTab([skill()])
    const dialog = await openDialog()
    expect(dialog.className).toContain('max-h-[calc(100vh-5rem)]')
    const body = dialog.querySelector('[data-share-skill-body]') as HTMLElement
    expect(body.className).toContain('overflow-y-auto')
    expect(body.contains(within(dialog).getByRole('button', { name: 'Share' }))).toBe(false)
  })

  it('is busy and undismissable while sharing, then keeps a refusal on screen and closes nothing', async () => {
    let answer!: (outcome: SkillPublishOutcome) => void
    publish.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByText('Version 1 (1.0.0)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }))
    const busy = await within(dialog).findByRole('button', { name: 'Sharing…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: 'Share erp-lookup' })).toBeTruthy()

    answer({ ok: false, code: 'secrets', message: 'A file that can hold a secret is in this skill (.env).' })
    expect((await within(dialog).findByRole('alert')).textContent).toBe('A file that can hold a secret is in this skill (.env).')
    expect(screen.getByRole('dialog', { name: 'Share erp-lookup' })).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
