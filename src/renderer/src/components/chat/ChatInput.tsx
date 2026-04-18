import { useState, useRef, useEffect, useCallback, useMemo, useImperativeHandle, forwardRef, type ReactNode } from 'react'
import { SendHorizontal, Square, Bot } from 'lucide-react'
import { useSendMessage, useChatDetail } from '../../hooks/useChat'
import { useChatStream } from '../../hooks/useChatStream'
import { useChatStore } from '../../stores/chat.store'
import { ChatControls } from './ChatControls'
import { AgentMentionPopup } from './AgentMentionPopup'
import { useAgents } from '../../hooks/useAgents'
import type { ColorPreset } from '../../constants/chatModeColors'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

interface ChatInputProps {
  chatId: string | null
  onNewChat?: (message: string) => void
  leftSlot?: ReactNode
  modeColor?: ColorPreset | null
  onSelectAgent?: (agent: AgentData | null) => void
}

/** Find the @mention token at the cursor position. Returns { start, filter } or null. */
function findMentionToken(
  value: string,
  cursorPos: number
): { start: number; filter: string } | null {
  // Walk backwards from cursor to find '@'
  let i = cursorPos - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === '@') {
      // '@' must be at start of input or preceded by whitespace
      if (i === 0 || /\s/.test(value[i - 1])) {
        return { start: i, filter: value.slice(i + 1, cursorPos) }
      }
      return null
    }
    // Stop at whitespace — no multi-word @mention
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export interface ChatInputHandle {
  focus: () => void
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { chatId, onNewChat, leftSlot, modeColor, onSelectAgent },
  ref
) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { data: chatData } = useChatDetail(chatId)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus()
  }))

  // Auto-focus on mount and when the bound chat changes — so opening a chat
  // (e.g. after sending the first message from the default screen) lands the
  // caret in the input without an extra click.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [chatId])
  const sendMessage = useSendMessage()
  const { cancel: cancelStream } = useChatStream()
  const { isStreaming, activeRequestId } = useChatStore()

  // @-mention state
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionStart, setMentionStart] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)

  const { data: agents } = useAgents()
  const enabledAgents = useMemo(
    () => (agents ?? []).filter((a) => a.enabled),
    [agents]
  )

  // Resolve the bound agent for active A2A sessions
  const boundAgent = useMemo(
    () => (chatData?.agentId ? (agents ?? []).find((a) => a.id === chatData.agentId) ?? null : null),
    [chatData?.agentId, agents]
  )

  // Filtered agents for the popup (used for keyboard nav bounds)
  const filteredAgents = useMemo(
    () =>
      enabledAgents.filter(
        (a) =>
          a.name.toLowerCase().includes(mentionFilter.toLowerCase()) ||
          a.protocol.toLowerCase().includes(mentionFilter.toLowerCase())
      ),
    [enabledAgents, mentionFilter]
  )

  const closeMention = useCallback(() => {
    setMentionOpen(false)
    setMentionFilter('')
    setMentionIndex(0)
  }, [])

  const selectAgent = useCallback(
    (agent: AgentData) => {
      // Remove the @... token from input
      const before = input.slice(0, mentionStart)
      const afterCursor = input.slice(mentionStart + 1 + mentionFilter.length)
      setInput(before + afterCursor)
      closeMention()
      onSelectAgent?.(agent)

      // Re-focus textarea
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [input, mentionStart, mentionFilter, closeMention, onSelectAgent]
  )

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    if (!chatId && onNewChat) {
      onNewChat(trimmed)
      return
    }

    sendMessage(trimmed)
  }, [input, isStreaming, sendMessage, chatId, onNewChat])

  const handleCancel = useCallback(() => {
    if (activeRequestId) cancelStream(activeRequestId)
  }, [activeRequestId, cancelStream])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // When mention popup is open, intercept navigation keys
    if (mentionOpen && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % filteredAgents.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + filteredAgents.length) % filteredAgents.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectAgent(filteredAgents[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMention()
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setInput(value)

    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'

    // Check for @-mention trigger (only on new-chat screen with agents available)
    if (!chatId && onSelectAgent && enabledAgents.length > 0) {
      const cursorPos = el.selectionStart
      const token = findMentionToken(value, cursorPos)

      if (token) {
        setMentionOpen(true)
        setMentionFilter(token.filter)
        setMentionStart(token.start)
        // Reset index when filter changes
        setMentionIndex(0)
      } else {
        if (mentionOpen) closeMention()
      }
    }
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-4 relative">
      {/* @-mention popup — positioned above the input box */}
      {mentionOpen && !chatId && (
        <AgentMentionPopup
          agents={enabledAgents}
          filter={mentionFilter}
          selectedIndex={mentionIndex}
          onSelect={selectAgent}
          onClose={closeMention}
        />
      )}

      {/* Message box — textarea only */}
      <div
        className="rounded-2xl bg-[var(--color-bg-input)] border overflow-hidden transition-colors duration-200"
        style={{
          borderColor: modeColor ? modeColor.border : 'var(--color-border)',
          backgroundColor: modeColor ? modeColor.bg : undefined
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          className="w-full bg-transparent text-[var(--color-text)] placeholder-[var(--color-text-muted)]
            px-4 pt-3 pb-3 resize-none text-sm leading-relaxed focus:outline-none"
        />
      </div>

      {/* Controls row — below the message box */}
      <div className="flex items-center justify-between px-1 pt-2">
        <div className="flex items-center gap-1.5">
          {leftSlot}
          {chatId && boundAgent ? (
            <div
              className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border
                text-[var(--color-accent)] border-[var(--color-accent)] bg-[var(--color-accent)]/10"
            >
              <Bot size={14} className="shrink-0" />
              <span className="text-[11px] font-medium whitespace-nowrap">
                {boundAgent.name}
              </span>
            </div>
          ) : chatId && !leftSlot ? (
            <ChatControls chatId={chatId} inline />
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {isStreaming ? (
            <button
              onClick={handleCancel}
              className="p-1.5 rounded-lg bg-[var(--color-danger)] hover:opacity-80 text-white transition-opacity"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-1.5 rounded-lg bg-[var(--color-success)] hover:opacity-80 text-white
                disabled:opacity-20 disabled:cursor-not-allowed transition-opacity"
            >
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
