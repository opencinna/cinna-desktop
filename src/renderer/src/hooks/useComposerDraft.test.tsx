import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useComposerDraftField, useComposerDraftKey } from './useComposerDraft'
import { useChatAttachments } from './useChatAttachments'
import { useChatNotes } from './useChatNotes'
import { useAuthStore } from '../stores/auth.store'

const file = { id: '/tmp/plan.md', filename: 'plan.md', size: 12, mimeType: 'text/markdown', source: 'pending' as const }
const note = { id: 'note-1', title: 'Requirements' }
const pickPaths = vi.fn()

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  pickPaths.mockReset().mockResolvedValue({ success: true, files: [file] })
  window.api = { files: { pickPaths, resolvePaths: pickPaths, pickAndUpload: pickPaths, remove: vi.fn() } } as never
})

function useDraft(chatId: string | null, agentId?: string) {
  const key = useComposerDraftKey(chatId, agentId)
  const [text, setText] = useComposerDraftField(key, 'text')
  const [mode, setMode] = useComposerDraftField(key, 'modeSelection')
  const [agents, setAgents] = useComposerDraftField(key, 'pendingAgentIds')
  const [mcps, setMcps] = useComposerDraftField(key, 'pendingMcpIds')
  return { text, setText, mode, setMode, agents, setAgents, mcps, setMcps, files: useChatAttachments(chatId, 'cinna', key), notes: useChatNotes(chatId, key) }
}

it('restores the whole draft after unmount, isolated by profile, agent screen and chat', async () => {
  const first = renderHook(() => useDraft(null))
  act(() => {
    first.result.current.setText('A multiline\ndraft')
    first.result.current.setMode({ id: 'mode-2' })
    first.result.current.setAgents(['agent-2', 'agent-1'])
    first.result.current.setMcps(['mcp-1'])
    first.result.current.notes.add(note)
  })
  await act(() => first.result.current.files.pick())
  first.unmount()

  const initialProps: { chatId: string | null; agentId?: string } = { chatId: 'chat-1' }
  const second = renderHook(({ chatId, agentId }) => useDraft(chatId, agentId), { initialProps })
  expect(second.result.current.text).toBe('')
  expect(second.result.current.files.attachments).toEqual([])
  act(() => second.result.current.setText('Existing chat draft'))
  second.rerender({ chatId: null, agentId: 'agent-1' })
  expect(second.result.current.text).toBe('')
  act(() => second.result.current.setText('Agent draft'))
  second.rerender({ chatId: null })
  expect(second.result.current.text).toBe('A multiline\ndraft')
  expect(second.result.current.mode).toEqual({ id: 'mode-2' })
  expect(second.result.current.agents).toEqual(['agent-2', 'agent-1'])
  expect(second.result.current.mcps).toEqual(['mcp-1'])
  expect(second.result.current.files.attachments).toEqual([file])
  expect(second.result.current.notes.notes).toEqual([note])
  act(() => useAuthStore.setState({ currentUser: { id: 'bob' } as never }))
  expect(second.result.current.text).toBe('')
  expect(second.result.current.notes.notes).toEqual([])
  act(() => useAuthStore.setState({ currentUser: { id: 'alice' } as never }))
  second.rerender({ chatId: null, agentId: 'agent-1' })
  expect(second.result.current.text).toBe('Agent draft')
  second.rerender({ chatId: 'chat-1' })
  expect(second.result.current.text).toBe('Existing chat draft')
})

it('finishes a file pick into its original draft after unmount, without polluting the visible draft', async () => {
  let finish!: (value: unknown) => void
  pickPaths.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  const first = renderHook(() => useDraft(null, 'agent-1'))
  let pending!: Promise<void>
  act(() => { pending = first.result.current.files.pick() })
  first.unmount()
  const second = renderHook(({ agentId }) => useDraft(null, agentId), { initialProps: { agentId: 'agent-2' } })
  await act(async () => { finish({ success: true, files: [file] }); await pending })
  expect(second.result.current.files.attachments).toEqual([])
  second.rerender({ agentId: 'agent-1' })
  expect(second.result.current.files.attachments).toEqual([file])
  expect(second.result.current.files.isUploading).toBe(false)
})

it('invalidates cleared uploads and keeps removal local to the original draft', async () => {
  let finish!: (value: unknown) => void
  pickPaths.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const { result, rerender } = renderHook(({ id }) => useDraft(id), { initialProps: { id: 'chat-1' } })
  let pending!: Promise<void>
  act(() => { pending = result.current.files.pick() })
  const clearOriginal = result.current.files.clear
  rerender({ id: 'chat-2' })
  act(clearOriginal)
  await act(async () => { finish({ success: true, files: [file] }); await pending })
  rerender({ id: 'chat-1' })
  expect(result.current.files.attachments).toEqual([])
  expect(result.current.files.isUploading).toBe(false)
})
