import { describe, expect, it } from 'vitest'
import { compactScriptOutput, expandScriptTemplate, MAX_SCRIPT_OUTPUT, MAX_SCRIPT_TEXT, readyScriptSteps, validateTaskScript } from './scriptRouter'

const sample = () => ({ version: 1, agents: {
  coder: { kind: 'agent', source: 'folder', manifestId: 'stable-coder-id' },
  reviewer: { kind: 'agent', source: 'local', cardUrl: 'http://localhost:1234/card' }
}, steps: [
  { id: 'analyse', agent: 'coder', prompt: 'Analyse {{goal}}' },
  { id: 'build', agent: 'coder', prompt: 'Implement {{analyse.text}}', after: ['analyse'] },
  { id: 'review', agent: 'reviewer', prompt: 'Review {{analyse.text}}', after: ['analyse'] },
  { id: 'gate', ask_user: 'Ship {{build.text}}? Review: {{review.text}}', after: ['build', 'review'] }
] })

describe('script definition preflight', () => {
  it('validates a parallel DAG, snapshots its inputs and exposes only ready steps', () => {
    const input = sample()
    const script = validateTaskScript(input)
    input.steps[0].prompt = 'changed'
    expect(script.steps[0]).toMatchObject({ prompt: 'Analyse {{goal}}' })
    const states = { analyse: 'pending', build: 'pending', review: 'pending', gate: 'pending' }
    expect(readyScriptSteps(script, states).map((s) => s.id)).toEqual(['analyse'])
    states.analyse = 'completed'
    expect(readyScriptSteps(script, states).map((s) => s.id)).toEqual(['build', 'review'])
    states.build = 'completed'; states.review = 'waiting'
    expect(readyScriptSteps(script, states)).toEqual([])
    states.review = 'completed'
    expect(readyScriptSteps(script, states).map((s) => s.id)).toEqual(['gate'])
  })

  it('allows a human-only script and dependency order independent of array order', () => {
    expect(validateTaskScript({ version: 1, agents: {}, steps: [
      { id: 'second', ask_user: 'Confirm {{first.text}} for {{goal}}', after: ['first'] },
      { id: 'first', ask_user: 'Which branch?' }
    ] }).steps).toHaveLength(2)
  })

  it.each([
    ['version', { ...sample(), version: 2 }, /version/],
    ['unknown top field', { ...sample(), code: 'execute()' }, /unsupported/],
    ['empty', { ...sample(), steps: [] }, /1–64/],
    ['too many', { ...sample(), steps: Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, ask_user: 'Proceed?' })) }, /1–64/],
    ['unknown agent', { ...sample(), steps: [{ id: 'a', agent: 'missing', prompt: 'do work' }] }, /unknown agent/],
    ['duplicate id', { ...sample(), steps: [{ id: 'a', ask_user: 'One?' }, { id: 'a', ask_user: 'Two?' }] }, /Duplicate/],
    ['unknown dependency', { ...sample(), steps: [{ id: 'a', ask_user: 'One?', after: ['missing'] }] }, /unknown dependency/],
    ['cycle', { ...sample(), steps: [{ id: 'a', ask_user: 'One?', after: ['b'] }, { id: 'b', ask_user: 'Two?', after: ['a'] }] }, /cycle/],
    ['self cycle', { ...sample(), steps: [{ id: 'a', ask_user: 'One?', after: ['a'] }] }, /cycle/],
    ['repeated edge', { ...sample(), steps: [{ id: 'a', ask_user: 'One?' }, { id: 'b', ask_user: 'Two?', after: ['a', 'a'] }] }, /repeats/],
    ['ambiguous action', { ...sample(), steps: [{ id: 'a', ask_user: 'One?', agent: 'coder', prompt: 'do it' }] }, /either/],
    ['missing action', { ...sample(), steps: [{ id: 'a' }] }, /Agent/],
    ['reserved id', { ...sample(), steps: [{ id: 'goal', ask_user: 'One?' }] }, /reserved/],
    ['unsafe id', { ...sample(), steps: [{ id: '../a', ask_user: 'One?' }] }, /identifier/],
    ['long prompt', { ...sample(), steps: [{ id: 'a', ask_user: 'x'.repeat(MAX_SCRIPT_TEXT + 1) }] }, /characters/],
    ['unknown step field', { ...sample(), steps: [{ id: 'a', ask_user: 'One?', script: {} }] }, /unsupported/],
    ['sibling output', { ...sample(), steps: [{ id: 'a', ask_user: 'One?' }, { id: 'b', ask_user: '{{a.text}}' }] }, /dependencies/],
    ['unknown output', { ...sample(), steps: [{ id: 'a', ask_user: '{{missing.text}}' }] }, /dependencies/],
    ['self output', { ...sample(), steps: [{ id: 'a', ask_user: '{{a.text}}' }] }, /dependencies/],
    ['expression', { ...sample(), steps: [{ id: 'a', ask_user: '{{process.env}}' }] }, /only support/],
    ['unclosed template', { ...sample(), steps: [{ id: 'a', ask_user: '{{goal}' }] }, /only support/],
    ['raw local id', { version: 1, agents: { coder: 'local-row-id' }, steps: sample().steps }, /object/]
  ])('refuses %s before execution', (_label, input, message) => {
    expect(() => validateTaskScript(input)).toThrow(message)
  })

  it('requires portable remote server identity and refuses credential-bearing/non-HTTP references', () => {
    const step = [{ id: 'a', agent: 'remote', prompt: 'Work' }]
    const remote = { kind: 'agent', source: 'remote', remoteTargetId: 'id', remoteTargetType: 'agent' }
    expect(() => validateTaskScript({ version: 1, agents: { remote }, steps: step })).toThrow(/server URL/)
    const script = validateTaskScript({ version: 1, agents: { remote: { ...remote, serverUrl: 'https://example.com' } }, steps: step })
    expect(script.agents.remote).toMatchObject({ serverUrl: 'https://example.com' })
    for (const cardUrl of ['file:///tmp/agent', 'https://user:secret@example.com/card']) {
      expect(() => validateTaskScript({ version: 1, agents: { remote: { kind: 'agent', source: 'local', cardUrl } }, steps: step })).toThrow(/HTTP/)
    }
    expect(() => validateTaskScript({ version: 1, agents: JSON.parse('{"__proto__":{"kind":"agent","source":"folder","manifestId":"x"}}'), steps: step })).toThrow(/reserved/)
  })

  it('bounds aggregate definition size before accepting a large DAG', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, ask_user: 'x'.repeat(64000) }))
    expect(() => validateTaskScript({ version: 1, agents: {}, steps })).toThrow(/1 MiB/)
  })
})

describe('script interpolation', () => {
  it('expands dependencies exactly once, treating outputs as literal data', () => {
    expect(expandScriptTemplate('Goal: {{goal}}; {{ analyse.text }}', 'Ship', { analyse: '{{goal}} $& `code`' }))
      .toBe('Goal: Ship; {{goal}} $& `code`')
    expect(expandScriptTemplate('{{empty.text}}', '', { empty: '' })).toBe('')
  })
  it('refuses unavailable and inherited outputs instead of fabricating success', () => {
    expect(() => expandScriptTemplate('{{a.text}}', 'Goal', {})).toThrow(/No completed output/)
    expect(() => expandScriptTemplate('{{a.text}}', 'Goal', Object.create({ a: 'inherited' }))).toThrow(/No completed output/)
  })
  it('bounds repeated expansion without truncating instructions', () => {
    expect(() => expandScriptTemplate('{{a.text}}{{a.text}}', '', { a: 'x'.repeat(40000) })).toThrow(/expanded/)
    expect(() => expandScriptTemplate('{{goal}}', 'x'.repeat(64001), {})).toThrow(/expanded/)
  })
  it('bounds compact outputs and explicitly marks shortened data', () => {
    expect(compactScriptOutput('complete')).toBe('complete')
    const compact = compactScriptOutput('x'.repeat(100000))
    expect(compact.length).toBe(MAX_SCRIPT_OUTPUT)
    expect(compact).toContain('Output shortened')
  })
})
