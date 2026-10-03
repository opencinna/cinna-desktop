import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TASK_PRIORITY,
  isTaskPriority,
  parseTaskAssigneeKind,
  parseTaskExecutor,
  parseTaskOrigin,
  parseTaskPriority,
  parseTaskRouter,
  TASK_PRIORITIES,
  taskRunsHere,
  TASK_RESERVED_FIELD_KEYS,
  validateTaskCustomFields,
  type TaskPriority
} from './tasks'

describe('task priority', () => {
  it('is cinna-core’s set, lowest first', () => {
    // backend/app/models/tasks/input_task.py:128 — "Priority: low / normal / high / urgent".
    expect(TASK_PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent'])
  })

  it.each(TASK_PRIORITIES)('takes %s as itself', (priority) => {
    expect(parseTaskPriority(priority)).toBe(priority)
    expect(isTaskPriority(priority)).toBe(true)
  })

  it.each([
    ['a priority this build predates', 'critical'],
    ['a capitalised one', 'High'],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined]
  ])('maps %s to the default rather than throwing', (_label, raw) => {
    expect(parseTaskPriority(raw)).toBe(DEFAULT_TASK_PRIORITY)
  })

  it('defaults to the server’s own default', () => {
    expect(DEFAULT_TASK_PRIORITY).toBe<TaskPriority>('normal')
  })

  it('rejects non-strings without reading them', () => {
    expect(isTaskPriority(1)).toBe(false)
    expect(isTaskPriority(null)).toBe(false)
    expect(isTaskPriority({ toString: () => 'high' })).toBe(false)
  })
})

describe('taskRunsHere', () => {
  const here = (executor: 'desktop' | 'remote', executorDevice: string | null) => ({
    executor,
    executorDevice
  })

  it('never claims a task the remote is running', () => {
    expect(taskRunsHere(here('remote', null), null)).toBe(false)
    expect(taskRunsHere(here('remote', null), 'device-a')).toBe(false)
    expect(taskRunsHere(here('remote', 'device-a'), 'device-a')).toBe(false)
  })

  it('claims a task this device named itself on', () => {
    expect(taskRunsHere(here('desktop', 'device-a'), 'device-a')).toBe(true)
  })

  it('does not claim a task another device named itself on', () => {
    expect(taskRunsHere(here('desktop', 'device-a'), 'device-b')).toBe(false)
  })

  it('claims a task nobody in particular named themselves on', () => {
    // What a profile with sync off always writes.
    expect(taskRunsHere(here('desktop', null), 'device-a')).toBe(true)
    expect(taskRunsHere(here('desktop', null), null)).toBe(true)
  })

  it('gives a device with no sync identity authority over everything it can see', () => {
    // `syncService.disconnect` keeps the sync_state row and nulls its deviceId,
    // and reconnecting enrols a new one. Without this arm, turning sync off
    // locks the only device there is out of every task it had claimed.
    expect(taskRunsHere(here('desktop', 'device-a'), null)).toBe(true)
    expect(taskRunsHere(here('desktop', 'a-device-that-no-longer-exists'), null)).toBe(true)
  })
})

describe('the unions that cross app-sync are parsed, not trusted', () => {
  it.each([
    ['router', parseTaskRouter, ['direct', 'human', 'coordinator', 'script'], 'direct'],
    ['origin', parseTaskOrigin, ['local', 'remote'], 'local'],
    ['executor', parseTaskExecutor, ['desktop', 'remote'], 'desktop'],
    ['assignee kind', parseTaskAssigneeKind, ['agent', 'model', 'remote_agent', 'script', 'human'], 'model']
  ] as Array<[string, (raw: unknown) => string, string[], string]>)(
    '%s takes its own members and falls back for anything else',
    (_label, parse, members, fallback) => {
      for (const member of members) expect(parse(member)).toBe(member)
      // A peer on a newer build; a column nulled by a bad write; a number.
      for (const junk of ['swarm', '', null, undefined, 7, {}]) {
        expect(parse(junk)).toBe(fallback)
      }
    }
  )
})

describe('validateTaskCustomFields', () => {
  it('rebuilds scalars and flat lists', () => {
    const input = { estimate: 3, area: 'docs', done: false, none: null, labels: ['a', 1, true] }
    const checked = validateTaskCustomFields(input)
    expect(checked).toEqual({ fields: input })
    if ('fields' in checked) expect(checked.fields.labels).not.toBe(input.labels)
  })

  it('refuses a key that is not a name', () => {
    for (const key of ['', '1st', '_x', 'has space', 'a'.repeat(65), 'dot.ted']) {
      expect(validateTaskCustomFields({ [key]: 'v' })).toHaveProperty('error')
    }
    expect(validateTaskCustomFields({ ['a'.repeat(64)]: 'v', 'x-y_z9': 1 })).toHaveProperty('fields')
  })

  it('refuses every reserved key', () => {
    for (const key of TASK_RESERVED_FIELD_KEYS) {
      expect(validateTaskCustomFields({ [key]: 'v' })).toEqual({ error: expect.stringContaining('built-in') })
    }
    expect(TASK_RESERVED_FIELD_KEYS).toEqual(expect.arrayContaining(['cinna_task', 'status', 'blocked_by', 'updated']))
  })

  it('refuses nested values, non-finite numbers and over-long text', () => {
    expect(validateTaskCustomFields({ a: { b: 1 } })).toHaveProperty('error')
    expect(validateTaskCustomFields({ a: [[1]] })).toHaveProperty('error')
    expect(validateTaskCustomFields({ a: Number.NaN })).toHaveProperty('error')
    expect(validateTaskCustomFields({ a: 'x'.repeat(2001) })).toHaveProperty('error')
    expect(validateTaskCustomFields({ a: ['x'.repeat(2001)] })).toHaveProperty('error')
    expect(validateTaskCustomFields({ a: 'x'.repeat(2000) })).toHaveProperty('fields')
  })

  it('refuses more than fifty fields, and anything that is not an object', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, i]))
    expect(validateTaskCustomFields(many)).toHaveProperty('error')
    delete (many as Record<string, number>).f50
    expect(validateTaskCustomFields(many)).toHaveProperty('fields')
    for (const bad of [null, 'x', 3, ['a']]) expect(validateTaskCustomFields(bad)).toHaveProperty('error')
  })
})
