import type { AgentEngine } from './engine'

/** Chat profiles never grant filesystem or shell tools. */
export type ChatToolPolicy = 'none' | 'connectors'

export interface ChatModeRuntime {
  /** Null inherits this device's Default runtime. */
  engine?: AgentEngine | null
  /** The existing providerId is the runtime credential binding. */
  systemPrompt?: string
  toolPolicy?: ChatToolPolicy
}
