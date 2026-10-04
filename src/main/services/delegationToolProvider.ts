import type { ToolProvider, ToolExecutionResult, ToolCallOptions } from '../llm/toolProvider'
import type { ToolDefinition } from '../llm/types'
import type { DelegationSession } from './delegationService'

const string = { type: 'string' }


interface ToolSchema {
  description: string
  properties: Record<string, unknown>
  required?: string[]
}

const schemas: Record<string, ToolSchema> = {
  handover_targets: {
    description:
      'List agents you can delegate to, with their permissions and the exact assignee to pass to task_create.',
    properties: {}
  },
  handover_list: {
    description:
      'Read delegations requested by this conversation and task. Do not poll: end your turn to receive the automatic return packet.',
    properties: {}
  },
  handover_reply: {
    description: 'Answer a blocked executor or send a follow-up to a delegation requested by this conversation.',
    properties: { id: string, message: string },
    required: ['id', 'message']
  },
  handover_report: {
    description:
      'Report this delegation’s progress, question, or final result to its requester. Report blocked for a requester question.',
    properties: {
      status: { enum: ['in_progress', 'blocked', 'done', 'failed'] },
      summary: string,
      question: string,
      artifacts: { type: 'array', items: string }
    },
    required: ['status', 'summary']
  },
  tasks_list: {
    description:
      'List tasks assigned to you, created by you, or delegated by you (newest first, at most 50). Closed tasks are left out unless include_closed is true.',
    properties: {
      relation: { enum: ['assigned', 'created', 'delegated', 'all'] },
      category: { enum: ['backlog', 'ready', 'active', 'waiting', 'closed'] },
      include_closed: { type: 'boolean' }
    }
  },
  task_create: {
    description: [
      'Create a task. Without an assignee (or with yourself) it goes into your own queue: status backlog (default) or ready; parent is one of your own tasks.',
      'For a bare folder agent that queue is the Markdown files in .cinna/tasks/ of your folder, which you may also create and edit directly (frontmatter title, status, priority; status words such as todo, ready, doing, review, done).',
      'With an assignee from handover_targets it delegates the work: id is required and makes the call idempotent, description is the brief, and status draft, priority and custom_fields are for bare folders only.',
      'A delegation returns immediately; end your turn and Cinna will wake you with the result. For a bare folder, writing the brief.md directly is also fine.'
    ].join(' '),
    properties: {
      title: string,
      description: string,
      priority: { enum: ['low', 'normal', 'high', 'urgent'] },
      custom_fields: { type: 'object' },
      status: { enum: ['backlog', 'ready', 'draft'] },
      parent: string,
      assignee: {
        type: 'object',
        properties: { kind: { enum: ['bare', 'kit', 'cloud'] }, agentId: string, adapter: string },
        required: ['kind', 'agentId'],
        additionalProperties: false
      },
      id: string,
      execution: {
        enum: ['ask', 'auto'],
        description:
          'Delegation only. `ask` forces the person to approve this run; otherwise the receiving side’s own setting decides whether it runs without asking. Leave it out unless approval is needed.'
      },
      group: string
    },
    required: ['title', 'description']
  },
  task_update: {
    description: [
      'Change a task assigned to you, or one you created that no conversation has started: title, description, priority, custom_fields, status.',
      'Status moves follow the board: backlog, ready, done or cancelled (a folder task also takes its folder’s status words). For the task of this conversation you may also set completed, blocked or error to report how your work ended.'
    ].join(' '),
    properties: {
      id: string,
      title: string,
      description: string,
      priority: { enum: ['low', 'normal', 'high', 'urgent'] },
      custom_fields: { type: 'object', description: 'The whole set of custom fields; {} clears them.' },
      status: string
    },
    required: ['id']
  },
  task_comment: {
    description: 'Add a comment to a task assigned to you, created by you or delegated by you. It is shown on the task page and copied to the task’s file or service.',
    properties: { id: string, body: { type: 'string', maxLength: 8000 } },
    required: ['id', 'body']
  }
}

const UNCHANGED_NOTICE = 'Nothing has changed; end your turn — you will be woken when a result arrives.'

/**
 * The session tools of a folder agent's own (or human-routed) chat: the
 * delegation bus (`handover_*`) and the agent task tools (`task*`, served by
 * `taskToolService`). One provider, one MCP server (`cinna-handovers`).
 */
export class DelegationToolProvider implements ToolProvider {
  readonly providerType = 'mcp' as const
  readonly displayName = 'Cinna handovers'
  private lastList: string | null = null

  constructor(
    private readonly session: DelegationSession,
    private readonly executor: boolean
  ) {}

  getTools(): ToolDefinition[] {
    return Object.entries(schemas)
      .filter(([name]) => name !== 'handover_report' || this.executor)
      .map(([name, schema]) => ({
        name,
        description: schema.description,
        inputSchema: {
          type: 'object',
          properties: schema.properties,
          required: schema.required ?? [],
          additionalProperties: false
        },
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
    if (!this.getTools().some((tool) => tool.name === name)) {
      throw new Error('This tool is not offered to this session.')
    }
    const schema = schemas[name]
    if (Object.keys(input).some((key) => !(key in schema.properties))) {
      throw new Error('The tool received an unknown argument.')
    }

    if (name.startsWith('task')) {
      const { taskToolService } = await import('./taskToolService')
      signal?.throwIfAborted()
      if (name === 'tasks_list') return { content: taskToolService.tasksList(this.session, input) }
      if (name === 'task_create') return { content: await taskToolService.taskCreate(this.session, input, signal) }
      if (name === 'task_update') return { content: await taskToolService.taskUpdate(this.session, input) }
      return { content: await taskToolService.taskComment(this.session, input) }
    }

    const { delegationService } = await import('./delegationService')
    signal?.throwIfAborted()
    if (name === 'handover_targets') return { content: await delegationService.targets(this.session, signal) }
    if (name === 'handover_reply') return { content: await delegationService.reply(this.session, input) }
    if (name === 'handover_report') return { content: await delegationService.report(this.session, input) }

    const delegations = delegationService.list(this.session)
    const digest = JSON.stringify(delegations)
    const unchanged = digest === this.lastList
    this.lastList = digest
    return { content: { delegations, ...(unchanged ? { notice: UNCHANGED_NOTICE } : {}) } }
  }
}
