/**
 * The elicitation mapping, against the form the Claude adapter actually builds.
 *
 * The fixtures here are not invented: they are what
 * `@agentclientprotocol/claude-agent-acp@0.76.0`'s
 * `askUserQuestionsToCreateRequest` produces, read out of
 * `node_modules/@agentclientprotocol/claude-agent-acp/dist/elicitation.js`. If
 * that function is reshaped by a version bump, these are the tests that say so.
 */

import { describe, expect, it } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { toElicitationContent, toInputQuestions } from './acpQuestions'

/** One single-select question, as the adapter renders it. */
const ONE_QUESTION = {
  mode: 'form',
  sessionId: 'ses_1',
  toolCallId: 'toolu_01',
  message: 'Which colour do you prefer?',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: 'Colour',
        oneOf: [
          { const: 'Red', title: 'Red', description: 'The colour red' },
          { const: 'Blue', title: 'Blue' }
        ]
      },
      question_0_custom: {
        type: 'string',
        title: 'Other',
        description: 'Type your own answer instead of choosing an option above (optional).',
        _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } }
      }
    }
  }
} as unknown as CreateElicitationRequest

/** Two questions, the second a multi-select — where `message` stops being the question. */
const TWO_QUESTIONS = {
  mode: 'form',
  sessionId: 'ses_1',
  message: 'Please answer the following questions.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: 'Approach',
        description: 'Which approach should I take?',
        oneOf: [{ const: 'Rewrite', title: 'Rewrite' }, { const: 'Patch', title: 'Patch' }]
      },
      question_0_custom: {
        type: 'string',
        title: 'Other',
        _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0' } }
      },
      question_1: {
        type: 'array',
        title: 'Files',
        description: 'Which files may I touch?',
        items: { anyOf: [{ const: 'a.ts', title: 'a.ts' }, { const: 'b.ts', title: 'b.ts' }] }
      },
      question_1_custom: {
        type: 'string',
        title: 'Other',
        _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_1' } }
      }
    }
  }
} as unknown as CreateElicitationRequest

describe('toInputQuestions', () => {
  it('reads one question’s text from `message`, and its options from `oneOf`', () => {
    const form = toInputQuestions(ONE_QUESTION)
    expect(form?.questions).toEqual([
      {
        question: 'Which colour do you prefer?',
        header: 'Colour',
        multiSelect: false,
        options: [{ label: 'Red', description: 'The colour red' }, { label: 'Blue' }]
      }
    ])
    expect(form?.fields).toEqual([{ key: 'question_0', multiple: false }])
  })

  it('drops the per-question “Other” box rather than asking it as a question', () => {
    // The desktop's question widget has no free-text answer. Rendered as a
    // question, the box would appear as an optionless prompt beside every real
    // one — twice as many questions as the model asked.
    const form = toInputQuestions(ONE_QUESTION)
    expect(form?.questions).toHaveLength(1)
    expect(form?.fields.map((field) => field.key)).toEqual(['question_0'])
  })

  it('takes each question’s own text when there are several, and marks the multi-select', () => {
    const form = toInputQuestions(TWO_QUESTIONS)
    expect(form?.questions.map((q) => q.question)).toEqual([
      'Which approach should I take?',
      'Which files may I touch?'
    ])
    expect(form?.questions.map((q) => q.multiSelect)).toEqual([false, true])
    expect(form?.questions[1].options).toEqual([{ label: 'a.ts' }, { label: 'b.ts' }])
  })

  it('maps a plain JSON-Schema `enum`, which is what an MCP server sends', () => {
    const form = toInputQuestions({
      mode: 'form',
      sessionId: 'ses_1',
      message: 'Pick an environment',
      requestedSchema: {
        type: 'object',
        properties: {
          env: { type: 'string', enum: ['staging', 'prod'], enumNames: ['Staging', 'Production'] }
        }
      }
    } as unknown as CreateElicitationRequest)
    expect(form?.questions[0].options).toEqual([
      { label: 'staging', description: 'Staging' },
      { label: 'prod', description: 'Production' }
    ])
  })

  it('refuses a url-mode elicitation, which the desktop has no surface for', () => {
    expect(
      toInputQuestions({
        mode: 'url',
        sessionId: 'ses_1',
        message: 'Log in',
        elicitationId: 'e1',
        url: 'https://example.com/login'
      } as unknown as CreateElicitationRequest)
    ).toBeNull()
  })

  it('refuses a form with no properties instead of asking an empty question', () => {
    expect(
      toInputQuestions({
        mode: 'form',
        sessionId: 'ses_1',
        message: 'Nothing to ask',
        requestedSchema: { type: 'object', properties: {} }
      } as unknown as CreateElicitationRequest)
    ).toBeNull()
  })

  it('asks a question with no options — the renderer shows free text', () => {
    const form = toInputQuestions({
      mode: 'form',
      sessionId: 'ses_1',
      message: 'What should I call the release?',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
    } as unknown as CreateElicitationRequest)
    expect(form?.questions[0].options).toEqual([])
  })
})

describe('toElicitationContent', () => {
  it('writes a single-select answer as the bare label the tool reads back', () => {
    const form = toInputQuestions(ONE_QUESTION)!
    expect(toElicitationContent(form, [['Blue']])).toEqual({ question_0: 'Blue' })
  })

  it('writes a multi-select answer as the array its field declares', () => {
    const form = toInputQuestions(TWO_QUESTIONS)!
    expect(toElicitationContent(form, [['Patch'], ['a.ts', 'b.ts']])).toEqual({
      question_0: 'Patch',
      question_1: ['a.ts', 'b.ts']
    })
  })

  it('omits a question the user skipped rather than answering it with an empty string', () => {
    // Nothing in the adapter's schema is required, and the tool treats an
    // absent field as "skipped" — which is a different answer from "chose the
    // empty option".
    const form = toInputQuestions(TWO_QUESTIONS)!
    expect(toElicitationContent(form, [[], ['a.ts']])).toEqual({ question_1: ['a.ts'] })
  })

  it('files each answer under its own field, not by position in the schema', () => {
    const form = toInputQuestions(TWO_QUESTIONS)!
    const content = toElicitationContent(form, [['Rewrite'], ['b.ts']])
    expect(Object.keys(content)).toEqual(['question_0', 'question_1'])
  })
})
