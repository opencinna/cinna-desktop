/**
 * **Whether a runtime mode can start a chat**, from what main already knows.
 *
 * Built for a list that is read on every visit (`chatmode:list`), so it must
 * never start setup: no download, no login, and no login probe. `peek` is the
 * setup service's own look; it never downloads, but it may run one
 * `--version` on a copy of the CLI the user installed themselves (on PATH) to
 * see whether it is the pinned version. A "not logged in" is reported only
 * when a probe some other surface ran already said so.
 *
 * - Claude / Codex / Antigravity: the pinned binary's state. On disk is
 *   `ready`, or `needs_login` when the last kept login answer is `logged_out`.
 *   Login is otherwise checked when a chat starts, as for every chat.
 * - OpenCode: `ready` when a usable AI credential exists (the binary is fetched
 *   on first use and needs no gesture), else `needs_credential`. "Usable" is
 *   `firstActiveCredential`, the credential a chat with none chosen runs on.
 */

import { firstActiveCredential, type UsableCredential } from '../../../shared/credentials'
import type { ChatModeRuntimeStatus, RuntimeModeAvailability } from '../../../shared/chatModeRuntime'
import {
  isEngineLoginId,
  type AgentEngine,
  type EngineBinaryState,
  type EngineLoginId,
  type RuntimeSetupRunning
} from '../../../shared/engine'
import { antigravityAuthProbe, claudeAuthProbe, codexAuthProbe } from '../../agents/drivers'
import { antigravityBinaryService, claudeBinaryService, codexBinaryService } from '../../engine/engineBinaryService'
import { providerService } from '../providerService'
import { chatModeService, type ChatModeListItem } from '../chatModeService'
import { getSettingsScopeUserId } from '../../auth/scope'
import { runtimeSetupService } from './runtimeSetupService'

export interface RuntimeModeAvailabilityDeps {
  /** The binary's state after a look that never downloads. */
  peek(engine: EngineLoginId): Promise<EngineBinaryState>
  /** Which engines a setup run is in, and in which phase. */
  running(): RuntimeSetupRunning
  /** The login probe's last kept answer, or null — must never ask. */
  lastKnownAuth(engine: EngineLoginId): string | null
  /** AI credentials as the renderer lists them. */
  providers(): readonly (UsableCredential & { enabled: boolean })[]
}

export function createRuntimeModeAvailability(deps: RuntimeModeAvailabilityDeps): (engine: AgentEngine) => Promise<RuntimeModeAvailability> {
  return async (engine) => {
    if (!isEngineLoginId(engine)) {
      return firstActiveCredential(deps.providers()) ? 'ready' : 'needs_credential'
    }
    if (deps.running()[engine] === 'installing') return 'installing'
    const binary = await deps.peek(engine).catch((): EngineBinaryState => ({ state: 'failed', error: 'Could not look for the runtime.' }))
    if (binary.state === 'resolving') return 'installing'
    if (binary.state === 'failed') return 'install_failed'
    if (binary.state === 'unresolved') return 'needs_install'
    return deps.lastKnownAuth(engine) === 'logged_out' ? 'needs_login' : 'ready'
  }
}

const BINARY: Record<EngineLoginId, { peek(): Promise<EngineBinaryState> }> = {
  claude: claudeBinaryService,
  codex: codexBinaryService,
  antigravity: antigravityBinaryService
}

const AUTH: Record<EngineLoginId, { lastKnown(): { state: string } | null }> = {
  claude: claudeAuthProbe,
  codex: codexAuthProbe,
  antigravity: antigravityAuthProbe
}

export const runtimeModeAvailability = createRuntimeModeAvailability({
  peek: (engine) => BINARY[engine].peek(),
  running: () => runtimeSetupService.running(),
  lastKnownAuth: (engine) => AUTH[engine].lastKnown()?.state ?? null,
  providers: () => providerService.listMerged()
})

export type ChatModeListEntry = ChatModeListItem & { runtime?: ChatModeRuntimeStatus }

/**
 * `chatmode:list`: the merged mode list, after making sure the user's runtime
 * modes exist (they live in the Default scope with the other local modes),
 * with each runtime mode's availability attached.
 */
export async function listChatModesWithRuntimes(
  availability: (engine: AgentEngine) => Promise<RuntimeModeAvailability> = runtimeModeAvailability
): Promise<ChatModeListEntry[]> {
  chatModeService.ensureRuntimeModes(getSettingsScopeUserId())
  const items = chatModeService.listMerged()
  const engines = [...new Set(items.flatMap((item) => (item.builtinEngine && !item.managed ? [item.builtinEngine] : [])))]
  const known = new Map(await Promise.all(engines.map(async (engine) => [engine, await availability(engine)] as const)))
  return items.map((item) => {
    const state = item.builtinEngine && !item.managed ? known.get(item.builtinEngine) : undefined
    return state && item.builtinEngine ? { ...item, runtime: { engine: item.builtinEngine, availability: state } } : item
  })
}
