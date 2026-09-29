import { describe, expect, it } from 'vitest'
import { buildToolStepPreview, clipText, keyToolInput, pairToolSteps, toolStepPreview, type ToolStepPart } from './toolStepPairs'

const call = (toolId?: string, extra: Partial<ToolStepPart> = {}): ToolStepPart => ({ kind: 'tool', text: '', toolId, ...extra })
const result = (toolId?: string, text = 'out', extra: Partial<ToolStepPart> = {}): ToolStepPart => ({ kind: 'tool_result', text, toolId, ...extra })

describe('pairToolSteps', () => {
  it('pairs a result with the call of the same toolId', () => {
    const { callOf, resultsOf } = pairToolSteps([call('a'), { kind: 'text', text: 'hi' }, result('a')])
    expect([...callOf]).toEqual([[2, 0]])
    expect([...resultsOf]).toEqual([[0, [2]]])
  })

  it('pairs interleaved calls by id, not by position', () => {
    const { callOf, resultsOf } = pairToolSteps([call('a'), call('b'), result('b'), result('a'), call('c'), result('c')])
    expect(Object.fromEntries(callOf)).toEqual({ 2: 1, 3: 0, 5: 4 })
    expect(Object.fromEntries(resultsOf)).toEqual({ 0: [3], 1: [2], 4: [5] })
  })

  it('takes the nearest preceding call when an id repeats', () => {
    const { callOf } = pairToolSteps([call('a'), result('a'), call('a'), result('a')])
    expect(Object.fromEntries(callOf)).toEqual({ 1: 0, 3: 2 })
  })

  it('keeps every result of one call (stdout and stderr parts)', () => {
    const { resultsOf } = pairToolSteps([call('a'), result('a'), result('a', 'err', { toolStream: 'stderr' })])
    expect(resultsOf.get(0)).toEqual([1, 2])
  })

  it('falls back to the call immediately before a result without an id', () => {
    const { callOf } = pairToolSteps([call(), result()])
    expect(Object.fromEntries(callOf)).toEqual({ 1: 0 })
  })

  it('does not fall back past a non-adjacent part or onto a call already answered', () => {
    const notAdjacent = pairToolSteps([call(), { kind: 'thinking', text: '…' }, result()])
    expect(notAdjacent.callOf.size).toBe(0)
    const answered = pairToolSteps([call('a'), result('a'), result()])
    expect(answered.callOf.get(2)).toBeUndefined()
  })

  it('leaves a result with an unknown toolId unpaired, even right after a call', () => {
    const { callOf, resultsOf } = pairToolSteps([call('a'), result('zzz')])
    expect(callOf.size).toBe(0)
    expect(resultsOf.size).toBe(0)
  })

  it('never pairs a result with a later call', () => {
    const { callOf } = pairToolSteps([result('a'), call('a')])
    expect(callOf.size).toBe(0)
  })
})

describe('clipText', () => {
  it('keeps short text whole', () => {
    expect(clipText('a\nb', 15, 2000)).toEqual({ text: 'a\nb', moreLines: 0 })
  })

  it('keeps the first lines and counts the rest', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const clipped = clipText(text, 15, 2000)
    expect(clipped.text.split('\n')).toHaveLength(15)
    expect(clipped.text.endsWith('line 14')).toBe(true)
    expect(clipped.moreLines).toBe(25)
  })

  it('cuts one huge line by characters', () => {
    const clipped = clipText('x'.repeat(10_000), 15, 2000)
    expect(clipped.text).toHaveLength(2001)
    expect(clipped.text.endsWith('…')).toBe(true)
  })
})

describe('keyToolInput', () => {
  it('prefers the command, then a path-like key, then compact JSON', () => {
    expect(keyToolInput({ command: 'ls -la', description: 'list' })).toBe('ls -la')
    expect(keyToolInput({ file_path: '/a/b.ts', limit: 3 })).toBe('/a/b.ts')
    expect(keyToolInput({ pattern: '*.ts' })).toBe('*.ts')
    expect(keyToolInput({ query: 'x', n: 1 })).toBe('{"query":"x","n":1}')
    expect(keyToolInput({})).toBeUndefined()
    expect(keyToolInput(undefined)).toBeUndefined()
  })
})

describe('toolStepPreview', () => {
  const parts: ToolStepPart[] = [
    call('a', { toolName: 'Bash', toolInput: { command: 'npm test' }, text: 'Run the tests' }),
    result('a', 'all green'),
    result('zzz', 'orphan', { toolStream: 'stderr' })
  ]
  const pairs = pairToolSteps(parts)

  it('gives a call and its result the same pairKey and the whole step', () => {
    const c = toolStepPreview(parts, 0, pairs, { keyPrefix: 'm' })
    const r = toolStepPreview(parts, 1, pairs, { keyPrefix: 'm' })
    expect(c.pairKey).toBe('m:0')
    expect(r.pairKey).toBe('m:0')
    for (const { preview } of [c, r]) {
      expect(preview()).toMatchObject({ hasCall: true, toolName: 'Bash', input: 'npm test', narration: 'Run the tests', output: 'all green', outputStream: 'stdout' })
    }
    expect(c.preview().focus).toBe('call')
    // A title that restates the command is not narration.
    const echo = [call('e', { toolName: 'Bash', toolInput: { command: 'ls -la' }, text: 'Bash: ls -la' })]
    expect(toolStepPreview(echo, 0, pairToolSteps(echo), { keyPrefix: 'm' }).preview().narration).toBeUndefined()
    expect(r.preview().focus).toBe('output')
  })

  it('shows only the output of an unpaired result', () => {
    const { pairKey, preview: getPreview } = toolStepPreview(parts, 2, pairs, { keyPrefix: 'm' })
    const preview = getPreview()
    expect(pairKey).toBeUndefined()
    expect(preview).toMatchObject({ hasCall: false, output: 'orphan', outputStream: 'stderr', status: 'error' })
  })

  it('marks a call with no output yet as running only while the turn runs', () => {
    const lone = [call('b', { toolName: 'Read', toolInput: { file_path: 'x' } })]
    const lonePairs = pairToolSteps(lone)
    expect(toolStepPreview(lone, 0, lonePairs, { keyPrefix: 's', running: true }).preview()).toMatchObject({ running: true, status: 'pending' })
    expect(toolStepPreview(lone, 0, lonePairs, { keyPrefix: 's' }).preview().running).toBeUndefined()
    // Its output has arrived: no longer running.
    expect(toolStepPreview(parts, 0, pairs, { keyPrefix: 's', running: true }).preview().running).toBeUndefined()
  })

  it('drops trailing whitespace, and a long blank stretch mid-output stays cheap', () => {
    expect(buildToolStepPreview({ outputs: [{ text: 'done\n\n  \n' }] })).toMatchObject({ output: 'done' })
    expect(buildToolStepPreview({ outputs: [{ text: 'a\nb\n\n' }] }).outputMoreLines).toBeUndefined()
    // `/\s+$/` took most of a second on this; the loop is linear.
    const text = `head${' '.repeat(50_000)}tail`
    const started = performance.now()
    expect(buildToolStepPreview({ outputs: [{ text }] }).output!.startsWith('head')).toBe(true)
    expect(performance.now() - started).toBeLessThan(100)
  })
})
