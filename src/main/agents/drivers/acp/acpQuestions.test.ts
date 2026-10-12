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
import { permissionAsQuestion, permissionQuestionAnswer, toElicitationContent, toInputQuestions } from './acpQuestions'

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

  it('drops the “Other” box when the adapter leaves its marker off, as 0.89 does for a client that is not AIR', () => {
    const schema = (ONE_QUESTION as unknown as { requestedSchema: { properties: Record<string, Record<string, unknown>> } }).requestedSchema
    const { _meta: _marker, ...unmarked } = schema.properties.question_0_custom
    const form = toInputQuestions({
      ...ONE_QUESTION,
      requestedSchema: { ...schema, properties: { ...schema.properties, question_0_custom: unmarked } }
    } as unknown as CreateElicitationRequest)
    expect(form?.fields.map((field) => field.key)).toEqual(['question_0'])
  })

  it('still asks an unmarked `_custom` field that has no `question_<n>` beside it', () => {
    const form = toInputQuestions({
      mode: 'form',
      sessionId: 'ses_1',
      message: 'Name it',
      requestedSchema: { type: 'object', properties: { question_0_custom: { type: 'string', title: 'Name' } } }
    } as unknown as CreateElicitationRequest)
    expect(form?.fields.map((field) => field.key)).toEqual(['question_0_custom'])
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

describe('a question asked as a permission (Antigravity’s ask_question)', () => {
  /** The real 1.3.0 request. */
  const ASK = {
    toolCall: { toolCallId: 'interaction_16c0825e', status: 'pending', title: 'Do you prefer red or blue?', rawInput: {} },
    options: [{ optionId: '1', name: 'Red', kind: 'allow_once' }, { optionId: '2', name: 'Blue', kind: 'allow_once' }]
  }

  it('is a single-choice question whose answers are the options, answered by option id', () => {
    const question = permissionAsQuestion('antigravity', ASK)
    expect(question?.questions).toEqual([{ question: 'Do you prefer red or blue?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }])
    expect(permissionQuestionAnswer(question!, [['Blue']])).toBe('2')
    expect(permissionQuestionAnswer(question!, [['Green']])).toBeNull()
    expect(permissionQuestionAnswer(question!, [])).toBeNull()
  })

  it('is only Antigravity’s, and only an interaction id', () => {
    expect(permissionAsQuestion('claude', ASK)).toBeNull()
    expect(permissionAsQuestion('antigravity', { ...ASK, toolCall: { ...ASK.toolCall, toolCallId: '97b6fe8b' } })).toBeNull()
    expect(permissionAsQuestion('antigravity', { ...ASK, options: [] })).toBeNull()
  })
})

describe('OpenCode 2’s question tool (`elicitation/create`, captured from 2.0.27)', () => {
  /** The request 2.0.27 sent for a two-question `question` call, verbatim. */
  const OPENCODE_QUESTIONS = {
    mode: 'form', sessionId: 'ses_oc', toolCallId: 'call_t', message: 'Questions',
    requestedSchema: {
      type: 'object',
      properties: {
        q0: { type: 'string', title: 'Pick', description: 'Pick one?', oneOf: [{ const: 'A', title: 'A', description: 'a' }, { const: 'B', title: 'B', description: 'b' }] },
        q0_custom: { type: 'string', title: 'Pick (other)', description: 'Type your own answer' },
        q1: { type: 'array', title: 'Extras', description: 'Which extras?', items: { anyOf: [{ const: 'X', title: 'X', description: 'x' }, { const: 'Y', title: 'Y', description: 'y' }] } },
        q1_custom: { type: 'string', title: 'Extras (other)', description: 'Add your own answer' }
      },
      required: []
    }
  } as unknown as CreateElicitationRequest

  it('asks each `q<n>` with its description as the question and its title as the header, and not the `_custom` boxes', () => {
    const form = toInputQuestions(OPENCODE_QUESTIONS)
    expect(form?.questions).toEqual([
      { question: 'Pick one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] },
      { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'X', description: 'x' }, { label: 'Y', description: 'y' }] }
    ])
    expect(form?.fields).toEqual([
      { key: 'q0', multiple: false, custom: 'q0_custom' },
      { key: 'q1', multiple: true, custom: 'q1_custom' }
    ])
  })

  it('takes a lone question’s text from its description, not the generic “Questions”', () => {
    const schema = (OPENCODE_QUESTIONS as unknown as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema
    const { q0, q0_custom } = schema.properties
    const form = toInputQuestions({ ...OPENCODE_QUESTIONS, requestedSchema: { type: 'object', properties: { q0, q0_custom } } } as unknown as CreateElicitationRequest)
    expect(form?.questions.map((q) => q.question)).toEqual(['Pick one?'])
  })

  it('answers chosen labels in their fields and a typed answer in the `_custom` companion, as 2.0.27 accepted it', () => {
    const form = toInputQuestions(OPENCODE_QUESTIONS)!
    expect(toElicitationContent(form, [['B'], ['X', 'Y', 'also Z']])).toEqual({ q0: 'B', q1: ['X', 'Y'], q1_custom: 'also Z' })
  })

  it('writes a typed single answer only into the companion', () => {
    const form = toInputQuestions(OPENCODE_QUESTIONS)!
    expect(toElicitationContent(form, [['my own'], []])).toEqual({ q0_custom: 'my own' })
  })

  it('keeps a typed answer in the question’s own field when it has no companion', () => {
    const schema = (OPENCODE_QUESTIONS as unknown as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema
    const form = toInputQuestions({ ...OPENCODE_QUESTIONS, requestedSchema: { type: 'object', properties: { q0: schema.properties.q0 } } } as unknown as CreateElicitationRequest)!
    expect(form.fields).toEqual([{ key: 'q0', multiple: false }])
    expect(toElicitationContent(form, [['my own']])).toEqual({ q0: 'my own' })
  })
})
