import { useRef, useState } from 'react'
import { Check, CheckCircle2, HelpCircle } from 'lucide-react'
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
  /**
   * The chat the question was asked in. Null only where the surface rendering
   * this block is not a chat — the inbox, which answers by request id and
   * never reaches the composer path below.
   */
  chatId: string | null
  /**
   * The engine request id (`que_*`) when a **local** agent is parked on this
   * question right now.
   *
   * Its presence is what picks the delivery path, and the two are genuinely
   * different rather than two spellings of one thing. A cloud agent's question
   * *ended its turn*, so the answer is the next user message and goes through
   * the composer. A local agent's question ended nothing: the agent loop is
   * still running, parked on
   * `POST /api/session/{id}/question/{requestID}/reply`, and there is no user
   * turn to send. Answering that through the composer would prompt the agent a
   * second time while the first turn was still waiting.
   */
  liveRequestId?: string
  /**
   * What this question settled as, as one sentence — the sibling of
   * {@link PermissionRequestBlock}'s `decision`, and for the same reason: a
   * settled ask that shows no record of its own outcome tells the reader
   * nothing, and sends them back to the transcript to find out.
   *
   * Compose it with `describeQuestionAnswers`, never by hand: the runner writes
   * the same sentence into the transcript as a `tool_result`, and the two are
   * read one reload apart.
   */
  decision?: string
  /**
   * True when the desktop itself is asking — the handover gate, which is a
   * question about work no agent has been given yet.
   *
   * Two things follow from it and both were findings. "The agent is asking"
   * named an actor that does not exist at that moment (§10), and the modal's
   * synthetic "Other (enter custom answer)" offered a free-text reply main
   * refuses: the gate is matched against `HANDOVER_GATE_OPTIONS` and anything
   * else comes back as an error the user cannot act on (§6).
   */
  askedByDesktop?: boolean
  onAnswerLocal?: (requestId: string, answers: string[][]) => Promise<unknown>
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
  chatId,
  liveRequestId,
  decision,
  askedByDesktop = false,
  onAnswerLocal
}: AskUserQuestionBlockProps): React.JSX.Element | null {
  if (questions.length === 0) return null

  const label = questions.length > 1 ? `${questions.length} questions` : 'A question'
  // A local agent's question is answerable **while the turn streams**, so
  // `interactive` — which requires the stream to have finished — is not the
  // only way in.
  const live = interactive || !!liveRequestId
  // One header for the card: every question in one ask comes from one place,
  // and the modal repeats it per question where they can differ.
  const header = questions.find((q) => q.header)?.header

  return (
    <div
      className={
        'rounded-lg border px-3.5 py-3 ' +
        (live
          ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/8'
          : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] opacity-90')
      }
    >
      <div className="flex items-start gap-2.5">
        {live ? (
          <HelpCircle size={16} className="shrink-0 mt-0.5 text-[var(--color-accent)]" />
        ) : (
          <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* The question's own `header` — "Handover" on a gate — as the
                badge the answer modal already shows it as, so the card and the
                modal it opens name the same thing. */}
            {header && (
              <span
                className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium
                  bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
              >
                {header}
              </span>
            )}
            <div className="text-[13px] font-medium text-[var(--color-text)]">
              {live
                ? `${askedByDesktop ? 'Cinna Desktop' : 'The agent'} is asking ${label.toLowerCase()}`
                : `${label} asked`}
            </div>
          </div>
          <ul className="mt-1 space-y-0.5">
            {questions.map((q, i) => (
              <li key={i} className="text-[12px] text-[var(--color-text-secondary)] truncate">
                {questions.length > 1 ? `${i + 1}. ` : ''}
                {q.question}
              </li>
            ))}
          </ul>
          {decision && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <Check size={12} />
              {decision}
            </div>
          )}
          {/* The send hook (and its chat-store subscription) lives in the inner
              component so it mounts only for the active prompt — historical,
              read-only records stay subscription-free. */}
          {(interactive || liveRequestId) && (
            <AnswerAffordance
              questions={questions}
              chatId={chatId}
              liveRequestId={liveRequestId}
              allowCustomAnswer={!askedByDesktop}
              onAnswerLocal={onAnswerLocal}
            />
          )}
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
  chatId,
  liveRequestId,
  allowCustomAnswer = true,
  onAnswerLocal
}: {
  questions: AskQuestion[]
  chatId: string | null
  liveRequestId?: string
  allowCustomAnswer?: boolean
  onAnswerLocal?: (requestId: string, answers: string[][]) => Promise<unknown>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  // Route a cloud agent's answer through the canonical composer, so it reaches
  // whoever the chat's router says answers — the same resolution as every other
  // turn, including the agent this chat is currently addressed to. The answer
  // auto-threads onto the chat's existing context so the agent resumes.
  const { submit } = useChatComposer(chatId)

  const handleSubmit = async (text: string, structured: string[][]): Promise<void> => {
    if (submitting.current) return
    // A retry starts clean. Without this a refused answer's red line survived
    // the answer that then landed, and sat under the button saying the opposite
    // of what had just happened.
    setError(null)
    submitting.current = true
    setPending(true)
    try {
      if (liveRequestId && onAnswerLocal) {
        await onAnswerLocal(liveRequestId, structured)
        setOpen(false)
        return
      }
      // **No chat and no live address: say so rather than do nothing.** The
      // composer's `submit` returns silently on a null `chatId`, so this branch
      // used to close the modal, send nothing and report nothing. It is
      // unreachable from the two callers that exist — the transcript always has a
      // chat, the inbox always has a request id — and it is exactly what the next
      // caller would write by accident, now that `chatId` is allowed to be null.
      if (!chatId) {
        setError('This question can only be answered in the chat it was asked in.')
        return
      }
      await submit(text)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      setPending(false)
    }
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
      {!open && error && <div className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</div>}
      {open && (
        <AnswerQuestionsModal
          questions={questions}
          allowCustomAnswer={allowCustomAnswer}
          onSubmit={handleSubmit}
          onClose={() => setOpen(false)}
          pending={pending}
          error={error}
        />
      )}
    </>
  )
}
