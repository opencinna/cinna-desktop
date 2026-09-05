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

vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveLocalAgentId, setPendingDraftAgentId, setActiveView })
}))
vi.mock('../../../hooks/useLocalAgents', () => ({
  useAgentRoots: () => ({
    data: [{ id: 'root-1', label: 'Agents', path: '/tmp/agents', isDefault: true }]
  }),
  useCreateLocalAgent: () => ({ mutate: create, isPending: false })
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

function open(): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn()
  render(createElement(NewLocalAgentModal, { onClose }))
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
