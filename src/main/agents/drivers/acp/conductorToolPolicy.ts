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
    if (plan.conductorPolicy === 'no-native-tools') return plan
    throw new Error('Codex chat policy was not verified. Choose Claude or OpenCode, or check the installed Codex runtime.')
  }
  // OpenCode's generated agent entry already carries permission {'*':'deny'};
  // its caller owns generation, because the file participates in the spec key.
  return plan
}
