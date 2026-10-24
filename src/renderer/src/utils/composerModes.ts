import type { ChatModeData } from '../constants/chatModeColors'
import { isRuntimeModeActive, RUNTIME_MODE_ENGINES } from '../../../shared/chatModeRuntime'

/** The composer's group heading for runtime modes. */
export const RUNTIMES_GROUP = 'Runtimes'
/** …and for every other mode, shown only below a Runtimes group. */
export const SAVED_GROUP = 'Saved modes'

/**
 * The modes the composer offers (`[+]` → Chat mode, and `~`): runtime modes
 * first, in the runtime cards' order, and only those whose runtime can start a
 * chat — an inactive one is absent rather than disabled, since its fix lives in
 * Settings. Then the saved and account modes, without the ones switched off.
 */
export function composerModes(modes: readonly ChatModeData[]): ChatModeData[] {
  const runtimes = RUNTIME_MODE_ENGINES.flatMap((engine) =>
    modes.filter((mode) => mode.builtinEngine === engine && mode.runtime && isRuntimeModeActive(mode.runtime.availability)))
  const others = modes.filter((mode) => !mode.builtinEngine && mode.enabled !== false)
  return [...runtimes, ...others]
}

/** The group a listed mode belongs to; null when the list has no runtime modes to set it apart from. */
export function composerModeGroup(mode: ChatModeData, list: readonly ChatModeData[]): string | null {
  if (!list.some((candidate) => candidate.builtinEngine)) return null
  return mode.builtinEngine ? RUNTIMES_GROUP : SAVED_GROUP
}
