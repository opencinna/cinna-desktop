import type { AgentEngine } from '../../../../shared/engine'
import type { AcpLaunchPlan } from './acpLaunchers'

/** Restrict native coding tools before starting a plain-chat/utility session. */
export function applyConductorToolPolicy(plan: AcpLaunchPlan, engine: AgentEngine): AcpLaunchPlan {
  if (engine === 'claude') {
    const meta = plan.session.meta ?? {}
    const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined
    return { ...plan, session: { ...plan.session, meta: { ...meta, claudeCode: {
      ...claude, options: { ...claude?.options, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, agents: {} }
    } } } }
  }
  if (engine === 'codex') {
    // Verified against codex-acp 1.11: its "read-only" mode sends
    // sandboxPolicy.workspaceWrite on every turn/start, overriding config.
    // Codex also selects apply_patch and optional native read tools from its
    // model catalogue independently of shell_tool. Flags cannot establish the
    // no-file-tools policy; never silently run a coding session as plain chat.
    throw new Error('Codex cannot enforce this chat’s no-file-tools policy yet. Choose Claude or OpenCode as the default runtime, or choose an AI Functions credential in Settings → Features.')
  }
  // OpenCode's generated agent entry already carries permission {'*':'deny'};
  // its caller owns generation, because the file participates in the spec key.
  return plan
}
