import { parseScheduleCron } from './scheduleTiming'

export interface ScheduleRule {
  weekdays: number[]
  hours: number[]
}

export interface ScheduleTemplate {
  id: string
  version: number
  label: string
  rule: ScheduleRule
}

/** Templates are copied by the editor; saved cron is always execution authority. */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  { id: 'workday-morning', version: 1, label: 'Workday morning', rule: { weekdays: [1, 2, 3, 4, 5], hours: [8] } },
  { id: 'workday-hourly', version: 1, label: 'Workday hourly', rule: { weekdays: [1, 2, 3, 4, 5], hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18] } }
]

export interface ScheduleEditorMetadata {
  mode: 'template' | 'custom' | 'advanced'
  templateId?: string
  templateVersion?: number
  weekdays?: number[]
  hours?: number[]
}

export function normalizeScheduleRule(rule: ScheduleRule): ScheduleRule {
  if (!rule || !Array.isArray(rule.weekdays) || rule.weekdays.length === 0) throw new Error('Choose at least one weekday.')
  if (!Array.isArray(rule.hours) || rule.hours.length === 0) throw new Error('Choose at least one hour.')
  if (rule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 7)) throw new Error('Choose valid weekdays from Monday through Sunday.')
  if (rule.hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) throw new Error('Choose whole hours from 00:00 through 23:00.')
  return {
    weekdays: [...new Set(rule.weekdays.map((day) => day === 7 ? 0 : day))].sort((a, b) => a - b),
    hours: [...new Set(rule.hours)].sort((a, b) => a - b)
  }
}

export function compileScheduleRule(rule: ScheduleRule): string {
  const normalized = normalizeScheduleRule(rule)
  return `0 ${normalized.hours.join(',')} * * ${normalized.weekdays.join(',')}`
}

function equalCron(left: string, right: string): boolean {
  const a = parseScheduleCron(left), b = parseScheduleCron(right)
  return a.dayWildcard === b.dayWildcard && a.weekdayWildcard === b.weekdayWildcard
    && a.fields.every((field, index) => field.size === b.fields[index].size && [...field].every((value) => b.fields[index].has(value)))
}

/** Invalid or stale metadata must never hide an externally edited advanced rule. */
export function normalizeScheduleEditorMetadata(metadata: unknown, cron: string): ScheduleEditorMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = metadata as Record<string, unknown>
  try {
    parseScheduleCron(cron)
    if (value.mode === 'advanced') return { mode: 'advanced' }
    if (value.mode !== 'template' && value.mode !== 'custom') return null
    const rule = normalizeScheduleRule({ weekdays: value.weekdays as number[], hours: value.hours as number[] })
    if (!equalCron(compileScheduleRule(rule), cron)) return null
    if (value.mode === 'custom') return { mode: 'custom', ...rule }
    if (typeof value.templateId !== 'string' || !value.templateId || value.templateId.length > 128
      || !Number.isSafeInteger(value.templateVersion) || (value.templateVersion as number) < 1) return null
    // Do not compare against the current registry: an old template's copied
    // values remain correct even if a later app changes that template.
    return { mode: 'template', templateId: value.templateId, templateVersion: value.templateVersion as number, ...rule }
  } catch {
    return null
  }
}

export function scheduleRuleSummary(rule: ScheduleRule): string {
  const { weekdays, hours } = normalizeScheduleRule(rule)
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayText = weekdays.length === 7 ? 'Every day'
    : weekdays.join(',') === '1,2,3,4,5' ? 'Monday–Friday'
      : [...weekdays].sort((a, b) => (a || 7) - (b || 7)).map((day) => labels[day]).join(', ')
  const hourText = hours.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(', ')
  return `${dayText} at ${hourText}`
}
