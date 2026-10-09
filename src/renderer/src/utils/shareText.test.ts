import { describe, expect, it } from 'vitest'
import type { AgentShareStatus, ShareRefusal } from '../../../shared/agentSharing'
import {
  FORBIDDEN_SHARE_WORDS,
  SHARE_REFUSAL_TEXT,
  SHARE_STATE_TEXT,
  SHARE_UI_TEXT,
  shareRefusalSentence,
  shareStatusSentence
} from './shareText'

/**
 * The sharing vocabulary is a contract (team-sharing plan, S9): no sentence a
 * sharing surface shows may say branch, commit, push, pull, merge, rebase,
 * remote, repository, conflict or SHA — in any inflection. Every string the
 * surfaces render comes from this module, so reading the module is reading
 * the screens.
 */

const STATUS: AgentShareStatus = {
  agentId: 'folder:a',
  remote: { kind: 'cinna', url: 'u', repoId: 'r', host: 'h', access: 'write' },
  state: 'unshared',
  headSha: 'a',
  remoteHeadSha: 'b',
  ahead: 1,
  behind: 2,
  changedFiles: 3,
  unshared: true,
  fetched: false,
  refusal: null
}

/** Each word with the endings English gives it, as a whole word. */
const FORBIDDEN = new RegExp(
  `\\b(${FORBIDDEN_SHARE_WORDS.map((w) => `${w}(e?s|e?d|ing|ies)?`).join('|')}|repositories|merging|rebasing)\\b`,
  'i'
)

function everyString(): string[] {
  const out: string[] = []
  out.push(...Object.values(SHARE_REFUSAL_TEXT))
  for (const fn of Object.values(SHARE_STATE_TEXT)) out.push(fn(STATUS), fn({ ...STATUS, changedFiles: 1 }))
  for (const value of Object.values(SHARE_UI_TEXT)) {
    out.push(typeof value === 'function' ? (value as (x: string) => string)('Alpha') : value)
  }
  for (const refusal of Object.keys(SHARE_REFUSAL_TEXT) as ShareRefusal[]) {
    out.push(shareRefusalSentence(refusal, 'Alpha'))
  }
  return out
}

describe('the sharing vocabulary', () => {
  it('the pattern catches every forbidden word and its inflections', () => {
    for (const word of ['branch', 'commits', 'pushed', 'Pull', 'merging', 'rebase', 'remote', 'repository', 'conflict', 'SHA']) {
      expect(FORBIDDEN.test(`The ${word} here`)).toBe(true)
    }
    // …and not the words the contract uses.
    expect(FORBIDDEN.test('Share changes with the team')).toBe(false)
  })

  it('no sentence or label says a forbidden word', () => {
    const offenders = everyString().filter((text) => FORBIDDEN.test(text))
    expect(offenders).toEqual([])
  })

  it('has a sentence for every refusal and every state', () => {
    for (const text of Object.values(SHARE_REFUSAL_TEXT)) expect(text.trim()).not.toBe('')
    for (const fn of Object.values(SHARE_STATE_TEXT)) expect(fn(STATUS).trim()).not.toBe('')
  })

  it('a failed read speaks its refusal, not its state', () => {
    expect(shareStatusSentence({ ...STATUS, refusal: 'git_missing' })).toBe(SHARE_REFUSAL_TEXT.git_missing)
    expect(shareStatusSentence(STATUS)).toBe(SHARE_STATE_TEXT.unshared(STATUS))
  })

  it('adds main’s detail only where it completes the sentence', () => {
    expect(shareRefusalSentence('push_rejected', 'Secrets are not allowed.')).toBe(
      `${SHARE_REFUSAL_TEXT.push_rejected} Secrets are not allowed.`
    )
    expect(shareRefusalSentence('exists', 'Payroll')).toContain('Payroll')
    expect(shareRefusalSentence('dirty', 'ignored')).toBe(SHARE_REFUSAL_TEXT.dirty)
    expect(shareRefusalSentence('secrets_tracked', 'credentials/.env')).toBe(
      'A file that can hold a secret is already in the team’s version (credentials/.env). Ask whoever maintains this agent to remove it before sharing.'
    )
    expect(shareRefusalSentence('secrets_tracked', null)).toBe(SHARE_REFUSAL_TEXT.secrets_tracked)
  })
})
