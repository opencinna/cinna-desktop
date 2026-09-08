import { describe, it, expect } from 'vitest'
import type { AgentRootDto, FileStamp, LocalAgentDto } from '../../../shared/localAgents'
import type { DetectedTool } from '../../../shared/localTools'
import { describeAgentSlug, fieldFilePath, slugifyAgentName } from '../../../shared/localAgents'
import {
  agentSubline,
  formatExamplePrompts,
  parseExamplePrompts,
  saveBlocked,
  editFileText,
  groupAgentsByRoot,
  isDirty,
  readinessLabel,
  receiveFileSnapshot,
  reloadFileEditor,
  saveRefused,
  saveRequest,
  saveSucceeded,
  seedFileEditor,
  launchableTools,
  resolveDefaultTool
} from './localAgents'

function stamp(hash: string, size = 100, mtimeMs = 1_000): FileStamp {
  return { hash, size, mtimeMs }
}

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:a',
    manifestId: 'a',
    identity: 'manifest',
    kind: 'kit',
    rootId: 'root-1',
    rootPath: '/w',
    path: '/w/Local/alpha',
    slug: 'alpha',
    name: 'Alpha',
    description: 'Watches the alpha feed.',
    enabled: true,
    readiness: 'ok',
    readinessReason: null,
    contractStatus: 'ok',
    manifest: {},
    publications: [],
    runtime: null,
    credentials: [],
    commands: [],
    status: null,
    validation: { errors: [], warnings: [], infos: [] },
    desktop: {
      localApiBaseUrl: null,
      hasAgentToken: false,
      sessionCount: 0,
      lastStatusAt: null
    },
    stamps: {},
    scannedAt: 0,
    ...overrides
  }
}

function root(overrides: Partial<AgentRootDto> = {}): AgentRootDto {
  return {
    id: 'root-1',
    path: '/w',
    label: 'Agents',
    isDefault: true,
    kind: 'workshop',
    exists: true,
    isGitRepo: false,
    truncated: false,
    agentCount: 0,
    hiddenAgentCount: 0,
    contractVersion: '1.0.0',
    createdAt: 10,
    ...overrides
  }
}

describe('agentSubline', () => {
  it('prefers what the agent said about itself', () => {
    expect(
      agentSubline(
        agent({
          readiness: 'credentials_needed',
          status: { summary: '12 invoices flagged', state: 'healthy', updatedAt: null, body: '' }
        })
      )
    ).toBe('12 invoices flagged')
  })

  it('drops the validator’s backticks, which a sidebar line would show literally', () => {
    expect(
      agentSubline(agent({ readiness: 'invalid', readinessReason: '`id` is required.' }))
    ).toBe('id is required.')
  })

  it('leaves the line empty when the description is only the name repeated', () => {
    expect(agentSubline(agent({ name: 'Alpha', description: 'Alpha' }))).toBe('')
    expect(agentSubline(agent({ name: 'Alpha', description: ' Alpha ' }))).toBe('')
    expect(agentSubline(agent({ name: 'Alpha', description: 'Watches alpha.' }))).toBe(
      'Watches alpha.'
    )
  })

  it('falls back to the readiness issue when there is no status', () => {
    expect(agentSubline(agent({ readiness: 'credentials_needed' }))).toBe('credentials needed')
    expect(agentSubline(agent({ readiness: 'invalid' }))).toBe('manifest invalid')
    expect(agentSubline(agent({ readiness: 'contract_too_new' }))).toBe('update the app')
  })

  it('says why an invalid folder is invalid, not just that it is', () => {
    // The case this exists for: a duplicate manifest id. That row cannot be
    // opened — it has no index row — so the agent page's readiness strip never
    // reaches the user, and "manifest invalid" would be the only thing they
    // ever see about a folder that is silently not working.
    expect(
      agentSubline(
        agent({
          readiness: 'invalid',
          readinessReason: 'This agent has the same id as "alpha". Give one of them a new id.'
        })
      )
    ).toBe('This agent has the same id as "alpha". Give one of them a new id.')
  })

  it('still says what is wrong when an invalid folder gives no reason', () => {
    expect(agentSubline(agent({ readiness: 'invalid', readinessReason: '  ' }))).toBe(
      'manifest invalid'
    )
  })

  it('keeps the short label for the other unhappy states', () => {
    // Only `invalid` gets the long form. `credentials_needed` already has a
    // readable label, and its reason is a sentence that would crowd the row.
    expect(
      agentSubline(
        agent({
          readiness: 'credentials_needed',
          readinessReason: 'Add the credentials for Stripe in credentials/.env.'
        })
      )
    ).toBe('credentials needed')
  })

  it('falls back to the description when nothing is wrong', () => {
    expect(agentSubline(agent())).toBe('Watches the alpha feed.')
  })

  it('treats a blank status summary as no status at all', () => {
    // A STATUS.md whose frontmatter carries `summary: ""` must not blank the
    // line that would otherwise say the agent cannot run.
    const dto = agent({
      readiness: 'invalid',
      status: { summary: '   ', state: null, updatedAt: null, body: '' }
    })
    expect(agentSubline(dto)).toBe('manifest invalid')
  })

  it('says nothing rather than "ok" for a healthy agent with no description', () => {
    expect(readinessLabel('ok')).toBeNull()
    expect(agentSubline(agent({ description: '' }))).toBe('')
  })
})

describe('groupAgentsByRoot', () => {
  it('puts the default home first and keeps added roots in registration order', () => {
    const groups = groupAgentsByRoot(
      [
        root({ id: 'r3', isDefault: false, createdAt: 30 }),
        root({ id: 'r2', isDefault: false, createdAt: 20 }),
        root({ id: 'r1', isDefault: true, createdAt: 99 })
      ],
      []
    )
    expect(groups.map((g) => g.root.id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('keeps an empty registered root visible', () => {
    const groups = groupAgentsByRoot([root({ id: 'r1' })], [])
    expect(groups).toHaveLength(1)
    expect(groups[0].agents).toEqual([])
  })

  it('files each agent under its own root', () => {
    const groups = groupAgentsByRoot(
      [root({ id: 'r1' }), root({ id: 'r2', isDefault: false, createdAt: 20 })],
      [
        agent({ id: 'folder:b', name: 'Beta', rootId: 'r2' }),
        agent({ id: 'folder:a', name: 'Alpha', rootId: 'r1' })
      ]
    )
    expect(groups[0].agents.map((a) => a.id)).toEqual(['folder:a'])
    expect(groups[1].agents.map((a) => a.id)).toEqual(['folder:b'])
  })
})

describe('slugifyAgentName', () => {
  it('produces the folder name the scaffolder will use', () => {
    expect(slugifyAgentName('Invoice Watcher')).toBe('invoice-watcher')
    expect(slugifyAgentName('Café Reporter')).toBe('cafe-reporter')
  })

  it('reports no usable slug rather than inventing one', () => {
    expect(slugifyAgentName('!!!')).toBe('')
    // Single character: below the schema's two-character minimum.
    expect(slugifyAgentName('X')).toBe('')
  })
})

describe('fieldFilePath', () => {
  it('names the manifest for a manifest field', () => {
    expect(fieldFilePath({ field: 'description', value: 'x' })).toBe('cinna-agent.json')
    expect(fieldFilePath({ field: 'example_prompts', value: [] })).toBe('cinna-agent.json')
  })

  it('names the prompt document a prompt update writes', () => {
    expect(fieldFilePath({ field: 'prompt', prompt: 'workflow', value: 'x' })).toBe(
      'docs/WORKFLOW_PROMPT.md'
    )
    expect(fieldFilePath({ field: 'prompt', prompt: 'refiner', value: 'x' })).toBe(
      'docs/REFINER_PROMPT.md'
    )
  })
})

describe('the file editor', () => {
  it('sends back the stamp the rendered text was read with', () => {
    const opened = seedFileEditor('docs/WORKFLOW_PROMPT.md', 'one', stamp('h1'))
    const typed = editFileText(opened, 'one two')

    const request = saveRequest(typed)
    expect(request).not.toBeNull()
    expect(request?.text).toBe('one two')
    // Not a stamp of what is being sent, and not a fresh read — the stamp of
    // the read that produced the text on screen.
    expect(request?.expectedStamp).toBe(opened.stamp)
  })

  it('sends nothing when there is nothing to save', () => {
    const opened = seedFileEditor('a.md', 'one', stamp('h1'))
    expect(saveRequest(opened)).toBeNull()
    expect(saveRequest(editFileText(opened, 'one'))).toBeNull()
  })

  it('cannot save a file it never had a stamp for', () => {
    const missing = seedFileEditor('docs/REFINER_PROMPT.md', '', null)
    expect(saveRequest(editFileText(missing, 'written by hand'))).toBeNull()
  })

  it('adopts an outside edit while the editor is clean', () => {
    const opened = seedFileEditor('a.md', 'one', stamp('h1'))
    const next = receiveFileSnapshot(opened, 'rewritten by an assistant', stamp('h2'))

    expect(next.text).toBe('rewritten by an assistant')
    expect(next.stamp).toEqual(stamp('h2'))
    expect(next.conflict).toBeNull()
  })

  it('keeps unsaved work and refuses to save when the file changed underneath', () => {
    const opened = seedFileEditor('a.md', 'one', stamp('h1'))
    const typed = editFileText(opened, 'one two')
    const clashed = receiveFileSnapshot(typed, 'rewritten by an assistant', stamp('h2'))

    expect(clashed.text).toBe('one two')
    expect(clashed.conflict).toBe('external-change')
    // The decisive assertion: the fresher stamp is NOT adopted. Adopting it
    // would let the very next autosave overwrite the assistant's file, and the
    // main-process guard would wave it through because the stamp matched.
    expect(clashed.stamp).toEqual(stamp('h1'))
    expect(saveRequest(clashed)).toBeNull()
  })

  it('does not resume saving when the user keeps typing into a conflict', () => {
    const clashed = receiveFileSnapshot(
      editFileText(seedFileEditor('a.md', 'one', stamp('h1')), 'one two'),
      'theirs',
      stamp('h2')
    )
    expect(saveRequest(editFileText(clashed, 'one two three'))).toBeNull()
  })

  it('never retries a refused save', () => {
    const typed = editFileText(seedFileEditor('a.md', 'one', stamp('h1')), 'one two')
    const refused = saveRefused(typed, 'theirs')

    expect(refused.conflict).toBe('refused')
    expect(saveRequest(refused)).toBeNull()
    // Still refused after the snapshot that caused it finally arrives.
    expect(saveRequest(receiveFileSnapshot(refused, 'theirs', stamp('h2')))).toBeNull()
  })

  it('takes the new stamp from the save that landed', () => {
    const typed = editFileText(seedFileEditor('a.md', 'one', stamp('h1')), 'one two')
    const saved = saveSucceeded(typed, 'one two', stamp('h2'))

    expect(isDirty(saved)).toBe(false)
    expect(saved.stamp).toEqual(stamp('h2'))
    expect(saveRequest(saved)).toBeNull()
  })

  it('keeps edits made while a save was in flight', () => {
    const typed = editFileText(seedFileEditor('a.md', 'one', stamp('h1')), 'one two')
    const whileSaving = editFileText(typed, 'one two three')
    const saved = saveSucceeded(whileSaving, 'one two', stamp('h2'))

    expect(saved.text).toBe('one two three')
    expect(saveRequest(saved)?.expectedStamp).toEqual(stamp('h2'))
  })

  it('reloads the text and the stamp from the same read', () => {
    // The stale-snapshot trap: the page still holds the pre-conflict read, so
    // reloading from *that* would restore the old text under the old stamp and
    // the next save would bounce all over again.
    const clashed = receiveFileSnapshot(
      editFileText(seedFileEditor('a.md', 'mine', stamp('h1')), 'mine, edited'),
      'theirs',
      stamp('h2')
    )
    const reloaded = reloadFileEditor(clashed, 'mine', stamp('h1'))

    expect(reloaded.text).toBe('theirs')
    expect(reloaded.stamp).toEqual(stamp('h2'))
  })

  it('clears the conflict only when the user reloads', () => {
    const clashed = receiveFileSnapshot(
      editFileText(seedFileEditor('a.md', 'one', stamp('h1')), 'one two'),
      'theirs',
      stamp('h2')
    )
    const reloaded = reloadFileEditor(clashed, 'theirs', stamp('h2'))

    expect(reloaded.text).toBe('theirs')
    expect(reloaded.stamp).toEqual(stamp('h2'))
    expect(reloaded.conflict).toBeNull()
    expect(saveRequest(editFileText(reloaded, 'theirs, edited'))?.expectedStamp).toEqual(
      stamp('h2')
    )
  })

  it('adopts a new stamp when another card wrote a different part of the same file', () => {
    // Two cards edit `cinna-agent.json`: description and example prompts.
    // Saving one restamps the file under the other. That must not become a
    // conflict — the value this editor owns is exactly as it left it.
    const opened = seedFileEditor('cinna-agent.json', 'Watches the feed.', stamp('h1'))
    const typed = editFileText(opened, 'Watches the feed, hourly.')
    const restamped = receiveFileSnapshot(typed, 'Watches the feed.', stamp('h2'))

    expect(restamped.conflict).toBeNull()
    expect(restamped.text).toBe('Watches the feed, hourly.')
    expect(saveRequest(restamped)?.expectedStamp).toEqual(stamp('h2'))
  })

  it('notices a change that keeps the file the same size', () => {
    // The metadata half of a stamp is only a pre-check; two files of equal size
    // with a preserved mtime differ only in their hash, and that is exactly the
    // case a `cp -p` or a `git checkout` produces.
    const opened = seedFileEditor('a.md', 'one', stamp('h1', 3, 1_000))
    const next = receiveFileSnapshot(opened, 'two', stamp('h2', 3, 1_000))
    expect(next.text).toBe('two')
  })
})

describe('describeAgentSlug', () => {
  it('gives a name that already works no message at all', () => {
    const check = describeAgentSlug('Invoice Reader')
    expect(check).toEqual({ slug: 'invoice-reader', problem: 'ok', message: null, suggestion: null })
  })

  it('does not block a name written in a non-Latin script', () => {
    // The case that mattered: nothing survives the ASCII fold, so the old form
    // said "no letters or digits" — false — and offered no way forward.
    const check = describeAgentSlug('日本語エージェント')
    expect(check.problem).toBe('not_transliterable')
    expect(check.slug).toBe('agent')
    expect(check.suggestion).toBe('agent')
    expect(check.message).toContain('Latin letters')
    // Whatever it suggests has to be a folder name the scaffolder accepts.
    expect(slugifyAgentName(check.slug)).toBe(check.slug)
  })

  it('does not block a one-character name either', () => {
    const check = describeAgentSlug('X')
    expect(check.problem).toBe('too_short')
    expect(check.slug).toBe('x-agent')
    expect(check.message).toContain('at least two')
    expect(slugifyAgentName(check.slug)).toBe(check.slug)
  })

  it('says nothing about an empty field', () => {
    // Not an error — the user has simply not typed yet.
    expect(describeAgentSlug('   ')).toEqual({
      slug: '',
      problem: 'empty',
      message: null,
      suggestion: null
    })
  })

  it('tells the two failures apart rather than merging them', () => {
    expect(describeAgentSlug('X').problem).not.toBe(
      describeAgentSlug('日本語エージェント').problem
    )
  })
})

describe('example prompts', () => {
  it('round-trips a list through the textarea', () => {
    const prompts = ['Summarise last week.', 'Flag anything without a PO number.']
    expect(parseExamplePrompts(formatExamplePrompts(prompts)).prompts).toEqual(prompts)
  })

  it('treats blank lines as editing, not as entries', () => {
    expect(parseExamplePrompts('one\n\n   \ntwo\n').prompts).toEqual(['one', 'two'])
  })

  it('never lets a prompt containing a newline become two prompts', () => {
    // Only an assistant or a hand edit can put one there; a textarea cannot
    // represent it. Flattening is visible and reversible — splitting silently
    // changes how many prompts the agent has.
    const flattened = formatExamplePrompts(['ask about\nthe invoice', 'second'])
    expect(flattened.split('\n')).toHaveLength(2)
    expect(parseExamplePrompts(flattened).prompts).toEqual(['ask about the invoice', 'second'])
  })

  it('names the line that is too long instead of the whole card', () => {
    const text = ['fine', 'x'.repeat(2001), 'also fine'].join('\n')
    const parsed = parseExamplePrompts(text)
    expect(parsed.error).toContain('Line 2')
    // And it does not quietly hand back a shorter list, which would save three
    // prompts where the user typed four with nothing saying so.
    expect(parsed.prompts).toHaveLength(3)
  })

  it('refuses more prompts than the manifest holds', () => {
    const parsed = parseExamplePrompts(Array.from({ length: 21 }, (_, i) => `p${i}`).join('\n'))
    expect(parsed.error).toContain('21')
  })
})

describe('a save blocked by a running turn', () => {
  it('keeps the text and stays sendable, unlike a conflict', () => {
    let state = seedFileEditor('docs/WORKFLOW_PROMPT.md', 'saved', stamp('a'))
    state = editFileText(state, 'my edit')
    state = saveBlocked(state)

    expect(state.blocked).toBe(true)
    expect(state.text).toBe('my edit')
    // The whole point: this is a "not yet", so the same request goes out again.
    // A refusal returns null here and the only exit is a reload, which discards
    // the user's text — the wrong answer to "the agent is busy".
    expect(saveRequest(state)).toEqual({ text: 'my edit', expectedStamp: stamp('a') })
    expect(state.conflict).toBeNull()
  })

  it('hands back a new object every time so the caller re-arms its timer', () => {
    const state = saveBlocked(
      editFileText(seedFileEditor('f', 'saved', stamp('a')), 'edit')
    )
    // Returning `state` unchanged would leave a blocked editor with no armed
    // timer, and the edit stranded until the user happened to type again.
    expect(saveBlocked(state)).not.toBe(state)
  })

  it('clears once a save lands', () => {
    let state = saveBlocked(editFileText(seedFileEditor('f', 'saved', stamp('a')), 'edit'))
    state = saveSucceeded(state, 'edit', stamp('b'))
    expect(state.blocked).toBe(false)
  })

  it('does not mask a real conflict', () => {
    let state = editFileText(seedFileEditor('f', 'saved', stamp('a')), 'edit')
    state = saveBlocked(state)
    state = saveRefused(state, 'what disk says')
    expect(state.conflict).toBe('refused')
    expect(saveRequest(state)).toBeNull()
  })
})

describe('the default tool', () => {
  const tool = (over: Partial<DetectedTool>): DetectedTool => ({
    id: 'claude',
    kind: 'cli-assistant',
    label: 'Claude Code',
    version: null,
    path: '/bin/claude',
    available: true,
    source: 'path',
    ...over
  })
  const tools: DetectedTool[] = [
    tool({ id: 'code', kind: 'editor', label: 'VS Code' }),
    tool({ id: 'uv', kind: 'runtime', label: 'uv' }),
    tool({ id: 'claude' }),
    tool({ id: 'codex', label: 'Codex', available: false })
  ]

  it('offers installed assistants before editors, and never a runtime', () => {
    expect(launchableTools(tools).map((t) => t.id)).toEqual(['claude', 'code'])
  })

  it('resolves the setting only against what is installed', () => {
    const launchable = launchableTools(tools)
    expect(resolveDefaultTool(launchable, 'claude')?.id).toBe('claude')
    // Chosen once, uninstalled since: the button must ask, not fail.
    expect(resolveDefaultTool(launchable, 'codex')).toBeNull()
    expect(resolveDefaultTool(launchable, '')).toBeNull()
    // A runtime is never launchable, whatever the setting says.
    expect(resolveDefaultTool(launchable, 'uv')).toBeNull()
  })
})
