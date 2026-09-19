import { describe, expect, it } from 'vitest'
import { delegationNoteText } from './delegationText'

describe('delegation notes', () => {
  it('keeps the useful failure detail while removing transport codes and reply identifiers', () => {
    expect(delegationNoteText({ warning: 'reply_failed:V1StGXR8_Z5jdHi6B-myT:Error: The executor conversation is gone.', refusalReason: null }))
      .toBe('The follow-up could not be delivered to the executor: The executor conversation is gone.')
    expect(delegationNoteText({ warning: 'start_refused:Error: No engine is installed.', refusalReason: null }))
      .toBe('The run could not be started: No engine is installed.')
    expect(delegationNoteText({ warning: 'wake_failed:The requester no longer exists.', refusalReason: null }))
      .toContain('The requester no longer exists.')
  })

  it('distinguishes an unknown delivery from a busy executor and a lost run', () => {
    expect(delegationNoteText({ warning: 'reply_uncertain:reply:Error: Closed', refusalReason: null })).toContain('before sending it again')
    expect(delegationNoteText({ warning: 'reply_timed_out:reply', refusalReason: null })).toContain('still waiting to be delivered')
    expect(delegationNoteText({ warning: 'run_lost', refusalReason: null })).toContain('The app closed')
    expect(delegationNoteText({ warning: 'report_missing', refusalReason: null })).toBe('The executor ended its turn without reporting a result.')
  })

  it('shows refusal reasons, preserves capability explanations and leaves absent notes empty', () => {
    expect(delegationNoteText({ warning: null, refusalReason: 'depth_exceeded' })).toContain('handed on twice')
    expect(delegationNoteText({ warning: 'This service does not expose remote attachments.', refusalReason: null }))
      .toBe('This service does not expose remote attachments.')
    expect(delegationNoteText({ warning: 'future_internal_code:opaque', refusalReason: null })).not.toContain('future_internal_code')
    expect(delegationNoteText({ warning: null, refusalReason: null })).toBeNull()
  })
  it('explains a stopped cloud dispatch with the dispatch error, not the capability warning', () => {
    expect(delegationNoteText({ state: 'uncertain', warning: 'This service does not expose remote attachments; inspect the remote task for files.', refusalReason: null, dispatchError: 'The previous dispatch was interrupted. Check the remote task before retrying.' }))
      .toBe('The previous dispatch was interrupted. Check the remote task before retrying.')
    expect(delegationNoteText({ state: 'done', warning: 'run_lost', refusalReason: null, dispatchError: 'stale' })).toContain('run was lost')
  })
})
