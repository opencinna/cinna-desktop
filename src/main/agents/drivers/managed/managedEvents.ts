import type {
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsStreamSessionEvents
} from '@anthropic-ai/sdk/resources/beta/sessions/events'

export type ManagedEvent = BetaManagedAgentsStreamSessionEvents
export type ManagedPermissionTool = BetaManagedAgentsAgentToolUseEvent | BetaManagedAgentsAgentMCPToolUseEvent
export type ManagedEffect =
  | { type: 'text'; text: string }
  | { type: 'progress' }
  | { type: 'tool'; tool: ManagedPermissionTool }
  | { type: 'tool_result'; id: string; content: unknown; failed: boolean }
  | { type: 'permissions'; tools: ManagedPermissionTool[] }
  | { type: 'terminal'; reason: 'end_turn' | 'budget' | 'canceled' }

/**
 * One reducer for history and the official SDK iterator. Initial history only
 * establishes a baseline. Reconnect history is replayed through accept(), so
 * overlap and queued-to-processed upgrades obey the same identity rules.
 * The caller awaits every permission barrier before accepting another event.
 */
export class ManagedEvents {
  private readonly stages = new Map<string, boolean>()
  private readonly tools = new Map<string, ManagedPermissionTool>()
  private readonly queuedInputs = new Set<string>()
  private readonly resolvedTools = new Set<string>()
  private latestStatus: 'running' | 'end_turn' | 'requires_action' | 'budget_reached' | 'retries_exhausted' | 'terminated' | null = null
  private kickoffId: string | null = null
  private active = false
  private interruptId: string | null = null
  private interruptProcessed = false
  private stopping = false

  constructor(private readonly maxEvents = 50_000) {}

  get budgetPaused(): boolean { return this.latestStatus === 'budget_reached' }

  /** Resolve relationships across every history page before parking on any one. */
  reconcile(events: ManagedEvent[]): void {
    for (const event of events) {
      if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') this.tools.set(event.id, event)
      if (event.type === 'agent.tool_result') this.resolvedTools.add(event.tool_use_id)
      if (event.type === 'agent.mcp_tool_result') this.resolvedTools.add(event.mcp_tool_use_id)
      if (event.type === 'user.tool_confirmation' && event.processed_at) this.resolvedTools.add(event.tool_use_id)
    }
  }

  baseline(event: ManagedEvent): void {
    if (this.fresh(event)) this.observe(event)
  }

  assertReady(status: string, newlyCreated: boolean): void {
    if (status === 'terminated' || this.latestStatus === 'terminated') {
      throw new Error('This Managed session has terminated. Start a new chat.')
    }
    if (this.latestStatus === 'budget_reached') {
      throw new Error('This Managed session is paused at its remote budget. Review the budget in Claude before continuing.')
    }
    if (this.queuedInputs.size || (!newlyCreated && status !== 'idle') ||
      (this.latestStatus !== null && this.latestStatus !== 'end_turn')) {
      throw new Error('This Managed session still has unfinished work. Resolve it in Claude before continuing.')
    }
  }

  start(id: string): void {
    if (!id || this.kickoffId) throw new Error('The Managed message acknowledgment could not be identified. Its acceptance is uncertain; do not resend it.')
    this.kickoffId = id
  }

  stop(id: string | null): void {
    this.stopping = true
    this.interruptId = id
  }

  accept(event: ManagedEvent): ManagedEffect[] {
    if (!this.fresh(event)) return []
    this.observe(event)
    if (this.stopping) {
      if (event.type === 'user.interrupt' && event.id === this.interruptId && event.processed_at) this.interruptProcessed = true
      if (this.interruptProcessed && (event.type === 'session.status_idle' || event.type === 'session.status_terminated')) {
        return [{ type: 'terminal', reason: 'canceled' }]
      }
      return []
    }
    if (event.type === 'user.message' && event.id === this.kickoffId && event.processed_at) this.active = true
    if (!this.active) return []
    switch (event.type) {
      case 'agent.message': {
        const text = event.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
        return text ? [{ type: 'text', text }] : []
      }
      case 'agent.thinking':
      case 'session.status_running':
      case 'session.status_rescheduled':
        return [{ type: 'progress' }]
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
        return [{ type: 'tool', tool: event }]
      case 'agent.tool_result':
        return [{ type: 'tool_result', id: event.tool_use_id, content: event.content, failed: event.is_error ?? false }]
      case 'agent.mcp_tool_result':
        return [{ type: 'tool_result', id: event.mcp_tool_use_id, content: event.content, failed: event.is_error ?? false }]
      case 'session.error':
        if (event.error.retry_status.type !== 'retrying') throw new Error(`The Managed session failed: ${event.error.message}`)
        return [{ type: 'progress' }]
      case 'session.deleted':
      case 'session.status_terminated':
        throw new Error('The Managed session ended without a completed turn.')
      case 'session.status_idle':
        switch (event.stop_reason.type) {
          case 'end_turn': return [{ type: 'terminal', reason: 'end_turn' }]
          case 'budget_reached': return [{ type: 'terminal', reason: 'budget' }]
          case 'retries_exhausted': throw new Error('The Managed session exhausted its retries.')
          case 'requires_action': {
            const tools = event.stop_reason.event_ids.filter((id) => !this.resolvedTools.has(id)).map((id) => {
              const tool = this.tools.get(id)
              if (!tool || tool.evaluated_permission !== 'ask') {
                throw new Error('This Managed session needs an unsupported tool result or action. Resolve it in Claude.')
              }
              return tool
            })
            if (!event.stop_reason.event_ids.length) throw new Error('The Managed session requested input without identifying its blocking action.')
            return tools.length ? [{ type: 'permissions', tools }] : []
          }
        }
      default: return [] // Child idle, preview deltas and usage do not end or write a turn.
    }
  }

  private fresh(event: ManagedEvent): boolean {
    // Preview deltas have event_id, not a persisted event identity. We request
    // no previews; ignoring them also prevents accidental authoritative text.
    if (!('id' in event) || !event.id) return false
    const processed = 'processed_at' in event && !!event.processed_at
    const previous = this.stages.get(event.id)
    if (previous === true || previous === processed) return false
    if (previous === undefined && this.stages.size >= this.maxEvents) {
      throw new Error('This Managed session exceeds the safe history limit. Start a new chat.')
    }
    this.stages.set(event.id, processed)
    return true
  }

  private observe(event: ManagedEvent): void {
    switch (event.type) {
      case 'user.message':
      case 'user.interrupt':
      case 'user.tool_confirmation':
      case 'user.custom_tool_result':
        if (event.processed_at) this.queuedInputs.delete(event.id)
        else this.queuedInputs.add(event.id)
        break
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': this.tools.set(event.id, event); break
      case 'session.status_idle': this.latestStatus = event.stop_reason.type; break
      case 'session.status_running':
      case 'session.status_rescheduled': this.latestStatus = 'running'; break
      case 'session.deleted':
      case 'session.status_terminated': this.latestStatus = 'terminated'; break
    }
  }
}
