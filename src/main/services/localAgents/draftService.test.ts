import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * The one-shot AI draft that follows a scaffold.
 *
 * Three properties matter more than the wording it produces: the folder is
 * created whether or not there is a model to draft with; the draft only ever
 * fills a blank; and a file that changed while the model was thinking is
 * refused rather than overwritten — the same stamp rule the page's editors
 * obey, applied across a call that takes seconds.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const ai = vi.hoisted(() => ({
  /** Set per test: what `resolveAdapterFromDefaultMode` should do. */
  resolve: null as null | (() => { adapter: unknown; modelId: string }),
  /** Set per test: one response per call, in order. */
  responses: [] as (string | (() => string))[],
  calls: [] as { label?: string; systemPrompt: string; userText: string }[]
}))

class FakeAiFunctionError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  shell: { showItemInFolder: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
vi.mock('../../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../aiFunctionsService', () => ({
  AiFunctionError: FakeAiFunctionError,
  aiFunctions: {
    resolveAdapterFromDefaultMode: () => {
      if (!ai.resolve) {
        throw new FakeAiFunctionError('no_provider', 'No default chat mode with a provider')
      }
      return ai.resolve()
    },
    runSingleShot: async (input: {
      label?: string
      systemPrompt: string
      userText: string
    }): Promise<string> => {
      ai.calls.push({ label: input.label, systemPrompt: input.systemPrompt, userText: input.userText })
      const next = ai.responses.shift()
      if (next === undefined) throw new FakeAiFunctionError('llm_failed', 'no response queued')
      return typeof next === 'function' ? next() : next
    }
  }
}))

const { agentRootRepo } = await import('../../db/agentRoots')
const { appSettingsRepo } = await import('../../db/appSettings')
const { clearContractCache } = await import('../../kit/contractStore')
const { readManifest, manifestPath } = await import('../../kit/manifestIo')
const { scaffoldService } = await import('./scaffoldService')
const { scannerService } = await import('./scannerService')
const { localAgentService } = await import('./localAgentService')
const { turnLock } = await import('./turnLock')
const { localAgentDraftService, parseDraftMeta, isUntouchedWorkflowPrompt } = await import(
  './draftService'
)

const USER = '__default__'
const WORKFLOW = 'docs/WORKFLOW_PROMPT.md'

const META_RESPONSE = [
  'TRIGGER: Route here when someone asks about unpaid invoices.',
  'PROMPT: Which invoices are missing a PO number?',
  'PROMPT: Summarise last week’s invoices.',
  'PROMPT: Flag anything over 30 days old.'
].join('\n')

let workshop: string
let agentDir: string
let agentId: string

beforeEach(() => {
  holder.current = createTestDatabase()
  clearContractCache()
  scannerService.markAllRootsDirty()
  turnLock.releaseAll()
  ai.resolve = () => ({ adapter: {}, modelId: 'test-model' })
  ai.responses = []
  ai.calls = []
  workshop = mkdtempSync(join(tmpdir(), 'cinna-draft-'))
  appSettingsRepo.set('localAgentsHome', workshop)
  scaffoldService.installRootTemplates(workshop)
  const root = agentRootRepo.create(USER, { path: workshop, label: 'Agents', isDefault: true })
  agentDir = scaffoldService.scaffoldAgent({
    rootPath: workshop,
    slug: 'alpha',
    name: 'Alpha',
    description: 'Watches the invoice inbox.'
  }).agentDir
  agentId = scannerService.scanRoot(USER, root).agents[0].id
})

afterEach(() => {
  turnLock.releaseAll()
  holder.current?.close()
  holder.current = null
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

function workflowText(): string {
  return readFileSync(join(agentDir, WORKFLOW), 'utf8')
}

describe('parseDraftMeta', () => {
  it('reads the trigger and up to three prompts', () => {
    const parsed = parseDraftMeta(META_RESPONSE)
    expect(parsed.routerTrigger).toBe('Route here when someone asks about unpaid invoices.')
    expect(parsed.examplePrompts).toHaveLength(3)
    expect(parsed.examplePrompts[0]).toBe('Which invoices are missing a PO number?')
  })

  it('keeps the lines it understands when the model adds its own', () => {
    const parsed = parseDraftMeta(
      ['Sure! Here you go:', '', '- PROMPT: "One"', 'PROMPT: Two', 'Thanks!'].join('\n')
    )
    expect(parsed.examplePrompts).toEqual(['One', 'Two'])
    expect(parsed.routerTrigger).toBeNull()
  })

  it('finds nothing in an answer that ignored the format', () => {
    const parsed = parseDraftMeta('I would suggest asking it about invoices.')
    expect(parsed.examplePrompts).toEqual([])
    expect(parsed.routerTrigger).toBeNull()
  })
})

describe('draft', () => {
  it('writes the workflow prompt, the example prompts and the router trigger', async () => {
    ai.responses = ['# Alpha\n\nYou are Alpha. You watch the invoice inbox.\n', META_RESPONSE]

    const result = await localAgentDraftService.draft(USER, agentId)

    expect(result.status).toBe('drafted')
    expect(result.parts).toEqual({
      workflowPrompt: true,
      examplePrompts: true,
      routerTrigger: true
    })
    expect(workflowText()).toContain('You are Alpha.')
    expect(isUntouchedWorkflowPrompt(workflowText())).toBe(false)

    const manifest = readManifest(manifestPath(agentDir))
    expect(manifest.example_prompts).toHaveLength(3)
    expect(manifest.router_trigger_prompt).toBe(
      'Route here when someone asks about unpaid invoices.'
    )
    // The returned agent is the folder re-read, not an echo of what was sent.
    expect(result.agent.manifest.example_prompts).toEqual(manifest.example_prompts)
  })

  /**
   * StrictMode's mount → cleanup → mount runs the page's draft effect twice
   * with no render between, so the second invocation still sees the pre-`null`
   * request and fires again. The renderer has a ref guard for that; this is the
   * service's own, which covers every other caller.
   *
   * The cost of not having it is not just a doubled bill. Both calls capture
   * the same pre-call stamps, so the second one's writes are correctly refused
   * — and it then reports "the draft could not be written" for a folder that
   * drafted perfectly. Whichever settles last is what the page shows.
   */
  it('runs one draft per agent, however many callers ask at once', async () => {
    ai.responses = ['# Alpha\n\nYou are Alpha.\n', META_RESPONSE]

    // Started together, without awaiting the first: the second call arrives
    // while the first is still inside its model call, which is exactly the
    // window StrictMode's double-mount opens.
    const [first, second] = await Promise.all([
      localAgentDraftService.draft(USER, agentId),
      localAgentDraftService.draft(USER, agentId)
    ])

    const outcomes = [first.status, second.status].sort()
    expect(outcomes).toEqual(['drafted', 'skipped'])
    const skipped = first.status === 'skipped' ? first : second
    expect(skipped.reason).toContain('already running')
    // One draft's worth of model calls, not two.
    expect(ai.calls).toHaveLength(2)
    expect(ai.calls.map((c) => c.label).sort()).toEqual([
      'local-agent-draft-meta',
      'local-agent-workflow-prompt'
    ])
  })

  it('gives the model the sentence the user typed', async () => {
    ai.responses = ['# Alpha\n', META_RESPONSE]
    await localAgentDraftService.draft(USER, agentId)
    expect(ai.calls[0].userText).toContain('Watches the invoice inbox.')
    expect(ai.calls[0].userText).toContain('Alpha')
  })

  it('skips the draft, and changes nothing, when no AI credential is configured', async () => {
    ai.resolve = null
    const before = workflowText()

    const result = await localAgentDraftService.draft(USER, agentId)

    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/AI credential/i)
    expect(result.parts.workflowPrompt).toBe(false)
    // The folder is untouched: the scaffold does not depend on a model.
    expect(workflowText()).toBe(before)
    expect(readManifest(manifestPath(agentDir)).example_prompts).toEqual([])
    expect(ai.calls).toHaveLength(0)
  })

  it('leaves a workflow prompt someone has already written alone', async () => {
    writeFileSync(join(agentDir, WORKFLOW), '# Alpha\n\nWritten by hand.\n')
    ai.responses = [META_RESPONSE]

    const result = await localAgentDraftService.draft(USER, agentId)

    expect(workflowText()).toBe('# Alpha\n\nWritten by hand.\n')
    expect(result.parts.workflowPrompt).toBe(false)
    // The blanks it can still fill, it fills.
    expect(result.parts.examplePrompts).toBe(true)
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].label).toBe('local-agent-draft-meta')
  })

  it('does not replace example prompts that are already there', async () => {
    const agent = localAgentService.get(USER, agentId)
    localAgentService.updateField(USER, {
      agentId,
      update: { field: 'example_prompts', value: ['Mine'] },
      expectedStamp: agent.stamps['cinna-agent.json']!
    })
    ai.responses = ['# Alpha\n\nDrafted.\n', META_RESPONSE]

    await localAgentDraftService.draft(USER, agentId)

    expect(readManifest(manifestPath(agentDir)).example_prompts).toEqual(['Mine'])
  })

  it('refuses to overwrite a document that changed while the model was thinking', async () => {
    const theirs = '# Alpha\n\nAn assistant rewrote this mid-call.\n'
    ai.responses = [
      () => {
        // The stamp was taken before this call started; by the time the answer
        // comes back, the file is somebody else's.
        writeFileSync(join(agentDir, WORKFLOW), theirs)
        return '# Alpha\n\nDrafted by the model.\n'
      },
      META_RESPONSE
    ]

    const result = await localAgentDraftService.draft(USER, agentId)

    expect(workflowText()).toBe(theirs)
    expect(result.parts.workflowPrompt).toBe(false)
    expect(result.reason).toMatch(/workflow prompt/i)
    // And it is not retried with a fresh stamp: exactly one workflow call.
    expect(ai.calls.filter((call) => call.label === 'local-agent-workflow-prompt')).toHaveLength(1)
  })

  it('reports a failure rather than throwing when the model is unreachable', async () => {
    ai.responses = []

    const result = await localAgentDraftService.draft(USER, agentId)

    expect(result.status).toBe('failed')
    expect(result.agent.id).toBe(agentId)
    expect(isUntouchedWorkflowPrompt(workflowText())).toBe(true)
  })

  it('does nothing at all for an agent that is already complete', async () => {
    ai.responses = ['# Alpha\n\nDrafted.\n', META_RESPONSE]
    await localAgentDraftService.draft(USER, agentId)
    const callsAfterFirst = ai.calls.length

    const second = await localAgentDraftService.draft(USER, agentId)

    expect(second.status).toBe('skipped')
    expect(ai.calls).toHaveLength(callsAfterFirst)
  })
})
