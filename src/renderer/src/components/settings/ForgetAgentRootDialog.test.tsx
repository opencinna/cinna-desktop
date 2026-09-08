import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UseMutationResult } from '@tanstack/react-query'
import type { AgentRootDto } from '../../../../shared/localAgents'
import { ForgetAgentRootDialog } from './ForgetAgentRootDialog'

/**
 * Forget drops the `agents` row of every folder agent under the root, and
 * `job_agents`, `a2a_sessions` and `chat_on_demand_agents` cascade from it.
 * The folder on disk is untouched, which makes the action *look* undoable —
 * so what this dialog has to get right is the half that is not (ux_rules
 * rule 5), and it has to stay put while the removal runs.
 */

type Remove = UseMutationResult<{ pruned: number }, Error, string>

const remove = (over: Partial<Remove> = {}): Remove =>
  ({ mutate: vi.fn(), isPending: false, ...over }) as unknown as Remove

const root = (over: Partial<AgentRootDto> = {}): AgentRootDto =>
  ({
    id: 'r1',
    label: 'team-agents',
    path: '/home/dev/team-agents',
    exists: true,
    isDefault: false,
    kind: 'external',
    agentCount: 3,
    hiddenAgentCount: 0,
    ...over
  }) as AgentRootDto

describe('ForgetAgentRootDialog', () => {
  it('names the folder, promises the recoverable half and owns the rest', () => {
    render(<ForgetAgentRootDialog root={root()} remove={remove()} onCancel={vi.fn()} />)

    expect(screen.getByText('team-agents')).toBeTruthy()
    expect(screen.getByText(/stays on disk/)).toBeTruthy()
    // The trap this copy exists for: re-adding the folder brings the agents
    // back, so without this sentence the user reads the whole action as undoable.
    expect(screen.getByText(/runs\s+without the agent rather than asking/)).toBeTruthy()
    expect(screen.getByText(/Its 3 agents\s+leave the list/)).toBeTruthy()
  })

  it('is named by its visible heading, not by a hardcoded string', () => {
    render(<ForgetAgentRootDialog root={root()} remove={remove()} onCancel={vi.fn()} />)

    // Rule 10: the accessible name has to be the one on screen. `aria-labelledby`
    // makes that true by construction — this fails if it is ever swapped for a
    // literal that drifts from the heading.
    expect(screen.getByRole('dialog', { name: 'Forget agents folder' })).toBeTruthy()
  })

  it('agrees its verb and pronouns with a single agent', () => {
    render(
      <ForgetAgentRootDialog root={root({ agentCount: 1 })} remove={remove()} onCancel={vi.fn()} />
    )

    // "Its 1 agent leave the list" shipped, because only the noun branched and
    // the verb did not. Asserted on the whole sentence's normalised text, so a
    // future edit that branches one word and forgets its neighbour fails here.
    const sentence = screen.getByText(/leaves the list/).textContent?.replace(/\s+/g, ' ')
    expect(sentence).toBe(
      'Its 1 agent leaves the list. Existing chats stay, but they can no longer reach it, and any ' +
        'job set up with it loses that agent. Adding the folder again lists the agent again — it ' +
        'does not put it back into those jobs, and a job left that way runs without the agent ' +
        'rather than asking.'
    )
  })

  it('agrees its verb and pronouns with several agents', () => {
    render(
      <ForgetAgentRootDialog root={root({ agentCount: 3 })} remove={remove()} onCancel={vi.fn()} />
    )

    const sentence = screen.getByText(/leave the list/).textContent?.replace(/\s+/g, ' ')
    expect(sentence).toBe(
      'Its 3 agents leave the list. Existing chats stay, but they can no longer reach them, and ' +
        'any job set up with one loses that agent. Adding the folder again lists the agents again ' +
        '— it does not put them back into those jobs, and a job left that way runs without the ' +
        'agent rather than asking.'
    )
  })

  it('never promises that re-adding the folder restores what was connected to it', () => {
    render(<ForgetAgentRootDialog root={root()} remove={remove()} onCancel={vi.fn()} />)

    // A bare or legacy agent's id embeds the root id, and every add mints a
    // fresh one — so re-adding an adopted folder produces *different* agents
    // and the old chats never reconnect. "Brings the agents back" shipped here
    // and read as "the harm is undone" (ux_rules rule 5).
    expect(screen.queryByText(/brings the agents? back/)).toBeNull()
    expect(screen.getByText(/does not put them\s+back into those jobs/)).toBeTruthy()
  })

  it('focuses the recoverable choice on open', () => {
    render(<ForgetAgentRootDialog root={root()} remove={remove()} onCancel={vi.fn()} />)

    // Focus used to stay on the row button behind an aria-modal overlay, so a
    // screen-reader user was never told the confirm had opened.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('says nothing about agents for a folder that has none in the list', () => {
    render(
      <ForgetAgentRootDialog
        // Hidden agents have no `agents` row, so nothing cascades off them.
        root={root({ agentCount: 0, hiddenAgentCount: 4 })}
        remove={remove()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByText(/leave the list/)).toBeNull()
  })

  it('ignores Escape and an outside click while the removal runs', () => {
    const onCancel = vi.fn()
    render(
      <ForgetAgentRootDialog
        root={root()}
        remove={remove({ isPending: true })}
        onCancel={onCancel}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)

    // Dismissing would cancel nothing and only hide what is happening.
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Forgetting…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
  })

  it('closes on Escape when nothing is running', () => {
    const onCancel = vi.fn()
    render(<ForgetAgentRootDialog root={root()} remove={remove()} onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('stays open on failure and shows the reason without the IPC plumbing', () => {
    const mutate = vi.fn((_id: string, opts: { onError: (e: Error) => void }) =>
      opts.onError(
        new Error(
          "Error invoking remote method 'local-agent:root-remove': LocalAgentError: That agents folder is not registered."
        )
      )
    )
    render(
      <ForgetAgentRootDialog
        root={root()}
        remove={remove({ mutate } as unknown as Partial<Remove>)}
        onCancel={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Forget folder' }))

    expect(screen.getByRole('alert').textContent).toBe('That agents folder is not registered.')
    expect(screen.getByRole('dialog', { name: 'Forget agents folder' })).toBeTruthy()
  })
})
