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
      'List agents available for durable delegation, including their permissions and exact target identifiers.',
    properties: {}
  },
  handover_create: {
    description: [
      'Ask another agent for work. Idempotent for this origin, target and id.',
      'Returns immediately; end your turn and Cinna will wake you with the result.',
      'For bare folders a direct brief.md write is preferred; use this tool when that write needs permission.'
    ].join(' '),
    properties: {
      target: {
        type: 'object',
        properties: { kind: { enum: ['bare', 'kit', 'cloud'] }, agentId: string, adapter: string },
        required: ['kind', 'agentId'],
        additionalProperties: false
      },
      id: string,
      title: string,
      brief: string,
      execution: { enum: ['ask', 'auto'] },
      group: string,
      status: { enum: ['draft', 'ready'] }
    },
    required: ['target', 'id', 'title', 'brief']
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
  }
}

const UNCHANGED_NOTICE = 'Nothing has changed; end your turn — you will be woken when a result arrives.'

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
      throw new Error('The handover tool received an unknown argument.')
    }

    const { delegationService } = await import('./delegationService')
    signal?.throwIfAborted()
    if (name === 'handover_targets') return { content: await delegationService.targets(this.session, signal) }
    if (name === 'handover_create') return { content: await delegationService.create(this.session, input, signal) }
    if (name === 'handover_reply') return { content: await delegationService.reply(this.session, input) }
    if (name === 'handover_report') return { content: await delegationService.report(this.session, input) }

    const delegations = delegationService.list(this.session)
    const digest = JSON.stringify(delegations)
    const unchanged = digest === this.lastList
    this.lastList = digest
    return { content: { delegations, ...(unchanged ? { notice: UNCHANGED_NOTICE } : {}) } }
  }
}
