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
  describeGrantScope,
  isEngineRequestId,
  isPermissionGranted,
  isPermissionRequestTool,
  parsePermissionRequest,
  permissionGrantKey,
  permissionGrantMatches,
  permissionGrantPatterns
} from '../../../shared/localAgentRequests'

/** A permission ask, with only the fields the grant rules read. */
const ask = (action: string, resources: string[] = []) => ({ action, resources, savable: [] })

describe('isEngineRequestId', () => {
  it("recognises the engine's own permission and question ids", () => {
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

describe('permissionGrantPatterns', () => {
  it('remembers a URL by its origin and everything else verbatim', () => {
    // A webfetch ask names one URL with its query string attached, which would
    // never match again — the origin is the unit a user actually reasons about.
    // Mutation: return the resource unchanged for a URL fails this, and every
    // *Always allow* on a fetch would be a rule that never fires again.
    expect(permissionGrantPatterns(ask('webfetch', ['https://docs.example.com/a?v=2']))).toEqual([
      { pattern: 'https://docs.example.com/*', scope: 'origin' }
    ])
    // A command line is **not** widened to `git *`: that reads as harmless and
    // would cover `git config --global …`, and anything after a `&&`.
    expect(permissionGrantPatterns(ask('bash', ['git status']))).toEqual([
      { pattern: 'git status', scope: 'exact' }
    ])
  })

  it('stores an asterisk the model wrote as part of the string, not as a wildcard', () => {
    // **The bug this scope exists for.** `rm -rf build/*` is a command line the
    // *model* wrote; a user clicking Always allow read exactly that string. With
    // `*` treated as a wildcard the rule silently also covered
    // `rm -rf build/../../Documents`, auto-answered with nothing in the
    // transcript. Mutation: derive the scope from whether the pattern contains
    // `*`, or compile the pattern to a regex, fails this.
    const [rule] = permissionGrantPatterns(ask('bash', ['rm -rf build/*']))
    expect(rule).toEqual({ pattern: 'rm -rf build/*', scope: 'exact' })
    expect(permissionGrantMatches(rule, 'rm -rf build/*')).toBe(true)
    expect(permissionGrantMatches(rule, 'rm -rf build/../../Documents')).toBe(false)
    expect(permissionGrantMatches(rule, 'rm -rf build/dist')).toBe(false)
  })

  it('falls back to the whole action only when the ask names nothing', () => {
    expect(permissionGrantPatterns(ask('webfetch'))).toEqual([{ pattern: '*', scope: 'action' }])
  })

  it("keys a grant so a URL's own colon cannot split it", () => {
    // Mutation: single `:` as the separator fails this — `forget` would then
    // address a different row than the one the user clicked.
    expect(permissionGrantKey('webfetch', 'https://x.test/*')).toBe('webfetch::https://x.test/*')
  })
})

describe('permissionGrantMatches', () => {
  it('covers a URL origin by prefix, and nothing that merely contains it', () => {
    const origin = { pattern: 'https://x.test/*', scope: 'origin' as const }
    expect(permissionGrantMatches(origin, 'https://x.test/a/b')).toBe(true)
    expect(permissionGrantMatches(origin, 'https://x.test')).toBe(true)
    // Mutation: `includes` instead of `startsWith` fails this — a grant for one
    // site would cover any URL that mentions it in a path or a query string.
    expect(permissionGrantMatches(origin, 'https://evil.test/?u=https://x.test/')).toBe(false)
  })

  it('matches an exact rule character for character, metacharacters included', () => {
    // Mutation: drop the escaping *and* the scope — `scripts/run(1).py` compiled
    // to a regex would match `scripts/run1.py`, or throw mid-turn while the
    // engine is parked on the ask.
    const rule = { pattern: 'scripts/run(1).py', scope: 'exact' as const }
    expect(permissionGrantMatches(rule, 'scripts/run(1).py')).toBe(true)
    expect(permissionGrantMatches(rule, 'scripts/run1.py')).toBe(false)
  })

  it('an action-scoped rule covers every resource of that action', () => {
    expect(permissionGrantMatches({ pattern: '*', scope: 'action' }, 'anything at all')).toBe(true)
  })
})

describe('isPermissionGranted', () => {
  const grant = (action: string, pattern: string) => ({
    action,
    pattern,
    scope: 'exact' as const,
    decidedAt: 1
  })

  it('requires every resource to be covered, not any of them', () => {
    // An ask naming two paths is one decision about both. Mutation: `.some`
    // instead of `.every` fails this, and a second resource would ride in on
    // the first one's grant.
    const grants = [grant('edit', 'a.txt')]
    expect(isPermissionGranted(ask('edit', ['a.txt']), grants)).toBe(true)
    expect(isPermissionGranted(ask('edit', ['a.txt', 'b.txt']), grants)).toBe(false)
  })

  it('does not carry a grant across actions', () => {
    // `action` is coarser than the tool already; letting it match across
    // actions would make "allow this fetch" mean "allow this edit".
    expect(isPermissionGranted(ask('bash', ['ls']), [grant('edit', 'ls')])).toBe(false)
  })

  it('answers no for an empty store', () => {
    expect(isPermissionGranted(ask('bash', ['ls']), [])).toBe(false)
  })
})

describe('describeGrantScope', () => {
  it('says what the button will actually remember', () => {
    // The button promises a scope; this is the text it promises it in, and the
    // main process stores exactly these patterns.
    expect(describeGrantScope('webfetch', [{ pattern: 'https://x.test/*', scope: 'origin' }])).toBe(
      'https://x.test/*'
    )
    // The blanket case says what it covers in words. Mutation: interpolate the
    // raw action fails this — the user would be asked to agree to "every
    // external_directory request", which names nothing they can reason about.
    expect(describeGrantScope('webfetch', [{ pattern: '*', scope: 'action' }])).toBe(
      'any request to fetch from the web'
    )
    expect(describeGrantScope('external_directory', [{ pattern: '*', scope: 'action' }])).toBe(
      'any request to use a folder outside its own'
    )
  })
})
