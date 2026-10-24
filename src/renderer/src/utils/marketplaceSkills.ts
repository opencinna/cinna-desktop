/**
 * Marketplace skills: the words the Addons tab's marketplace rows and the
 * addon picker use. Core sends unsupported reasons as
 * codes; the sentences are the renderer's.
 */

const UNSUPPORTED_SENTENCES: Record<string, string> = {
  no_skill_md: 'This skill has no valid SKILL.md, so there is nothing to add.',
  unsafe_path: 'This skill points outside its repository, so it cannot be fetched safely.',
  too_large: 'This skill is larger than 16 MB, so it cannot be added.'
}

/** An unsupported entry's reason as a sentence; a code this build does not know gets the generic one. */
export function unsupportedSentence(reason: string | null): string {
  return (reason && UNSUPPORTED_SENTENCES[reason]) || 'This skill cannot be added from its marketplace.'
}

export const MARKETPLACE_SKILL_TEXT = {
  openRepository: 'Open the source repository',
  openRepositoryLabel: (skill: string) => `Open the source of ${skill}`,
  /** The Addons row's badge. */
  from: (marketplace: string) => (marketplace ? `From ${marketplace}` : 'From a marketplace'),
  fromTitle: (marketplace: string) => (marketplace ? `Pinned from the ${marketplace} marketplace` : 'Pinned from a skills marketplace'),
  version: (version: string) => `Version ${version}`,
  updateTo: (skill: string, version: string | null | undefined) =>
    version ? `Update ${skill} to version ${version}` : `Update ${skill} to the marketplace’s latest copy`,
  unavailable: 'No longer available to you',
  removeConfirm: (skill: string) =>
    `Remove ${skill} from this agent? It stays in its marketplace; you can add it again. ${skill} stops being available to this agent in new chats.`
} as const
