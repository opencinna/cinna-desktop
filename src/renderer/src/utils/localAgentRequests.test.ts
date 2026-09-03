/**
 * The rule that keeps a replayed permission block from looking live.
 *
 * This is the discriminator behind the replay case, and it is the one thing
 * standing between "a persisted transcript" and "a persisted transcript with a
 * live-looking Allow button whose address is dead". Cheap to test, and the
 * failure it prevents is expensive.
 */
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_GRANTS_ENABLED,
  isEngineRequestId,
  isPermissionRequestTool,
  parsePermissionRequest
} from '../../../shared/localAgentRequests'

describe('isEngineRequestId', () => {
  it('recognises the engine\'s own permission and question ids', () => {
    expect(isEngineRequestId('per_abc')).toBe(true)
    expect(isEngineRequestId('que_abc')).toBe(true)
  })

  it('does not claim an ordinary tool call id', () => {
    // A cloud agent's `askuserquestion` part carries a provider tool-call id,
    // and it must keep the existing `activeQuestionMsgId` behaviour: it stays
    // answerable after its turn, because the answer is simply the next user
    // turn.
    //
    // Mutation: `isEngineRequestId` returning `true` for any non-empty string
    // fails this, and would make every cloud question render read-only the
    // moment its turn ended — silently removing the only way to answer it.
    expect(isEngineRequestId('toolu_01ABC')).toBe(false)
    expect(isEngineRequestId('call_xyz')).toBe(false)
    expect(isEngineRequestId(undefined)).toBe(false)
    expect(isEngineRequestId('')).toBe(false)
  })

  it('requires the underscore, so a lookalike name does not match', () => {
    // Mutation: `startsWith('per')` without the separator fails this.
    // `permission_check` is a plausible tool name and matching it would route
    // a real tool call into the request-block renderer.
    expect(isEngineRequestId('permission_check')).toBe(false)
    expect(isEngineRequestId('query_builder')).toBe(false)
  })
})

describe('parsePermissionRequest', () => {
  it('returns null rather than a half-built request', () => {
    // The payload crosses a socket from a separately-versioned binary, so a
    // missing `action` is possible and must not render a permission prompt
    // that says "asking to run undefined".
    expect(parsePermissionRequest(undefined)).toBeNull()
    expect(parsePermissionRequest({})).toBeNull()
    expect(parsePermissionRequest({ action: '' })).toBeNull()
  })

  it('drops non-string entries out of resources and savable', () => {
    // Mutation: assigning `data.resources` straight through fails this, and a
    // non-string in `resources` would render as an object in the very list the
    // user is being asked to approve.
    expect(parsePermissionRequest({ action: 'bash', resources: ['ok', 3, null] })).toEqual({
      action: 'bash',
      resources: ['ok'],
      savable: [],
      callId: undefined
    })
  })
})

describe('isPermissionRequestTool', () => {
  it('matches only the reserved name', () => {
    expect(isPermissionRequestTool('cinna_permission_request')).toBe(true)
    // Deliberately not named after the tool being asked about: OpenCode's
    // permission asks are *about* `bash`/`edit`/`webfetch`, so naming this one
    // after a tool would make an agent's own call to that tool
    // indistinguishable from a request to run it.
    expect(isPermissionRequestTool('bash')).toBe(false)
    expect(isPermissionRequestTool(undefined)).toBe(false)
  })
})

describe('the Always gate', () => {
  it('is off, because one Always was observed granting every folder agent', () => {
    // Duplicated deliberately from the component test so the gate fails from
    // two directions. The leak is proven end to end, not inferred — see the
    // constant for the observation and for the desktop-authoritative design
    // that replaces this path.
    expect(ALWAYS_GRANTS_ENABLED).toBe(false)
  })
})
