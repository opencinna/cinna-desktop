import type { ToolProvider, ToolExecutionResult, ToolCallOptions } from '../llm/toolProvider'
import type { ToolDefinition } from '../llm/types'
import type { DelegationSession } from './delegationService'

/*
 * The Cinna Task Protocol's eight tools, exactly as `tasks.schema.json`
 * states them (`tasksProtocolParity.test.ts` holds the two equal): the
 * schema's `$ref`s are written out here, because an engine reads each tool's
 * input schema on its own, without the file's `$defs`.
 */

const ref = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'A task reference as this host shows it (`t-3f9a2b1c`, `TASK-5`, a folder task\'s id). Opaque: never built or translated by the agent, always copied from a tool result or the turn context.'
}

const priority = { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }

const customFields = {
  type: 'object',
  maxProperties: 32,
  description: 'User-named values on the task: text, number, boolean or a flat list of strings. Keys the protocol owns (status, title, priority, id, execution, origin, depth, group, parent, blocked_by) are refused in any letter case. The whole set is replaced on update; `{}` clears it.',
  additionalProperties: {
    oneOf: [
      { type: 'string', maxLength: 2000 },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 200 } }
    ]
  }
}

const artifact = {
  oneOf: [
    {
      type: 'string',
      minLength: 1,
      maxLength: 1024,
      description: 'A path relative to the working folder, or an http(s) URL.'
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      properties: {
        kind: { type: 'string', enum: ['file', 'link'] },
        name: { type: 'string', maxLength: 200 },
        ref: { type: 'string', minLength: 1, maxLength: 1024 }
      }
    }
  ]
}

/** The handover id shape (`isHandoverId`), for `id` and `group`. */
const slug = '^[a-z0-9][a-z0-9._-]{2,63}$'

interface ToolSchema {
  description: string
  inputSchema: Record<string, unknown> & { properties: Record<string, unknown> }
}

function object(properties: Record<string, unknown>, required?: string[]): ToolSchema['inputSchema'] {
  return { type: 'object', additionalProperties: false, ...(required ? { required } : {}), properties }
}

export const TASKS_TOOL_SCHEMAS: Record<string, ToolSchema> = {
  tasks_targets: {
    description: 'Who you can hand work to. Returns one entry per target with the exact `target` string to pass as `tasks_create.assignee`, its name, kind, where it runs, what it supports and its protocol version. Call it before delegating; never guess a target.',
    inputSchema: object({})
  },
  tasks_list: {
    description: 'The tasks that concern you: assigned to you, created by you, or delegated by you. Newest first, at most 50, closed ones left out unless `include_closed`. Not a wait primitive: if nothing changed since your last call in this turn, end your turn.',
    inputSchema: object({
      relation: { type: 'string', enum: ['assigned', 'created', 'delegated', 'all'], default: 'all' },
      category: {
        type: 'string',
        enum: ['backlog', 'ready', 'active', 'waiting', 'done'],
        description: 'Where a task sits. `done` covers completed, failed and cancelled work.'
      },
      include_closed: { type: 'boolean', default: false }
    })
  },
  tasks_get: {
    description: 'One task in full: goal, description, status and category, priority, assignee, parent, blocked_by, custom fields, the latest comments, the latest report, and where any attached files were placed for you to read.',
    inputSchema: object({ ref }, ['ref'])
  },
  tasks_create: {
    description: 'Create work. Without `assignee` it goes into your own queue (Backlog unless `category: ready`). With an `assignee` from `tasks_targets` it is a delegation: `description` is the brief, `id` makes the request idempotent (repeating it returns the same work), and you end your turn afterwards — the result arrives later as a message in this conversation. `parent` must be a task of yours; with an assignee it makes a delegated subtask. Depth is capped at 2 and at most 20 tool-created tasks per conversation.',
    inputSchema: object({
      title: { type: 'string', minLength: 1, maxLength: 500 },
      description: { type: 'string', minLength: 1, maxLength: 100000, description: 'Markdown. For a delegation, everything the executor needs; it may not see this conversation.' },
      priority,
      category: { type: 'string', enum: ['backlog', 'ready', 'draft'], description: '`backlog` (default) or `ready`. `draft` is only for a delegation to a folder target: the brief is written but not picked up until made ready.' },
      parent: ref,
      assignee: { type: 'string', maxLength: 256, description: 'A `target` from `tasks_targets`, verbatim. Omit for your own queue.' },
      id: { type: 'string', pattern: slug, description: 'Delegations only. Your idempotency key for this request; `YYYYMMDD-HHMM-<slug>` is the recommended shape.' },
      execution: { type: 'string', enum: ['ask', 'auto'], description: 'Delegations only. `ask` forces a person to approve the run; otherwise the receiving side\'s own setting decides.' },
      group: { type: 'string', pattern: slug, description: 'Delegations only. Give several requests the same group and you are woken once, when all of them are over.' },
      custom_fields: customFields
    }, ['title', 'description'])
  },
  tasks_update: {
    description: 'Edit a task\'s fields, or move it by hand between Backlog, Ready, Done and Cancelled as a person would on the board. Not for saying how your work went — that is `tasks_report`. Refused on a task something else is working on: a running turn, an open question, a queue or a delegation.',
    inputSchema: object({
      ref,
      title: { type: 'string', minLength: 1, maxLength: 500 },
      description: { type: 'string', maxLength: 100000 },
      priority,
      custom_fields: customFields,
      category: { type: 'string', enum: ['backlog', 'ready', 'done', 'cancelled'], description: 'A manual move. A host with status words of its own (a folder\'s `_board.yaml`) also accepts one of those words here.' }
    }, ['ref'])
  },
  tasks_comment: {
    description: 'Leave a Markdown note on a task — a finding, an intermediate result, a question for a person reading the task page. Shown on the task and copied to the task\'s home where it has one. Does not change status; use `tasks_report` for that.',
    inputSchema: object({
      ref: { ...ref, description: 'Defaults to the task this conversation is working on.' },
      body: { type: 'string', minLength: 1, maxLength: 8000 },
      files: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1024 }, description: 'Paths relative to the working folder to attach, where the host supports attachments. A missing file fails the call and posts nothing.' }
    }, ['body'])
  },
  tasks_report: {
    description: 'Say how your work on a task is going or how it ended. The only way to close work you were given: `done` or `failed` with a one-line summary before you end your turn; `blocked` with a `question` when you cannot continue (audience `requester` wakes the agent that asked, `user` waits for a person); `in_progress` for a progress note. A dispatched or delegated task that ends without a report is left Waiting with “Ended without reporting”. Idempotent: repeating the same report changes nothing.',
    inputSchema: object({
      ref: { ...ref, description: 'Defaults to the task this conversation is working on.' },
      status: { type: 'string', enum: ['in_progress', 'blocked', 'done', 'failed'] },
      summary: { type: 'string', minLength: 1, maxLength: 1000, description: 'One line. It is what every list shows.' },
      question: { type: 'string', maxLength: 4000, description: 'Required when `status` is `blocked`.' },
      audience: { type: 'string', enum: ['requester', 'user'], description: 'Who a `blocked` question is for. Defaults to `requester` when an agent asked for this work, else `user`.' },
      artifacts: { type: 'array', maxItems: 100, items: artifact },
      body: { type: 'string', maxLength: 100000, description: 'The full answer or report, Markdown.' }
    }, ['status', 'summary'])
  },
  tasks_reply: {
    description: 'Answer a `blocked` question from work you delegated, or send a follow-up to work still under way. The executor receives it in its own conversation with everything it has already read.',
    inputSchema: object({
      ref: { ...ref, description: 'The delegated task.' },
      message: { type: 'string', minLength: 1, maxLength: 64000 }
    }, ['ref', 'message'])
  }
}

/** What `tasks_list` adds when nothing changed since the previous call in this provider's life. */
export const UNCHANGED_NOTICE = 'Nothing has changed since your last call in this turn; end your turn.'

/**
 * The session tools of a folder agent's own (or human-routed) chat: the Cinna
 * Task Protocol's `tasks_*`, served by `taskToolService` (and through it by
 * the delegation bus). One provider, one loopback MCP server (`cinna`).
 */
export class DelegationToolProvider implements ToolProvider {
  readonly providerType = 'mcp' as const
  readonly displayName = 'Cinna tasks'
  private lastList: string | null = null

  constructor(private readonly session: DelegationSession) {}

  getTools(): ToolDefinition[] {
    return Object.entries(TASKS_TOOL_SCHEMAS).map(([name, schema]) => ({
      name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      mcpProviderId: 'cinna-handovers',
      providerType: 'mcp'
    }))
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    options?: ToolCallOptions
  ): Promise<ToolExecutionResult> {
    const signal = options?.signal
    signal?.throwIfAborted()
    const schema = TASKS_TOOL_SCHEMAS[name]
    if (!schema) throw new Error('This tool is not offered to this session.')
    if (Object.keys(input).some((key) => !(key in schema.inputSchema.properties))) {
      throw new Error('The tool received an unknown argument.')
    }

    const { taskToolService } = await import('./taskToolService')
    signal?.throwIfAborted()
    switch (name) {
      case 'tasks_targets':
        return { content: await taskToolService.tasksTargets(this.session, signal) }
      case 'tasks_list': {
        const listed = taskToolService.tasksList(this.session, input)
        const digest = JSON.stringify(listed)
        const unchanged = digest === this.lastList
        this.lastList = digest
        return { content: { ...listed, ...(unchanged ? { notice: UNCHANGED_NOTICE } : {}) } }
      }
      case 'tasks_get':
        return { content: await taskToolService.tasksGet(this.session, input) }
      case 'tasks_create':
        return { content: await taskToolService.tasksCreate(this.session, input, signal) }
      case 'tasks_update':
        return { content: await taskToolService.tasksUpdate(this.session, input) }
      case 'tasks_comment':
        return { content: await taskToolService.tasksComment(this.session, input) }
      case 'tasks_report':
        return { content: await taskToolService.tasksReport(this.session, input) }
      default:
        return { content: await taskToolService.tasksReply(this.session, input) }
    }
  }
}
