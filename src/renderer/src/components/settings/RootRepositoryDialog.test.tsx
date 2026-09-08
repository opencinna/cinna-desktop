import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { GitDetail } from '../../../../shared/agentGit'
import type { AgentRootDto } from '../../../../shared/localAgents'

/**
 * The dialog's job is to describe the thing it will act on.
 *
 * Every git command runs at the **repository root**, which may be an ancestor
 * of the registered folder — a team keeping its `AGENT.md` folders inside a
 * product monorepo is the case this exists for. Its predecessor showed a
 * branch, an upstream, a commit list and an Update button, all true of a
 * repository whose identity was the one thing it withheld: pressing Update to
 * move an agents folder advanced the whole checkout instead.
 *
 * These assertions came with that panel (`AgentsRootGit`) and were carried over
 * when it became this dialog. The panel is gone; the rules it encoded are not.
 */

const detail = vi.fn<() => { data: GitDetail | undefined; isLoading: boolean }>()
vi.mock('../../hooks/useLocalAgents', () => ({
  useGitDetail: () => detail(),
  useCheckForUpdates: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFromGit: () => ({ mutate: vi.fn(), isPending: false, data: undefined })
}))

const { RootRepositoryDialog } = await import('./RootRepositoryDialog')

const root = (over: Partial<AgentRootDto> = {}): AgentRootDto =>
  ({
    id: 'r1',
    label: 'agents',
    path: '/home/platform/agents',
    exists: true,
    isGitRepo: true,
    ...over
  }) as AgentRootDto

const gitDetail = (over: Partial<GitDetail> = {}): GitDetail => ({
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
  repoRootIsAbove: false,
  remotes: [],
  branches: ['main'],
  head: null,
  ...over
})

function renderDialog(r: AgentRootDto, d: GitDetail | undefined, isLoading = false): void {
  detail.mockReturnValue({ data: d, isLoading })
  render(createElement(RootRepositoryDialog, { root: r, onClose: vi.fn() }))
}

describe('RootRepositoryDialog — naming what it acts on', () => {
  it('names the repository when it is above the adopted folder', () => {
    renderDialog(root(), gitDetail({ repoRoot: '/home/platform', repoRootIsAbove: true }))

    // The full path, which the dialog has room for where the old row did not.
    expect(screen.getByText('/home/platform')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update' }).getAttribute('title')).toContain(
      '/home/platform'
    )
  })

  it('says nothing about a repository that is the folder itself', () => {
    // The common case. A line naming the folder the dialog is already about
    // would be a sub-line repeating its title.
    renderDialog(root(), gitDetail())

    expect(screen.queryByText('Repository:')).toBeNull()
    expect(screen.getByRole('button', { name: 'Update' }).getAttribute('title')).toBe(
      'Fast-forward this folder'
    )
  })

  it('explains a folder that is not a repository instead of showing empty fields', () => {
    renderDialog(root({ isGitRepo: false }), gitDetail({ isRepo: false, refusal: 'not_a_repo' }))

    expect(screen.getByText(/not inside a git working tree/)).toBeTruthy()
    expect(screen.queryByText('origin/main')).toBeNull()
  })

  it('says it is still reading rather than asserting an empty repository', () => {
    renderDialog(root(), undefined, true)
    expect(screen.getByText(/Reading the repository…/)).toBeTruthy()
  })
})

describe('RootRepositoryDialog — remotes', () => {
  it('links a remote a browser can open, and shows the raw URL as text when it cannot', () => {
    renderDialog(
      root(),
      gitDetail({
        remotes: [
          { name: 'origin', url: 'git@github.com:acme/agents.git', webUrl: 'https://github.com/acme/agents' },
          { name: 'backup', url: '/mnt/backup/agents.git', webUrl: null }
        ]
      })
    )

    // The link carries the derived https URL; its title keeps the real remote.
    const link = screen.getByRole('button', { name: /github\.com\/acme\/agents/ })
    expect(link.getAttribute('title')).toBe('git@github.com:acme/agents.git')
    // A local path is not offered as a link — `openExternal` would refuse it.
    expect(screen.getByText('/mnt/backup/agents.git')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /mnt\/backup/ })).toBeNull()
  })
})

describe('RootRepositoryDialog — refusals', () => {
  it('blames the repository, not the folder', () => {
    // A user told their *agents folder* has uncommitted changes, when the edit
    // is elsewhere in a monorepo they never associated with Cinna, goes looking
    // in the wrong directory.
    renderDialog(root(), gitDetail({ repoRoot: '/home/platform', dirty: true, refusal: 'dirty' }))

    expect(screen.getByText(/This repository has uncommitted changes/)).toBeTruthy()
    expect(screen.queryByText(/changes here/)).toBeNull()
  })

  it('hides Update when something stands in the way', () => {
    renderDialog(root(), gitDetail({ ahead: 1, refusal: 'diverged' }))
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('hides Check for the refusals a check cannot move', () => {
    // `readGitStatus` returns before it ever fetches in these two states, so
    // the button spun and changed nothing at all — not even the refusal, which
    // was already on screen.
    renderDialog(root(), gitDetail({ behind: 0, refusal: 'no_upstream', upstream: null }))
    expect(screen.queryByRole('button', { name: /Check for updates/ })).toBeNull()
  })
})
