import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { RenameAgentDialog, RENAME_FOLDER_WARNING } from './AgentDialogs'

/**
 * The rename dialog: the folder stays unless the user ticks the box, the box
 * says why when it cannot be ticked, the path line says where the folder will
 * be, and the save goes to the right channel for the agent's kind.
 */

const STAMP = { mtimeMs: 1, size: 1, hash: 'h' }

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:alpha',
    name: 'Alpha',
    path: '/Users/me/CinnaAgents/Local/alpha',
    rootId: 'root-1',
    identity: 'manifest',
    kind: 'kit',
    stamps: { 'cinna-agent.json': STAMP },
    ...overrides
  } as LocalAgentDto
}

const renameBare = { mutate: vi.fn(), isPending: false }
const renameKit = { mutate: vi.fn(), isPending: false }

function open(a: LocalAgentDto = agent(), shared = false, onCancel = vi.fn()): void {
  render(
    createElement(RenameAgentDialog, {
      agent: a,
      shared,
      renameBare: renameBare as never,
      renameKit: renameKit as never,
      onCancel
    })
  )
}

const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: /rename folder too/i })
const nameInput = (): HTMLInputElement => screen.getByRole('textbox')
const save = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save' })
const pathLine = (): string => screen.getByTestId('rename-folder-path').textContent ?? ''

afterEach(() => {
  vi.clearAllMocks()
  renameBare.isPending = false
  renameKit.isPending = false
})

describe('RenameAgentDialog', () => {
  it('opens prefilled, focused, with the folder box unticked and the warning shown', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Rename agent' })).toBeTruthy()
    expect(nameInput().value).toBe('Alpha')
    expect(document.activeElement).toBe(nameInput())
    expect(box().checked).toBe(false)
    expect(box().disabled).toBe(false)
    expect(screen.getByText(RENAME_FOLDER_WARNING)).toBeTruthy()
    expect(RENAME_FOLDER_WARNING).toContain("the agent's previous sessions could lose their context")
    // Unchanged name, box unticked: nothing to save.
    expect(save().disabled).toBe(true)
  })

  it('flips the path line between where the folder stays and where it goes', () => {
    open()
    fireEvent.change(nameInput(), { target: { value: 'Invoice Watcher' } })
    expect(pathLine()).toBe('Folder stays: /Users/me/CinnaAgents/Local/alpha')
    fireEvent.click(box())
    expect(pathLine()).toBe('Folder becomes: /Users/me/CinnaAgents/Local/invoice-watcher')
    fireEvent.click(box())
    expect(pathLine()).toBe('Folder stays: /Users/me/CinnaAgents/Local/alpha')
  })

  it('disables Save on an empty name', () => {
    open()
    fireEvent.change(nameInput(), { target: { value: '   ' } })
    expect(save().disabled).toBe(true)
  })

  it('saves a kit agent through the kit rename, with the stamp and the box as ticked', () => {
    open()
    fireEvent.change(nameInput(), { target: { value: ' Invoice watcher ' } })
    fireEvent.click(box())
    fireEvent.click(save())
    expect(renameKit.mutate).toHaveBeenCalledTimes(1)
    expect(renameKit.mutate.mock.calls[0][0]).toEqual({
      agentId: 'folder:alpha',
      name: 'Invoice watcher',
      renameFolder: true,
      expectedStamp: STAMP
    })
    expect(renameBare.mutate).not.toHaveBeenCalled()
  })

  it('keeps the folder by default, and Enter saves', () => {
    open()
    fireEvent.change(nameInput(), { target: { value: 'Invoice watcher' } })
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    expect(renameKit.mutate.mock.calls[0][0]).toMatchObject({ renameFolder: false })
  })

  it('renames a bare agent through the bare rename, and never offers its folder', () => {
    open(agent({ kind: 'bare', identity: 'external' }))
    expect(box().disabled).toBe(true)
    expect(screen.getByText('This is your own folder; Cinna keeps its name without touching it.')).toBeTruthy()
    expect(screen.queryByText(RENAME_FOLDER_WARNING)).toBeNull()
    fireEvent.change(nameInput(), { target: { value: 'Invoice watcher' } })
    fireEvent.click(save())
    expect(renameBare.mutate.mock.calls[0][0]).toEqual({ agentId: 'folder:alpha', name: 'Invoice watcher' })
    expect(renameKit.mutate).not.toHaveBeenCalled()
  })

  it('says why a legacy folder cannot move', () => {
    open(agent({ identity: 'legacy' }))
    expect(box().disabled).toBe(true)
    expect(
      screen.getByText("This agent is identified by its folder's name. Stamp identity first, or its chats would lose it.")
    ).toBeTruthy()
  })

  it('says why a shared folder cannot move', () => {
    open(agent(), true)
    expect(box().disabled).toBe(true)
    expect(screen.getByText('The folder name is part of the team version, so it stays.')).toBeTruthy()
  })

  it('explains a mid-turn refusal and stays open', () => {
    const onCancel = vi.fn()
    open(agent(), false, onCancel)
    fireEvent.change(nameInput(), { target: { value: 'Invoice watcher' } })
    fireEvent.click(save())
    const { onError } = renameKit.mutate.mock.calls[0][1] as { onError: (err: unknown) => void }
    act(() => onError(Object.assign(new Error('busy'), { code: 'turn_in_progress' })))
    expect(screen.getByRole('alert').textContent).toBe(
      'This agent is in the middle of a turn. Wait for it to finish, then try again — nothing was renamed.'
    )
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cannot be dismissed while the rename is in flight', () => {
    renameKit.isPending = true
    const onCancel = vi.fn()
    open(agent(), false, onCancel)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
  })
})
