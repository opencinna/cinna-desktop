import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DetectedTool } from '../../../../../shared/localTools'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The new-agent flow's contract with main and with the settings:
 *
 * - a name alone is a complete request — `description` is *absent* from the
 *   payload, not empty, and no AI draft is queued for it;
 * - a description given under More options travels and queues the draft;
 * - the second step launches the picked tool at the new folder and makes it
 *   the default;
 * - with auto-open on, there is no second step.
 */

const CLAUDE: DetectedTool = {
  id: 'claude',
  kind: 'cli-assistant',
  label: 'Claude Code',
  path: '/usr/local/bin/claude',
  available: true,
  version: null,
  source: 'path'
}
const CODEX: DetectedTool = { ...CLAUDE, id: 'codex', label: 'Codex' }

const CREATED = {
  id: 'folder:new',
  name: 'Invoice watcher',
  path: '/tmp/agents/Local/invoice-watcher'
} as LocalAgentDto

let defaultTool: DetectedTool | null = null
let autoOpen = false
const create = vi.fn()
const openIn = vi.fn()
const setDefaultTool = vi.fn()
const setSetting = vi.fn()
const setActiveLocalAgentId = vi.fn()
const setPendingDraftAgentId = vi.fn()
const setActiveView = vi.fn()
const pickFolder = vi.fn()
const addFolder = vi.fn()

vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveLocalAgentId, setPendingDraftAgentId, setActiveView })
}))
vi.mock('../../../hooks/useLocalAgents', () => ({
  useAgentRoots: () => ({
    data: [{ id: 'root-1', label: 'Agents', path: '/tmp/agents', isDefault: true }]
  }),
  useCreateLocalAgent: () => ({ mutate: create, isPending: false }),
  usePickAgentFolder: () => ({ mutate: pickFolder, isPending: false }),
  useAddAgentFolder: () => ({ mutate: addFolder, isPending: false })
}))
vi.mock('../../../hooks/useLocalTools', () => ({
  useDefaultTool: () => ({ tool: defaultTool, launchable: [CLAUDE, CODEX], autoOpen }),
  useOpenIn: () => ({ mutate: openIn, isPending: false }),
  useSetDefaultTool: () => setDefaultTool
}))
vi.mock('../../../hooks/useAppSettings', () => ({
  useSetAppSetting: () => ({ mutate: setSetting })
}))

const { NewLocalAgentModal } = await import('./NewLocalAgentModal')

/** Resolve the create mutation the way react-query would, through `onSuccess`. */
function succeedCreate(): void {
  const [, options] = create.mock.calls[0] as [unknown, { onSuccess: (a: LocalAgentDto) => void }]
  act(() => options.onSuccess(CREATED))
}

type OpenInOptions = { onSuccess: () => void; onError: (err: Error) => void }
function lastOpenIn(): { request: Record<string, unknown>; options: OpenInOptions } {
  const [request, options] = openIn.mock.calls[0] as [Record<string, unknown>, OpenInOptions]
  return { request, options }
}

/** Render the dialog. It opens on the choice step. */
function openChoice(): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  render(createElement(NewLocalAgentModal, { onClose }))
  return { onClose }
}

/**
 * Open the dialog on the **New agent** step.
 *
 * The dialog now opens on a choice — new agent, or an existing folder — so
 * every test about naming and scaffolding clicks through that first. Tests
 * about the choice itself, and about adding a folder, use {@link openChoice}.
 */
function open(): { onClose: ReturnType<typeof vi.fn> } {
  const { onClose } = openChoice()
  fireEvent.click(screen.getByRole('button', { name: /New agent/ }))
  return { onClose }
}

afterEach(() => {
  vi.clearAllMocks()
  defaultTool = null
  autoOpen = false
})

describe('NewLocalAgentModal', () => {
  it('creates from a name alone, sending no description and queueing no draft', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    expect(create).toHaveBeenCalledTimes(1)
    const [input] = create.mock.calls[0] as [Record<string, unknown>]
    expect(input).toEqual({ name: 'Invoice watcher', slug: 'invoice-watcher', rootId: 'root-1' })
    expect('description' in input).toBe(false)

    succeedCreate()
    await waitFor(() => expect(screen.getByRole('dialog', { name: /build it with/i })).toBeTruthy())
    expect(setActiveLocalAgentId).toHaveBeenCalledWith('folder:new')
    expect(setActiveView).toHaveBeenCalledWith('local-agent')
    expect(setPendingDraftAgentId).not.toHaveBeenCalled()
  })

  it('submits on Enter — one name, one key', () => {
    open()
    const name = screen.getByLabelText('Name')
    fireEvent.change(name, { target: { value: 'Invoice watcher' } })
    fireEvent.submit(name)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('sends a description given under More options and queues the draft for it', () => {
    open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /more options/i }))
    fireEvent.change(screen.getByLabelText(/what should it do/i), {
      target: { value: 'Flags invoices with no PO number.' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    const [input] = create.mock.calls[0] as [Record<string, unknown>]
    expect(input.description).toBe('Flags invoices with no PO number.')
    succeedCreate()
    expect(setPendingDraftAgentId).toHaveBeenCalledWith('folder:new')
  })

  it('launches the picked tool at the new folder, remembers it, and closes', async () => {
    const { onClose } = open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    succeedCreate()
    await waitFor(() => screen.getByRole('button', { name: /codex/i }))

    fireEvent.click(screen.getByRole('checkbox', { name: /without asking/i }))
    fireEvent.click(screen.getByRole('button', { name: /codex/i }))

    expect(setDefaultTool).toHaveBeenCalledWith('codex')
    expect(setSetting).toHaveBeenCalledWith({ key: 'localAgentsAutoOpen', value: true })
    expect(lastOpenIn().request).toEqual({
      folder: CREATED.path,
      toolId: 'codex',
      action: 'terminal-command'
    })
    // Closed once the tool has actually opened, not on the click.
    expect(onClose).not.toHaveBeenCalled()
    act(() => lastOpenIn().options.onSuccess())
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open and says why when the tool could not be opened', async () => {
    const { onClose } = open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    succeedCreate()
    await waitFor(() => screen.getByRole('button', { name: /codex/i }))
    fireEvent.click(screen.getByRole('button', { name: /codex/i }))

    act(() => lastOpenIn().options.onError(new Error('Terminal automation was denied.')))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /build it with/i })).toBeTruthy()
    expect(screen.getByText(/automation was denied/i)).toBeTruthy()
  })

  it('skips the tool step entirely when auto-open is on and the default is installed', () => {
    defaultTool = CLAUDE
    autoOpen = true
    const { onClose } = open()
    expect(screen.getByRole('button', { name: /create and open in claude code/i })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /create and open/i }))
    succeedCreate()

    expect(lastOpenIn().request).toEqual({
      folder: CREATED.path,
      toolId: 'claude',
      action: 'terminal-command'
    })
    expect(screen.queryByRole('dialog', { name: /build it with/i })).toBeNull()
    act(() => lastOpenIn().options.onSuccess())
    expect(onClose).toHaveBeenCalled()
  })

  it('falls back to the tool step when the automatic open fails', () => {
    defaultTool = CLAUDE
    autoOpen = true
    const { onClose } = open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /create and open/i }))
    succeedCreate()

    act(() => lastOpenIn().options.onError(new Error('claude is no longer installed.')))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /build it with/i })).toBeTruthy()
    expect(screen.getByText(/no longer installed/i)).toBeTruthy()
    // The folder exists and the page is behind the modal either way.
    expect(setActiveLocalAgentId).toHaveBeenCalledWith('folder:new')
  })

  it('never inserts a hint under the name while typing — the dialog must not jump', () => {
    // One character makes an adjusted slug ("1-agent"); the sentence explaining
    // that used to appear on this keystroke and vanish on the next, resizing
    // the dialog twice. The path preview already shows the result.
    open()
    const name = screen.getByLabelText('Name')
    fireEvent.change(name, { target: { value: '1' } })
    expect(screen.queryByText(/folder names/i)).toBeNull()
    expect(screen.getByText('1-agent')).toBeTruthy()
    fireEvent.change(name, { target: { value: '12' } })
    expect(screen.queryByText(/folder names/i)).toBeNull()
    expect(screen.getByText('12')).toBeTruthy()
  })

  it('mirrors the auto-open setting in the checkbox and turns it off when unticked', async () => {
    defaultTool = CLAUDE
    autoOpen = true
    open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invoice watcher' } })
    fireEvent.click(screen.getByRole('button', { name: /create and open/i }))
    succeedCreate()
    // The automatic open failed, so the tool step shows — with the box
    // reflecting the setting that is actually on.
    act(() => lastOpenIn().options.onError(new Error('nope')))
    const box = screen.getByRole('checkbox', { name: /without asking/i }) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: /codex/i }))
    expect(setSetting).toHaveBeenCalledWith({ key: 'localAgentsAutoOpen', value: false })
  })

  it('keeps a reserved line for errors so the buttons never move', () => {
    open()
    // Present before any error: the slot is part of the layout, not inserted.
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
  })

  it('will not create without a name', () => {
    open()
    const button = screen.getByRole('button', { name: /^create$/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})

/**
 * The other half of the fork: pointing at a folder that is already an agent.
 *
 * What has to hold is that nothing is registered until the user has seen what
 * was found, that a refusal keeps the dialog open, and that the path sent back
 * is the one the picker returned rather than anything the form composed.
 */
describe('NewLocalAgentModal — add a folder', () => {
  type PickOptions = { onSuccess: (result: unknown) => void; onError: (err: Error) => void }
  function resolvePick(result: unknown): void {
    const [, options] = pickFolder.mock.calls[0] as [unknown, PickOptions]
    act(() => options.onSuccess(result))
  }

  const FOUND_ONE = {
    cancelled: false,
    path: '/repo/alpha',
    folderName: 'alpha',
    refusal: null,
    truncated: false,
    reselecting: null,
    found: [
      {
        relPath: '.',
        path: '/repo/alpha',
        name: 'Invoice watcher',
        hasReadme: true,
        alreadyAdded: false,
        addedElsewhere: false
      }
    ]
  }
  const FOUND_MANY = {
    cancelled: false,
    path: '/repo',
    folderName: 'repo',
    refusal: null,
    truncated: false,
    reselecting: null,
    found: [
      {
        relPath: 'local_agents/alpha',
        path: '/repo/local_agents/alpha',
        name: 'Alpha',
        hasReadme: true,
        alreadyAdded: false,
        addedElsewhere: false
      },
      {
        relPath: 'local_agents/beta',
        path: '/repo/local_agents/beta',
        name: 'Beta',
        hasReadme: false,
        alreadyAdded: false,
        addedElsewhere: false
      },
      {
        relPath: 'local_agents/gamma',
        path: '/repo/local_agents/gamma',
        name: 'Gamma',
        hasReadme: false,
        alreadyAdded: true,
        addedElsewhere: true
      }
    ]
  }

  it('opens on a choice, not on a name field', () => {
    openChoice()
    expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBeTruthy()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByRole('button', { name: /Add a folder/ })).toBeTruthy()
  })

  it('names the single agent, and sends the picker’s own path back', () => {
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick(FOUND_ONE)

    // Prefilled from the AGENT.md heading — one Enter is a complete answer.
    const field = screen.getByLabelText('Name') as HTMLInputElement
    expect(field.value).toBe('Invoice watcher')
    fireEvent.change(field, { target: { value: 'My watcher' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))

    const [payload] = addFolder.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({ path: '/repo/alpha', relPaths: ['.'], name: 'My watcher' })
  })

  it('lands the user on the agent it just added', () => {
    // ux_rules rule 3: creating lands you on the thing created, and adopting is
    // a create in every sense the user cares about. Closing straight to the
    // empty pane left them reading "Select an agent from the sidebar" with the
    // agent they had just added sitting unselected behind it.
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick(FOUND_MANY)
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }))

    const [, options] = addFolder.mock.calls[0] as [
      unknown,
      { onSuccess: (r: { root: unknown; agentIds: string[] }) => void }
    ]
    act(() =>
      options.onSuccess({ root: {}, agentIds: ['folder:external:r1:a', 'folder:external:r1:b'] })
    )

    expect(setActiveLocalAgentId).toHaveBeenCalledWith('folder:external:r1:a')
    expect(setActiveView).toHaveBeenCalledWith('local-agent')
  })

  it('ticks everything addable and leaves the already-added ones out of the payload', () => {
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick(FOUND_MANY)

    // No name field for several: naming fifteen folders at adoption time is
    // work nobody asked for, and each one already has a name in its AGENT.md.
    expect(screen.queryByLabelText('Name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }))

    const [payload] = addFolder.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({
      path: '/repo',
      relPaths: ['local_agents/alpha', 'local_agents/beta']
    })
  })

  it('never truncates away the folder name in the picked path', () => {
    // The confirm step's one job is answering "which folder", and a plain
    // `truncate` cuts from the right — removing the only part of a path that
    // identifies it. The basename is in its own non-shrinking span, so it is on
    // screen at any width; the parent directory is the half that ellipsises.
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({
      ...FOUND_ONE,
      path: '/Users/me/Documents/work/clients/acme/old-invoice-agent-v2'
    })

    const leaf = screen.getByText('old-invoice-agent-v2')
    expect(leaf.className).toContain('shrink-0')
    expect(leaf.className).not.toContain('truncate')
    expect(screen.getByText('/Users/me/Documents/work/clients/acme/').className).toContain(
      'truncate'
    )
  })

  it('says so when the walk stopped at its cap', () => {
    // Otherwise the header reads "N agents in <folder>" over the first N by
    // path — every count true, and all of them true of the wrong set. The user
    // ticks Select all, the agents they came for are absent, and they read that
    // as the scanner having missed those folders.
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({ ...FOUND_MANY, truncated: true })

    expect(screen.getByText(/first 3 folders found/)).toBeTruthy()
  })

  it('says nothing about a cap it did not hit', () => {
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick(FOUND_MANY)

    expect(screen.queryByText(/folders found/)).toBeNull()
  })

  it('re-picking a registered folder opens on what is in the app, and can change it', () => {
    // The refusal this replaced ("already registered as …") left a user who
    // ticked one agent out of three with no way to add the others: the ⋯ menu
    // removes one at a time and Settings restores all of them at once.
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({
      ...FOUND_MANY,
      reselecting: { rootId: 'r1', label: 'repo' },
      found: FOUND_MANY.found.map((entry) => ({
        ...entry,
        alreadyAdded: entry.relPath === 'local_agents/alpha',
        addedElsewhere: false
      }))
    })

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // Opens on the state the app is actually in: alpha in, the others out. So
    // confirming without touching anything changes nothing, and an agent the
    // user removed earlier is not silently put back.
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false])
    // And the one already in the list is editable — unticking it is how it
    // leaves — where a row added under another root stays disabled.
    expect(boxes.map((box) => box.disabled)).toEqual([false, false, false])

    fireEvent.click(boxes[1])
    fireEvent.click(boxes[0])
    expect(screen.getByText('1 to add, 1 to remove from the list.')).toBeTruthy()

    // Removing confirms first, naming the agent and saying what does not come
    // back with it (ux_rules rule 5) — the same act as ⋯ → Remove from the list.
    fireEvent.click(screen.getByRole('button', { name: 'Save selection' }))
    expect(addFolder).not.toHaveBeenCalled()
    const confirm = screen.getByText(/any job that uses one will refuse to run/)
    // The agent is named in the confirmation, not merely counted (rule 5).
    expect(confirm.textContent).toContain('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Remove and save' }))
    const [payload] = addFolder.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({ path: '/repo', relPaths: ['local_agents/beta'] })
  })

  it('adds without a confirmation when nothing is being removed', () => {
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({
      ...FOUND_MANY,
      reselecting: { rootId: 'r1', label: 'repo' },
      found: FOUND_MANY.found.map((entry) => ({
        ...entry,
        alreadyAdded: entry.relPath === 'local_agents/alpha',
        addedElsewhere: false
      }))
    })

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[1])
    fireEvent.click(screen.getByRole('button', { name: 'Save selection' }))

    const [payload] = addFolder.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({
      path: '/repo',
      // No `name`: the field is prefilled from the folder, and sending it back
      // would rename an agent the user named themselves.
      relPaths: ['local_agents/alpha', 'local_agents/beta']
    })
  })

  it('lets a re-selection empty the list, rather than disabling the button in silence', () => {
    // This dialog performs removals now, so "take all of these out" is a
    // legitimate answer — refusing it with a greyed-out button and no sentence
    // is the silent failure ux_rules rule 6 is about.
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({
      ...FOUND_MANY,
      reselecting: { rootId: 'r1', label: 'repo' },
      found: FOUND_MANY.found.map((entry) => ({
        ...entry,
        alreadyAdded: true,
        addedElsewhere: false
      }))
    })

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    const save = screen.getByRole('button', { name: 'Save selection' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    fireEvent.click(screen.getByRole('button', { name: 'Remove and save' }))

    const [payload] = addFolder.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({ path: '/repo', relPaths: [] })
  })

  it('does not navigate away when a save only removed agents', () => {
    // A user who came to take one agent out must not be dropped onto another
    // agent's page (ux_rules rule 3 cuts the other way here).
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({
      ...FOUND_MANY,
      reselecting: { rootId: 'r1', label: 'repo' },
      found: FOUND_MANY.found.map((entry) => ({
        ...entry,
        alreadyAdded: true,
        addedElsewhere: false
      }))
    })

    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save selection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove and save' }))
    const [, options] = addFolder.mock.calls[0] as [
      unknown,
      { onSuccess: (r: { root: unknown; agentIds: string[] }) => void }
    ]
    act(() => options.onSuccess({ root: {}, agentIds: ['folder:external:r1:b'] }))

    expect(setActiveLocalAgentId).not.toHaveBeenCalled()
  })

  it('keeps a row added under another agents folder locked, even when re-selecting', () => {
    // This pick speaks for one folder's contents, and gamma belongs to another
    // root. Ticked and disabled, never filtered out — a list that loses a row
    // reads as a bad scan. Asserted *while re-selecting*, which is the only
    // state where the other rows are unlocked and this one still must not be.
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({
      ...FOUND_MANY,
      reselecting: { rootId: 'r1', label: 'repo' },
      found: FOUND_MANY.found.map((entry) => ({
        ...entry,
        alreadyAdded: entry.relPath === 'local_agents/gamma',
        addedElsewhere: entry.relPath === 'local_agents/gamma'
      }))
    })

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => box.disabled)).toEqual([false, false, true])
    // And it is never counted as something this save could remove.
    for (const box of boxes) if (!box.disabled) fireEvent.click(box)
    expect(screen.queryByText(/to remove from the list/)).toBeNull()
  })

  it('keeps the dialog open and says why when the folder is refused', () => {
    // ux_rules rule 6: a dialog closes on success only. Closing here would
    // leave the user with a picker that did nothing and no message anywhere.
    const { onClose } = openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({ ...FOUND_ONE, refusal: 'Nothing in this folder has an AGENT.md.', found: [] })

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('AGENT.md')
    expect(screen.getByRole('button', { name: /Add a folder/ })).toBeTruthy()
  })

  it('does nothing at all when the picker is cancelled', () => {
    const { onClose } = openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick({ cancelled: true })

    expect(onClose).not.toHaveBeenCalled()
    expect(addFolder).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('')
  })

  it('goes back to the choice without adopting anything', () => {
    openChoice()
    fireEvent.click(screen.getByRole('button', { name: /Add a folder/ }))
    resolvePick(FOUND_MANY)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBeTruthy()
    expect(addFolder).not.toHaveBeenCalled()
  })
})
