import type { RunEvent } from '../../shared/runEvents'
import type { ToolCallOptions, ToolExecutionResult, ToolProvider } from '../llm/toolProvider'
import type { ToolDefinition } from '../llm/types'
import type { TaskArtifact } from '../../shared/tasks'

/** Instructions to the owning runner, never parsed from an agent's prose. */
export type CoordinatorControl =
  | { kind: 'await_input' }
  | { kind: 'finish'; summary: string }
  | { kind: 'handoff'; agentId: string; agentName: string; note: string }
  | { kind: 'ask_user'; requestId: string; question: string }

export const COORDINATOR_TOOL_NAMES = ['delegate', 'handoff', 'ask_user', 'update_task', 'finish'] as const
export interface CoordinatorAgent { id: string; name: string }
export interface CoordinatorTaskUpdate { note?: string; artifacts?: TaskArtifact[] }
export interface CoordinatorActions {
  /** Recheck the captured task/device authority before any side effect. */
  assertCurrent(): void
  delegate(agentId: string, message: string, opts: ToolCallOptions): Promise<ToolExecutionResult>
  /** Persist an answerable gate before emitting needs_input or returning it. */
  askUser(question: string, toolCallId: string): { requestId: string }
  updateTask(update: CoordinatorTaskUpdate): void
}

function text(input: Record<string, unknown>, key: string, max: number, optional = false): string | undefined {
  const value = input[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${key} must be nonempty text of at most ${max} characters.`)
  }
  return value.trim()
}
function shape(input: Record<string, unknown>, keys: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Error('The tool arguments contain an unsupported field.')
  }
}
const stringSchema = (description: string, maxLength: number) => ({ type: 'string', minLength: 1, maxLength, description })

/** Offered only by an explicitly runner-owned coordinator model turn. */
export class CoordinatorToolProvider implements ToolProvider {
  readonly providerType = 'coordinator' as const
  readonly displayName = 'Task coordinator'
  constructor(private readonly taskId: string, private readonly agents: readonly CoordinatorAgent[], private readonly actions: CoordinatorActions) {}

  /** Delegates are already child-framed by callTool; gates belong directly to the root. */
  eventSink(_toolCallId: string, publish: (event: RunEvent) => void): (event: RunEvent) => void {
    return publish
  }

  getTools(): ToolDefinition[] {
    const agent = stringSchema(`Attached agent ID or unique name. Available: ${this.agents.map((entry) => `${entry.name} (${entry.id})`).join(', ') || 'none'}.`, 512)
    const definitions: [string, string, Record<string, unknown>, string[]][] = [
      ['delegate', 'Ask an attached agent to do a bounded piece of work. You retain ownership and receive its result. Agents cannot use coordinator tools.',
        { agent, message: stringSchema('Self-contained instructions for the agent.', 64000), expect: stringSchema('Optional expected output, included in the instructions.', 4000) }, ['agent', 'message']],
      ['handoff', 'Give the next turn to an attached agent with context and a handoff note. End this coordinator turn. The runner returns completed work to you.',
        { agent, note: stringSchema('Goal, progress, verification, open work and useful locations.', 12000) }, ['agent', 'note']],
      ['ask_user', 'Pause the task at a durable Inbox question. End this turn and wait for a human answer.',
        { question: stringSchema('The question the human must answer.', 4000) }, ['question']],
      ['update_task', 'Update the current handoff note or artifact list. Use ask_user to pause and finish to complete the task.',
        { note: stringSchema('Current progress and next steps.', 12000),
          artifacts: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['file', 'link'] }, name: stringSchema('Artifact name.', 512), ref: stringSchema('File path or link.', 4096) }, required: ['kind', 'name', 'ref'] } } }, []],
      ['finish', 'Complete the task with a final summary of the result and verification. End this coordinator turn.',
        { summary: stringSchema('Final answer for the user.', 20000) }, ['summary']]
    ]
    return definitions.map(([name, description, properties, required]) => ({ name, description,
      inputSchema: { type: 'object', additionalProperties: false, properties, required },
      mcpProviderId: `coordinator:${this.taskId}`, providerType: 'coordinator' }))
  }

  private agent(target: string): CoordinatorAgent {
    const exact = this.agents.find((entry) => entry.id === target)
    if (exact) return exact
    const named = this.agents.filter((entry) => entry.name.toLowerCase() === target.toLowerCase())
    if (named.length !== 1) throw new Error(named.length ? 'That agent name is ambiguous. Use its ID.' : 'Choose an attached, available agent.')
    return named[0]
  }

  describeCall(name: string, input: Record<string, unknown>): { agentId: string; displayName: string } | undefined {
    if (name !== 'delegate' || typeof input?.agent !== 'string') return undefined
    try {
      const agent = this.agent(input.agent.trim())
      return { agentId: agent.id, displayName: agent.name }
    } catch { return undefined } // callTool reports invalid targets as tool errors.
  }

  async callTool(name: string, input: Record<string, unknown>, opts: ToolCallOptions = {}): Promise<ToolExecutionResult> {
    this.actions.assertCurrent()
    if (opts.signal?.aborted) throw new Error('The task was stopped.')
    switch (name) {
      case 'delegate': {
        shape(input, ['agent', 'message', 'expect'])
        const agent = this.agent(text(input, 'agent', 512)!)
        const message = text(input, 'message', 64000)!
        const expected = text(input, 'expect', 4000, true)
        if (!opts.toolCallId) throw new Error('The delegated invocation has no identity.')
        const result = await this.actions.delegate(agent.id, expected ? `${message}\n\nExpected output:\n${expected}` : message, {
          ...opts, onEvent: (event) => opts.onEvent?.({ type: 'child', agentId: agent.id, toolCallId: opts.toolCallId!, event })
        })
        // A specialist's result cannot smuggle a coordinator control through.
        return { content: result.content, parts: result.parts, isError: result.isError,
          ...(result.needsInput && !result.isError ? { control: { kind: 'await_input' as const } } : {}) }
      }
      case 'handoff': {
        shape(input, ['agent', 'note'])
        const agent = this.agent(text(input, 'agent', 512)!)
        const note = text(input, 'note', 12000)!
        return { content: `Handing the task to ${agent.name}.`, control: { kind: 'handoff', agentId: agent.id, agentName: agent.name, note } }
      }
      case 'ask_user': {
        shape(input, ['question'])
        const question = text(input, 'question', 4000)!
        if (!opts.toolCallId) throw new Error('The question has no invocation identity.')
        const { requestId } = this.actions.askUser(question, opts.toolCallId)
        opts.onEvent?.({ type: 'needs_input', requestId, resume: 'reply',
          request: { kind: 'question', questions: [{ question, multiSelect: false, options: [] }] } })
        return { content: `Waiting for a human answer: ${question}`, control: { kind: 'ask_user', requestId, question } }
      }
      case 'update_task': {
        shape(input, ['status', 'note', 'artifacts'])
        if (input.status !== undefined && input.status !== 'in_progress') throw new Error('Use ask_user to pause or finish to complete the task.')
        const note = text(input, 'note', 12000, true)
        let artifacts: TaskArtifact[] | undefined
        if (input.artifacts !== undefined) {
          if (!Array.isArray(input.artifacts) || input.artifacts.length > 50) throw new Error('artifacts must contain at most 50 entries.')
          artifacts = input.artifacts.map((entry) => {
            shape(entry, ['kind', 'name', 'ref'])
            if (entry.kind !== 'file' && entry.kind !== 'link') throw new Error('An artifact kind must be file or link.')
            return { kind: entry.kind, name: text(entry, 'name', 512)!, ref: text(entry, 'ref', 4096)! }
          })
        }
        this.actions.updateTask({ ...(note !== undefined ? { note } : {}), ...(artifacts !== undefined ? { artifacts } : {}) })
        return { content: 'Task progress updated.' }
      }
      case 'finish': {
        shape(input, ['summary'])
        const summary = text(input, 'summary', 20000)!
        return { content: 'Task finished.', control: { kind: 'finish', summary } }
      }
      default: throw new Error('Unknown coordinator tool.')
    }
  }
}
