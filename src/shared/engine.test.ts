import { describe, it, expect } from 'vitest'
import { effectiveEngine, resolveDefaultEngine } from './engine'

/**
 * The two rules that decide **which engine an agent runs on** when its folder
 * does not say.
 *
 * They live in `shared/` because four places answer that question — the
 * service that resolves a runtime, the ACP driver's dispatch, the "Runs with"
 * panel and the Permissions card — and this area's expensive bugs have all been
 * one of those four computing it a second way. These tests are about the rules
 * themselves; each caller's own suite covers what it does with the answer.
 */
describe('resolveDefaultEngine', () => {
  it('is Automatic when nothing is pinned, and Automatic prefers the machine’s own Claude', () => {
    expect(resolveDefaultEngine('', true)).toBe('claude')
    expect(resolveDefaultEngine('', false)).toBe('opencode')
  })

  it('honours a pin even when that runtime is not installed', () => {
    // Deliberately: a pin that silently fell back would leave Settings claiming
    // one runtime while agents ran on another. The Settings screen warns about
    // this state instead, beside the control that set it.
    expect(resolveDefaultEngine('claude', false)).toBe('claude')
    expect(resolveDefaultEngine('opencode', true)).toBe('opencode')
  })

  it('reads a value this build does not recognise as Automatic', () => {
    // Written by a newer build, or corrupted. Falling back to Automatic keeps
    // the machine running agents; refusing would strand every agent that names
    // no engine of its own.
    expect(resolveDefaultEngine('gemini', true)).toBe('claude')
    expect(resolveDefaultEngine('  ', false)).toBe('opencode')
  })
})

describe('effectiveEngine', () => {
  it('takes the engine the folder names, over the machine default', () => {
    expect(effectiveEngine({ engine: 'claude' }, 'opencode')).toBe('claude')
    expect(effectiveEngine({ engine: 'opencode' }, 'claude')).toBe('opencode')
    expect(effectiveEngine({ engine: ' claude ' }, 'opencode')).toBe('claude')
  })

  it('follows the machine default when the folder names nothing', () => {
    expect(effectiveEngine(null, 'claude')).toBe('claude')
    expect(effectiveEngine({}, 'claude')).toBe('claude')
    expect(effectiveEngine(undefined, 'opencode')).toBe('opencode')
  })

  it('keeps a runtime that names a credential on OpenCode, whatever the machine default is', () => {
    // The rule that stops a change of machine default from taking an existing
    // agent off the key its own committed file names. The Claude path spends no
    // credential at all, so running this agent there would ignore the one thing
    // its runtime block says.
    expect(effectiveEngine({ credential: 'My Anthropic' }, 'claude')).toBe('opencode')
  })

  it('keeps a runtime that pins a concrete model on OpenCode too', () => {
    // A catalogue id means nothing to a plan addressed by alias, so a machine
    // default of Claude must not inherit it.
    expect(effectiveEngine({ model: 'gpt-5' }, 'claude')).toBe('opencode')
  })

  it('lets a Work Complexity travel — it means the same thing on either engine', () => {
    // The one field that is portable, which is why the tier survives a change of
    // runtime in the panel as well.
    expect(effectiveEngine({ complexity: 'medium' } as Record<string, unknown>, 'claude')).toBe(
      'claude'
    )
  })

  it('ignores blank strings, which is what an emptied field leaves behind', () => {
    expect(effectiveEngine({ engine: '', credential: '', model: '' }, 'claude')).toBe('claude')
  })

  it('reads an engine this build has no launcher for as “not named”', () => {
    // `gemini` and `codex` are names the manifest may legally carry and this
    // build cannot run. The ACP dispatch refuses them in words on its own path
    // (`launcherOfFolder` returns them verbatim); here — where the question is
    // which of the *two* engines applies — an unrecognised value must not pin
    // anything, or a folder written by a newer tool would be stuck.
    expect(effectiveEngine({ engine: 'gemini' }, 'claude')).toBe('claude')
  })
})
