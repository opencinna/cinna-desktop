import { useState, useRef, useCallback, type ReactNode } from 'react'
import { SendHorizontal, Square } from 'lucide-react'
import { useSendMessage } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chat.store'
import { ChatControls } from './ChatControls'
import type { ColorPreset } from '../../constants/chatModeColors'

interface ChatInputProps {
  chatId: string | null
  onNewChat?: (message: string) => void
  leftSlot?: ReactNode
  modeColor?: ColorPreset | null
}

export function ChatInput({ chatId, onNewChat, leftSlot, modeColor }: ChatInputProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useSendMessage()
  const { isStreaming, activeRequestId } = useChatStore()

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
    if (activeRequestId) {
      window.api.llm.cancel(activeRequestId)
    }
  }, [activeRequestId])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-4">
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
          {chatId && <ChatControls chatId={chatId} inline />}
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
}
