import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { GitStatus } from '../../../../shared/agentGit'
import type { AgentRootDto } from '../../../../shared/localAgents'

/**
 * The update panel's job is to describe the thing it will act on.
 *
 * Every git command runs at the **repository root**, which may be an ancestor
 * of the registered folder — a team keeping its `AGENT.md` folders inside a
 * product monorepo is the case this exists for. The panel showed a branch, an
 * upstream, a commit list and an Update button, all true of a repository whose
 * identity was the one thing it withheld: pressing Update to move an agents
 * folder advanced the whole checkout instead.
 */

const status = vi.fn<() => { data: GitStatus | undefined; isLoading: boolean }>()
vi.mock('../../hooks/useLocalAgents', () => ({
  useGitStatus: () => status(),
  useCheckForUpdates: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFromGit: () => ({ mutate: vi.fn(), isPending: false, data: undefined })
}))

const { AgentsRootGit } = await import('./AgentsRootGit')

const root = (over: Partial<AgentRootDto> = {}): AgentRootDto =>
  ({ id: 'r1', label: 'agents', path: '/home/platform/agents', exists: true, isGitRepo: true, ...over }) as AgentRootDto

const gitStatus = (over: Partial<GitStatus> = {}): GitStatus => ({
  isRepo: true,
  repoRoot: '/home/platform/agents',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 1,
  dirty: false,
  incoming: [],
  refusal: null,
  fetched: true,
  ...over
})

function renderPanel(r: AgentRootDto, s: GitStatus | undefined, isLoading = false): void {
  status.mockReturnValue({ data: s, isLoading })
  render(createElement(AgentsRootGit, { root: r }))
}

describe('AgentsRootGit — naming what it acts on', () => {
  it('names the repository when it is above the adopted folder', () => {
    renderPanel(root(), gitStatus({ repoRoot: '/home/platform' }))

    // The *name*, not the path: appended to a truncating line a path loses its
    // tail, which is the only part that identifies it.
    expect(screen.getByText(/repository: platform/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Update' }).getAttribute('title')
    ).toContain('/home/platform')
  })

  it('says nothing about a repository that is the folder itself', () => {
    // The common case. A line naming the folder the row is already about would
    // be a sub-line repeating its title.
    renderPanel(root(), gitStatus())

    expect(screen.queryByText(/repository:/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Update' }).getAttribute('title')
    ).toBe('Fast-forward this folder')
  })

  it('renders nothing at all for a folder that is not a repository', () => {
    // Known from the root DTO at first paint, so no block appears later and
    // pushes the settings rows below it down.
    const { container } = { container: document.body }
    renderPanel(root({ isGitRepo: false }), undefined)
    expect(container.textContent).not.toContain('origin/main')
  })

  it('reserves the block while the answer is in flight', () => {
    renderPanel(root(), undefined, true)
    expect(document.querySelector('[aria-hidden]')).toBeTruthy()
  })
})

describe('AgentsRootGit — refusals', () => {
  it('blames the repository, not the folder', () => {
    // A user told their *agents folder* has uncommitted changes, when the edit
    // is elsewhere in a monorepo they never associated with Cinna, goes looking
    // in the wrong directory.
    renderPanel(root(), gitStatus({ repoRoot: '/home/platform', dirty: true, refusal: 'dirty' }))

    expect(screen.getByText(/this repository’s changes/)).toBeTruthy()
    expect(screen.queryByText(/changes here/)).toBeNull()
  })

  it('hides Update when something stands in the way', () => {
    renderPanel(root(), gitStatus({ ahead: 1, refusal: 'diverged' }))
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('hides Check for the refusals a check cannot move', () => {
    renderPanel(root(), gitStatus({ behind: 0, refusal: 'no_upstream', upstream: null }))
    expect(screen.queryByRole('button', { name: /Check .* for updates/ })).toBeNull()
  })
})
