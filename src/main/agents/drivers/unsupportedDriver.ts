import type { AgentDriver, AgentCapabilities, AgentReadiness } from './driver'

export function unsupportedCapabilities(): AgentCapabilities {
  return { streaming: false, cancel: false, sessions: 'none',
    input: { permission: false, question: false, auth: false, elicitation: false },
    inputResume: 'reply', attachments: 'none', auth: 'none', commands: 'none',
    mcpInjection: false, cwd: false }
}

export function unsupportedReadiness(): AgentReadiness {
  return { state: 'invalid', reason: 'This agent does not name a driver supported by this version of Cinna.' }
}

/** Keep future/malformed rows visible, but never run them through another transport. */
export const unsupportedDriver: AgentDriver = {
  id: 'unsupported',
  capabilities: unsupportedCapabilities,
  readiness: async () => unsupportedReadiness(),
  run: async (_userId, _agent, input) => input.signal.aborted
    ? { text: '', parts: [], notices: [], taskState: 'canceled' }
    : { text: '', parts: [], notices: [], error: { message: unsupportedReadiness().reason!, raw: 'Unsupported agent driver', code: 'unsupported_driver' } },
  respond: () => ({ delivered: false })
}
