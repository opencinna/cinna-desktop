/**
 * Single source of truth for the communication-pattern decision, shared by the
 * renderer routing flow (`useNewChatFlow.startNewChat`, `CommPatternBadge`) and
 * the main-process job runner (`jobService.executeLocal`). Pure function — no
 * React, no I/O — so it can live in `src/shared`.
 *
 *  - `A2A`: exactly one agent and zero MCPs → the agent is bound as the chat
 *    root and talked to directly over A2A (full per-part fidelity).
 *  - `AI`: anything else (LLM root + ≥1 agent, ≥2 agents, or agents mixed with
 *    MCPs, or zero agents) → the local model orchestrates, calling each
 *    agent/MCP as a tool.
 */
export type CommPattern = 'A2A' | 'AI'

export function derivePattern(agentIds: string[], mcpIds: string[]): CommPattern {
  return agentIds.length === 1 && mcpIds.length === 0 ? 'A2A' : 'AI'
}
