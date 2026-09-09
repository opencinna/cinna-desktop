import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentsHomeState } from '../../../../../shared/localAgents'

/**
 * The dialog that gets in front of the macOS Documents prompt.
 *
 * Two things make it worth testing rather than eyeballing. It must not appear
 * on its own — the whole reason it exists is that an unasked-for dialog is the
 * problem — and a refusal has to turn into the *next question* rather than an
 * error, because "macOS said no" with an OK button is a dead end for someone
 * whose agents now have nowhere to live.
 */

const HOME: AgentsHomeState = {
  path: '/Users/test/Documents/CinnaAgents',
  access: 'needs_consent',
  guarded: true
}

const grantMutate = vi.fn()
const grantReset = vi.fn()
const chooseMutate = vi.fn()
const chooseReset = vi.fn()
let home: AgentsHomeState = HOME
/** What the last folder pick said, if it rejected. */
let chooseError: Error | null = null

vi.mock('../../../hooks/useLocalAgents', () => ({
  useAgentsHome: () => ({ data: home }),
  useGrantAgentsHome: () => ({
    mutate: grantMutate,
    reset: grantReset,
    isPending: false,
    error: null
  }),
  useChooseAgentsHome: () => ({
    mutate: chooseMutate,
    reset: chooseReset,
    isPending: false,
    error: chooseError
  })
}))

const { AgentsHomeModal } = await import('./AgentsHomeModal')
const { useAgentsHomeStore } = await import('../../../stores/agentsHome.store')

beforeEach(() => {
  home = HOME
  chooseError = null
  grantMutate.mockClear()
  grantReset.mockClear()
  chooseMutate.mockClear()
  chooseReset.mockClear()
  useAgentsHomeStore.setState({ ask: null, dismissed: [] })
})

/** Raise the question the way a surface that needs the folder would. */
function ask(access: 'needs_consent' | 'denied'): void {
  act(() => useAgentsHomeStore.getState().request(access))
}

describe('AgentsHomeModal', () => {
  it('shows nothing until something asks for the folder', () => {
    render(<AgentsHomeModal />)
    // Main can answer "the folder is not there" from the first millisecond of
    // the app. Acting on that would explain agents to someone signing in.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the folder and warns that macOS is about to ask', () => {
    render(<AgentsHomeModal />)
    ask('needs_consent')

    expect(screen.getByRole('dialog', { name: 'Where your agents will live' })).toBeTruthy()
    expect(screen.getByText('/Users/test/Documents/CinnaAgents')).toBeTruthy()
    expect(screen.getByText(/macOS will now ask/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    expect(grantMutate).toHaveBeenCalled()
  })

  it('promises no prompt where there will not be one', () => {
    // Linux, Windows, or a home the user moved out of Documents. Announcing a
    // system dialog that never arrives is a lie about the next click.
    home = { ...HOME, guarded: false }
    render(<AgentsHomeModal />)
    ask('needs_consent')

    expect(screen.queryByText(/macOS will now ask/)).toBeNull()
    expect(screen.getByText(/Nothing else is touched/)).toBeTruthy()
  })

  it('turns a refusal into the next question, not an error', () => {
    render(<AgentsHomeModal />)
    ask('denied')

    expect(screen.getByRole('dialog', { name: 'Where should your agents live?' })).toBeTruthy()
    // Both ways out: somewhere else, or the switch that undoes the refusal.
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    expect(chooseMutate).toHaveBeenCalled()
    // The retry sits in the sentence that says when to press it, not in the
    // footer beside two folder verbs.
    expect(screen.getByText(/System Settings/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'try again' }))
    expect(grantMutate).toHaveBeenCalled()
  })

  it('does not carry the last attempt\'s message into the next question', () => {
    chooseError = new Error('That folder cannot hold agents.')
    const { unmount } = render(<AgentsHomeModal />)
    ask('denied')
    expect(screen.getByText('That folder cannot hold agents.')).toBeTruthy()

    // Dismissing unmounts the dialog, which is what forgets the message: a
    // rejected pick still on screen when the sidebar reopens the dialog is an
    // error under a question the user has not answered yet — and in the other
    // branch it explains a button that is not there (ux_rules rule 6).
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    unmount()
    expect(chooseReset).toHaveBeenCalled()
  })

  it('stays away once put away, and comes back for a different question', () => {
    render(<AgentsHomeModal />)
    ask('needs_consent')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // The agents list refetches on every watcher push and every window focus,
    // and asks again each time. "Not now" has to outlive that, or the dialog
    // reappears over whatever the user moved on to (ux_rules rule 1).
    ask('needs_consent')
    expect(screen.queryByRole('dialog')).toBeNull()

    // A refusal is a new thing to say, and does get through.
    ask('denied')
    expect(screen.getByRole('dialog', { name: 'Where should your agents live?' })).toBeTruthy()
  })

  it('blames the folder, not macOS, where macOS is not the reason', () => {
    // A read-only mount, or a root-owned folder, on any platform. Naming a
    // cause the user does not have — and a System Settings pane their machine
    // does not have — sends them somewhere that cannot help.
    home = { ...HOME, guarded: false }
    render(<AgentsHomeModal />)
    ask('denied')

    expect(screen.queryByText(/macOS/)).toBeNull()
    expect(screen.getByText(/could not write to that folder/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'try again' })).toBeTruthy()
  })
})
