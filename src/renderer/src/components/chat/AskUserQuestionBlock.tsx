import { useState } from 'react'
import { CheckCircle2, HelpCircle } from 'lucide-react'
import { useChatComposer } from '../../hooks/useChatComposer'
import { AnswerQuestionsModal } from './AnswerQuestionsModal'
import type { AskQuestion } from '../../utils/askUserQuestion'

interface AskUserQuestionBlockProps {
  questions: AskQuestion[]
  /**
   * True when this is the chat's current unanswered question (last turn, not
   * streaming) — shows the prominent "Answer" affordance. False for historical
   * questions that have already been answered, which render as a muted record.
   */
  interactive: boolean
  chatId: string
}

/**
 * Renders an agent's `AskUserQuestion` tool call as an interactive prompt in the
 * transcript. When {@link AskUserQuestionBlockProps.interactive}, it surfaces an
 * "Answer" button that opens {@link AnswerQuestionsModal}; the formatted answer
 * is sent as the next user turn, which auto-threads onto the same A2A context so
 * the agent resumes. Mirrors cinna-core's question widget.
 */
export function AskUserQuestionBlock({
  questions,
  interactive,
  chatId
}: AskUserQuestionBlockProps): React.JSX.Element | null {
  if (questions.length === 0) return null

  const label = questions.length > 1 ? `${questions.length} questions` : 'A question'

  return (
    <div
      className={
        'rounded-lg border px-3.5 py-3 ' +
        (interactive
          ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/8'
          : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] opacity-90')
      }
    >
      <div className="flex items-start gap-2.5">
        {interactive ? (
          <HelpCircle size={16} className="shrink-0 mt-0.5 text-[var(--color-accent)]" />
        ) : (
          <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {interactive ? `The agent is asking ${label.toLowerCase()}` : `${label} asked`}
          </div>
          <ul className="mt-1 space-y-0.5">
            {questions.map((q, i) => (
              <li key={i} className="text-[12px] text-[var(--color-text-secondary)] truncate">
                {questions.length > 1 ? `${i + 1}. ` : ''}
                {q.question}
              </li>
            ))}
          </ul>
          {/* The send hook (and its chat-store subscription) lives in the inner
              component so it mounts only for the active prompt — historical,
              read-only records stay subscription-free. */}
          {interactive && <AnswerAffordance questions={questions} chatId={chatId} />}
        </div>
      </div>
    </div>
  )
}

/**
 * The "Answer" button + modal for the active prompt. Isolated so the
 * `useChatComposer` subscription only attaches while a question is answerable.
 */
function AnswerAffordance({
  questions,
  chatId
}: {
  questions: AskQuestion[]
  chatId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Route the answer through the canonical composer — same A2A-vs-LLM decision
  // (and orchestrated-chat handling) as every other turn; the answer auto-
  // threads onto the chat's existing context so the agent resumes.
  const { submit } = useChatComposer(chatId)

  const handleSubmit = (text: string): void => {
    void submit(text)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
          bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
          transition-colors"
      >
        <HelpCircle size={13} />
        {questions.length > 1 ? 'Answer questions' : 'Answer'}
      </button>
      {open && (
        <AnswerQuestionsModal
          questions={questions}
          onSubmit={handleSubmit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
