import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The page's own decisions: which controls sit above the fold, and what the
 * tabs show. Everything under the header — the runtime panel, the menus, the
 * cards — is its own component with its own hooks and IPC, and each is stubbed
 * to a labelled marker so this file pins the *page*, not half the app.
 *
 * "Start chat" is here because it is the page's primary action and because it
 * was once a hard-coded `disabled` button: the runner could serve a turn since
 * Phase 6 and nothing in the renderer could reach it. It uses the mechanism
 * `AgentStatusOverlay`'s own "Start chat" already proves — `setActiveView('chat')`
 * + `setPendingAgentId` — plus the sidebar move the sidebar row's chat button
 * already makes, so only those three calls are pinned.
 */

const setActiveView = vi.fn()
const setPendingAgentId = vi.fn()
const setSidebarTab = vi.fn()
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeLocalAgentId: 'folder:alpha',
      setActiveLocalAgentId: vi.fn(),
      pendingDraftAgentId: null,
      setPendingDraftAgentId: vi.fn(),
      setActiveView,
      setPendingAgentId,
      setSidebarTab
    })
}))

let AGENT: LocalAgentDto

vi.mock('../../../hooks/useLocalAgents', () => ({
  useLocalAgent: () => ({ data: AGENT, isLoading: false, error: null }),
  // The page's empty placeholder branches on whether there is an agents folder
  // at all; with one, it reads as it always did.
  useAgentsHomeQuestion: () => 'ready',
  useDraftLocalAgent: () => ({ isPending: false, data: undefined, mutate: vi.fn() }),
  useOpenAgentPath: () => ({ mutate: vi.fn() }),
  useRescanLocalAgents: () => ({ mutate: vi.fn(), isPending: false }),
  useStampAgentIdentity: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  // Two standing grants, so the tab's count badge has something to render. The
  // card itself is a marker here; its own behaviour is in `PermissionsCard.test.tsx`.
  useLocalAgentGrants: () => ({
    data: [
      { key: 'bash::make test', action: 'bash', pattern: 'make test', decidedAt: 1 },
      {
        key: 'webfetch::https://x.test/*',
        action: 'webfetch',
        pattern: 'https://x.test/*',
        decidedAt: 2
      }
    ]
  })
}))

const marker = (name: string) => () => createElement('div', { 'data-marker': name }, name)
vi.mock('./RuntimePanel', () => ({ RuntimePanel: marker('runtime') }))
vi.mock('./ReadinessStrip', () => ({ ReadinessStrip: () => null }))
vi.mock('./OpenInMenu', () => ({ OpenInMenu: marker('open-in') }))
vi.mock('./AgentActionsMenu', () => ({ AgentActionsMenu: marker('actions') }))
vi.mock('./ManifestCards', () => ({
  DescriptionCard: marker('description-card'),
  ExamplePromptsCard: marker('prompts-card')
}))
vi.mock('./PromptDocCard', () => ({
  PromptDocCard: ({ prompt }: { prompt: string }) =>
    createElement('div', { 'data-marker': `doc-${prompt}` }, `doc-${prompt}`)
}))
vi.mock('./BareAgentCards', () => ({
  BareNameCard: marker('bare-name-card'),
  BareReadmeCard: marker('bare-readme-card')
}))
vi.mock('./ReadOnlyCards', () => ({
  CommandsCard: marker('commands-card'),
  StatusCard: marker('status-card')
}))
vi.mock('./FolderTab', () => ({ FolderTab: marker('folder-tab') }))
vi.mock('./PermissionsCard', () => ({ PermissionsCard: marker('permissions-card') }))

const { LocalAgentPage } = await import('./LocalAgentPage')

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:alpha',
    name: 'Alpha',
    description: 'Watches the alpha feed.',
    path: '/tmp/agents/alpha',
    rootId: 'root-1',
    readiness: 'ok',
    readinessReason: null,
    validation: { errors: [], warnings: [], infos: [] },
    commands: [],
    stamps: {},
    ...overrides
  } as LocalAgentDto
}

function renderPage(a: LocalAgentDto = agent()): ReturnType<typeof render> {
  AGENT = a
  const client = new QueryClient()
  return render(createElement(QueryClientProvider, { client }, createElement(LocalAgentPage)))
}

describe('LocalAgentPage — Start chat', () => {
  it('switches to the chat view and hands the agent id to the pending-agent path', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /start chat/i }))
    expect(setActiveView).toHaveBeenCalledWith('chat')
    expect(setPendingAgentId).toHaveBeenCalledWith('folder:alpha')
  })

  it('moves the sidebar to Chats, so it does not stay on the agents list', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /start chat/i }))
    expect(setSidebarTab).toHaveBeenCalledWith('chats')
  })

  it('is enabled — this used to be a hard-coded `disabled` button', () => {
    renderPage()
    const button = screen.getByRole('button', { name: /start chat/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})

describe('LocalAgentPage — layout', () => {
  it('puts Open in, Start chat, the actions menu and the runtime panel above the tabs', () => {
    renderPage()
    expect(screen.getByText('open-in')).toBeTruthy()
    expect(screen.getByText('actions')).toBeTruthy()
    expect(screen.getByText('runtime')).toBeTruthy()
    expect(screen.getByRole('tablist', { name: /agent details/i })).toBeTruthy()
  })

  it('opens on Overview and switches the panel with the tabs', () => {
    renderPage(agent({ commands: [{ name: 'check' }] as LocalAgentDto['commands'] }))
    expect(screen.getByText('status-card')).toBeTruthy()
    expect(screen.getByText('description-card')).toBeTruthy()
    expect(screen.queryByText('doc-workflow')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /prompts/i }))
    expect(screen.getByText('doc-workflow')).toBeTruthy()
    expect(screen.getByText('doc-entrypoint')).toBeTruthy()
    expect(screen.getByText('doc-refiner')).toBeTruthy()
    expect(screen.queryByText('description-card')).toBeNull()

    // The command count rides on the tab so a catalog is discoverable unopened.
    fireEvent.click(screen.getByRole('tab', { name: /commands/i }))
    expect(screen.getByText('commands-card')).toBeTruthy()

    // Permissions is a tab rather than a card on Overview: in the common case
    // it is a fixed paragraph plus "nothing remembered yet", which is knowledge
    // and not a control (`ux_rules.md` §2). Mutation: render
    // `<PermissionsCard>` under `tab === 'overview'` fails this.
    expect(screen.queryByText('permissions-card')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /permissions/i }))
    expect(screen.getByText('permissions-card')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /folder/i }))
    expect(screen.getByText('folder-tab')).toBeTruthy()
  })

  it('counts standing permissions on their tab, the way Commands counts a catalog', () => {
    // The badge is what makes a grant the user made weeks ago discoverable
    // without opening the tab — the same rule the Commands and Folder counts
    // follow. Mutation: drop the badge and a standing rule is invisible until
    // someone goes looking for it.
    renderPage(agent())
    const tab = screen.getByRole('tab', { name: /permissions/i })
    expect(tab.textContent).toBe('Permissions2')
  })

  it('counts validation findings on the Folder tab, where a ready folder now keeps them', () => {
    renderPage(
      agent({
        validation: {
          errors: [],
          warnings: [{ code: 'w', message: 'No example prompts', path: null }],
          infos: []
        } as unknown as LocalAgentDto['validation']
      })
    )
    expect(screen.getByRole('tab', { name: /folder/i }).textContent).toContain('1')
  })

  it('puts a bare folder’s README on Overview and leaves Prompts to AGENT.md', () => {
    // The README is what the folder tells a *person*; `AGENT.md` is the whole
    // of what the agent is told. Showing both on Prompts read as though the
    // README were part of the prompt, and buried the one document that is.
    // Mutation: move `BareReadmeCard` back under `tab === 'prompts'` and both
    // halves of this fail.
    renderPage(agent({ kind: 'bare' } as Partial<LocalAgentDto>))
    expect(screen.getByText('bare-name-card')).toBeTruthy()
    expect(screen.getByText('bare-readme-card')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /prompts/i }))
    expect(screen.getByText('doc-bare_prompt')).toBeTruthy()
    expect(screen.queryByText('doc-bare_readme')).toBeNull()
    expect(screen.queryByText('bare-readme-card')).toBeNull()
  })

  it('shows the description in the header, and a nudge when it is only the name', () => {
    renderPage()
    expect(screen.getByText('Watches the alpha feed.')).toBeTruthy()

    // A folder created from a name alone carries the name as its description
    // — the kit schema demands one — and repeating it under the heading would
    // read as a description rather than as the absence of one.
    renderPage(agent({ description: 'Alpha' }))
    expect(screen.getByText(/no description yet/i)).toBeTruthy()
  })
})
