import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto, LocalAgentSkill } from '../../../../../shared/localAgents'
import type { SkillGetLatestOutcome, SkillPublishOutcome, SkillPublishPreviewOutcome } from '../../../../../shared/skillPublish'

/**
 * Share a skill, from the agent's Skills section: the row's icon action, its
 * "Version N" and Shared badge, and the dialog over the preview — loading, a
 * refused preview, the credential choices (and what a later version carries
 * over), first share against a later version (the row's or the preview's
 * word), Everyone over Can use, busy, and a refusal that closes nothing.
 */

const preview = vi.fn<(agentId: string, name: string) => Promise<SkillPublishPreviewOutcome>>()
const publish = vi.fn<(input: unknown) => Promise<SkillPublishOutcome>>()
const getLatest = vi.fn<(agentId: string, name: string, replace?: boolean) => Promise<SkillGetLatestOutcome>>()
window.api = {
  localAgents: { listMcpProviders: async () => [], openPath: async () => ({ success: true }) },
  mcp: { list: async () => [], onStatusChanged: () => () => {}, agentsUsing: async () => [] },
  sharing: {
    statuses: async () => ({ success: true, value: [] }),
    searchPeople: async () => ({ success: true, value: [{ userId: 'u-bob', email: 'bob@x.test', name: 'Bob' }] })
  },
  catalogSkills: {},
  catalog: { items: async () => ({ success: true, value: null }) },
  skillPublish: { preview, publish, getLatest }
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
    providersCarried: true,
    editablePackages: [],
    stale: null
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

async function openDialog(name = 'Publish erp-lookup…', title = 'Publish erp-lookup'): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('dialog', { name: title })
}

beforeEach(() => {
  vi.clearAllMocks()
  // A queued answer a test left unused must not reach the next one.
  preview.mockReset()
  getLatest.mockReset()
  preview.mockResolvedValue(READY)
})

describe('the Skills row', () => {
  it('offers Share on a shareable own skill, and nothing when it is not shareable', async () => {
    const view = renderTab([skill()])
    expect(await screen.findByRole('button', { name: 'Publish erp-lookup…' })).toBeTruthy()
    view.unmount()
    renderTab([skill({ shareable: false })])
    await screen.findByText('erp-lookup')
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull()
  })

  it('shows Version N and a Shared badge once shared, and offers a new version', async () => {
    renderTab([skill({ shared: { packageUuid: 'u', packageId: 'test.cinna.skill.erp-lookup', revisionNumber: 3 } })])
    expect(await screen.findByText('Version 3')).toBeTruthy()
    expect(screen.getByText('Published').getAttribute('title')).toBe('In the catalog as test.cinna.skill.erp-lookup')
    expect(screen.queryByText(/·/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Publish a new version of erp-lookup…' })).toBeTruthy()
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
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refused preview as the dialog’s error and does not offer Share', async () => {
    preview.mockResolvedValue({ ok: false, code: 'not_publisher', message: 'Ask a maintainer for edit access.' })
    renderTab([skill()])
    const dialog = await openDialog()
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Ask a maintainer for edit access.')
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
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
    dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    expect(within(dialog).getByText('People who can use it keep access.')).toBeTruthy()
    expect(within(dialog).queryByText('Who can use it')).toBeNull()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    await within(dialog).findByText('Version 1 (1.0.0)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
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
    expect(await screen.findByRole('dialog', { name: 'Publish a new version of erp-lookup' })).toBeTruthy()
    expect(screen.queryByText('Who can use it')).toBeNull()
    expect(screen.getByText('People who can use it keep access.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0][0]).toEqual({ agentId: 'folder:a', name: 'erp-lookup', releaseNotes: '', publisherCredentials: [] })
  })

  it('starts a later version from what the last one provided, and says when that could not be carried', async () => {
    preview.mockResolvedValue(later({}, 'cred-1'))
    const view = renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    let dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    await within(dialog).findByText('Version 4 (1.0.0)')
    const select = within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }) as HTMLSelectElement
    expect(select.value).toBe('cred-1')
    expect(select.title).toBe('ERP token')
    expect(within(dialog).queryByText(/not kept/)).toBeNull()
    view.unmount()

    preview.mockResolvedValue(later({ providersCarried: false }))
    const again = renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    expect(await within(dialog).findByText('Credentials you provided for the last version are not kept unless you pick them again.')).toBeTruthy()
    again.unmount()

    // An editor who did not first share it: core refuses their credentials, so none is offered.
    preview.mockResolvedValue(later({ canProvide: false, providersCarried: false }))
    renderTab([skill({ shared: { packageUuid: 'u', packageId: 'p', revisionNumber: 3 } })])
    dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    expect(await within(dialog).findByText('Credentials the first publisher provided are not kept — each person connects their own.')).toBeTruthy()
    const only = within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }) as HTMLSelectElement
    expect([...only.options].map((option) => option.textContent)).toEqual(['Each person connects their own'])
  })

  it('strikes a person at Can use while Everyone is ticked, in place, and does not send them', async () => {
    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 1, version: '1.0.0', packageUuid: 'u', packageId: 'p', recorded: true })
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByText('Version 1 (1.0.0)')
    fireEvent.change(within(dialog).getByLabelText('Find a person', { selector: 'input' }), { target: { value: 'bo' } })
    // The results list is portaled to the body, outside the dialog.
    fireEvent.click(await screen.findByRole('option', { name: 'Bob <bob@x.test>' }))
    const list = within(dialog).getByRole('list', { name: 'People' })
    expect(within(list).getByText('Bob').className).not.toContain('line-through')
    expect(within(list).getByText('bob@x.test')).toBeTruthy()
    expect(within(dialog).queryByText('Everyone can use it — Can use is not sent')).toBeNull()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Everyone on this server can use it' }))
    const name = within(list).getByText('Bob')
    expect(name.className).toContain('line-through')
    expect(name.getAttribute('title')).toBe('Bob <bob@x.test>: everyone can already use it, so Can use is not sent')
    expect(within(dialog).getByText('Everyone can use it — Can use is not sent')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0][0]).toMatchObject({ everyone: true, people: [{ userId: 'u-bob', access: 'use' }] })
  })

  it('pins its top and scrolls its fields between the heading and the buttons', async () => {
    renderTab([skill()])
    const dialog = await openDialog()
    expect(dialog.className).toContain('max-h-[calc(100vh-5rem)]')
    const body = dialog.querySelector('[data-share-skill-body]') as HTMLElement
    expect(body.className).toContain('overflow-y-auto')
    expect(body.contains(within(dialog).getByRole('button', { name: 'Publish' }))).toBe(false)
  })

  it('is busy and undismissable while sharing, then keeps a refusal on screen and closes nothing', async () => {
    let answer!: (outcome: SkillPublishOutcome) => void
    publish.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByText('Version 1 (1.0.0)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    const busy = await within(dialog).findByRole('button', { name: 'Publishing…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: 'Publish erp-lookup' })).toBeTruthy()

    answer({ ok: false, code: 'secrets', message: 'A file that can hold a secret is in this skill (.env).' })
    expect((await within(dialog).findByRole('alert')).textContent).toBe('A file that can hold a secret is in this skill (.env).')
    expect(screen.getByRole('dialog', { name: 'Publish erp-lookup' })).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

/** A first share's preview that finds packages of this name the person may edit (S6). */
function withCandidates(...publishers: string[]): SkillPublishPreviewOutcome {
  const base = (READY as Extract<SkillPublishPreviewOutcome, { ok: true }>).preview
  return {
    ok: true,
    preview: {
      ...base,
      editablePackages: publishers.map((publisher, index) => ({
        packageUuid: `pkg-${index}`,
        packageId: `test.cinna.skill.erp-lookup.${publisher.toLowerCase()}`,
        publisher,
        access: 'edit',
        latestRevisionNumber: 2 + index,
        latestVersion: '1.0.1'
      }))
    }
  }
}

describe('ShareSkillDialog: Share as, for a skill someone else shares (co-maintainers D4)', () => {
  it('defaults to the next version of the first editable package: its version and id, no access or credential choices', async () => {
    preview.mockResolvedValue(withCandidates('Ann', 'Cy'))
    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3, version: '1.0.2', packageUuid: 'pkg-0', packageId: 'p', recorded: true })
    renderTab([skill()])
    const dialog = await openDialog()
    const group = await within(dialog).findByRole('group', { name: 'Publish as' })
    expect(within(group).getAllByRole('radio').map((radio) => [radio.parentElement!.textContent, (radio as HTMLInputElement).checked])).toEqual([
      ['New version of Ann’s erp-lookup', true],
      ['New version of Cy’s erp-lookup', false],
      ['A separate skill', false]
    ])
    expect(within(dialog).getByText('Version 3')).toBeTruthy()
    expect(within(dialog).getByText('test.cinna.skill.erp-lookup.ann').tagName).toBe('CODE')
    // Who can use and the credential choices are not offered (left in place, hidden), a line says why.
    expect(within(dialog).queryByRole('checkbox', { name: 'Everyone on this server can use it' })).toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: 'What people need for erp.example.com' })).toBeNull()
    expect(within(dialog).getByText('Who can use it stays as Ann set it.')).toBeTruthy()
    expect(within(dialog).getByText('People who can use it keep access.')).toBeTruthy()

    fireEvent.click(within(group).getByRole('radio', { name: 'New version of Cy’s erp-lookup' }))
    expect(within(dialog).getByText('Version 4')).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'From B' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0][0]).toEqual({
      agentId: 'folder:a',
      name: 'erp-lookup',
      releaseNotes: 'From B',
      packageUuid: 'pkg-1',
      baseRevisionNumber: 3,
      publisherCredentials: []
    })
  })

  it('shares a separate skill as today’s first share, with new_package', async () => {
    preview.mockResolvedValue(withCandidates('Ann'))
    publish.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 1, version: '1.0.0', packageUuid: 'u', packageId: 'p', recorded: true })
    renderTab([skill()])
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'A separate skill' }))
    expect(within(dialog).getByText('Version 1 (1.0.0)')).toBeTruthy()
    expect(within(dialog).getByText('test.cinna.skill.erp-lookup').tagName).toBe('CODE')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'What people need for erp.example.com' }), { target: { value: 'cred-1' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Everyone on this server can use it' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0][0]).toEqual({
      agentId: 'folder:a',
      name: 'erp-lookup',
      releaseNotes: '',
      people: [],
      everyone: true,
      newPackage: true,
      publisherCredentials: [{ slot: 'erp.example.com', credentialId: 'cred-1' }]
    })
  })

  it('switching Share as moves nothing above the note: the choice-dependent blocks are below it', async () => {
    preview.mockResolvedValue(withCandidates('Ann'))
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByRole('group', { name: 'Publish as' })
    const body = dialog.querySelector('[data-share-skill-body]') as HTMLElement
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' })
    const noteRow = note.closest('label') as HTMLElement
    const upToNote = (): Element[] => {
      const rows = [...body.children]
      return rows.slice(0, rows.indexOf(noteRow) + 1)
    }
    const before = upToNote()
    // Share as, the intro (one sentence swapped in one cell), the version and id, then the note.
    expect(before[0]).toBe(within(dialog).getByRole('group', { name: 'Publish as' }))
    expect(before).toHaveLength(4)
    const swaps = [...dialog.querySelectorAll('[data-share-swap]')]
    expect(swaps).toHaveLength(1)
    expect(before[1]).toBe(swaps[0])
    // Below the note: what the next version keeps, as lines.
    expect(noteRow.nextElementSibling!.hasAttribute('data-share-keeps-access')).toBe(true)
    expect(body.lastElementChild!.hasAttribute('data-share-keeps-providers')).toBe(true)

    fireEvent.click(within(dialog).getByRole('radio', { name: 'A separate skill' }))
    // The same elements, in the same order, up to and including the note.
    const after = upToNote()
    expect(after).toHaveLength(before.length)
    after.forEach((element, index) => expect(element).toBe(before[index]))
    // Who can use and the credential choices appear below it.
    const below = [...body.children].slice(after.length)
    expect(below.some((row) => within(row as HTMLElement).queryByRole('checkbox', { name: 'Everyone on this server can use it' }))).toBe(true)
    expect(below.some((row) => within(row as HTMLElement).queryByRole('combobox', { name: 'What people need for erp.example.com' }))).toBe(true)
    expect(dialog.querySelector('[data-share-keeps-access]')).toBeNull()

    fireEvent.click(within(dialog).getByRole('radio', { name: 'New version of Ann’s erp-lookup' }))
    upToNote().forEach((element, index) => expect(element).toBe(before[index]))
  })

  it('keeps the note disabled and unfocused until the preview answers, then focuses it', async () => {
    let answer!: (outcome: SkillPublishPreviewOutcome) => void
    preview.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    renderTab([skill()])
    const dialog = await openDialog()
    const note = within(dialog).getByRole('textbox', { name: 'Note (optional)' }) as HTMLTextAreaElement
    expect(note.disabled).toBe(true)
    expect(document.activeElement).not.toBe(note)
    answer(withCandidates('Ann'))
    await within(dialog).findByRole('group', { name: 'Publish as' })
    await waitFor(() => expect(note.disabled).toBe(false))
    expect(document.activeElement).toBe(note)
  })

  it('previews again when the share finds an editable package the preview did not list, and stays open', async () => {
    preview.mockResolvedValueOnce(READY).mockResolvedValueOnce(withCandidates('Ann'))
    publish.mockResolvedValue({
      ok: false,
      code: 'editable_package_exists',
      message: 'You can edit Ann’s skill. Share this as a new version of it, or as a separate skill.',
      candidates: []
    })
    renderTab([skill()])
    const dialog = await openDialog()
    await within(dialog).findByText('Version 1 (1.0.0)')
    expect(within(dialog).queryByRole('group', { name: 'Publish as' })).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Kept' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    expect(await within(dialog).findByRole('group', { name: 'Publish as' })).toBeTruthy()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(within(dialog).getByRole('radio', { name: 'New version of Ann’s erp-lookup' }) as HTMLInputElement).toHaveProperty('checked', true)
    expect((within(dialog).getByRole('textbox', { name: 'Note (optional)' }) as HTMLTextAreaElement).value).toBe('Kept')
    expect(screen.getByRole('dialog', { name: 'Publish erp-lookup' })).toBeTruthy()
  })
})

describe('ShareSkillDialog: a copy behind the package (co-maintainers D4)', () => {
  const shared = { packageUuid: 'u', packageId: 'p', revisionNumber: 2 }

  it('says so before Share when the preview is stale, disables Share, and after Get Version N previews again', async () => {
    preview.mockResolvedValueOnce(later({ stale: { latestRevision: 3, version: '1.0.2', publishedBy: 'Ann' } })).mockResolvedValueOnce(later())
    let done!: (outcome: SkillGetLatestOutcome) => void
    getLatest.mockReturnValue(new Promise((resolve) => { done = resolve }))
    renderTab([skill({ shared, sync: 'behind', latest: { revisionNumber: 3, version: '1.0.2', publishedBy: 'Ann' } })])
    const dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    const alert = await within(dialog).findByRole('alert')
    expect(alert.querySelector('p')!.textContent).toBe('Ann published Version 3 since your copy. Get it first, then publish your changes.')
    // Last before the buttons (rule 6).
    expect(alert.nextElementSibling).toBe(within(dialog).getByRole('button', { name: 'Publish' }).parentElement)
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(alert).getByRole('button', { name: 'Get Version 3' }))
    await waitFor(() => expect(getLatest).toHaveBeenCalledWith('folder:a', 'erp-lookup', false))
    expect((await within(dialog).findByRole('button', { name: 'Getting…' }) as HTMLButtonElement).disabled).toBe(true)
    done({ ok: true, name: 'erp-lookup', revisionNumber: 3, version: '1.0.2', backupPath: null })
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
    expect(preview).toHaveBeenCalledTimes(2)
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the dialog and the note on a stale refusal; Get is offered only over a folder without unshared changes', async () => {
    preview.mockResolvedValue(later())
    publish.mockResolvedValue({
      ok: false,
      code: 'stale',
      message: 'Ann published Version 3 since your copy. Get it first, then publish your changes.',
      stale: { latestRevision: 3, version: null, publishedBy: 'Ann' }
    })
    const view = renderTab([skill({ shared, sync: 'in_sync' })])
    let dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    await within(dialog).findByText('Version 4 (1.0.0)')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'Mine' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    const alert = await within(dialog).findByRole('alert')
    // One sentence, not the stale line and the same refusal again.
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1)
    expect(alert.querySelector('p')!.textContent).toBe('Ann published Version 3 since your copy. Get it first, then publish your changes.')
    expect(within(alert).getByRole('button', { name: 'Get Version 3' })).toBeTruthy()
    expect(alert.querySelector('[data-share-stale-changes]')).toBeNull()
    expect((within(dialog).getByRole('textbox', { name: 'Note (optional)' }) as HTMLTextAreaElement).value).toBe('Mine')
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()

    renderTab([skill({ shared, sync: 'changed' })])
    dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    await within(dialog).findByText('Version 4 (1.0.0)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    const changed = await within(dialog).findByRole('alert')
    expect(changed.querySelector('p')!.textContent).toBe('Ann published Version 3 since your copy. Get it first, then publish your changes.')
    expect(within(changed).queryByRole('button')).toBeNull()
    // No Get over unshared changes: a sentence points at Replace on the row.
    expect(changed.querySelector('[data-share-stale-changes]')!.textContent).toBe(
      'Your copy has changes that were never published. Replace on the skill’s row gets Version 3 and keeps your files in a backup folder.'
    )
  })

  it('shows a failed Get in the dialog and keeps Share disabled', async () => {
    preview.mockResolvedValue(later({ stale: { latestRevision: 3, version: null, publishedBy: null } }))
    getLatest.mockResolvedValue({ ok: false, code: 'download_failed', message: 'The newer version couldn’t be downloaded. Nothing was changed.' })
    renderTab([skill({ shared, sync: 'behind' })])
    const dialog = await openDialog('Publish a new version of erp-lookup…', 'Publish a new version of erp-lookup')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Get Version 3' }))
    await waitFor(() => expect(within(dialog).getAllByRole('alert')).toHaveLength(2))
    expect(within(dialog).getAllByRole('alert')[0].querySelector('p')!.textContent).toBe('Someone published Version 3 since your copy. Get it first, then publish your changes.')
    expect(within(dialog).getAllByRole('alert')[1].textContent).toBe('The newer version couldn’t be downloaded. Nothing was changed.')
    expect((within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
