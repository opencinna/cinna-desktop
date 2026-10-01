import { describe, expect, it } from 'vitest'
import { contextBudget, contextHealth, isAiSpendingLevel } from './aiSpendingLevel'

describe('contextBudget', () => {
  it('caps Eco and Mid at 250K / 350K on a 1M window', () => {
    expect(contextBudget('eco', 1_000_000)).toBe(250_000)
    expect(contextBudget('mid', 1_000_000)).toBe(350_000)
  })

  it('scales Eco and Mid to 60% / 80% of a smaller window', () => {
    expect(contextBudget('eco', 200_000)).toBe(120_000)
    expect(contextBudget('mid', 200_000)).toBe(160_000)
    expect(contextBudget('eco', 272_000)).toBe(163_200)
    expect(contextBudget('mid', 272_000)).toBe(217_600)
  })

  it('gives Greedy the full window', () => {
    expect(contextBudget('greedy', 200_000)).toBe(200_000)
    expect(contextBudget('greedy', 1_000_000)).toBe(1_000_000)
  })

  it('rounds to whole tokens', () => {
    expect(contextBudget('eco', 333_333)).toBe(200_000)
    expect(Number.isInteger(contextBudget('mid', 123_457))).toBe(true)
  })
})

describe('contextHealth', () => {
  it('reports fill against the budget', () => {
    expect(contextHealth('eco', { used: 60_000, size: 200_000, sizeAuthoritative: true })).toEqual({ budget: 120_000, fill: 0.5, over: false })
  })

  it('is over at exactly the budget and clamps fill to 1 beyond it', () => {
    expect(contextHealth('mid', { used: 160_000, size: 200_000, sizeAuthoritative: true })).toEqual({ budget: 160_000, fill: 1, over: true })
    expect(contextHealth('mid', { used: 190_000, size: 200_000, sizeAuthoritative: true })?.fill).toBe(1)
  })

  it('clamps a negative reading to 0', () => {
    expect(contextHealth('greedy', { used: -5, size: 200_000, sizeAuthoritative: true })?.fill).toBe(0)
  })

  it('says nothing about a guessed or missing window size', () => {
    expect(contextHealth('mid', { used: 190_000, size: 200_000, sizeAuthoritative: false })).toBeNull()
    expect(contextHealth('mid', { used: 1_000, size: 0, sizeAuthoritative: true })).toBeNull()
    expect(contextHealth('mid', { used: 1_000, size: Number.NaN, sizeAuthoritative: true })).toBeNull()
  })
})

it('recognises only the three levels', () => {
  expect(isAiSpendingLevel('eco')).toBe(true)
  expect(isAiSpendingLevel('greedy')).toBe(true)
  expect(isAiSpendingLevel('max')).toBe(false)
  expect(isAiSpendingLevel(undefined)).toBe(false)
})
