import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * "Start chat" on the agent page — a Phase 6 leftover, not new Phase 7a
 * work: the runner has been able to serve a folder-agent turn since Phase 6
 * ("chat with a folder agent through the local engine"), but nothing in the
 * renderer had a way to reach a chat bound to one. This button was the
 * missing caller for a path that already exists and is already proven —
 * `AgentStatusOverlay`'s own "Start chat" for a remote agent, which seeds
 * `ui.store`'s `pendingAgentId`. This test pins only the two calls that
 * matter (`setActiveView('chat')`, `setPendingAgentId(agent.id)`) — the
 * downstream chat-creation and `/run:` dispatch are covered elsewhere
 * (`useNewChatFlow`'s own tests, `commandService.test.ts`).
 *
 * Every card and every other hook on this page is stubbed: none of them are
 * what this test is about, and the page pulls in enough of them that
 * rendering it for real would mean mocking half the app's IPC surface for
 * no added coverage.
 */

const setActiveView = vi.fn()
const setPendingAgentId = vi.fn()
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeLocalAgentId: 'folder:alpha',
      setActiveLocalAgentId: vi.fn(),
      pendingDraftAgentId: null,
      setPendingDraftAgentId: vi.fn(),
      setActiveView,
      setPendingAgentId
    })
}))

const AGENT: LocalAgentDto = {
  id: 'folder:alpha',
  name: 'Alpha',
  path: '/tmp/agents/alpha',
  rootId: 'root-1',
  stamps: {}
} as LocalAgentDto

vi.mock('../../../hooks/useLocalAgents', () => ({
  useLocalAgent: () => ({ data: AGENT, isLoading: false, error: null }),
  useDraftLocalAgent: () => ({ isPending: false, data: undefined, mutate: vi.fn() }),
  useOpenAgentPath: () => ({ mutate: vi.fn() }),
  useRescanLocalAgents: () => ({ mutate: vi.fn(), isPending: false }),
  useStampAgentIdentity: () => ({ mutate: vi.fn(), isPending: false, error: null })
}))

// Every card is a viewer with its own hooks/IPC — stub each to a no-op so
// this test's dependency graph stays to exactly what "Start chat" touches.
vi.mock('./RuntimeCard', () => ({ RuntimeCard: () => null }))
vi.mock('./ReadinessStrip', () => ({ ReadinessStrip: () => null }))
vi.mock('./OpenInRow', () => ({ OpenInRow: () => null }))
vi.mock('./ManifestCards', () => ({ DescriptionCard: () => null, ExamplePromptsCard: () => null }))
vi.mock('./PromptDocCard', () => ({ PromptDocCard: () => null }))
vi.mock('./ReadOnlyCards', () => ({
  CommandsCard: () => null,
  CredentialsCard: () => null,
  PublishedCard: () => null,
  RunsCard: () => null,
  StatusCard: () => null
}))

const { LocalAgentPage } = await import('./LocalAgentPage')

function renderPage(): ReturnType<typeof render> {
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

  it('is enabled — this used to be a hard-coded `disabled` button', () => {
    renderPage()
    const button = screen.getByRole('button', { name: /start chat/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})
