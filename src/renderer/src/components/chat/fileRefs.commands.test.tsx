import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'
import { CommandScopeContext, FileRefContext, MessageIdContext, type CommandScope, type FileRefScope } from './fileRefs'
import { useRunScriptStore } from '../../stores/runScript.store'
import { COMMAND_REVIEW_REASONS } from '../../../../shared/userCommands'

/**
 * Commands in a folder agent's reply are clickable: a click (or Enter / Space)
 * opens the Run Script window, nothing runs.
 */

const scope: CommandScope = { chatId: 'chat-1', messages: new Map([['msg-1', { agentId: 'folder:a', folder: '/agents/a' }]]) }

beforeEach(() => {
  useRunScriptStore.setState({ window: null, pending: null, error: null, runSources: {} })
  window.getSelection()?.removeAllRanges()
})

function renderReply(content: string, { messageId = 'msg-1', isStreaming = false, role = 'assistant', fileRefs = null }: {
  messageId?: string; isStreaming?: boolean; role?: 'user' | 'assistant'; fileRefs?: FileRefScope | null
} = {}) {
  return render(
    <CommandScopeContext.Provider value={scope}>
      <FileRefContext.Provider value={fileRefs}>
        <MessageIdContext.Provider value={messageId}>
          <MessageBubble role={role} content={content} isStreaming={isStreaming} />
        </MessageIdContext.Provider>
      </FileRefContext.Provider>
    </CommandScopeContext.Provider>
  )
}

describe('clickable commands', () => {
  it('makes an inline command a button that opens the window on it, from the click', () => {
    renderReply('Run `uv run scripts/check.py italy` then `not a command`.')
    const span = screen.getByRole('button', { name: 'Run… uv run scripts/check.py italy' })
    expect(span.tagName).toBe('CODE')
    expect(span.className).toContain('command-ref')
    expect(span.getAttribute('tabindex')).toBe('0')
    expect(span.getAttribute('title')).toBe('Run…')
    expect(screen.getByText('not a command').getAttribute('role')).toBeNull()
    fireEvent.click(span, { detail: 1, clientX: 40, clientY: 50 })
    expect(useRunScriptStore.getState().window).toMatchObject({
      chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', folder: '/agents/a',
      command: 'uv run scripts/check.py italy', origin: { x: 40, y: 50 }, reason: null, runs: []
    })
  })

  it('makes a fenced command block one button, with the guard\'s sentence for a command that does not look safe', () => {
    const { container } = renderReply('```bash\n$ rm -rf build\n```')
    const pre = container.querySelector('pre')!
    expect(pre.getAttribute('role')).toBe('button')
    expect(pre.className).toContain('command-ref')
    expect(pre.querySelector('[role="button"]')).toBeNull()
    fireEvent.click(pre, { detail: 1, clientX: 1, clientY: 2 })
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'rm -rf build', reason: COMMAND_REVIEW_REASONS.not_read_only })
  })

  it('reads a highlighted block\'s text from its tree', () => {
    const { container } = renderReply('```bash\nuv run scripts/x.py --name "a b" --year 2026\n```')
    // rehype-highlight split the block into spans.
    expect(container.querySelector('pre code span')).not.toBeNull()
    fireEvent.click(container.querySelector('pre')!, { detail: 1 })
    expect(useRunScriptStore.getState().window?.command).toBe('uv run scripts/x.py --name "a b" --year 2026')
  })

  it('opens nothing for a click that ends a selection inside the block', () => {
    const { container } = renderReply('```bash\nls -la\n```')
    const pre = container.querySelector('pre')!
    const range = document.createRange()
    range.selectNodeContents(pre)
    window.getSelection()!.addRange(range)
    fireEvent.click(pre, { detail: 1 })
    expect(useRunScriptStore.getState().window).toBeNull()
  })

  it('opens from the keyboard with Enter and Space, from the centre', () => {
    renderReply('`ls -la`')
    const span = screen.getByRole('button', { name: 'Run… ls -la' })
    fireEvent.keyDown(span, { key: 'Enter' })
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'ls -la', origin: null })
    useRunScriptStore.setState({ window: null })
    fireEvent.keyDown(span, { key: ' ' })
    expect(useRunScriptStore.getState().window?.command).toBe('ls -la')
  })

  it('is plain code in a streaming bubble, a user\'s message, a reply that may not run commands, and a fence of another language', () => {
    renderReply('`ls -la`', { isStreaming: true })
    renderReply('`ls -lb`', { role: 'user' })
    renderReply('`ls -lc`', { messageId: 'msg-other' })
    const { container } = renderReply('```python\nprint("x")\n```')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(container.querySelector('pre')?.className ?? '').not.toContain('command-ref')
  })

  it('leaves a file reference a file reference', () => {
    const ref = { text: 'scripts/check.py', path: '/agents/a/scripts/check.py', displayPath: 'scripts/check.py', kind: 'file' as const, inside: true }
    renderReply('`scripts/check.py`', { fileRefs: { agentId: 'folder:a', refs: new Map([[ref.text, ref]]), links: new Map() } })
    expect(screen.getByRole('button', { name: 'Preview scripts/check.py' }).className).toContain('file-ref')
  })
})
