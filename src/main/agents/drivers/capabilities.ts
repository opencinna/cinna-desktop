/**
 * What each driver can do, answered from the row alone.
 *
 * Pure and import-light on purpose: `agentService` maps it into every agent
 * DTO, so it may not pull the drivers' production wiring (`index.ts`) into the
 * service layer, and it must answer the same thing for the same row every time
 * — a capability that changed between the list and the send would put the
 * composer and the turn into disagreement.
 *
 * This is one of the files a kind branch is allowed in (`kindBranches.test.ts`
 * allowlists the drivers folder): the whole point is that the branch happens
 * here, once, instead of at every call site that used to ask.
 */
import type { AgentRow } from '../../db/agents'
import type { AgentCapabilities } from '../../../shared/agentDrivers'
import { driverOfRow, launcherOfRow } from './driverOf'
import { unsupportedCapabilities } from './unsupportedDriver'

type CapabilityRow = Pick<
  AgentRow,
  'driver' | 'driverConfig' | 'source' | 'accessTokenEncrypted'
>

export function capabilitiesFor(agent: CapabilityRow): AgentCapabilities {
  switch (driverOfRow(agent)) {
    case null: return unsupportedCapabilities()
    case 'acp':
      return acpCapabilities(launcherOfRow(agent))
    case 'a2a': {
      const synced = agent.source === 'remote'
      return {
        streaming: true,
        cancel: true,
        sessions: 'context',
        // A2A ends the turn to ask, as a question or as an auth demand, and
        // the answer is the user's next message.
        input: { permission: false, question: true, auth: true, elicitation: false },
        inputResume: 'next_message',
        // **Only a Cinna-synced agent takes a file.** Its bytes go to the Cinna
        // backend and the message carries the id; a hand-added A2A agent has
        // no such backend behind it, so the composer offers no attach at all.
        attachments: synced ? 'cinna' : 'none',
        // A synced agent authenticates with the account's Cinna JWT, so a
        // 401/403 there means the session is gone and the user can re-auth; a
        // hand-added agent's token is one the user typed, and a rejection is
        // just a wrong token.
        auth: synced ? 'cinna' : agent.accessTokenEncrypted ? 'token' : 'none',
        commands: 'card',
        mcpInjection: false,
        cwd: false
      }
    }
  }
}

/**
 * One driver, and still two answers — because a capability is about what the
 * *engine* behind the protocol can do, not about the protocol.
 *
 * The two differences are both measured, and both move in the opposite
 * direction to what a transport change would suggest:
 *
 * - **Questions.** Claude *gains* them: the ACP adapter enables its
 *   `AskUserQuestion` tool when the client declares `elicitation.form`, which
 *   the launcher does. OpenCode *loses* them: its `question` tool is not
 *   registered under `OPENCODE_CLIENT=acp`, and its ACP layer bridges no
 *   question to `elicitation/create` at all — so the model asks in prose. See
 *   the Q3 verdict in the phase 3 plan.
 * - **Auth.** Claude's turn is paid for by the user's own CLI login, so the
 *   desktop holds no credential for it; OpenCode's is paid for by a credential
 *   in Settings, which is not an auth state a user is ever asked about here.
 *
 * A launcher this build has no implementation for (`gemini`, `codex` before
 * their step) is described as a CLI-authenticated agent with no question path.
 * Both of those are true of them as far as anything here has measured, and the
 * driver refuses such a turn in words either way — a capability answer that
 * pretended otherwise would put the composer and the turn into disagreement.
 */
function acpCapabilities(launcher: string): AgentCapabilities {
  return {
    ...folderCapabilities(),
    input: {
      permission: true,
      // **Claude alone**, because Claude alone is measured: its adapter enables
      // `AskUserQuestion` when the client declares `elicitation.form`. OpenCode
      // registers no question tool under ACP at all, and whether Gemini CLI or
      // Codex bridge one is not something this build has run — claiming a path
      // that turns out not to exist would have the composer offer an answer
      // widget for an ask that never arrives.
      question: launcher === 'claude',
      auth: false,
      // The desktop renders an elicitation *as* a question — one widget, one
      // answer path — so nothing downstream needs a fourth ask kind to
      // distinguish it.
      elicitation: false
    },
    auth: launcher === 'opencode' ? 'none' : 'cli'
  }
}

function folderCapabilities(): Omit<AgentCapabilities, 'input' | 'auth'> {
  return {
    streaming: true,
    cancel: true,
    // The desktop remembers the engine session per chat and reopens it.
    sessions: 'resumable',
    // Parked on the ask, answered while the turn is still open.
    inputResume: 'reply',
    attachments: 'none',
    // `docs/CLI_COMMANDS.yaml`, run on this machine as `/run:<name>`.
    commands: 'catalog',
    mcpInjection: false,
    cwd: true
  }
}

/**
 * Whether a row carries what its driver needs before a turn can even be tried.
 *
 * An A2A agent is reached through its card, so a row with no card URL cannot
 * run; a folder agent legitimately has none (`cardUrl: null` at insert). This
 * used to be `!isFolderAgent(row) && !row.cardUrl` at each call site — and
 * before that a bare `!row.cardUrl`, which skipped every folder agent.
 */
export function hasRunConfig(agent: Pick<AgentRow, 'driver' | 'source' | 'cardUrl'>): boolean {
  const driver = driverOfRow(agent)
  return driver !== null && (driver !== 'a2a' || !!agent.cardUrl)
}
