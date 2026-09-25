import { describe, expect, it } from 'vitest'
import { compileScheduleRule, normalizeScheduleEditorMetadata, normalizeScheduleRule, SCHEDULE_TEMPLATES, scheduleRuleSummary } from './scheduleTemplates'

describe('schedule templates and editor rules', () => {
  it('copies stable template values with all ten hourly slots', () => {
    expect(SCHEDULE_TEMPLATES.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'workday-morning', version: 1 }, { id: 'workday-hourly', version: 1 }
    ])
    expect(compileScheduleRule(SCHEDULE_TEMPLATES[0].rule)).toBe('0 8 * * 1,2,3,4,5')
    expect(SCHEDULE_TEMPLATES[1].rule.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
    const normalized = normalizeScheduleRule(SCHEDULE_TEMPLATES[0].rule)
    normalized.hours.push(18)
    expect(SCHEDULE_TEMPLATES[0].rule.hours).toEqual([8])
  })

  it('normalizes numeric sets and validates empty and invalid choices', () => {
    expect(compileScheduleRule({ weekdays: [7, 3, 0, 1, 3], hours: [23, 0, 8, 8] })).toBe('0 0,8,23 * * 0,1,3')
    expect(() => compileScheduleRule({ weekdays: [], hours: [8] })).toThrow('at least one weekday')
    expect(() => compileScheduleRule({ weekdays: [1], hours: [] })).toThrow('at least one hour')
    for (const hour of [-1, 24, 1.5, NaN]) expect(() => compileScheduleRule({ weekdays: [1], hours: [hour] })).toThrow('whole hours')
    expect(() => compileScheduleRule({ weekdays: [8], hours: [8] })).toThrow('valid weekdays')
  })

  it('discards stale metadata instead of losing advanced rule details', () => {
    const metadata = { mode: 'custom', weekdays: [1, 2, 3, 4, 5], hours: [8] }
    expect(normalizeScheduleEditorMetadata(metadata, '0 8 * * 1-5')).toEqual(metadata)
    for (const cron of ['15 8 * * 1-5', '0 8 1 * 1-5', '0 8 * 1-6 1-5', '*/15 8 * * 1-5']) {
      expect(normalizeScheduleEditorMetadata(metadata, cron)).toBeNull()
    }
    expect(normalizeScheduleEditorMetadata(null, '0 8 * * 1-5')).toBeNull()
    expect(normalizeScheduleEditorMetadata({ mode: 'advanced' }, '*/15 2 1-10 2,4 1')).toEqual({ mode: 'advanced' })
  })

  it('retains saved template values independently from the current registry', () => {
    const metadata = { mode: 'template', templateId: 'workday-morning', templateVersion: 123, weekdays: [1, 2, 3, 4, 5], hours: [10] }
    expect(normalizeScheduleEditorMetadata(metadata, '0 10 * * 1-5')).toEqual(metadata)
    expect(normalizeScheduleEditorMetadata(metadata, '0 8 * * 1-5')).toBeNull()
  })

  it('summarizes custom hours and uses Monday-first display order', () => {
    expect(scheduleRuleSummary({ weekdays: [0, 1, 6], hours: [23, 0] })).toBe('Mon, Sat, Sun at 00:00, 23:00')
    expect(scheduleRuleSummary(SCHEDULE_TEMPLATES[0].rule)).toBe('Monday–Friday at 08:00')
  })
})
