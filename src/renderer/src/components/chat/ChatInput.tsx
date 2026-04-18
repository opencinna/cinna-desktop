import { useState, useRef, useEffect, useCallback, useMemo, useImperativeHandle, useId, forwardRef, type ReactNode } from 'react'
import { SendHorizontal, Square, Bot } from 'lucide-react'
import { useSendMessage, useChatDetail } from '../../hooks/useChat'
import { useChatStream } from '../../hooks/useChatStream'
import { useChatStore } from '../../stores/chat.store'
import { ChatControls } from './ChatControls'
import { AgentMentionPopup } from './AgentMentionPopup'
import { ExamplePromptPopup } from './ExamplePromptPopup'
import { useAgents } from '../../hooks/useAgents'
import { extractExamplePrompts, type ExamplePrompt } from '../../utils/examplePrompts'
import type { ColorPreset } from '../../constants/chatModeColors'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]
type TriggerChar = '@' | '#'

interface ChatInputProps {
  chatId: string | null
  onNewChat?: (message: string) => void
  leftSlot?: ReactNode
  modeColor?: ColorPreset | null
  onSelectAgent?: (agent: AgentData | null) => void
  /** Agent currently selected on the new-chat screen — used to source example prompts for `#`. */
  selectedAgent?: AgentData | null
}

/** Find a trigger token (@ or #) at the cursor position. */
function findTriggerToken(
  value: string,
  cursorPos: number
): { char: TriggerChar; start: number; filter: string } | null {
  let i = cursorPos - 1
  while (i >= 0) {
    const ch = value[i]
    if (ch === '@' || ch === '#') {
      if (i === 0 || /\s/.test(value[i - 1])) {
        return { char: ch, start: i, filter: value.slice(i + 1, cursorPos) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export interface ChatInputHandle {
  focus: () => void
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { chatId, onNewChat, leftSlot, modeColor, onSelectAgent, selectedAgent },
  ref
) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { data: chatData } = useChatDetail(chatId)
  const listboxId = useId()

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus()
  }))

  useEffect(() => {
    textareaRef.current?.focus()
  }, [chatId])
  const sendMessage = useSendMessage()
  const { cancel: cancelStream } = useChatStream()
  const { isStreaming, activeRequestId } = useChatStore()

  // Trigger popup state — shared between @ (agents) and # (example prompts)
  const [triggerChar, setTriggerChar] = useState<TriggerChar | null>(null)
  const [triggerFilter, setTriggerFilter] = useState('')
  const [triggerStart, setTriggerStart] = useState(0)
  const [triggerIndex, setTriggerIndex] = useState(0)

  const { data: agents } = useAgents()
  const enabledAgents = useMemo(
    () => (agents ?? []).filter((a) => a.enabled),
    [agents]
  )

  const boundAgent = useMemo(
    () => (chatData?.agentId ? (agents ?? []).find((a) => a.id === chatData.agentId) ?? null : null),
    [chatData?.agentId, agents]
  )

  /** Agent whose example_prompts `#` should surface. Bound agent wins in an active chat, else the selected agent on the new-chat screen. */
  const promptSourceAgent = boundAgent ?? selectedAgent ?? null
  const examplePrompts = useMemo(
    () => extractExamplePrompts(promptSourceAgent),
    [promptSourceAgent]
  )

  const filteredAgents = useMemo(
    () =>
      enabledAgents.filter(
        (a) =>
          a.name.toLowerCase().includes(triggerFilter.toLowerCase()) ||
          a.protocol.toLowerCase().includes(triggerFilter.toLowerCase())
      ),
    [enabledAgents, triggerFilter]
  )

  const filteredPrompts = useMemo(() => {
    const q = triggerFilter.toLowerCase()
    return examplePrompts.filter(
      (p) => p.label.toLowerCase().includes(q) || p.full.toLowerCase().includes(q)
    )
  }, [examplePrompts, triggerFilter])

  const agentPopupOpen = triggerChar === '@' && !chatId && !!onSelectAgent
  const promptPopupOpen = triggerChar === '#' && examplePrompts.length > 0

  const closeTrigger = useCallback(() => {
    setTriggerChar(null)
    setTriggerFilter('')
    setTriggerIndex(0)
  }, [])

  const replaceTriggerToken = useCallback(
    (replacement: string): void => {
      const before = input.slice(0, triggerStart)
      const afterCursor = input.slice(triggerStart + 1 + triggerFilter.length)
      setInput(before + replacement + afterCursor)
      closeTrigger()
      setTimeout(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 180) + 'px'
      }, 0)
    },
    [input, triggerStart, triggerFilter, closeTrigger]
  )

  const selectAgent = useCallback(
    (agent: AgentData) => {
      // Drop the @token entirely; agent binding happens via callback.
      replaceTriggerToken('')
      onSelectAgent?.(agent)
    },
    [replaceTriggerToken, onSelectAgent]
  )

  const selectPrompt = useCallback(
    (prompt: ExamplePrompt) => {
      replaceTriggerToken(prompt.full)
    },
    [replaceTriggerToken]
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

  const activeListLength = agentPopupOpen
    ? filteredAgents.length
    : promptPopupOpen
      ? filteredPrompts.length
      : 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (triggerChar && activeListLength > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setTriggerIndex((prev) => (prev + 1) % activeListLength)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setTriggerIndex((prev) => (prev - 1 + activeListLength) % activeListLength)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (agentPopupOpen) selectAgent(filteredAgents[triggerIndex])
        else if (promptPopupOpen) selectPrompt(filteredPrompts[triggerIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeTrigger()
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

    const cursorPos = el.selectionStart
    const token = findTriggerToken(value, cursorPos)

    if (!token) {
      if (triggerChar) closeTrigger()
      return
    }

    // Gate each trigger by context.
    const agentGate = token.char === '@' && !chatId && onSelectAgent && enabledAgents.length > 0
    const promptGate = token.char === '#' && examplePrompts.length > 0
    if (!agentGate && !promptGate) {
      if (triggerChar) closeTrigger()
      return
    }

    setTriggerChar(token.char)
    setTriggerFilter(token.filter)
    setTriggerStart(token.start)
    setTriggerIndex(0)
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-4 relative">
      {agentPopupOpen && (
        <AgentMentionPopup
          items={filteredAgents}
          selectedIndex={triggerIndex}
          onSelect={selectAgent}
          onClose={closeTrigger}
          listboxId={listboxId}
          anchorRef={textareaRef}
        />
      )}

      {promptPopupOpen && (
        <ExamplePromptPopup
          items={filteredPrompts}
          selectedIndex={triggerIndex}
          onSelect={selectPrompt}
          onClose={closeTrigger}
          listboxId={listboxId}
          anchorRef={textareaRef}
        />
      )}

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
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={agentPopupOpen || promptPopupOpen}
          aria-controls={agentPopupOpen || promptPopupOpen ? listboxId : undefined}
          aria-activedescendant={
            (agentPopupOpen && filteredAgents.length > 0) ||
            (promptPopupOpen && filteredPrompts.length > 0)
              ? `${listboxId}-opt-${triggerIndex}`
              : undefined
          }
          className="w-full bg-transparent text-[var(--color-text)] placeholder-[var(--color-text-muted)]
            px-4 pt-3 pb-3 resize-none text-sm leading-relaxed focus:outline-none"
        />
      </div>

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
