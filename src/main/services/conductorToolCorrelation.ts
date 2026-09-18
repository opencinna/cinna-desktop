import type { SessionNotification } from '@agentclientprotocol/sdk'

/** Claude carries its id in MCP metadata; other engines correlate by tool name and arrival order. */
export class ConductorToolCorrelation {
  private calls = new Map<string, { name: string; claimed: boolean }>()
  private early = new Map<string, string[]>()

  observe(notification: SessionNotification): boolean {
    const update = notification.update
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false
    if (this.calls.has(update.toolCallId)) return true
    const raw = update.rawInput as {server?: string; tool?: string} | undefined
    const meta = update._meta as {claudeCode?: {toolName?: string}} | undefined
    const label = meta?.claudeCode?.toolName ?? update.title ?? ''
    const name = raw?.server === 'cinna' && typeof raw.tool === 'string' ? raw.tool
      : label.startsWith('mcp__cinna__') ? label.slice('mcp__cinna__'.length)
      : label.startsWith('mcp.cinna.') ? label.slice('mcp.cinna.'.length)
      : label.startsWith('cinna_') ? label.slice('cinna_'.length) : null
    if (!name) return false
    const pending = this.early.get(name)
    const alreadyClaimed = !!pending?.shift()
    this.calls.set(update.toolCallId, { name, claimed: alreadyClaimed })
    if (this.calls.size > 4096) this.calls.delete(this.calls.keys().next().value!)
    return true
  }

  owns(id: string): boolean { return this.calls.has(id) }

  claim(name: string, fallbackId: string, explicit = false): string {
    if (explicit) {
      const call = this.calls.get(fallbackId)
      if (call) call.claimed = true
      else this.calls.set(fallbackId, {name, claimed:true})
      return fallbackId
    }
    for (const [id, call] of this.calls) if (call.name === name && !call.claimed) {
      call.claimed = true
      return id
    }
    const pending = this.early.get(name) ?? []
    pending.push(fallbackId)
    this.early.set(name, pending)
    return fallbackId
  }
}
