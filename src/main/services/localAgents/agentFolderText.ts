/**
 * What an agent folder's text files say, from their text alone: the filled
 * variable names of `credentials/.env`, each declared credential slot's state,
 * and `STATUS.md`. No filesystem: the scanner reads a folder on this Mac, and
 * a vault agent's details are read from inside its vault
 * (`vault/vaultAgentDetails.ts`), and both parse the same way.
 */
import type { ServiceCredentialDto } from '../../../shared/serviceCredentials'
import { slotEnvPrefix, type CinnaAgentManifest, type CredentialSlot } from '../../../shared/kit/manifest'
import { ACCOUNT_UNAVAILABLE, type LocalAgentCredentialState, type LocalAgentStatusSummary } from '../../../shared/localAgents'
import { parseFrontmatter } from '../../kit/miniYaml'
import { pySplitLines, pyStrip } from './envFile'

/** Local `.env` holding the credential values. Names are read; values never. */
export const ENV_FILE = 'credentials/.env'

/**
 * The variable **names** `credentials/.env` defines with a non-empty value.
 * Values are never returned and never logged (Invariant 4) — only whether a
 * slot is filled reaches the renderer.
 *
 * Emptiness is judged the way the kit's `scripts/cinna_credentials.py` reads
 * the file: the value trimmed, one pair of matching quotes stripped, and the
 * last assignment of a name winning. `KEY=`, `KEY=""` and `KEY=''` are absent —
 * the script skips them, so counting them would call the agent ready and then
 * fail its first run.
 */
export function parseEnvKeysText(text: string): Set<string> {
  const filled = new Map<string, boolean>()
  // `_parse_env_file`, step for step: Python's `splitlines` and `strip`, not JS's.
  for (const raw of pySplitLines(text)) {
    let line = pyStrip(raw)
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue
    if (line.startsWith('export ')) line = pyStrip(line.slice('export '.length))
    const at = line.indexOf('=')
    const key = pyStrip(line.slice(0, at))
    let value = pyStrip(line.slice(at + 1))
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1)
    }
    if (key) filled.set(key, value !== '')
  }
  return new Set([...filled].filter(([, isFilled]) => isFilled).map(([key]) => key))
}

/**
 * The `.env` names a slot expects, `<prefix><FIELD>` upper-cased, under the
 * prefix the kit reads it by (`slotEnvPrefix`: declared, else derived from the
 * name). A slot that declares no `fields` expects no particular name: see
 * `envFilledFor`.
 *
 * An `api_token` slot expects only its token. `api_token_type` and
 * `api_token_template` are the form's header shape, not secrets: absent, the
 * kit's reader sends `Authorization: Bearer <token>`, as Core and the local
 * transform do. Expecting them would hold a bearer slot unready, and Finish
 * setup would ask for both, until the user filled in values nothing needs.
 * A custom header still works: they are read when set.
 */
const OPTIONAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  api_token: ['api_token_type', 'api_token_template']
}
function expectedKeysFor(slot: CredentialSlot, prefix: string | null): string[] {
  let fields = Array.isArray(slot.fields)
    ? slot.fields.filter((f): f is string => typeof f === 'string')
    : []
  const optional = typeof slot.type === 'string' ? OPTIONAL_FIELDS[slot.type] : undefined
  if (optional && fields.length > 0) {
    const kept = fields.filter((f) => !optional.includes(f.toLowerCase()))
    fields = kept.length > 0 ? kept : ['api_token']
  }
  if (prefix === null) return []
  return fields.map((field) => `${prefix}${field.toUpperCase()}`)
}

/**
 * The filled `.env` names a slot counts. With `fields`, the expected ones that
 * are set. Without, every set name under the prefix: the kit's `_local_payload`
 * gathers each `<prefix><anything>` with a non-empty value and is satisfied by
 * one of them.
 */
function presentKeysFor(prefix: string | null, expectedKeys: string[], envKeys: ReadonlySet<string>, fieldless: boolean): string[] {
  if (!fieldless) return expectedKeys.filter((key) => envKeys.has(key))
  if (prefix === null) return []
  return [...envKeys].filter((key) => key.startsWith(prefix)).sort()
}

export function credentialStates(
  manifest: CinnaAgentManifest,
  envKeys: ReadonlySet<string>,
  attached: (ServiceCredentialDto & { state: string })[] = []
): LocalAgentCredentialState[] {
  const slots = Array.isArray(manifest.credentials) ? manifest.credentials : []
  return slots
    .filter((slot): slot is CredentialSlot => slot !== null && typeof slot === 'object')
    .map((slot) => {
      const prefix = slotEnvPrefix(slot)
      const expectedKeys = expectedKeysFor(slot, prefix)
      const fieldless = expectedKeys.length === 0
      const presentKeys = presentKeysFor(prefix, expectedKeys, envKeys, fieldless)
      const optional = slot.optional === true
      // The tiers `serviceCredentials/slotMatch.ts` attaches and offers by; change both together.
      const sameType = attached.filter(c => c.type === slot.type)
      const tiers = (records: typeof sameType) => typeof slot.service_uri === 'string' && slot.service_uri
        ? records.filter(c => c.serviceUri === slot.service_uri)
        : [records.filter(c => c.name === slot.name), records.filter(c => c.serviceUri === slot.name)].find(group => group.length) ?? []
      const envFilled = fieldless ? presentKeys.length > 0 : presentKeys.length === expectedKeys.length
      // A record of an account that cannot supply it now (`account_unavailable`) is never delivered,
      // so it decides nothing over a live attachment or a filled `.env`: the tiers are chosen over
      // live records first, so a held record matching by name never hides a live one matching by
      // Service URI. Alone, it holds the slot: unsatisfied, but not missing, since attaching
      // another would duplicate it.
      const live = tiers(sameType.filter(c => c.state !== ACCOUNT_UNAVAILABLE))
      const held = tiers(sameType.filter(c => c.state === ACCOUNT_UNAVAILABLE))
      const attachment = live.find(c => c.state === 'ready') ?? live[0] ?? (envFilled ? undefined : held[0])
      return {
        name: typeof slot.name === 'string' ? slot.name : '(unnamed)',
        type: typeof slot.type === 'string' ? slot.type : 'unknown',
        optional,
        envPrefix: prefix,
        serviceUri: typeof slot.service_uri === 'string' && slot.service_uri ? slot.service_uri : null,
        expectedKeys,
        presentKeys,
        overlappingKeys: attachment && attachment.state !== ACCOUNT_UNAVAILABLE ? presentKeys : [],
        attachment: attachment ? { credentialId: attachment.id, state: attachment.state } : null,
        // A matching attachment decides; without one, `.env` must hold every
        // expected name, or — for a slot with no `fields` — any name under its
        // prefix. A slot whose name yields no prefix can only be filled by an
        // attachment, so with none it is missing (a warning, not a block).
        satisfied:
          optional || (attachment ? attachment.state === 'ready' : envFilled)
      }
    })
}

/** A `STATUS.md`'s text as the Status card reads it: its frontmatter, else the whole text as the body. */
export function parseStatusText(text: string): LocalAgentStatusSummary {
  const parsed = parseFrontmatter(text)
  if (!parsed) {
    // No frontmatter is fine: the file is still the Status card's body.
    return { summary: null, state: null, updatedAt: null, body: text }
  }
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = parsed.data[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
      if (typeof value === 'number') return String(value)
    }
    return null
  }
  return {
    summary: pick('summary', 'status_summary', 'headline'),
    state: pick('state', 'status', 'health'),
    // `timestamp` is first because it is what the contract's own
    // `scripts/update_status.py` writes (`render_status`, template
    // `scripts/update_status.py:59`) — every STATUS.md a scaffolded agent
    // produces uses that key, and without it the status the desktop shows has
    // no time on it at all. The rest are the synonyms a hand-written file uses.
    updatedAt: pick('timestamp', 'updated', 'updated_at', 'last_updated', 'generated_at'),
    body: parsed.body
  }
}
