import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Circle, HelpCircle, Send, Star, X } from 'lucide-react'
import {
  CUSTOM_ANSWER_VALUE,
  formatAnswersForSubmission,
  isQuestionAnswered,
  isRecommended,
  type AskQuestion,
  type CollectedAnswer
} from '../../utils/askUserQuestion'

interface AnswerQuestionsModalProps {
  questions: AskQuestion[]
  onSubmit: (text: string) => void
  onClose: () => void
}

/**
 * Modal that collects answers to an agent's `AskUserQuestion` tool call and
 * formats them into the plain-text turn the agent resumes on. Mirrors
 * cinna-core's `AnswerQuestionsModal`: radio (single) / checkbox (multi)
 * options, a synthetic "Other" free-text option per question, a progress
 * counter when there is more than one question, and a Send button gated until
 * every question is answered. Rendered locally by {@link AskUserQuestionBlock}.
 */
export function AnswerQuestionsModal({
  questions,
  onSubmit,
  onClose
}: AnswerQuestionsModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [answers, setAnswers] = useState<Record<number, CollectedAnswer>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onMouse = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
    }
  }, [onClose])

  const answeredFlags = useMemo(
    () => questions.map((q, i) => isQuestionAnswered(q, answers[i])),
    [questions, answers]
  )
  const allAnswered = answeredFlags.every(Boolean)

  const getAnswer = (i: number): CollectedAnswer => answers[i] ?? { selected: [], custom: '' }

  const setSelected = (i: number, q: AskQuestion, value: string): void => {
    setAnswers((prev) => {
      const cur = prev[i] ?? { selected: [], custom: '' }
      if (q.multiSelect) {
        const has = cur.selected.includes(value)
        const selected = has
          ? cur.selected.filter((s) => s !== value)
          : [...cur.selected, value]
        return { ...prev, [i]: { ...cur, selected } }
      }
      return { ...prev, [i]: { ...cur, selected: [value] } }
    })
  }

  const setCustom = (i: number, text: string): void => {
    setAnswers((prev) => {
      const cur = prev[i] ?? { selected: [], custom: '' }
      return { ...prev, [i]: { ...cur, custom: text } }
    })
  }

  const scrollToQuestion = (i: number): void => {
    cardRef.current?.querySelector(`[data-question-index="${i}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  }

  const handleSend = (): void => {
    if (!allAnswered) return
    const text = formatAnswersForSubmission(questions, answers)
    if (!text.trim()) return
    onSubmit(text)
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay-backdrop)] px-4">
      <div
        ref={cardRef}
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border
          border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 min-w-0">
            <HelpCircle size={16} className="text-[var(--color-accent)] shrink-0" />
            <div className="text-sm font-semibold text-[var(--color-text)] truncate">
              {questions.length > 1 ? `${questions.length} questions` : 'Question'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]
              hover:text-[var(--color-text)] transition-colors"
            title="Close"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Progress counter (only when more than one question) */}
        {questions.length > 1 && (
          <div className="flex items-center gap-1.5 px-5 py-2 border-b border-[var(--color-border)] flex-wrap">
            <span className="text-[11px] text-[var(--color-text-muted)] mr-1">
              {answeredFlags.filter(Boolean).length}/{questions.length} answered
            </span>
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => scrollToQuestion(i)}
                className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
                title={`Question ${i + 1}`}
                aria-label={`Go to question ${i + 1}`}
              >
                {answeredFlags[i] ? (
                  <CheckCircle2 size={14} className="text-[var(--color-success)]" />
                ) : (
                  <Circle size={14} className="text-[var(--color-text-muted)]" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Questions */}
        <div className="px-5 py-4 overflow-auto flex-1 space-y-5">
          {questions.map((q, i) => {
            const a = getAnswer(i)
            const customSelected = a.selected.includes(CUSTOM_ANSWER_VALUE)
            return (
              <div key={i} data-question-index={i} className="space-y-2">
                <div className="flex items-start gap-2">
                  {q.header && (
                    <span
                      className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium
                        bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                    >
                      {q.header}
                    </span>
                  )}
                  <div className="text-sm font-medium text-[var(--color-text)]">{q.question}</div>
                </div>

                <div className="space-y-1.5">
                  {q.options.map((opt, oi) => {
                    const selected = a.selected.includes(opt.label)
                    const recommended = isRecommended(opt.label)
                    return (
                      <button
                        key={oi}
                        type="button"
                        onClick={() => setSelected(i, q, opt.label)}
                        className={
                          'w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border transition-colors ' +
                          (selected
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                            : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] opacity-90')
                        }
                      >
                        {q.multiSelect ? (
                          selected ? (
                            <CheckCircle2 size={15} className="shrink-0 mt-0.5 text-[var(--color-accent)]" />
                          ) : (
                            <Circle size={15} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
                          )
                        ) : (
                          <span
                            className={
                              'shrink-0 mt-1 w-3.5 h-3.5 rounded-full border ' +
                              (selected
                                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] ring-2 ring-inset ring-[var(--color-bg-secondary)]'
                                : 'border-[var(--color-text-muted)]')
                            }
                          />
                        )}
                        <span className="min-w-0">
                          <span className="flex items-center gap-1 text-[13px] text-[var(--color-text)]">
                            {opt.label}
                            {recommended && (
                              <Star size={11} className="shrink-0 text-[var(--color-accent)] fill-[var(--color-accent)]" />
                            )}
                          </span>
                          {opt.description && (
                            <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5">
                              {opt.description}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}

                  {/* Synthetic free-text "Other" option, always available. */}
                  <button
                    type="button"
                    onClick={() => setSelected(i, q, CUSTOM_ANSWER_VALUE)}
                    className={
                      'w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border transition-colors ' +
                      (customSelected
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] opacity-90')
                    }
                  >
                    {q.multiSelect ? (
                      customSelected ? (
                        <CheckCircle2 size={15} className="shrink-0 mt-0.5 text-[var(--color-accent)]" />
                      ) : (
                        <Circle size={15} className="shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
                      )
                    ) : (
                      <span
                        className={
                          'shrink-0 mt-1 w-3.5 h-3.5 rounded-full border ' +
                          (customSelected
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent)] ring-2 ring-inset ring-[var(--color-bg-secondary)]'
                            : 'border-[var(--color-text-muted)]')
                        }
                      />
                    )}
                    <span className="text-[13px] text-[var(--color-text)]">Other (enter custom answer)</span>
                  </button>

                  {customSelected && (
                    <input
                      type="text"
                      autoFocus
                      value={a.custom}
                      onChange={(e) => setCustom(i, e.target.value)}
                      placeholder="Type your answer…"
                      className="w-full mt-1 px-3 py-2 text-[13px] rounded-lg border border-[var(--color-border)]
                        bg-[var(--color-bg-input)] text-[var(--color-text)]
                        placeholder:text-[var(--color-text-muted)] focus:outline-none
                        focus:border-[var(--color-accent)]"
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--color-text-secondary)]
              hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!allAnswered}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium
              bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={13} />
            Send {questions.length > 1 ? 'answers' : 'answer'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
