import { chatRepo, type ChatRow } from '../db/chats'
import { appSettingsRepo } from '../db/appSettings'
import { chatFileRepo, type ChatFileRow } from '../db/chatFiles'
import { DEFAULT_USER_ID } from '../../shared/userIds'
import { getProfileScopeUserId } from './scope'

/**
 * Which profiles' chats a profile sees, and who owns a given chat.
 *
 * A chat belongs to one user id. With `showLocalDataInAllProfiles` on (the
 * default), chats owned by the default (guest) profile — chats made while
 * signed out, and chats with local agents or chat modes — are also listed and
 * usable in every other profile. The default profile only ever sees its own.
 * With the setting off each profile sees exactly the chats it owns.
 *
 * Kept apart from `scope.ts` because these read the database; `scope.ts` is
 * the session-only answer many modules (and their test doubles) depend on.
 *
 * Only the chat is shared: tasks, delegations, handovers and Inbox rows made
 * from a default-owned chat keep the active profile's id. Callers that ask
 * "is this still the same profile" compare profiles, never chat owners.
 */

export function localDataInAllProfiles(): boolean {
  return appSettingsRepo.get('showLocalDataInAllProfiles') !== false
}

/** The owners whose chats `profileUserId` sees, its own first. */
export function chatScopesFor(profileUserId: string): string[] {
  if (profileUserId === DEFAULT_USER_ID || !localDataInAllProfiles()) return [profileUserId]
  return [profileUserId, DEFAULT_USER_ID]
}

/** {@link chatScopesFor} the active profile. */
export function getChatScopes(): string[] {
  return chatScopesFor(getProfileScopeUserId())
}

/**
 * The chat row, when `profileUserId` can see it: its own, or — with the
 * setting on — one the default profile owns (live or trashed). One read for a
 * chat the profile owns, which is the common path; the setting is read only
 * for a chat it does not.
 */
export function visibleChat(profileUserId: string, chatId: string): ChatRow | undefined {
  const own = chatRepo.getOwned(profileUserId, chatId)
  if (own || profileUserId === DEFAULT_USER_ID || typeof chatId !== 'string') return own
  const shared = chatRepo.getOwned(DEFAULT_USER_ID, chatId)
  return shared && localDataInAllProfiles() ? shared : undefined
}

/**
 * The owner of a chat {@link visibleChat} returned for `profileUserId`: the
 * default profile for a shared chat, else the profile itself.
 */
export function ownerOfVisible(profileUserId: string, chat: Pick<ChatRow, 'userId'>): string {
  return chat.userId === DEFAULT_USER_ID ? DEFAULT_USER_ID : profileUserId
}

/**
 * The owner of `chatId` as `profileUserId` sees it: the profile itself, or the
 * default profile for a shared chat. A chat found nowhere resolves to the
 * profile, so a not-found stays a not-found for every caller.
 */
export function chatOwnerFor(profileUserId: string, chatId: string): string {
  const chat = visibleChat(profileUserId, chatId)
  return chat ? ownerOfVisible(profileUserId, chat) : profileUserId
}

/** {@link chatOwnerFor} the active profile. */
export function resolveChatOwner(chatId: string): string {
  return chatOwnerFor(getProfileScopeUserId(), chatId)
}

/**
 * A local attachment row, when `profileUserId` can see it. A file is stored
 * under its chat's owner (`files/<owner>/<chatId>`), so an attachment in a
 * chat shared across profiles is the default profile's row.
 */
export function visibleChatFile(profileUserId: string, fileId: string): ChatFileRow | undefined {
  const own = chatFileRepo.getOwned(profileUserId, fileId)
  if (own || profileUserId === DEFAULT_USER_ID) return own
  const shared = chatFileRepo.getOwned(DEFAULT_USER_ID, fileId)
  return shared && chatOwnerFor(profileUserId, shared.chatId) === DEFAULT_USER_ID ? shared : undefined
}
