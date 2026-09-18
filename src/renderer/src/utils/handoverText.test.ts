import { describe, expect, it } from 'vitest'
import {
  HANDOVERS_DIR,
  HANDOVER_STATES,
  HANDOVER_WARNING_KINDS,
  type HandoverState
} from '../../../shared/handovers'
import {
  handoverAutoOverriddenText,
  handoverFolderPathShort,
  handoverNoteText,
  handoverStateLabel,
  handoverWarningText
} from './handoverText'

/**
 * The module that turns main's vocabulary into the user's.
 *
 * Tested without a component because both surfaces that render these strings —
 * the task page and the agent card — would otherwise each need a screen to
 * prove the same sentence, and the thing that must not drift is the wording.
 */

describe('what a warning says', () => {
  it('has a sentence for every kind main can write', () => {
    /*
      Seven of the sixteen kinds had one, and the `default` printed the rest as
      they arrived: a task page's Note row read `report_missing` at the user.
      Mutation: delete any `case` below the `start_refused` one and this fails
      on that kind, because its sentence becomes its own token.
    */
    for (const kind of HANDOVER_WARNING_KINDS) {
      // The two shapes a kind arrives in: bare, and with main's detail on it.
      for (const warning of [kind, `${kind}:the chat was busy`]) {
        const text = handoverWarningText(warning)
        expect(text, warning).not.toBe(warning)
        expect(text, warning).not.toContain('_')
        expect(text.trim(), warning).not.toBe('')
      }
    }
  })

  it('says what the run missing its report means, not its token', () => {
    expect(handoverWarningText('report_missing')).toBe(
      'The run finished without writing report.md; the outcome below is the agent’s reply'
    )
    expect(handoverWarningText('run_lost')).toBe(
      'The app closed while the run was in progress, so the run was lost'
    )
    expect(handoverWarningText('wake_timed_out')).toBe(
      'The requester’s chat stayed busy, so the result could not be delivered'
    )
  })

  it('carries main’s own reason after the colon', () => {
    expect(handoverWarningText('wake_failed:The chat was deleted')).toBe(
      'The result could not be delivered to the requester: the chat was deleted'
    )
    expect(handoverWarningText('auto_not_allowed:tracked')).toBe(
      `Automatic run was not allowed: ${HANDOVERS_DIR} is tracked by git`
    )
  })

  it('still shows a kind from a newer build rather than a blank row', () => {
    expect(handoverWarningText('some_future_kind')).toBe('some_future_kind')
  })
})

describe('where the handover is', () => {
  it('fits every state on one line of a 13rem column', () => {
    /*
      The panel polls every five seconds, so this row is the one that changes
      under the reader: "Blocked — needs an answer" wrapped at 800px and moved
      every row below it (`ux_rules.md` §1). 23 characters is what the column
      holds at 12px. Mutation: restore any of the old labels and this fails.
    */
    for (const state of HANDOVER_STATES) {
      const label = handoverStateLabel({ state, refusalReason: 'depth_exceeded' })
      expect(label.length, `${state}: ${label}`).toBeLessThanOrEqual(23)
    }
  })

  it('tells a withdrawal from a Skip', () => {
    expect(handoverStateLabel({ state: 'skipped' })).toBe('Skipped')
    expect(handoverStateLabel({ state: 'skipped', briefMissingAt: 1 })).toBe('Withdrawn')
  })

  it('keeps the refusal’s reason in the row', () => {
    expect(handoverStateLabel({ state: 'refused', refusalReason: 'depth_exceeded' })).toBe(
      'Refused: too deep'
    )
  })

  it('has a phrase for a state this build has not heard of', () => {
    // `parseHandoverState` folds an unknown state to `seen`, so the only way in
    // is a cast — the point is that the switch is exhaustive over the union.
    expect(handoverStateLabel({ state: 'seen' as HandoverState })).toBe('Recorded')
  })
})

describe('the note under the panel', () => {
  it('explains a withdrawal that has no warning of its own', () => {
    expect(handoverNoteText({ state: 'skipped', briefMissingAt: 1 })).toBe(
      'The requester removed the brief, so the handover was withdrawn'
    )
    expect(handoverNoteText({ state: 'skipped' })).toBeNull()
    expect(handoverNoteText({ state: 'done' })).toBeNull()
  })

  it('prefers the warning, which is the more specific fact', () => {
    expect(handoverNoteText({ state: 'skipped', briefMissingAt: 1, warning: 'run_lost' })).toBe(
      'The app closed while the run was in progress, so the run was lost'
    )
  })
})

describe('the folder path, short enough for the panel', () => {
  const row = {
    folderPath: '/Users/dev/projects/uploader',
    handoverId: '20260917-2000-add-retry'
  }

  it('never cuts the handover id', () => {
    // The id is what names this handover; the directories above it are in the
    // `title`. Mutation: elide from the right and the id loses its tail.
    expect(handoverFolderPathShort(row)).toContain(row.handoverId)
    expect(handoverFolderPathShort(row).length).toBeLessThanOrEqual(23)
  })

  it('keeps a path that already fits', () => {
    expect(handoverFolderPathShort({ folderPath: '/w', handoverId: 'abc' })).toBe(
      `/w/${HANDOVERS_DIR}/abc`
    )
  })

  it('elides the middle when there is room for a head', () => {
    const short = handoverFolderPathShort({ folderPath: '/Users/dev/uploader', handoverId: 'ab' })
    expect(short.endsWith('/ab')).toBe(true)
    expect(short).toContain('…')
    expect(short.length).toBeLessThanOrEqual(23)
  })

  it('keeps a Windows path a Windows path', () => {
    const short = handoverFolderPathShort(
      { folderPath: 'C:\\work\\uploader', handoverId: 'ab' },
      40
    )
    expect(short).toBe('C:\\work\\uploader\\.cinna\\handovers\\ab')
  })
})

describe('the git line under the Handovers setting', () => {
  it('says the stored setting is not in force, and why', () => {
    // The select shows `ask` because `ask` is what happens; this line is the
    // only place the stored `auto` still shows (`ux_rules.md` §1, §7).
    expect(handoverAutoOverriddenText({ result: 'tracked' })).toBe(
      `Run automatically is set but not in force — git tracks ${HANDOVERS_DIR}`
    )
    expect(handoverAutoOverriddenText({ result: 'not_ignored' })).toBe(
      `Run automatically is set but not in force — ${HANDOVERS_DIR} is not ignored`
    )
    expect(handoverAutoOverriddenText({ result: 'unknown' })).toBe(
      'Run automatically is set but not in force — git could not be checked'
    )
  })

  it('fits the 800px card', () => {
    for (const result of ['tracked', 'not_ignored', 'unknown'] as const) {
      expect(handoverAutoOverriddenText({ result }).length).toBeLessThanOrEqual(75)
    }
  })
})
