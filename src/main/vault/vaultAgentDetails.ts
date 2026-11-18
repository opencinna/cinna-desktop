/**
 * A vault agent's settings-page details, read from inside its vault (hub
 * core, no Electron): the manifest, `STATUS.md`, the three kit prompt
 * documents, the declared credential slots judged against the vault
 * folder's `credentials/.env` names, and the launch settings the vault
 * holds. The folder agent's DTO carries these from a scan of the folder on
 * this Mac; a vault agent's folder is only reachable through
 * {@link VaultFileAccess}, so they are read here, on request, while the vault
 * is unlocked. Read-only: nothing is written back.
 *
 * Parsed by the scanner's own rules (`agentFolderText.ts`), so the two cannot
 * disagree about what a file says. `.env` values never leave this module:
 * only the names that are set.
 */
import { MANIFEST_FILE, type CinnaAgentManifest } from '../../shared/kit/manifest'
import { LOCAL_AGENT_PROMPT_PATHS, type LocalAgentPromptKind } from '../../shared/localAgents'
import type { VaultAgentDetailsDto } from '../../shared/vault/types'
import { ENV_FILE, credentialStates, parseEnvKeysText, parseStatusText } from '../services/localAgents/agentFolderText'
import type { VaultFileAccess } from './fileAccess'
import type { VaultLaunchSettings } from './vaultAgentState'

/** Where a kit agent writes its status (the kit layout's default; a vault agent has no workshop layout here). */
export const VAULT_STATUS_FILE = 'app-data/storage/STATUS.md'

/** Each file is read up to this much; a manifest or prompt past it is not one a card shows whole anyway. */
const READ_MAX = 512 * 1024

export interface VaultAgentDetailsDeps {
  files: VaultFileAccess
  vaultId: string
  /** The vault's `cinna.launch` (rejects as the vault does, e.g. `locked`). */
  launch: () => Promise<VaultLaunchSettings>
}

/** A refusal that means "no such file here", as vaultd and the backends word it. */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'not_found' || code === 'invalid'
}

/**
 * One agent-relative file's text, or null when the folder has none. The
 * vault answers with the path it really opened; one that is not the path
 * asked for (a link to elsewhere in the folder) counts as absent, so no
 * other file's bytes are shown under this one's name. Any other refusal
 * (`locked`, …) is the caller's.
 */
async function readText(deps: VaultAgentDetailsDeps, relPath: string): Promise<string | null> {
  try {
    const read = await deps.files.read(deps.vaultId, relPath, { maxBytes: READ_MAX })
    if (read.rel !== relPath) return null
    return read.bytes.toString('utf8')
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

function parseManifest(text: string | null): CinnaAgentManifest {
  if (text === null) return {}
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as CinnaAgentManifest) : {}
  } catch {
    return {}
  }
}

const PROMPTS = Object.keys(LOCAL_AGENT_PROMPT_PATHS) as LocalAgentPromptKind[]

export async function readVaultAgentDetails(deps: VaultAgentDetailsDeps): Promise<VaultAgentDetailsDto> {
  const [manifestText, statusText, envText, launch, ...docTexts] = await Promise.all([
    readText(deps, MANIFEST_FILE),
    readText(deps, VAULT_STATUS_FILE),
    readText(deps, ENV_FILE),
    deps.launch(),
    ...PROMPTS.map((prompt) => readText(deps, LOCAL_AGENT_PROMPT_PATHS[prompt]))
  ])
  const manifest = parseManifest(manifestText)
  const docs = Object.fromEntries(
    PROMPTS.map((prompt, at) => {
      const text = docTexts[at] as string | null
      return [prompt, text === null ? null : { relPath: LOCAL_AGENT_PROMPT_PATHS[prompt], text }]
    })
  ) as VaultAgentDetailsDto['docs']
  return {
    manifest,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    status: statusText === null ? null : parseStatusText(statusText),
    docs,
    // Names only: the text is dropped here. Attachments captured at move-in
    // are not judged (a vault agent has no host attachments to look up).
    credentials: credentialStates(manifest, envText === null ? new Set() : parseEnvKeysText(envText)),
    launch: { kind: launch.kind, model: launch.model, approval: launch.approval }
  }
}
