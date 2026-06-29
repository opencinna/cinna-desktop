/**
 * Helpers for the interactive "AskUserQuestion" agent tool.
 *
 * A cinna-core agent (Claude Code SDK `AskUserQuestion`, OpenCode `question`)
 * can pause its turn to ask the user one or more structured questions. The
 * Cinna backend normalises every variant to the tool name `askuserquestion`
 * and ships the payload as a `tool`-kind A2A part whose `toolInput` carries a
 * `{ questions: Question[] }` object. These helpers detect that part, parse the
 * payload defensively (it arrives as an untyped `Record<string, unknown>`), and
 * format the collected answers back into the plain-text user turn the agent
 * resumes on. See cinna-core `AnswerQuestionsModal` for the reference behaviour.
 */

export interface AskQuestionOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  /** Short tag/badge shown next to the question. */
  header?: string
  /** true → checkboxes (multi), false/absent → radio (single). */
  multiSelect?: boolean
  options: AskQuestionOption[]
}

/** Sentinel option value for the synthetic per-question free-text answer. */
export const CUSTOM_ANSWER_VALUE = '__custom__'

/**
 * True when a `tool`-kind part is the interactive question tool. The Cinna
 * backend normalises `AskUserQuestion` / `question` to `askuserquestion`, but
 * match case- and separator-insensitively so a non-normalised `AskUserQuestion`
 * (or `ask_user_question`) still resolves.
 */
export function isAskUserQuestionTool(toolName?: string): boolean {
  if (!toolName) return false
  return toolName.toLowerCase().replace(/[^a-z]/g, '') === 'askuserquestion'
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Parse the `{ questions: [...] }` payload out of a tool part's `toolInput`,
 * dropping any malformed entries. Returns an empty array when nothing usable is
 * present so callers can treat `length === 0` as "no questions".
 */
export function parseAskQuestions(toolInput?: Record<string, unknown>): AskQuestion[] {
  const raw = toolInput?.questions
  if (!Array.isArray(raw)) return []
  const out: AskQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const question = asString(obj.question)
    if (!question) continue
    const optionsRaw = Array.isArray(obj.options) ? obj.options : []
    const options: AskQuestionOption[] = []
    for (const opt of optionsRaw) {
      if (!opt || typeof opt !== 'object') continue
      const o = opt as Record<string, unknown>
      const label = asString(o.label)
      if (!label) continue
      options.push({ label, description: asString(o.description) })
    }
    out.push({
      question,
      header: asString(obj.header),
      multiSelect: obj.multiSelect === true || obj.multiple === true,
      options
    })
  }
  return out
}

/** True when an option label marks itself as the recommended choice. */
export function isRecommended(label: string): boolean {
  return /\(recommended\)/i.test(label)
}

/**
 * Per-question collected answer, mirroring the modal's local state. `selected`
 * holds chosen option labels (plus {@link CUSTOM_ANSWER_VALUE} when the free-
 * text option is picked); `custom` is the free-text content.
 */
export interface CollectedAnswer {
  selected: string[]
  custom: string
}

/** True when a single question has a complete answer (custom requires text). */
export function isQuestionAnswered(_q: AskQuestion, a: CollectedAnswer | undefined): boolean {
  if (!a || a.selected.length === 0) return false
  if (a.selected.includes(CUSTOM_ANSWER_VALUE) && a.custom.trim() === '') return false
  return true
}

/**
 * Format the collected answers into the plain-text turn the agent resumes on.
 * Matches cinna-core's `formatAnswersForSubmission`:
 *  - single: `"{question}\nAnswer: {label}"`
 *  - multi:  `"{question}\nAnswers:\n- {a}\n- {b}"`
 * Custom free-text is rendered as `Custom answer: {text}`. Questions are joined
 * with a blank line.
 */
export function formatAnswersForSubmission(
  questions: AskQuestion[],
  answers: Record<number, CollectedAnswer>
): string {
  const blocks: string[] = []
  questions.forEach((q, i) => {
    const a = answers[i]
    if (!a) return
    const labels = a.selected.filter((s) => s !== CUSTOM_ANSWER_VALUE)
    if (a.selected.includes(CUSTOM_ANSWER_VALUE) && a.custom.trim() !== '') {
      labels.push(`Custom answer: ${a.custom.trim()}`)
    }
    if (labels.length === 0) return
    if (q.multiSelect) {
      blocks.push(`${q.question}\nAnswers:\n${labels.map((l) => `- ${l}`).join('\n')}`)
    } else {
      blocks.push(`${q.question}\nAnswer: ${labels[0]}`)
    }
  })
  return blocks.join('\n\n')
}
