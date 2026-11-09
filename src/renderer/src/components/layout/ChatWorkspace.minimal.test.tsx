import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * Minimal view in the chat workspace: the composer's phases, the transcript
 * padding frozen through them, the restore button, auto-restore, the refusal
 * to start while the chat needs the user, and keys sent into the cloud.
 */

const spy = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    dropFiles: vi.fn(), resize: null as null | ((height: number) => void), handoffPending: false,
    /** Chat search's reach observer: the composer area's and the chat area's boxes. */
    reach: null as null | (() => void)
  }
})
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: { defaultMultiAgentRouting: 'human' } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }), useDefaultChatMode: () => ({ data: null }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useHintsEnabled', () => ({ useHintsEnabled: () => false }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: vi.fn() }), resolveModel: () => null }))
vi.mock('../../hooks/useApplyChatMode', () => ({ useApplyChatMode: () => vi.fn() }))
vi.mock('../../hooks/useNewChatLike', () => ({ useNewChatLike: () => vi.fn(async () => undefined) }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: null }) }))
vi.mock('../chat/MessageStream', () => ({
  MessageStream: (props: { bottomPadding?: number; pillBottom?: number; searchBottom?: number }) =>
    <output data-testid="stream" data-transcript-scroll data-search-bottom={props.searchBottom ?? 'none'}>{JSON.stringify({ padding: props.bottomPadding, pill: props.pillBottom ?? null })}</output>
}))
// The chat's pending handoff, as the cache its PendingHandoffControl polls would hold it.
vi.mock('../tasks/PendingHandoffControl', async () => {
  const { useSyncExternalStore } = await import('react')
  const listeners = new Set<() => void>()
  ;(spy as unknown as { notify: () => void }).notify = () => listeners.forEach((listener) => listener())
  return {
    useChatHandoffPending: () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, () => spy.handoffPending)
  }
})
vi.mock('../ui/HintBar', () => ({ HintBar: () => null }))
vi.mock('../chat/DesktopAppsBanner', () => ({ DesktopAppsBanner: () => null }))
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => null }))
vi.mock('../chat/ComposerReadiness', () => ({ RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children, readinessRefusal: () => null, usePickedFolder: () => ({ folder: null, pending: false }) }))
vi.mock('../chat/ChatInput', () => ({
  ChatInput: forwardRef(function ChatInput(props: { minimal?: boolean; onCloudShownChange?: (shown: boolean) => void }, ref) {
    const box = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({
      focus: () => box.current?.focus(),
      focusAtEnd: () => box.current?.focus(),
      clearInput: () => {},
      fill: () => {},
      acceptsFileDrop: () => true,
      dropFiles: spy.dropFiles
    }))
    return <div data-testid="composer" data-minimal={props.minimal ? 'yes' : 'no'}><textarea ref={box} aria-label="Message" /><button onClick={() => props.onCloudShownChange?.(true)}>Cloud shows</button></div>
  })
}))
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')
const { requestMinimalView, MINIMAL_TRANSITION_MS } = await import('../../hooks/useMinimalView')

beforeEach(() => {
  vi.useFakeTimers()
  spy.dropFiles.mockReset()
  spy.handoffPending = false
  window.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    // The composer dock's height only; chat search's reach observer watches other boxes.
    observe(el: Element): void {
      if (!el.classList.contains('composer-dock')) {
        spy.reach = () => this.callback([], this as never)
        return
      }
      spy.resize = (height) => this.callback([{ contentRect: { height } } as ResizeObserverEntry], this as never)
    }
    disconnect(): void {}
  } as never
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', minimalView: false, pendingAgentId: null, pendingModeId: null, draftingAgentIds: [] })
  act(() => useChatStore.getState().setActiveChatId('chat-1'))
})
afterEach(() => vi.useRealTimers())

const dock = (): HTMLElement => screen.getByTestId('composer').closest('[data-minimal-phase]') as HTMLElement
const stream = (): { padding: number; pill: number | null } => JSON.parse(screen.getByTestId('stream').textContent!)
const settle = (): void => act(() => { vi.advanceTimersByTime(MINIMAL_TRANSITION_MS) })
const ask = (requestId: string) => ({ requestId, request: {} as never, resume: 'reply' as const })

function enterMinimal(): void {
  act(() => { expect(requestMinimalView()).toBe(true) })
}

it('slides the composer out, brings it back as the cloud, and reverses on restore', () => {
  render(<ChatWorkspace />)
  act(() => spy.resize?.(140))
  expect(dock().dataset.minimalPhase).toBe('full')
  enterMinimal()
  expect(dock().dataset.minimalPhase).toBe('leaving')
  expect(screen.getByTestId('composer').dataset.minimal).toBe('no')
  expect(screen.getByTestId('minimal-restore-button').hasAttribute('data-shown')).toBe(false)
  settle()
  expect(dock().dataset.minimalPhase).toBe('cloud')
  expect(screen.getByTestId('composer').dataset.minimal).toBe('yes')
  const restore = screen.getByTestId('minimal-restore-button')
  expect(restore.hasAttribute('data-shown')).toBe(true)
  expect(restore.getAttribute('aria-label')).toBe('Exit minimal view')
  expect(restore.getAttribute('title')).toBe('Exit minimal view')

  fireEvent.click(restore)
  expect(useUIStore.getState().minimalView).toBe(false)
  expect(dock().dataset.minimalPhase).toBe('returning')
  expect(document.activeElement).toBe(screen.getByLabelText('Message'))
  settle()
  expect(dock().dataset.minimalPhase).toBe('entering')
  expect(screen.getByTestId('composer').dataset.minimal).toBe('no')
  settle()
  expect(dock().dataset.minimalPhase).toBe('full')
  expect(screen.queryByTestId('minimal-restore-button')).toBeNull()
})

it('keeps the transcript padding of the full composer while the composer changes shape', () => {
  render(<ChatWorkspace />)
  act(() => spy.resize?.(140))
  expect(stream().padding).toBe(140)
  enterMinimal()
  settle()
  // The cloud is shorter; the transcript does not move.
  act(() => spy.resize?.(60))
  expect(stream()).toEqual({ padding: 140, pill: 12 })
  act(() => useUIStore.getState().setMinimalView(false))
  settle()
  expect(stream().padding).toBe(140)
  act(() => spy.resize?.(140))
  settle()
  expect(stream()).toEqual({ padding: 140, pill: null })
})

it('ends on its own on a send error or a new ask, not on a nested one', () => {
  render(<ChatWorkspace />)
  enterMinimal()
  settle()
  act(() => useChatStore.getState().addInputRequest({ ...ask('nested'), toolCallId: 'tool-1' }))
  expect(useUIStore.getState().minimalView).toBe(true)
  act(() => useChatStore.getState().addInputRequest(ask('perm-1')))
  expect(useUIStore.getState().minimalView).toBe(false)

  act(() => useChatStore.getState().resolveInputRequest('perm-1'))
  enterMinimal()
  act(() => useChatStore.getState().setSendError('No provider'))
  expect(useUIStore.getState().minimalView).toBe(false)
})

it('refuses to start while the chat needs the user, and off the open-chat view', () => {
  render(<ChatWorkspace />)
  act(() => useChatStore.getState().addInputRequest(ask('perm-1')))
  act(() => { expect(requestMinimalView()).toBe(false) })
  act(() => useChatStore.getState().resolveInputRequest('perm-1'))
  act(() => useChatStore.getState().setSendError('Failed'))
  act(() => { expect(requestMinimalView()).toBe(false) })
  act(() => useChatStore.getState().setSendError(null))
  act(() => useChatStore.getState().setActiveChatId(null))
  act(() => { expect(requestMinimalView()).toBe(false) })
  expect(useUIStore.getState().minimalView).toBe(false)
})

it('ends when the open chat closes for the new-chat screen', () => {
  render(<ChatWorkspace />)
  enterMinimal()
  act(() => useChatStore.getState().setActiveChatId(null))
  expect(useUIStore.getState().minimalView).toBe(false)
})

it('sends printable keys and Cmd+V typed outside any field into the cloud, but not Cmd+C', () => {
  render(<ChatWorkspace />)
  const box = screen.getByLabelText('Message')
  enterMinimal()
  settle()
  box.blur()
  fireEvent.keyDown(document.body, { key: 'c', metaKey: true })
  expect(document.activeElement).toBe(document.body)
  fireEvent.keyDown(document.body, { key: 'a' })
  expect(document.activeElement).toBe(box)
  box.blur()
  fireEvent.keyDown(document.body, { key: 'v', metaKey: true })
  expect(document.activeElement).toBe(box)
  // Not while a dialog has the keys.
  box.blur()
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  document.body.append(dialog)
  fireEvent.keyDown(document.body, { key: 'a' })
  expect(document.activeElement).toBe(document.body)
  dialog.remove()
})

it('does not send keys anywhere outside minimal view', () => {
  render(<ChatWorkspace />)
  screen.getByLabelText('Message').blur()
  fireEvent.keyDown(document.body, { key: 'a' })
  expect(document.activeElement).toBe(document.body)
})

it('takes a file drop anywhere on the transcript through the composer, with an overlay while dragging', () => {
  render(<ChatWorkspace />)
  const area = screen.getByTestId('stream').parentElement as HTMLElement
  const dataTransfer = { types: ['Files'], files: [], dropEffect: 'none' }
  fireEvent.dragEnter(area, { dataTransfer })
  expect(screen.queryByTestId('minimal-drop-overlay')).toBeNull()
  enterMinimal()
  settle()
  fireEvent.dragEnter(area, { dataTransfer })
  expect(screen.getByTestId('minimal-drop-overlay')).toBeTruthy()
  fireEvent.drop(area, { dataTransfer })
  expect(screen.queryByTestId('minimal-drop-overlay')).toBeNull()
  expect(spy.dropFiles).toHaveBeenCalledTimes(1)
})

it('never applies to an embedded or hosted workspace', () => {
  render(<ChatWorkspace chatId="chat-2" />)
  enterMinimal()
  expect(dock().dataset.minimalPhase).toBe('full')
  expect(screen.queryByTestId('minimal-restore-button')).toBeNull()
})

function setHandoffPending(pending: boolean): void {
  spy.handoffPending = pending
  act(() => (spy as unknown as { notify: () => void }).notify())
}

it('ends when a handoff becomes pending, and does not start while one is', () => {
  render(<ChatWorkspace />)
  enterMinimal()
  settle()
  setHandoffPending(true)
  expect(useUIStore.getState().minimalView).toBe(false)
  act(() => { expect(requestMinimalView(true)).toBe(false) })
  setHandoffPending(false)
  enterMinimal()
  expect(useUIStore.getState().minimalView).toBe(true)
})

it('puts Jump to latest above the cloud while it shows, at the bottom edge while it is empty', () => {
  render(<ChatWorkspace />)
  act(() => spy.resize?.(140))
  enterMinimal()
  settle()
  act(() => spy.resize?.(90))
  expect(stream().pill).toBe(12)
  fireEvent.click(screen.getByText('Cloud shows'))
  expect(stream()).toEqual({ padding: 140, pill: 82 })
})

it('ends on two scroll-down attempts at the bottom of the transcript, focusing the composer', () => {
  render(<ChatWorkspace />)
  enterMinimal()
  settle()
  const wheel = (t: number): void => {
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true })
    Object.defineProperty(event, 'timeStamp', { value: t })
    act(() => { screen.getByTestId('stream').dispatchEvent(event) })
  }
  wheel(1000)
  expect(useUIStore.getState().minimalView).toBe(true)
  wheel(1400)
  expect(useUIStore.getState().minimalView).toBe(false)
  expect(document.activeElement).toBe(screen.getByLabelText('Message'))
})

it("places chat search above the composer's drawn content, following it, and measures again after minimal view", () => {
  // The chat area ends at 800; the composer's content starts at `top`.
  const geo = { top: 700 }
  const original = HTMLElement.prototype.getBoundingClientRect
  const boxes = { area: null as HTMLElement | null, composer: null as HTMLElement | null }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === boxes.area) return { top: 0, bottom: 800 } as DOMRect
    if (this === boxes.composer) return { top: geo.top, bottom: 788 } as DOMRect
    return original.call(this)
  }
  try {
    render(<ChatWorkspace />)
    boxes.composer = screen.getByTestId('composer').parentElement
    boxes.area = dock().parentElement
    const searchBottom = (): string | null => screen.getByTestId('stream').getAttribute('data-search-bottom')
    act(() => spy.reach?.())
    expect(searchBottom()).toBe('108')
    // A notice panel opens above the box.
    geo.top = 640
    act(() => spy.reach?.())
    expect(searchBottom()).toBe('168')

    enterMinimal()
    settle()
    expect(searchBottom()).toBe('none')
    // The panel went while the composer was away; the slide back resizes nothing.
    geo.top = 690
    act(() => useUIStore.getState().setMinimalView(false))
    settle()
    settle()
    expect(dock().dataset.minimalPhase).toBe('full')
    expect(searchBottom()).toBe('118')
    // And a slide that ends later is measured too.
    geo.top = 680
    fireEvent.transitionEnd(dock())
    expect(searchBottom()).toBe('128')
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})
