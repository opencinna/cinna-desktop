import { describe, expect, it } from 'vitest'
import { isRunEvent, type RunEvent } from './runEvents'

/** One instance of every variant, keyed by its discriminator so a new one fails the typecheck here. */
const EVERY_VARIANT: { [T in RunEvent['type']]: Extract<RunEvent, { type: T }> } = {
  'request-id': { type: 'request-id', requestId: 'req-1' },
  status: { type: 'status', state: 'needs_input', taskId: 't-1', contextId: 'c-1' },
  delta: { type: 'delta', kind: 'text', text: 'Hello' },
  tool_use: { type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'x' }, providerType: 'mcp' },
  tool_result: { type: 'tool_result', id: 'call-1', result: { hits: 3 } },
  tool_error: { type: 'tool_error', id: 'call-1', error: 'timeout' },
  needs_input: {
    type: 'needs_input',
    requestId: 'per_1',
    request: { kind: 'permission', action: 'bash', resources: ['rm -rf build'] },
    resume: 'reply'
  },
  input_resolved: {
    type: 'input_resolved',
    requestId: 'per_1',
    resolution: { kind: 'permission', reply: 'once' }
  },
  child: {
    type: 'child',
    toolCallId: 'call-2',
    agentId: 'agent-1',
    event: { type: 'delta', kind: 'thinking', text: 'Hmm' }
  },
  user_message: { type: 'user_message', text: 'also check the tests' },
  done: { type: 'done', stopReason: 'end_turn' },
  error: { type: 'error', error: 'boom', code: 'cinna_reauth_required', errorDetail: '401' }
}

describe('isRunEvent', () => {
  it.each(Object.values(EVERY_VARIANT))('accepts $type', (event) => {
    expect(isRunEvent(event)).toBe(true)
  })

  it('accepts a variant carrying only its discriminator — the guard checks nothing else', () => {
    expect(isRunEvent({ type: 'done' })).toBe(true)
  })

  it('rejects a retired discriminator', () => {
    expect(isRunEvent({ type: 'tool_subevent', toolCallId: 'call-2', event: { type: 'done' } })).toBe(false)
  })

  it('rejects a type that is only an inherited property name', () => {
    expect(isRunEvent({ type: 'toString' })).toBe(false)
    expect(isRunEvent({ type: 'constructor' })).toBe(false)
  })

  it.each([
    ['null', null],
    ['a string', 'delta'],
    ['an object with no type', { kind: 'text', text: 'Hello' }],
    ['a non-string type', { type: 42 }]
  ])('rejects %s', (_label, value) => {
    expect(isRunEvent(value)).toBe(false)
  })
})
