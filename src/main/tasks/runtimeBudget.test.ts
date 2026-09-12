import { describe, expect, it } from 'vitest'
import { runtimeBudget } from './runtimeBudget'
import type { TaskBudget } from '../../shared/tasks'

describe('task budget validation', () => {
  it('fills bounded defaults and preserves a positive fractional time limit', () => {
    expect(runtimeBudget()).toEqual({ maxRounds: 20, maxMinutes: 60 })
    expect(runtimeBudget({ maxMinutes: 0.1 })).toEqual({ maxRounds: 20, maxMinutes: 0.1 })
  })

  it.each([
    { maxRounds: 0 }, { maxRounds: 1.5 }, { maxRounds: 1001 }, { maxRounds: Infinity },
    { maxMinutes: 0 }, { maxMinutes: -1 }, { maxMinutes: NaN }, { maxMinutes: 1441 },
    { maxTokens: 0 }, { maxTokens: 1.5 }, { other: true }, [], 'unbounded'
  ])('rejects unsafe limits before dispatch: %j', (input) => {
    expect(() => runtimeBudget(input as TaskBudget)).toThrow()
  })
})
