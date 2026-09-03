/**
 * The one-shot AI draft that follows a scaffold.
 *
 * A folder is created from one sentence, and that sentence is all the app
 * knows. This service turns it into the three things a kit agent needs before
 * it can be talked to: a workflow prompt in the shape
 * `templates/agent/docs/WORKFLOW_PROMPT.md` describes, three example prompts,
 * and a router trigger sentence.
 *
 * Three rules shape it:
 *
 * * **The scaffold never depends on this.** A machine with no AI credential
 *   configured still gets its folder; the draft comes back `skipped` and the
 *   page's readiness strip says what to add. Nothing here throws for that case.
 * * **It only ever fills a blank.** A workflow document that no longer looks
 *   like the scaffold template, an `example_prompts` list that is not empty, a
 *   `router_trigger_prompt` that is already set — each is left alone. The user
 *   and their assistant own those files the moment they touch them.
 * * **Invariant 3 holds across the LLM call.** Stamps are taken *before* the
 *   model runs, not after, so an assistant that edits the folder during the
 *   ten seconds the draft takes has its work refused-into rather than
 *   overwritten. A refused part is reported, never retried.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiFunctions, AiFunctionError } from '../aiFunctionsService'
import { createLogger } from '../../logger/logger'
import {
  LOCAL_AGENT_PROMPT_PATHS,
  isStaleWriteError,
  type DraftLocalAgentResult,
  type FileStamp,
  type LocalAgentDraftParts,
  type LocalAgentDto
} from '../../../shared/localAgents'
import { MANIFEST_FILE } from '../../../shared/kit/manifest'
import { localAgentService } from './localAgentService'

const logger = createLogger('local-agents-draft')

/** Ceiling on one drafting call. A wedged provider must not wedge creation. */
const DRAFT_TIMEOUT_MS = 90_000

/** Generous caps — the guard is against a runaway model, not a long answer. */
const MAX_WORKFLOW_CHARS = 8_000
const MAX_META_CHARS = 2_000

/** How many example prompts guide 02 asks a new agent to ship with. */
const EXAMPLE_PROMPT_COUNT = 3

/**
 * Strings that only exist in the untouched scaffold template. One of them
 * present means nobody has written the document yet, so drafting over it takes
 * nothing away. Both come from `templates/agent/docs/WORKFLOW_PROMPT.md`.
 */
const SCAFFOLD_MARKERS = ['This file IS the agent.', '<!-- first step -->']

const WORKFLOW_SYSTEM_PROMPT = [
  'You write the system prompt for a small, single-purpose work agent.',
  '',
  'The user gives you the agent name and one sentence describing its job.',
  'Write the complete document that will be loaded as that agent\'s system',
  'prompt. Address the agent as "you", in its own voice.',
  '',
  'Output EXACTLY this markdown skeleton, with every section filled in:',
  '',
  '# <name>',
  '',
  'You are <name>. <one sentence restating the job>',
  '',
  '## What you do',
  '<one or two sentences: the job, and who asks for it>',
  '',
  '## How you do it',
  '<numbered steps, each naming a concrete action and its output>',
  '',
  '## What counts as a problem',
  '<the decision logic: what to flag, what to ignore, what to say when there',
  'is nothing to report>',
  '',
  '## How you answer',
  '<the shape of the reply: what to lead with, what to leave out>',
  '',
  '## Boundaries',
  '- If an input you need is missing, say exactly which one and stop. Never guess a value and never invent data.',
  '- If a credential is not configured, say which slot is missing and stop.',
  '- Write files only under `app-data/`.',
  '- Never print, echo or log a secret.',
  '',
  'Rules:',
  '- Output ONLY the document. No preamble, no code fence, no HTML comments.',
  '- Reproduce the four Boundaries bullets above verbatim.',
  '- Do not invent script names, file paths, APIs or credentials. Where a step',
  '  needs a tool that has not been written yet, describe the step in plain',
  '  words instead of naming a command.',
  '- Keep it under 400 words.'
].join('\n')

const META_SYSTEM_PROMPT = [
  'You write the discovery metadata for a small, single-purpose work agent.',
  '',
  'The user gives you the agent name and one sentence describing its job.',
  'Produce two things:',
  '',
  `1. A router trigger sentence: one sentence, in the third person, saying`,
  '   when a request should be handed to this agent. It is read by another',
  '   agent deciding where to route work.',
  `2. ${EXAMPLE_PROMPT_COUNT} example prompts: short, concrete things a user`,
  '   would actually type to this agent. First person, one line each, no',
  '   numbering, no quotes.',
  '',
  'Output format — exactly these lines, nothing else:',
  'TRIGGER: <the sentence>',
  'PROMPT: <example one>',
  'PROMPT: <example two>',
  'PROMPT: <example three>',
  '',
  'Rules:',
  '- Output ONLY those lines. No preamble, no markdown, no blank-line padding.',
  '- Do not invent specific customer names, account numbers or file paths.',
  '- Match the language of the job description.'
].join('\n')

/** Strip a fence the model may have wrapped the document in anyway. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const firstBreak = trimmed.indexOf('\n')
  if (firstBreak === -1) return trimmed
  const withoutOpen = trimmed.slice(firstBreak + 1)
  const closing = withoutOpen.lastIndexOf('```')
  return (closing === -1 ? withoutOpen : withoutOpen.slice(0, closing)).trim()
}

/**
 * Parse the `TRIGGER:` / `PROMPT:` block.
 *
 * Line-based rather than JSON on purpose: a small model that fumbles one line
 * still yields the others, where one stray character in a JSON object yields
 * nothing at all. Anything unrecognised is dropped rather than guessed at.
 */
export function parseDraftMeta(raw: string): {
  routerTrigger: string | null
  examplePrompts: string[]
} {
  let routerTrigger: string | null = null
  const examplePrompts: string[] = []
  for (const line of stripCodeFence(raw).split('\n')) {
    const trimmed = line.trim().replace(/^[-*]\s+/, '')
    const trigger = /^TRIGGER:\s*(.+)$/i.exec(trimmed)
    if (trigger && routerTrigger === null) {
      routerTrigger = trigger[1].trim()
      continue
    }
    const prompt = /^PROMPT:\s*(.+)$/i.exec(trimmed)
    if (prompt && examplePrompts.length < EXAMPLE_PROMPT_COUNT) {
      const value = prompt[1].trim().replace(/^["'`]+|["'`]+$/g, '').trim()
      if (value !== '') examplePrompts.push(value)
    }
  }
  return { routerTrigger: routerTrigger === '' ? null : routerTrigger, examplePrompts }
}

/** True while the workflow document is still exactly what the scaffolder wrote. */
export function isUntouchedWorkflowPrompt(contents: string): boolean {
  return SCAFFOLD_MARKERS.some((marker) => contents.includes(marker))
}

function readWorkflowPrompt(agentDir: string): string | null {
  try {
    return readFileSync(join(agentDir, LOCAL_AGENT_PROMPT_PATHS.workflow), 'utf8')
  } catch {
    return null
  }
}

function describeAgent(agent: LocalAgentDto): string {
  return [`Agent name: ${agent.name}`, `What it should do: ${agent.description}`].join('\n')
}

/**
 * Agents with a draft call in flight. Process-local and in-memory, like
 * `turnLock` — it coordinates this process with itself, nothing more.
 */
const inFlight = new Set<string>()

export const localAgentDraftService = {
  /**
   * Draft the workflow prompt, example prompts and router trigger for a
   * freshly scaffolded agent.
   *
   * Never throws for the ordinary refusals — no credential, a document the user
   * already wrote, a file that changed underneath. Each comes back as a
   * `skipped` status or an unset part, with the freshly-scanned agent attached
   * either way.
   */
  async draft(userId: string, agentId: string): Promise<DraftLocalAgentResult> {
    // One draft per agent at a time. Two concurrent calls are billed twice and
    // then fight: both capture the same pre-call stamps, so whichever finishes
    // second has every write correctly refused — and reports "the draft could
    // not be written" for a folder that drafted perfectly well. Whichever
    // settles last is what the page shows, so the *successful* run is the one
    // likely to be hidden. The renderer has its own guard; this one covers
    // every future caller, including a retry button nobody has written yet.
    if (inFlight.has(agentId)) {
      logger.info('draft skipped — one is already running for this agent', { agentId })
      return {
        status: 'skipped',
        parts: { workflowPrompt: false, examplePrompts: false, routerTrigger: false },
        reason: 'A draft is already running for this agent.',
        agent: localAgentService.get(userId, agentId)
      }
    }
    inFlight.add(agentId)
    try {
      return await this.draftOnce(userId, agentId)
    } finally {
      inFlight.delete(agentId)
    }
  },

  async draftOnce(userId: string, agentId: string): Promise<DraftLocalAgentResult> {
    let agent = localAgentService.get(userId, agentId)
    const parts: LocalAgentDraftParts = {
      workflowPrompt: false,
      examplePrompts: false,
      routerTrigger: false
    }

    const workflowOnDisk = readWorkflowPrompt(agent.path)
    const wantsWorkflow = workflowOnDisk !== null && isUntouchedWorkflowPrompt(workflowOnDisk)
    const wantsExamples = (agent.manifest.example_prompts ?? []).length === 0
    const wantsTrigger =
      agent.manifest.router_trigger_prompt === null ||
      agent.manifest.router_trigger_prompt === undefined ||
      agent.manifest.router_trigger_prompt === ''

    if (!wantsWorkflow && !wantsExamples && !wantsTrigger) {
      return {
        status: 'skipped',
        parts,
        reason: 'This agent already has a workflow prompt, example prompts and a router trigger.',
        agent
      }
    }

    let resolved
    try {
      resolved = aiFunctions.resolveAdapterFromDefaultMode(userId)
    } catch (err) {
      if (err instanceof AiFunctionError && err.code === 'no_provider') {
        logger.info('draft skipped — no AI credential configured', { agentId })
        return {
          status: 'skipped',
          parts,
          reason:
            'No AI credential is configured, so the prompts were left as the template. Add one in Settings → AI Credentials, then draft them by hand or in your assistant.',
          agent
        }
      }
      throw err
    }

    // Both stamps are taken here, before the model runs. A stamp taken after a
    // 30-second call would certify nothing about the file the write lands on.
    const workflowStamp = agent.stamps[LOCAL_AGENT_PROMPT_PATHS.workflow] ?? null
    let manifestStamp = agent.stamps[MANIFEST_FILE] ?? null
    const context = describeAgent(agent)
    const failures: string[] = []

    if (wantsWorkflow && !workflowStamp) {
      // The template said this document should be drafted, but there is no
      // stamp — the file is not on disk, so there is nothing safe to write to.
      // Named rather than skipped in silence: without this the reason line
      // claims a clean draft while the card the user is looking at is empty.
      //
      // UNTESTED, deliberately. `wantsWorkflow` comes from `readWorkflowPrompt`
      // and the stamp from the same scan, so reaching here needs the file to be
      // deleted *between* those two reads. Covering it would mean a seam in the
      // scan whose only purpose is this branch, which costs more than the two
      // lines are worth — but do not read the absence of a test as evidence
      // that this cannot happen.
      failures.push('the workflow prompt')
    }

    if (wantsWorkflow && workflowStamp) {
      const document = await this.runDraftCall({
        resolved,
        systemPrompt: WORKFLOW_SYSTEM_PROMPT,
        userText: context,
        label: 'local-agent-workflow-prompt',
        maxOutputChars: MAX_WORKFLOW_CHARS
      })
      if (document === null) {
        failures.push('the workflow prompt')
      } else {
        const written = this.saveField(
          userId,
          agentId,
          { field: 'prompt', prompt: 'workflow', value: `${stripCodeFence(document)}\n` },
          workflowStamp
        )
        if (written) {
          agent = written
          manifestStamp = written.stamps[MANIFEST_FILE] ?? manifestStamp
          parts.workflowPrompt = true
        } else {
          failures.push('the workflow prompt')
        }
      }
    }

    if (wantsExamples || wantsTrigger) {
      const raw = await this.runDraftCall({
        resolved,
        systemPrompt: META_SYSTEM_PROMPT,
        userText: context,
        label: 'local-agent-draft-meta',
        maxOutputChars: MAX_META_CHARS
      })
      if (raw === null) {
        failures.push('the example prompts')
      } else {
        const meta = parseDraftMeta(raw)
        if (wantsExamples && meta.examplePrompts.length > 0 && manifestStamp) {
          const written = this.saveField(
            userId,
            agentId,
            { field: 'example_prompts', value: meta.examplePrompts },
            manifestStamp
          )
          if (written) {
            agent = written
            // Every manifest write invalidates the stamp the next one needs:
            // the second write must carry the file as the first one left it.
            manifestStamp = written.stamps[MANIFEST_FILE] ?? null
            parts.examplePrompts = true
          } else {
            failures.push('the example prompts')
          }
        }
        if (wantsTrigger && meta.routerTrigger && manifestStamp) {
          const written = this.saveField(
            userId,
            agentId,
            { field: 'router_trigger_prompt', value: meta.routerTrigger },
            manifestStamp
          )
          if (written) {
            agent = written
            manifestStamp = written.stamps[MANIFEST_FILE] ?? null
            parts.routerTrigger = true
          } else {
            failures.push('the router trigger')
          }
        }
      }
    }

    const wroteSomething = parts.workflowPrompt || parts.examplePrompts || parts.routerTrigger
    if (!wroteSomething) {
      return {
        status: 'failed',
        parts,
        reason: 'The draft could not be written. Edit the prompts on this page instead.',
        agent
      }
    }
    logger.info('local agent drafted', { agentId, ...parts })
    return {
      status: 'drafted',
      parts,
      reason:
        failures.length > 0
          ? `Drafted, except ${[...new Set(failures)].join(' and ')} — edit ${
              failures.length > 1 ? 'those cards' : 'that card'
            } on this page.`
          : null,
      agent
    }
  },

  /**
   * One single-shot call, with a timeout. Returns `null` instead of throwing:
   * a provider that is down must degrade the draft, not the creation.
   */
  async runDraftCall(input: {
    resolved: ReturnType<typeof aiFunctions.resolveAdapterFromDefaultMode>
    systemPrompt: string
    userText: string
    label: string
    maxOutputChars: number
  }): Promise<string | null> {
    try {
      return await aiFunctions.runSingleShot({
        adapter: input.resolved.adapter,
        modelId: input.resolved.modelId,
        systemPrompt: input.systemPrompt,
        userText: input.userText,
        label: input.label,
        maxOutputChars: input.maxOutputChars,
        signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS)
      })
    } catch (err) {
      logger.warn('a draft call failed', {
        label: input.label,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  },

  /**
   * Write one drafted field. Returns the rescanned agent, or `null` when the
   * write was refused — a file the user or their assistant changed while the
   * model was thinking is left exactly as they left it, and is never retried
   * with a fresher stamp.
   */
  saveField(
    userId: string,
    agentId: string,
    update: Parameters<typeof localAgentService.updateField>[1]['update'],
    expectedStamp: FileStamp
  ): LocalAgentDto | null {
    try {
      return localAgentService.updateField(userId, { agentId, update, expectedStamp })
    } catch (err) {
      if (isStaleWriteError(err)) {
        logger.info('a drafted field was refused — the file changed during the call', {
          agentId,
          field: update.field
        })
        return null
      }
      logger.warn('could not save a drafted field', {
        agentId,
        field: update.field,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }
}
