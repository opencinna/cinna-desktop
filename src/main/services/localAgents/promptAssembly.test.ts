import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleAgentPrompt,
  assembleBareAgentPrompt,
  listKnowledgeTopics,
  stripHtmlComments,
  type DesktopPromptContext
} from './promptAssembly'
import type { CinnaAgentManifest } from '../../../shared/kit/manifest'

/**
 * The assembled system prompt.
 *
 * The failures worth catching here are **omissions**: a section that silently
 * disappears when its file is missing, an author-facing comment that survives
 * into the prompt, a rule that quietly stops being stated. So the shape test is
 * a full snapshot rather than a handful of `toContain`s — a `toContain` for each
 * section passes happily while a *fourth* section vanishes.
 *
 * Every assertion below was mutation-checked against the code it covers.
 *
 * A re-check found one hole in that claim — the 64 KB section cap was asserted
 * by nothing, so removing it left the file green — and it is covered now. The
 * `knowledge/` sort remains a declared gap for a reason given at
 * `listKnowledgeTopics` below; it is the one thing here that cannot be
 * mutation-checked without mocking the filesystem.
 */

const CONTEXT: DesktopPromptContext = { locale: 'en-GB', timeZone: 'Europe/Berlin' }

let dir: string

function write(relPath: string, contents: string): void {
  const full = join(dir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents)
}

function manifest(overrides: Partial<CinnaAgentManifest> = {}): CinnaAgentManifest {
  return { name: 'Invoices', description: 'Checks invoices against POs.', ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-prompt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('stripHtmlComments', () => {
  it('removes the kit templates’ author guidance', () => {
    expect(stripHtmlComments('a\n<!-- tell the author what to do -->\nb')).toBe('a\n\nb')
  })

  it('removes an unterminated comment rather than leaving the rest of the file behind', () => {
    // A half-typed comment is a state a real file is genuinely in. Leaving the
    // opener would carry the whole tail of the document into the prompt as an
    // instruction, which is worse than dropping it.
    expect(stripHtmlComments('keep this\n<!-- half written')).toBe('keep this')
  })

  it('leaves a lone `-->` alone', () => {
    expect(stripHtmlComments('an arrow --> like this')).toBe('an arrow --> like this')
  })
})

describe('listKnowledgeTopics', () => {
  /**
   * Known gap, stated rather than implied: the explicit `.sort()` in
   * `listKnowledgeTopics` is **not** verified by this test. `readdirSync`
   * already returns name order on APFS and on ext4 in practice, so removing the
   * sort leaves every assertion here passing — the failure it guards against
   * (a prompt whose bytes shuffle between runs, which would restart a live
   * engine on every rescan) only appears on a filesystem that returns entries
   * in creation order.
   */
  it('lists .md topics as agent-relative posix paths, nested included', () => {
    write('knowledge/README.md', 'about this folder')
    write('knowledge/invoice_rules.md', 'rules')
    write('knowledge/vendor_portal/api_quirks.md', 'quirks')
    write('knowledge/notes.txt', 'not markdown')
    expect(listKnowledgeTopics(dir)).toEqual([
      'knowledge/invoice_rules.md',
      'knowledge/vendor_portal/api_quirks.md'
    ])
  })

  it('is empty rather than throwing when there is no knowledge folder', () => {
    expect(listKnowledgeTopics(dir)).toEqual([])
  })
})

describe('assembleAgentPrompt', () => {
  it('reads as one document: workflow, scripts, credentials, knowledge, handovers, context', () => {
    write(
      'docs/WORKFLOW_PROMPT.md',
      [
        '<!--',
        'This file IS the agent. Replace every placeholder below.',
        '-->',
        '',
        '# Invoices',
        '',
        'You are Invoices. Check invoices against POs.',
        '',
        '## How you do it',
        '',
        '<!-- Numbered steps. For each: the exact command. -->',
        '',
        '1. Run `python scripts/fetch.py`.'
      ].join('\n')
    )
    write('scripts/README.md', '# Scripts\n\n| Script | What it does |\n|---|---|\n| fetch.py | Fetches. |')
    write('credentials/README.md', '# Credentials\n\nDeclare the slot first.')
    write('knowledge/invoice_rules.md', 'rules')

    const prompt = assembleAgentPrompt(
      dir,
      manifest({
        handovers: [{ target_slug: 'expenses', description: 'Anything about expense claims.' }]
      }),
      CONTEXT
    )
    expect(prompt).toMatchSnapshot()
  })

  it('does not carry the template’s author-facing comments into the prompt', () => {
    write(
      'docs/WORKFLOW_PROMPT.md',
      '# A\n\n<!-- Replace every placeholder below with what the agent really does -->\n\nreal text'
    )
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).not.toContain('Replace every placeholder')
    expect(prompt).toContain('real text')
  })

  it('states the never-read-the-secret-files rule even when the folder has no credentials README', () => {
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    // The rule is the desktop's, not the folder's: an agent whose author
    // deleted `credentials/README.md` must not thereby lose it.
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).toMatch(/never read `credentials\/\.env` yourself/i)
  })

  it('says the agent has no instructions rather than producing a promptless agent', () => {
    // No `docs/WORKFLOW_PROMPT.md` at all. Without this branch the model gets
    // only the appendices and answers as a generic assistant, which reads as
    // "the agent is broken" rather than "the file is empty".
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).toContain('You are Invoices.')
    expect(prompt).toContain('no instructions yet')
  })

  it('treats a file of nothing but comments as empty', () => {
    write('docs/WORKFLOW_PROMPT.md', '<!-- fill this in -->\n')
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).toContain('no instructions yet')
  })

  it('always states the desktop rules: conversation mode, uv run, app-data, locale, building mode', () => {
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).toContain('conversation mode')
    expect(prompt).toContain('uv run scripts/')
    expect(prompt).toContain('In conversation mode, write files only under `app-data/`')
    expect(prompt).toContain('en-GB')
    expect(prompt).toContain('Europe/Berlin')
    expect(prompt).toContain('## Building mode')
    expect(prompt).not.toContain('Do not switch to the Builder role')
  })

  it('lets only a person switch it into building mode, and keeps it there', () => {
    // The two limits on building mode: the switch is the person's, never the
    // agent's own idea or an unattended task's, and it lasts the conversation
    // rather than one reply.
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).toContain('do not refuse it, do not ask them to confirm it')
    expect(prompt).toContain('never for an unattended or handed-over task')
    expect(prompt).toContain('Stay in building mode for the rest of this conversation')
    // An edit that breaks the manifest makes the folder `invalid`, and an
    // invalid folder runs no further turn to repair it from.
    expect(prompt).toContain('Keep `cinna-agent.json` and `docs/CLI_COMMANDS.yaml` valid')
  })

  it('sends building mode to the folder’s AGENTS.md only when there is one', () => {
    // Naming a guide that does not exist is how a model ends up refusing the
    // work; a kit folder without `AGENTS.md` gets the definition's three files.
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    const without = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(without).not.toContain('`AGENTS.md`')
    expect(without).toContain('`scripts/README.md` catalogues every script')

    write('AGENTS.md', '# A\n\nThe build loop.')
    const withGuide = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(withGuide).toContain('read `AGENTS.md` in this folder and follow it')
    // Named, never inlined: it is the builder's document, not the agent's.
    expect(withGuide).not.toContain('The build loop.')
  })

  it('describes coordinator return only for its explicit role, leaving plain coordinator as a sibling', () => {
    const base = manifest()
    const declared = assembleAgentPrompt(dir, { ...base, handovers: [{ target_slug: 'coordinator', target_kind: 'coordinator' }] }, CONTEXT)
    expect(declared).toContain('/handback <note>')
    expect(declared).toContain('existing coordinator')
    for (const handover of [{ target_slug: 'coordinator' }, { target_slug: 'coordinator', target_kind: 'future-role' }]) {
      expect(assembleAgentPrompt(dir, { ...base, handovers: [handover] }, CONTEXT)).not.toContain('/handback')
    }
    expect(declared).toContain('unattended task')
    expect(declared).not.toContain('a person is talking to you and waiting')
  })

  it('omits the handover block when the manifest declares none', () => {
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    expect(assembleAgentPrompt(dir, manifest(), CONTEXT)).not.toContain('Handing over')
    expect(
      assembleAgentPrompt(dir, manifest({ handovers: [{ target_slug: 'expenses' }] }), CONTEXT)
    ).toContain('`expenses`')
  })

  it('lists knowledge topics without inlining their contents', () => {
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    write('knowledge/invoice_rules.md', 'A PO number matches when the vendor and total agree.')
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt).toContain('`knowledge/invoice_rules.md`')
    // Inlining every knowledge file would spend the context window before the
    // conversation starts.
    expect(prompt).not.toContain('A PO number matches')
  })

  it('truncates a document too large to belong in a system prompt', () => {
    // A `WORKFLOW_PROMPT.md` this size is a mistake — a pasted log, a generated
    // dump — but it is the author's file and it lands in every turn's system
    // prompt. The cap keeps a mistake expensive rather than fatal, and the
    // ellipsis is what tells a reader of the generated prompt that it happened.
    write('docs/WORKFLOW_PROMPT.md', `# A\n\n${'x'.repeat(100 * 1024)}`)
    const prompt = assembleAgentPrompt(dir, manifest(), CONTEXT)
    expect(prompt.length).toBeLessThan(80 * 1024)
    expect(prompt).toContain('…')
    // Truncated, not dropped: the beginning of the document still has to be
    // there, or a too-large file would silently become a promptless agent.
    expect(prompt).toContain('# A')
    // And the desktop appendix still follows it.
    expect(prompt).toContain('## Building mode')
  })

  it('is deterministic for the same folder', () => {
    write('docs/WORKFLOW_PROMPT.md', '# A\n\nreal text')
    write('knowledge/b.md', 'b')
    write('knowledge/a.md', 'a')
    expect(assembleAgentPrompt(dir, manifest(), CONTEXT)).toBe(
      assembleAgentPrompt(dir, manifest(), CONTEXT)
    )
  })
})

describe('assembleBareAgentPrompt', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cinna-bare-prompt-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const context = { locale: 'en-GB', timeZone: 'Europe/Berlin' }

  it('is AGENT.md, with the desktop context appended', () => {
    writeFileSync(join(dir, 'AGENT.md'), '# Invoice watcher\n\nFlag invoices with no PO number.\n')
    const prompt = assembleBareAgentPrompt(dir, 'Invoice watcher', context)

    expect(prompt).toContain('Flag invoices with no PO number.')
    expect(prompt).toContain('conversation mode')
    expect(prompt).toContain('Europe/Berlin')
  })

  it('never includes README.md', () => {
    // The rule, and the one most likely to be "fixed" by someone who thinks a
    // README is free context. It is written *for the builder* — "run `make
    // install` first" — and a model reads that as a step it should take.
    // Mutation: append it as a section and the agent starts doing the setup
    // instructions in its first reply.
    writeFileSync(join(dir, 'AGENT.md'), 'Answer questions about invoices.\n')
    writeFileSync(join(dir, 'README.md'), '# Setup\n\nRun `uv sync` before anything else.\n')
    const prompt = assembleBareAgentPrompt(dir, 'Alpha', context)

    expect(prompt).toContain('Answer questions about invoices.')
    expect(prompt).not.toContain('uv sync')
  })

  it('never includes anything else in the folder either', () => {
    // A bare folder has no shape, so a scripts/knowledge/credentials sweep
    // would be reaching into an arbitrary repository. Mutation: reuse the kit
    // assembler here and a folder's `scripts/README.md` — or another agent's
    // notes — arrives as instructions.
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'AGENT.md'), 'Do the thing.\n')
    writeFileSync(join(dir, 'scripts', 'README.md'), 'SCRIPTS_MARKER')
    writeFileSync(join(dir, 'knowledge', 'rules.md'), 'KNOWLEDGE_MARKER')

    const prompt = assembleBareAgentPrompt(dir, 'Alpha', context)
    expect(prompt).not.toContain('SCRIPTS_MARKER')
    expect(prompt).not.toContain('knowledge/rules.md')
  })

  it('strips HTML comments', () => {
    writeFileSync(join(dir, 'AGENT.md'), 'Real text.\n<!-- note to the author -->\nMore.\n')
    const prompt = assembleBareAgentPrompt(dir, 'Alpha', context)
    expect(prompt).toContain('Real text.')
    expect(prompt).not.toContain('note to the author')
  })

  it('never produces a promptless agent for an empty or missing AGENT.md', () => {
    // Same rule as the kit path: without the stand-in the model gets only the
    // context block and answers as a generic assistant, which reads as "the
    // agent is broken" rather than as "the file is empty".
    writeFileSync(join(dir, 'AGENT.md'), '   \n')
    const empty = assembleBareAgentPrompt(dir, 'Invoice watcher', context)
    expect(empty).toContain('You are Invoice watcher.')
    expect(empty).toContain('is empty')

    rmSync(join(dir, 'AGENT.md'))
    expect(assembleBareAgentPrompt(dir, 'Invoice watcher', context)).toContain('is empty')
  })

  it('keeps building mode, pointed at README.md only when the folder has one', () => {
    // A bare folder's README is its builder guide. Named when it exists, never
    // inlined (see above); without it the agent works from AGENT.md alone.
    writeFileSync(join(dir, 'AGENT.md'), 'Do the thing.\n')
    const without = assembleBareAgentPrompt(dir, 'Alpha', context)
    expect(without).toContain('## Building mode')
    expect(without).toContain('never for an unattended or handed-over task')
    expect(without).toContain('work from `AGENT.md`, which is your whole definition')
    expect(without).not.toContain('`README.md`')

    writeFileSync(join(dir, 'README.md'), '# Setup\n')
    const withGuide = assembleBareAgentPrompt(dir, 'Alpha', context)
    expect(withGuide).toContain('read `README.md` in this folder for how this agent is organised')
    // Background, never a checklist: a repository README is setup steps too.
    expect(withGuide).toContain('not as setup steps to run')
    expect(withGuide).toContain('edit `AGENT.md` and `README.md`')
  })

  it('states no rule about files a bare folder does not have', () => {
    // The kit block tells the agent to `uv run` its scripts and to write only
    // under `app-data/`. Neither exists here, and a rule about a missing file
    // is how a model ends up refusing ordinary work in the folder it was
    // pointed at.
    writeFileSync(join(dir, 'AGENT.md'), 'Do the thing.\n')
    const prompt = assembleBareAgentPrompt(dir, 'Alpha', context)
    expect(prompt).not.toContain('app-data/')
    expect(prompt).not.toContain('uv run')
  })
})
