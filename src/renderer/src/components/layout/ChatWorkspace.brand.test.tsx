import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ResolvedBrandTheme } from '../../../../shared/brandTheme/roles'

/**
 * The new-chat screen under a server brand: the brand's logo for the mode
 * showing takes CinnaLogoDraw's place in the same box, and its heading
 * replaces the generic one, never the guided build's.
 */
const fixtures = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    settings: { defaultMultiAgentRouting: 'human', guidedFirstBuild: true } as Record<string, unknown> | undefined,
    folder: { id: 'a1', kind: 'kit', unbuilt: true, name: 'Mail helper' } as Record<string, unknown> | null,
    /** The folder list cannot answer yet (loading, or refetching without the agent). */
    pending: false,
    startNewChat: vi.fn(async () => true)
  }
})
// Minimal view reads the chat's pending handoff from the query cache; no client here.
vi.mock('../tasks/PendingHandoffControl', () => ({ useChatHandoffPending: () => false }))
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: fixtures.settings }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [{ id: 'a1', name: 'Mail helper', skills: [] }, { id: 'a2', name: 'Other', skills: [] }] }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }), useDefaultChatMode: () => ({ data: null }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useHintsEnabled', () => ({ useHintsEnabled: () => false }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: fixtures.startNewChat }), resolveModel: () => null }))
vi.mock('../../hooks/useApplyChatMode', () => ({ useApplyChatMode: () => vi.fn() }))
vi.mock('../../hooks/useNewChatLike', () => ({ useNewChatLike: () => vi.fn(async () => undefined) }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: null }) }))
vi.mock('../chat/MessageStream', () => ({ MessageStream: () => null }))
vi.mock('../ui/HintBar', () => ({ HintBar: () => null }))
vi.mock('../chat/DesktopAppsBanner', () => ({ DesktopAppsBanner: () => null }))
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => <p>Example prompts</p> }))
vi.mock('../chat/ComposerReadiness', () => ({
  RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children,
  readinessRefusal: () => null,
  usePickedFolder: (id: string | null, listed: boolean) => {
    const folder = id && fixtures.folder?.id === id ? fixtures.folder : null
    return { folder, pending: id !== null && folder === null && fixtures.pending && !listed }
  }
}))
vi.mock('../chat/ChatInput', async () => {
  const { forwardRef, useImperativeHandle, useState } = await import('react')
  return {
    ChatInput: forwardRef(function ChatInput(props: {
      placeholder?: string
      guidedBuildAgentId?: string | null
      onNewChat?: (message: string) => unknown
      onTogglePendingAgent?: (id: string) => void
    }, ref) {
      const [filled, setFilled] = useState('')
      useImperativeHandle(ref, () => ({ focus: () => {}, clearInput: () => {}, fill: setFilled }))
      return <div>
        <output data-testid="guided-row">{props.guidedBuildAgentId ?? '(none)'}</output>
        <output data-testid="placeholder">{props.placeholder === undefined ? '(default)' : props.placeholder}</output>
        <output data-testid="filled">{filled}</output>
        <button onClick={() => void props.onNewChat?.('check my Gmail')}>Send</button>
        <button onClick={() => props.onTogglePendingAgent?.('a2')}>Toggle agent</button>
      </div>
    })
  }
})
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')
const { useBrandThemeStore } = await import('../../stores/brandTheme.store')
const { GUIDED_BUILD_HEADING } = await import('../chat/GuidedBuildNotice')

const DARK_LOGO = 'data:image/png;base64,ZGFyaw=='
const LIGHT_LOGO = 'data:image/png;base64,bGlnaHQ='

function brand(over: Partial<ResolvedBrandTheme> = {}): ResolvedBrandTheme {
  return {
    origin: 'https://acme.example',
    revision: 1,
    name: 'Acme',
    modes: {} as ResolvedBrandTheme['modes'],
    logo: { dark: DARK_LOGO, light: LIGHT_LOGO },
    background: { dark: null, light: null },
    copy: { newChatHeading: 'Ask Acme anything' },
    ...over
  }
}
/** The store as the document shows it; the sheet itself is the store test's business. */
const show = (theme: ResolvedBrandTheme | null): void => useBrandThemeStore.setState({ active: theme, override: null, theme, key: theme ? `${theme.origin}#${theme.revision}` : null })

function mount(agentId = 'a1', embedded = false) {
  const client = new QueryClient()
  const tree = () => <QueryClientProvider client={client}><ChatWorkspace agentId={agentId} embedded={embedded} /></QueryClientProvider>
  const view = render(tree())
  return { ...view, rerender: () => view.rerender(tree()) }
}

beforeEach(() => {
  window.ResizeObserver = class { observe() {} disconnect() {} } as never
  fixtures.settings = { defaultMultiAgentRouting: 'human', guidedFirstBuild: true }
  fixtures.folder = { id: 'a1', kind: 'kit', unbuilt: true, name: 'Mail helper' }
  fixtures.pending = false
  fixtures.startNewChat.mockClear()
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', pendingAgentId: null, pendingModeId: null, draftingAgentIds: [], theme: 'dark' })
  // The ordinary screen unless a test picks the blank agent.
  fixtures.folder = null
})
afterEach(() => show(null))

const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? ''
const drawnMark = (): Element | null => document.querySelector('svg.cinna-logo-draw')



it('no brand: the drawn Cinna mark and the generic heading', () => {
  mount('a2')
  expect(drawnMark()).not.toBeNull()
  expect(screen.queryByTestId('brand-logo')).toBeNull()
  expect(heading()).toBe('What can I help with?')
})

it('a brand logo replaces the drawn mark in the same 62 px box, shown at once, and follows the mode', () => {
  show(brand())
  mount('a2')
  const logo = screen.getByTestId('brand-logo') as HTMLImageElement
  expect(drawnMark()).toBeNull()
  expect(logo.getAttribute('src')).toBe(DARK_LOGO)
  expect(logo.getAttribute('alt')).toBe('')
  expect(logo.getAttribute('aria-hidden')).toBe('true')
  expect(logo.getAttribute('draggable')).toBe('false')
  // CinnaLogoDraw's footprint: 62 px tall, mb-3 under it.
  expect(logo.className).toContain('h-[62px]')
  expect(logo.className).toContain('mb-3')
  expect(logo.className).toContain('max-w-[240px]')
  expect(logo.className).toContain('object-contain')
  act(() => useUIStore.setState({ theme: 'light' }))
  expect((screen.getByTestId('brand-logo') as HTMLImageElement).getAttribute('src')).toBe(LIGHT_LOGO)
})

it('a brand without a logo keeps the drawn mark; its heading still applies', () => {
  show(brand({ logo: undefined }))
  mount('a2')
  expect(drawnMark()).not.toBeNull()
  expect(screen.queryByTestId('brand-logo')).toBeNull()
  expect(heading()).toBe('Ask Acme anything')
})

it('the brand heading replaces the generic one; without one the generic heading stays', () => {
  show(brand())
  mount('a2')
  expect(heading()).toBe('Ask Acme anything')
  act(() => show(brand({ copy: {} })))
  expect(heading()).toBe('What can I help with?')
})

it('the guided-build heading wins over the brand heading, and the undetermined blank does too', () => {
  show(brand())
  fixtures.folder = { id: 'a1', kind: 'kit', unbuilt: true, name: 'Mail helper' }
  const view = mount('a1')
  expect(heading()).toBe(GUIDED_BUILD_HEADING)
  view.unmount()
  fixtures.settings = undefined
  mount('a1')
  expect(heading()).toBe('\u00a0')
})

it("a lock screen's override recolours the document but not this profile's logo or heading", () => {
  // Stock active profile; the LoginPrompt for a branded one is up over it.
  show(null)
  act(() => useBrandThemeStore.setState({ override: { userId: 'bob', theme: brand() }, theme: brand(), key: 'x#1' }))
  mount('a2')
  expect(screen.queryByTestId('brand-logo')).toBeNull()
  expect(drawnMark()).not.toBeNull()
  expect(heading()).toBe('What can I help with?')
})
