import type { RunHandle } from './runExecutionService'

/** Process-local turn ownership. Type-only dependencies keep read views acyclic. */
export const activeRunsByChat = new Map<string, RunHandle>()
