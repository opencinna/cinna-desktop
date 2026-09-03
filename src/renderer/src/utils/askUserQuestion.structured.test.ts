/**
 * `toStructuredAnswers` — the local-agent serialisation of the answer modal.
 *
 * The same collected state has to serialise two ways, and the two consumers
 * disagree about what "no answer" means. The prose form resumes a **cloud**
 * agent and simply omits an unanswered question, because the agent reads it as
 * text. OpenCode's `QuestionV2Reply` matches answers to questions **by
 * position**, so omitting one there does not skip a question — it shifts every
 * later answer onto the wrong one.
 *
 * Every mutation named below was run; the table is at the bottom.
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_ANSWER_VALUE,
  formatAnswersForSubmission,
  toStructuredAnswers,
  type AskQuestion
} from './askUserQuestion'

const q = (question: string, multiSelect = false): AskQuestion => ({
  question,
  multiSelect,
  options: [{ label: 'A' }, { label: 'B' }]
})

describe('toStructuredAnswers', () => {
  it('emits one array per question, in question order', () => {
    const questions = [q('first'), q('second', true)]
    expect(
      toStructuredAnswers(questions, {
        0: { selected: ['A'], custom: '' },
        1: { selected: ['A', 'B'], custom: '' }
      })
    ).toEqual([['A'], ['A', 'B']])
  })

  it('keeps an unanswered question as an empty slot rather than dropping it', () => {
    const questions = [q('first'), q('second'), q('third')]
    const answers = { 0: { selected: ['A'], custom: '' }, 2: { selected: ['B'], custom: '' } }

    // **This is the trap.** The prose formatter drops question 1 entirely,
    // which is right for a cloud agent reading text and wrong for OpenCode,
    // which pairs `answers[i]` with `questions[i]`. Dropping the middle slot
    // would deliver 'B' — the answer to question *three* — as the answer to
    // question *two*.
    //
    // Mutation: `questions.map(...)` → `Object.values(answers).map(...)`, or
    // filtering out empty arrays, fails this with `[['A'], ['B']]`.
    expect(toStructuredAnswers(questions, answers)).toEqual([['A'], [], ['B']])

    // The prose form deliberately does not do this, and that difference is the
    // reason both exist.
    expect(formatAnswersForSubmission(questions, answers)).not.toContain('second')
  })

  it('sends a custom answer as its own text, not as the sentinel', () => {
    const questions = [q('first')]
    const out = toStructuredAnswers(questions, {
      0: { selected: [CUSTOM_ANSWER_VALUE], custom: '  Postgres  ' }
    })

    // Two mutations fail this. Dropping the
    // `selected.filter(s => s !== CUSTOM_ANSWER_VALUE)` sends the literal
    // '__custom__' to the agent as if it were an option label. Dropping the
    // `.trim()` sends the surrounding whitespace, which will not match any
    // option the agent offered.
    expect(out).toEqual([['Postgres']])
  })

  it('does not decorate a custom answer the way the prose form does', () => {
    const questions = [q('first')]
    const answers = { 0: { selected: [CUSTOM_ANSWER_VALUE], custom: 'Postgres' } }

    // The prose form writes 'Custom answer: Postgres' because a human-readable
    // turn benefits from the label. The structured form must not: these strings
    // are *selected labels*, and a prefix makes one that matches nothing.
    // Mutation: reuse `formatAnswersForSubmission`'s
    // `labels.push(\`Custom answer: ${'${a.custom.trim()}'}\`)` here fails this.
    expect(toStructuredAnswers(questions, answers)).toEqual([['Postgres']])
    expect(formatAnswersForSubmission(questions, answers)).toContain('Custom answer: Postgres')
  })

  it('drops a custom selection with no text rather than sending an empty label', () => {
    const questions = [q('first')]
    expect(
      toStructuredAnswers(questions, { 0: { selected: [CUSTOM_ANSWER_VALUE], custom: '   ' } })
    ).toEqual([[]])
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | `questions.map` → `Object.values(answers).map` | keeps an unanswered question as an empty slot |
 * | filter out empty arrays before returning | keeps an unanswered question as an empty slot |
 * | drop the `CUSTOM_ANSWER_VALUE` filter | sends a custom answer as its own text… |
 * | drop `.trim()` on the custom text | sends a custom answer as its own text… |
 * | prefix the custom answer with 'Custom answer: ' | does not decorate a custom answer… |
 */
