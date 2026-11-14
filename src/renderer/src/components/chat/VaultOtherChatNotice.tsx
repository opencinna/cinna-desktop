import { MessageSquarePlus } from 'lucide-react'
import { SafeIcon } from '../ui/SafeIcon'
import type { AgentReadiness } from '../../../../shared/agentDrivers'
import { NoticeButton } from './ComposerNoticePanel'
import type { ComposerNotice } from './ComposerNoticePanel'

/** Main's sentence, for a `vault_other_chat` answer that came without one. */
const FALLBACK = 'This chat started before its agent moved into its vault. Start a new chat to talk to it.'

/**
 * The composer row for an old chat of an agent that has since moved into its
 * vault: main's `vault_other_chat` on the chat detail (`vaultReadiness`). The
 * chat's words are on this Mac, so the agent never answers there; the row
 * says so and offers **Start new chat** with the agent. Null for every other
 * chat — this answer is per chat and never on the agent list.
 */
export function vaultOtherChatNotice(
  readiness: AgentReadiness | null | undefined,
  onStartNewChat: (() => void) | undefined,
  textId: string
): ComposerNotice | null {
  if (readiness?.state !== 'vault_other_chat') return null
  const text = readiness.reason ?? FALLBACK
  return {
    key: 'vault-other-chat',
    tone: 'warning',
    icon: SafeIcon,
    text,
    textId,
    title: readiness.detail || text,
    action: onStartNewChat ? (
      <NoticeButton onClick={onStartNewChat}>
        <MessageSquarePlus size={12} aria-hidden="true" />
        Start new chat
      </NoticeButton>
    ) : undefined
  }
}
