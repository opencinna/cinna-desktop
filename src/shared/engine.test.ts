import { describe, it, expect } from 'vitest'
import { effectiveEngine, resolveDefaultEngine, isAgentEngine } from './engine'

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

  it('runs an engine this build does not recognise on OpenCode, not on the machine default', () => {
    // `runtime.engine` is a preference: a named engine this build cannot run
    // falls back to OpenCode (contract decision 4), so a folder a newer tool
    // wrote keeps running without inheriting a Claude or Codex default it never
    // asked for. That includes `gemini` and `custom`: they are launcher ids,
    // but a folder cannot run on either, so `launcherOfFolder` sends them here.
    expect(effectiveEngine({ engine: 'gemini' }, 'claude')).toBe('opencode')
    expect(effectiveEngine({ engine: 'aider' }, 'codex')).toBe('opencode')
    expect(effectiveEngine({ engine: ' something-new ' }, 'claude')).toBe('opencode')
  })

  it('still reads an absent or blank engine as the machine default', () => {
    expect(effectiveEngine({ engine: null }, 'claude')).toBe('claude')
    expect(effectiveEngine({ engine: '   ' }, 'codex')).toBe('codex')
  })
})

describe('Codex engine selection', () => {
  it('honors explicit and default Codex selections', () => {
    expect(isAgentEngine('codex')).toBe(true)
    expect(effectiveEngine({ engine: 'codex' }, 'claude')).toBe('codex')
    expect(effectiveEngine(null, 'codex')).toBe('codex')
    expect(resolveDefaultEngine('codex', true, false)).toBe('codex')
  })
  it('selects an installed Codex on a fresh machine without Claude, preserving pins', () => {
    expect(resolveDefaultEngine('', false, true)).toBe('codex')
    expect(resolveDefaultEngine('', true, true)).toBe('claude')
    expect(resolveDefaultEngine('opencode', false, true)).toBe('opencode')
  })
})
