import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDOVER_HOW_TO_REPORT } from '../../../shared/handovers'
import {
  assembleAgentPrompt,
  assembleBareAgentPrompt,
  assembleBareNativePrompt,
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

  it('never produces a promptless agent for an empty or missing instructions file', () => {
    // Same rule as the kit path: without the stand-in the model gets only the
    // context block and answers as a generic assistant, which reads as "the
    // agent is broken" rather than as "the file is empty".
    writeFileSync(join(dir, 'AGENT.md'), '   \n')
    const empty = assembleBareAgentPrompt(dir, 'Invoice watcher', context)
    expect(empty).toContain('You are Invoice watcher.')
    expect(empty).toContain('`AGENT.md` in this folder is empty')

    // Missing is not "empty" — there is no file to be empty — and the stand-in
    // names every file that would give the agent instructions.
    rmSync(join(dir, 'AGENT.md'))
    const missing = assembleBareAgentPrompt(dir, 'Invoice watcher', context)
    expect(missing).toContain('You are Invoice watcher.')
    expect(missing).toContain('This folder has no `AGENT.md`, `AGENTS.md` or `CLAUDE.md`')
    expect(missing).not.toContain('is empty')
  })

  it.each(['AGENTS.md', 'CLAUDE.md'] as const)(
    'runs on %s when that is the file the folder has, and building mode names it',
    (file) => {
      // Mutation: read `AGENT.md` whatever the folder has and an adopted
      // `CLAUDE.md` agent runs on the empty stand-in — a working folder that
      // tells every person it has no instructions.
      writeFileSync(join(dir, file), '# Support\n\nAnswer tickets politely.\n')
      const prompt = assembleBareAgentPrompt(dir, 'Support', context)
      expect(prompt).toContain('Answer tickets politely.')
      expect(prompt).not.toContain('no instructions yet')
      // The file building mode edits is the one this agent actually runs on,
      // never an `AGENT.md` that is not in the folder.
      expect(prompt).toContain(`work from \`${file}\`, which is your whole definition`)
      expect(prompt).not.toContain('`AGENT.md`')

      writeFileSync(join(dir, 'README.md'), '# Setup\n')
      expect(assembleBareAgentPrompt(dir, 'Support', context)).toContain(
        `edit \`${file}\` and \`README.md\``
      )
    }
  )

  it('reads AGENT.md first when the folder has several', () => {
    // The scan's priority, kept here too: the page must edit the file the
    // agent runs on. Mutation: reverse the order and the two disagree.
    writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE_MARKER\n')
    writeFileSync(join(dir, 'AGENT.md'), 'AGENT_MARKER\n')
    const prompt = assembleBareAgentPrompt(dir, 'Alpha', context)
    expect(prompt).toContain('AGENT_MARKER')
    expect(prompt).not.toContain('CLAUDE_MARKER')
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

/**
 * The prompt a bare agent runs on when the **engine** loads the folder: its
 * instructions file, its settings, its hooks and its MCP servers, exactly as a
 * terminal session in that folder has them.
 *
 * Two failures are worth catching here and they pull in opposite directions.
 * Pasting the file the engine has already read states the folder's
 * instructions twice — once as memory, once as a system prompt the folder never
 * wrote. *Not* pasting a file the engine would never read leaves the agent with
 * no instructions at all. Which of the two happens depends only on the engine
 * and the name of the file the folder was adopted for, so both directions are
 * asserted for both engines.
 */
describe('assembleBareNativePrompt', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cinna-native-prompt-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const context = { locale: 'en-GB', timeZone: 'Europe/Berlin' }

  it('pastes an AGENTS.md folder’s instructions for Claude, which would not read that file', () => {
    // Mutation: name `AGENTS.md` as Claude's own native file and this folder's
    // instructions reach the model from nowhere — the agent answers as a
    // generic coding assistant in somebody's repository.
    writeFileSync(join(dir, 'AGENTS.md'), '# Uploader\n\nUPLOADER_MARKER: keep retries bounded.\n')
    const prompt = assembleBareNativePrompt(dir, 'Uploader', context, 'claude')
    expect(prompt).toContain('## Your instructions')
    expect(prompt).toContain('UPLOADER_MARKER')
  })

  it('leaves the same folder’s AGENTS.md to Codex, which reads it itself', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Uploader\n\nUPLOADER_MARKER: keep retries bounded.\n')
    const prompt = assembleBareNativePrompt(dir, 'Uploader', context, 'codex')
    expect(prompt).not.toContain('## Your instructions')
    expect(prompt).not.toContain('UPLOADER_MARKER')
  })

  it('does the mirror image for a CLAUDE.md-only folder', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE_MARKER: check the invoice numbers.\n')
    expect(assembleBareNativePrompt(dir, 'Invoices', context, 'claude')).not.toContain('CLAUDE_MARKER')
    const codex = assembleBareNativePrompt(dir, 'Invoices', context, 'codex')
    expect(codex).toContain('## Your instructions')
    expect(codex).toContain('CLAUDE_MARKER')
  })

  it('strips HTML comments out of the instructions it does paste', () => {
    writeFileSync(join(dir, 'AGENT.md'), 'Real text.\n<!-- note to the author -->\nMore.\n')
    const prompt = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(prompt).toContain('Real text.')
    expect(prompt).not.toContain('note to the author')
  })

  it('never includes README.md or anything else in the folder', () => {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'AGENT.md'), 'Answer questions about invoices.\n')
    writeFileSync(join(dir, 'README.md'), '# Setup\n\nRun `uv sync` before anything else.\n')
    writeFileSync(join(dir, 'scripts', 'README.md'), 'SCRIPTS_MARKER')
    const prompt = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(prompt).not.toContain('uv sync')
    expect(prompt).not.toContain('SCRIPTS_MARKER')
  })

  it('says the runtime is the folder’s own, and keeps the desktop’s rules', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Do the thing.\n')
    const prompt = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(prompt).toContain('## How you are running now')
    // An agent that assumes a sandbox behaves differently from one that knows
    // its hooks and MCP servers are live.
    expect(prompt).toContain('your own runtime')
    expect(prompt).toContain('MCP servers')
    expect(prompt).toContain('conversation mode')
    expect(prompt).toContain('unattended task')
    expect(prompt).toContain('Europe/Berlin')
    expect(prompt).toContain('Long output goes to a file in this folder')
    expect(prompt).toContain('## Building mode')
  })

  it('names each engine’s own setup, and never machinery that engine does not have', () => {
    // Claude's four scopes were watched loading; Codex has no hooks and no
    // skills. Mutation: state one list for both and the Codex agent is told it
    // has hooks and skills, which is how a turn ends in a tool that never runs.
    writeFileSync(join(dir, 'AGENTS.md'), 'Do the thing.\n')
    const claude = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(claude).toContain('its hooks, its skills and its MCP servers')
    expect(claude).not.toContain('config.toml')
    const codex = assembleBareNativePrompt(dir, 'Alpha', context, 'codex')
    expect(codex).toContain('`~/.codex/config.toml`')
    expect(codex).toContain('trust decision')
    expect(codex).not.toContain('its hooks')
    expect(codex).not.toContain('its skills')
  })

  it('never points the agent at instructions above it, because there are none', () => {
    // On the native runtime the engine loaded the instructions file itself, so
    // "the instructions above" names text that is not in this document.
    // Mutation: leave `buildingModeSection`'s default note in place and the
    // last bullet sends the model looking for a section it cannot see.
    writeFileSync(join(dir, 'CLAUDE.md'), 'Do the thing.\n')
    for (const engine of ['claude', 'codex'] as const) {
      expect(assembleBareNativePrompt(dir, 'Alpha', context, engine)).not.toContain('instructions above')
    }
    // The bullet the assembled prompt carries about following them is gone too.
    expect(assembleBareNativePrompt(dir, 'Alpha', context, 'claude'))
      .not.toContain('Cinna Desktop imposes no convention of its own here')
  })

  it('states no rule about files a bare folder does not have', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Do the thing.\n')
    const prompt = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(prompt).not.toContain('app-data/')
    expect(prompt).not.toContain('uv run')
  })

  it('never produces a promptless agent when the file the engine would not read is empty or missing', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '   \n')
    const empty = assembleBareNativePrompt(dir, 'Invoice watcher', context, 'claude')
    expect(empty).toContain('You are Invoice watcher.')
    expect(empty).toContain('`AGENTS.md` in this folder is empty')

    rmSync(join(dir, 'AGENTS.md'))
    const missing = assembleBareNativePrompt(dir, 'Invoice watcher', context, 'claude')
    expect(missing).toContain('This folder has no `AGENT.md`, `AGENTS.md` or `CLAUDE.md`')
  })

  it('never says the agent has no instructions while the engine holds some', () => {
    // `resolveBareInstructionsFile` short-circuits on the *first* name it
    // finds, so an empty `AGENT.md` beside a real `CLAUDE.md` resolves to the
    // empty one. The engine has loaded the real file; the stub would have the
    // agent deny work it can plainly do. Mutation: emit the stub whenever the
    // pasted text is empty and this folder's agent opens by saying it has no
    // instructions yet.
    for (const [engine, own] of [['claude', 'CLAUDE.md'], ['codex', 'AGENTS.md']] as const) {
      const folder = mkdtempSync(join(tmpdir(), 'cinna-native-empty-'))
      writeFileSync(join(folder, 'AGENT.md'), '   \n')
      writeFileSync(join(folder, own), 'REAL_MARKER: the real instructions.\n')
      const prompt = assembleBareNativePrompt(folder, 'Alpha', context, engine)
      expect(prompt).not.toContain('you have no instructions yet')
      expect(prompt).not.toContain('## Your instructions')
      // Not pasted either: the engine read it itself.
      expect(prompt).not.toContain('REAL_MARKER')
      expect(prompt).toContain('## How you are running now')
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('keeps building mode pointed at README.md only when the folder has one', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Do the thing.\n')
    const without = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(without).toContain('work from `CLAUDE.md`, which is your whole definition.')
    writeFileSync(join(dir, 'README.md'), '# Alpha\n')
    expect(assembleBareNativePrompt(dir, 'Alpha', context, 'claude'))
      .toContain('read `README.md` in this folder for how this agent is organised')
  })

  it('appends trailing sections after the context block, ignoring empty ones', () => {
    // The seam for the handover protocol and the agent's own id. They go
    // *after* the desktop context, never between the instructions and it.
    writeFileSync(join(dir, 'CLAUDE.md'), 'Do the thing.\n')
    const prompt = assembleBareNativePrompt(dir, 'Alpha', context, 'claude', [
      '## Handovers\n\nHANDOVER_MARKER',
      '   '
    ])
    expect(prompt.indexOf('HANDOVER_MARKER')).toBeGreaterThan(prompt.indexOf('## Building mode'))
    expect(prompt).toBe(`${prompt.trimEnd()}\n`)
    expect(prompt).not.toContain('---\n\n   ')
  })

  it('is deterministic, and shorter than the prompt that replaces the engine’s own', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'A long set of folder instructions.\n'.repeat(20))
    const native = assembleBareNativePrompt(dir, 'Alpha', context, 'claude')
    expect(native).toBe(assembleBareNativePrompt(dir, 'Alpha', context, 'claude'))
    expect(native.length).toBeLessThan(assembleBareAgentPrompt(dir, 'Alpha', context).length)
  })
})

/**
 * What the desktop tells an agent about **itself** and about handing work on.
 *
 * Two additions, one rule each. The agent id is in the system prompt because it
 * is stable per agent — a per-turn id there would start one pooled Codex
 * process per chat — and an agent that does not know its id cannot fill in the
 * `origin.agent` of a handover brief, so the id and the protocol are tested
 * together. Both must reach **all three** documents: kit, isolated bare, and
 * native bare. A section that silently appears in only two of them is exactly
 * the omission this file exists to catch.
 */
describe('the agent’s own identifiers and the handover protocol', () => {
  const withId: DesktopPromptContext = { ...CONTEXT, agentId: 'folder:invoices' }

  /** The three prompts an agent can run on, over the same folder. */
  function prompts(dir: string, context: DesktopPromptContext): Record<string, string> {
    return {
      kit: assembleAgentPrompt(dir, manifest(), context),
      isolated: assembleBareAgentPrompt(dir, 'Invoices', context),
      native: assembleBareNativePrompt(dir, 'Invoices', context, 'claude')
    }
  }

  beforeEach(() => {
    write('docs/WORKFLOW_PROMPT.md', 'You are Invoices.')
    writeFileSync(join(dir, 'AGENTS.md'), 'Check the invoices.\n')
  })

  it('states the agent id once, in “How you are running now”, in every prompt', () => {
    for (const [kind, prompt] of Object.entries(prompts(dir, withId))) {
      const line = '- Your Cinna agent id is `folder:invoices`;'
      expect(prompt, kind).toContain(line)
      expect(prompt.split(line).length - 1, kind).toBe(1)
      // In the desktop's own section, not loose at the end: the bullet has to
      // sit above `## Building mode` in the same block.
      expect(prompt.indexOf(line), kind).toBeGreaterThan(prompt.indexOf('## How you are running now'))
      expect(prompt.indexOf(line), kind).toBeLessThan(prompt.indexOf('## Building mode'))
    }
  })

  it('teaches the handover protocol in every prompt, with this agent as the origin', () => {
    for (const [kind, prompt] of Object.entries(prompts(dir, withId))) {
      expect(prompt, kind).toContain('## Handing work to another project')
      expect(prompt, kind).toContain('.cinna/handovers/<id>/brief.md')
      expect(prompt, kind).toContain('agent: folder:invoices')
      expect(prompt, kind).toContain('status: ready')
      // The reporting instructions the brief has to end with, verbatim from the
      // contract module — an executor in a terminal gets nothing else.
      expect(prompt, kind).toContain(HANDOVER_HOW_TO_REPORT)
      // Chat and task ids are per turn and arrive in the wire-only header.
      expect(prompt, kind).toContain("chat: <the chat id from this turn's context>")
    }
  })

  it('leaves both out when the producer knows no agent id, rather than writing a blank one', () => {
    // A preview or a development session assembles a prompt for something with
    // no agent row. Mutation: emit the section anyway and its brief tells the
    // executor that `origin.agent` is `undefined`.
    for (const [kind, prompt] of Object.entries(prompts(dir, CONTEXT))) {
      expect(prompt, kind).not.toContain('Your Cinna agent id')
      expect(prompt, kind).not.toContain('## Handing work to another project')
      expect(prompt, kind).not.toContain('undefined')
    }
  })

  it('changes nothing else in the kit document', () => {
    // The identity bullet and the protocol section are additive: everything the
    // snapshot above pins is still there, in the same order.
    const before = assembleAgentPrompt(dir, manifest(), CONTEXT)
    const after = assembleAgentPrompt(dir, manifest(), withId)
    const added = ['- Your Cinna agent id is', '## Handing work to another project']
    expect(after.startsWith(before.slice(0, before.indexOf('- Long output goes')))).toBe(true)
    for (const marker of added) expect(before).not.toContain(marker)
    // And the sections it already had survive the two insertions.
    for (const marker of ['## How you are running now', '## Building mode', 'You are Invoices.']) {
      expect(after).toContain(marker)
    }
  })
})
