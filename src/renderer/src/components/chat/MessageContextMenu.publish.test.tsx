import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { messageMenuItems, useMessageContextMenu } from './MessageContextMenu'
import { MessageBubble } from './MessageBubble'
import { FileRefContext, MessageIdContext, type FileRefScope } from './fileRefs'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactsSupportStore } from '../../hooks/useArtifacts'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'

/**
 * Publish… on a file or folder reference: offered only when the profile's
 * instance keeps artifacts, only for what is inside the agent's folder and
 * not a credential file, and it opens the app-wide dialog on the message the
 * reference was in.
 */

const ref = (text: string, over: Partial<AgentFileRef> = {}): AgentFileRef => ({
  text,
  path: `/agent/${text}`,
  displayPath: text,
  kind: 'file',
  inside: true,
  ...over
})
const refs = [
  ref('reports/q3', { kind: 'dir' }),
  ref('report.md'),
  ref('.env'),
  ref('outside.csv', { inside: false, path: '/elsewhere/outside.csv', displayPath: '/elsewhere/outside.csv' })
]
const scope: FileRefScope = { agentId: 'folder:a', refs: new Map(refs.map((r) => [r.text, r])), links: new Map() }
const content = refs.map((r) => `\`${r.text}\``).join(' and ')
const LIMITS = { maxRevisionBytes: 1, maxRevisionFiles: 1, maxFileBytes: 1 }

function Harness() {
  const context = useMessageContextMenu('chat-1')
  return (
    <>
      <div onContextMenu={context.onContextMenu}>
        <FileRefContext.Provider value={scope}>
          <MessageIdContext.Provider value="msg-7">
            <MessageBubble role="assistant" content={content} />
          </MessageIdContext.Provider>
        </FileRefContext.Provider>
      </div>
      {context.menu}
    </>
  )
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<Harness />, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}

const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent)

beforeEach(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS } })
  useArtifactPublishStore.setState({ request: null, publishing: false })
})

describe('Publish… in the reference menu', () => {
  it('is offered last for a folder and a file inside the agent folder', () => {
    mount()
    fireEvent.contextMenu(screen.getByText('reports/q3'), { clientX: 10, clientY: 10 })
    expect(items()).toEqual(['Copy full path', 'Show in the folder', 'Reference in a new chat', 'Publish…'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.contextMenu(screen.getByText('report.md'), { clientX: 10, clientY: 10 })
    expect(items().at(-1)).toBe('Publish…')
  })

  it('is not offered for a credential file, a path outside the folder, or plain text', () => {
    mount()
    for (const text of ['.env', 'outside.csv']) {
      fireEvent.contextMenu(screen.getByText(text), { clientX: 10, clientY: 10 })
      expect(items()).not.toContain('Publish…')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    }
    expect(messageMenuItems(undefined, true)).toEqual([['copy-text', 'save-text']])
  })

  it('is not offered when the instance does not keep artifacts, or the answer is for another profile', () => {
    useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: false, limits: LIMITS } })
    const { unmount } = mount()
    fireEvent.contextMenu(screen.getByText('report.md'), { clientX: 10, clientY: 10 })
    expect(items()).not.toContain('Publish…')
    unmount()
    useArtifactsSupportStore.setState({ profileId: 'bob', support: { supported: true, limits: LIMITS } })
    mount()
    fireEvent.contextMenu(screen.getByText('report.md'), { clientX: 10, clientY: 10 })
    expect(items()).not.toContain('Publish…')
  })

  it('opens the dialog on the reference and the message it was in, and closes the menu', async () => {
    mount()
    fireEvent.contextMenu(screen.getByText('reports/q3'), { clientX: 10, clientY: 10 })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Publish…' }))
    })
    expect(useArtifactPublishStore.getState().request).toEqual({
      agentId: 'folder:a',
      path: '/agent/reports/q3',
      kind: 'dir',
      chatId: 'chat-1',
      messageId: 'msg-7'
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
