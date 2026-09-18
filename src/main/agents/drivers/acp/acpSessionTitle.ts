/**
 * A thread that names itself: the title an engine reports for a chat's own
 * session, offered to the chat.
 *
 * Codex titles its thread over `session_info_update { title }`, twice: first a
 * **placeholder** that is the prompt text verbatim, then the title its own
 * model generated (contract entry `codex.session.info-title`; fixtures
 * `codex/subagent.json`, `codex/async_task_stop.json`). A chat whose root
 * session runs on Codex takes that second one as its title, in place of
 * Cinna's own AI title — see `chatTitleService.applyEngineTitle` for when it
 * may replace what the chat is called.
 *
 * Only the chat's **root** session: the one a chat's turn prompts, not a
 * specialist's nested session, not a subagent's child session, not an AI
 * function's utility session (those never come through the driver's turns).
 * Claude sends the same update and is deliberately left out: its titles are
 * not what this chat is named after, and nothing about that changed here.
 *
 * No Electron and no services: the driver hands the title to a sink it was
 * given (`AcpDriverDeps.sessionTitle`), as it does every other fact the rest
 * of the app acts on.
 */

import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentRow } from '../../../db/agents'
import { driverOfRow, launcherOfRow } from '../driverOf'
import type { AcpLauncherId } from './types'

/** The engines whose own thread title names the chat. */
const TITLES_THE_CHAT: ReadonlySet<AcpLauncherId> = new Set<AcpLauncherId>(['codex'])

/** Whether a launcher's session titles name the chat it answers. */
export function engineTitlesChat(launcher: AcpLauncherId | null | undefined): boolean {
  return launcher != null && TITLES_THE_CHAT.has(launcher)
}

/**
 * Whether a chat answered by this agent is named by the agent's engine rather
 * than by Cinna's AI title — asked by the send path before the turn, so from
 * the row: `driver_config.launcher`, which a chat-owned runtime is created
 * with and a folder agent's row caches from its folder.
 */
export function agentTitlesChat(agent: Pick<AgentRow, 'driver' | 'driverConfig'>): boolean {
  return driverOfRow(agent) === 'acp' && agent.driverConfig?.transport !== 'websocket' && engineTitlesChat(launcherOfRow(agent))
}

/** Where an accepted title goes. */
export type SessionTitleSink = (input: { profileUserId: string; chatId: string; agentId: string; title: string }) => void

/** Whose session an update is from, as far as titles care. */
export interface SessionTitleScope {
  launcherId: AcpLauncherId
  chatId: string
  agentId: string
  /** The chat's root session — the only one whose title is the chat's. */
  sessionId: string
  /** The profile the chat belongs to. Absent: a turn with no chat of its own, which names nothing. */
  profileUserId?: string
}

/** The title an update carries, or null. */
export function sessionInfoTitle(notification: SessionNotification): string | null {
  const update = notification?.update as { sessionUpdate?: unknown; title?: unknown } | undefined
  if (update?.sessionUpdate !== 'session_info_update') return null
  return typeof update.title === 'string' && update.title.trim() !== '' ? update.title : null
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Longer than any title Codex generates for a thread. A title this long that
 * the prompt starts with is the prompt cut short, not a name.
 */
const GENERATED_TITLE_MAX = 40

/**
 * Whether a title is only the prompt echoed back: equal to one of the prompts
 * sent, or a long cut of one (whitespace-normalized either way). A short title
 * the prompt merely starts with — "Fix flaky parser test" for "Fix flaky
 * parser test and add coverage" — is a real name.
 */
export function isPromptPlaceholder(title: string, prompts: readonly string[]): boolean {
  const wanted = normalize(title)
  if (!wanted) return true
  return prompts.some((prompt) => {
    const sent = normalize(prompt)
    return sent === wanted || (wanted.length > GENERATED_TITLE_MAX && sent.startsWith(wanted))
  })
}

/** How many prompts per session, and sessions, are kept to recognise a placeholder by. */
const PROMPTS_PER_SESSION = 4
const SESSIONS_KEPT = 200

export interface SessionTitles {
  /** A prompt about to go to a session whose title may name a chat. */
  prompted(scope: SessionTitleScope, prompt: readonly ContentBlock[]): void
  /** One update heard on a session, in a turn or between turns. */
  observe(scope: SessionTitleScope, notification: SessionNotification): void
}

export function createSessionTitles(sink: SessionTitleSink | undefined): SessionTitles {
  /** Session id → the prompt texts recently sent to it, oldest first. Insertion order is the eviction order. */
  const prompts = new Map<string, string[]>()
  const applies = (scope: SessionTitleScope): scope is SessionTitleScope & { profileUserId: string } =>
    sink !== undefined && scope.profileUserId !== undefined && engineTitlesChat(scope.launcherId)
  return {
    prompted(scope, prompt) {
      if (!applies(scope)) return
      const texts = prompt.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      if (texts.length === 0) return
      // Every block on its own and all of them together: which of those the
      // engine echoes is its business, and each is a prompt it was sent.
      const next = [...(prompts.get(scope.sessionId) ?? []), ...texts, ...(texts.length > 1 ? [texts.join('\n')] : [])]
      prompts.delete(scope.sessionId)
      prompts.set(scope.sessionId, next.slice(-PROMPTS_PER_SESSION * 3))
      while (prompts.size > SESSIONS_KEPT) prompts.delete(prompts.keys().next().value as string)
    },
    observe(scope, notification) {
      if (!applies(scope)) return
      // A subagent's child session reports its own title under its own id.
      if (notification.sessionId !== scope.sessionId) return
      const title = sessionInfoTitle(notification)
      // A session this process never prompted (loaded after a restart) has no
      // prompt to tell its placeholder by, and it was titled long ago anyway.
      const sent = prompts.get(scope.sessionId)
      if (title === null || !sent || isPromptPlaceholder(title, sent)) return
      sink!({ profileUserId: scope.profileUserId, chatId: scope.chatId, agentId: scope.agentId, title })
    }
  }
}
