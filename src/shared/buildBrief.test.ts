import { describe, it, expect } from 'vitest'
import { BUILD_BRIEF_LIMITS, composeBuildMessage, parseBuildBrief, type BuildBrief } from './buildBrief'

const input = {
  summary: 'Sorts the morning mail.',
  prompt: 'Build me an agent that sorts my Gmail inbox.',
  capabilities: [
    { id: 'credentials', state: 'used', note: 'reads your Gmail' },
    { id: 'schedules', state: 'maybe', note: 'every weekday at 8' },
    { id: 'artifacts', state: 'maybe', note: 'a weekly chart' },
    { id: 'status', state: 'not_needed', note: '' }
  ],
  skills: [{ name: 'triage', purpose: 'sorts new mail' }],
  credentials: [{ name: 'Gmail' }],
  effort: { level: 'high', reason: 'many rules' }
}

describe('parseBuildBrief', () => {
  it('reads a full brief, trimming its text', () => {
    const parsed = parseBuildBrief({ ...input, summary: '  Sorts the morning mail.  ' })
    expect(parsed).toEqual({ ok: true, brief: { ...input, summary: 'Sorts the morning mail.' } })
  })

  it('fills the optional lists with none', () => {
    const parsed = parseBuildBrief({ summary: 's', prompt: 'p', capabilities: [] })
    expect(parsed).toEqual({ ok: true, brief: { summary: 's', prompt: 'p', capabilities: [], skills: [], credentials: [], effort: null } })
  })

  it.each([
    ['not an object', 'x', 'The input must be an object.'],
    ['no summary', { ...input, summary: undefined }, '`summary` is required.'],
    ['an empty prompt', { ...input, prompt: '   ' }, '`prompt` must not be empty.'],
    ['a prompt too long', { ...input, prompt: 'x'.repeat(BUILD_BRIEF_LIMITS.prompt + 1) }, '`prompt` is longer than'],
    ['no capabilities', { ...input, capabilities: undefined }, '`capabilities` is required.'],
    ['an unknown capability', { ...input, capabilities: [{ id: 'webapp', state: 'used', note: '' }] }, '`capabilities[0].id` must be one of'],
    ['an unknown state', { ...input, capabilities: [{ id: 'status', state: 'yes', note: '' }] }, '`capabilities[0].state` must be one of'],
    ['a capability twice', { ...input, capabilities: [{ id: 'status', state: 'used', note: '' }, { id: 'status', state: 'maybe', note: '' }] }, '`status` is listed twice'],
    ['too many skills', { ...input, skills: Array.from({ length: BUILD_BRIEF_LIMITS.skills + 1 }, (_, i) => ({ name: `s${i}`, purpose: 'p' })) }, '`skills` has more than'],
    ['a nameless credential', { ...input, credentials: [{ name: '' }] }, '`credentials[0].name` must not be empty.'],
    ['an unknown effort', { ...input, effort: { level: 'extreme', reason: '' } }, '`effort.level` must be one of'],
    ['an unknown field', { ...input, password: 'x' }, 'Unknown field `password`.']
  ])('refuses %s', (_label, value, message) => {
    const parsed = parseBuildBrief(value)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(message)
  })
})

describe('composeBuildMessage', () => {
  const brief = (parseBuildBrief(input) as { ok: true; brief: BuildBrief }).brief

  it('is the prompt, what to set up with notes and skills, and the maybes left out', () => {
    expect(composeBuildMessage(brief, 'Build me an agent that sorts my Gmail inbox.', new Set(['schedules']))).toBe([
      'Build me an agent that sorts my Gmail inbox.',
      '',
      'Set up:',
      '- Credentials — reads your Gmail: Gmail',
      '- Schedules — every weekday at 8',
      '- Skills: triage (sorts new mail)',
      '',
      'Not now: Published dashboards.'
    ].join('\n'))
  })

  it('uses the edited prompt and leaves every maybe out by default', () => {
    const message = composeBuildMessage(brief, '  My own words.  ', new Set())
    expect(message.startsWith('My own words.\n\nSet up:')).toBe(true)
    expect(message).not.toContain('- Schedules')
    expect(message.endsWith('Not now: Schedules, Published dashboards.')).toBe(true)
    // `not_needed` is not mentioned at all.
    expect(message).not.toContain('Status')
  })

  it('is the prompt alone when nothing is set up or left out', () => {
    const bare = { ...brief, capabilities: [], skills: [], credentials: [] }
    expect(composeBuildMessage(bare, 'Just this.', new Set())).toBe('Just this.')
  })
})
