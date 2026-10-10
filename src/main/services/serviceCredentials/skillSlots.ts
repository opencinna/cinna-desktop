/**
 * Credential slots a kit agent's skills declare (catalog U11), apart from the
 * agent's own manifest slots.
 *
 * A skill names its credential by **slot**, which is a Service URI, and finds
 * it at run time with Core's `credentials.require_slot(slot)` (the
 * `core.cinna_api` shim under `resources/skill-runtime`). So the match is
 * strict: an attached record fills a skill slot only when its `type` is the
 * slot's type **and** its Service URI is the slot, exactly — no name
 * fallback, unlike an agent slot without `service_uri`.
 *
 * Skill slots never block the agent or a turn, as in Core: a missing one is a
 * warning, and the script fails at call time with a sentence naming the slot.
 *
 * Pure: skill rows and attachment metadata in, states out. No values.
 */
import type { LocalAgentSkill, LocalAgentSkillCredential } from '../../../shared/localAgents'
import type { ServiceCredentialDto } from '../../../shared/serviceCredentials'
import type { SlotSpec } from './slotMatch'

/** One `(slot, type)` the agent's deliverable skills declare. */
export interface SkillSlot {
  slot: string
  type: string
  /** The declaring skills, in row order. */
  skills: string[]
  description: string | null
  /** The pinned catalog revisions among the declaring skills, for `provision-local`. */
  catalog: { packageUuid: string; revisionNumber: number }[]
}

/** Attachment metadata as `serviceCredentialService.metadataForPath` answers it. */
export type AttachedMetadata = Pick<ServiceCredentialDto, 'id' | 'type' | 'serviceUri'> & { state: string }

/**
 * Every slot the agent's **deliverable** skills declare, own and catalog, one
 * entry per `(slot, type)` in first-seen order. A skill that is not given to
 * any engine needs no credential.
 */
export function collectSkillSlots(skills: readonly LocalAgentSkill[] | undefined): SkillSlot[] {
  const out = new Map<string, SkillSlot>()
  for (const skill of skills ?? []) {
    if (!skill.deliverable) continue
    for (const declared of skill.credentials) {
      const key = `${declared.type}\n${declared.slot}`
      let entry = out.get(key)
      if (!entry) {
        entry = { slot: declared.slot, type: declared.type, skills: [], description: declared.description, catalog: [] }
        out.set(key, entry)
      }
      if (!entry.skills.includes(skill.name)) entry.skills.push(skill.name)
      if (entry.description === null) entry.description = declared.description
      if (skill.source === 'catalog' && skill.packageUuid && typeof skill.revisionNumber === 'number'
        && !entry.catalog.some((c) => c.packageUuid === skill.packageUuid && c.revisionNumber === skill.revisionNumber)) {
        entry.catalog.push({ packageUuid: skill.packageUuid, revisionNumber: skill.revisionNumber })
      }
    }
  }
  return [...out.values()]
}

/** The skill slot as `slotMatch` takes it: its Service URI is the slot, so only the strict tier applies. */
export function skillSlotSpec(slot: Pick<LocalAgentSkillCredential, 'slot' | 'type'>): SlotSpec {
  return { name: slot.slot, type: slot.type, serviceUri: slot.slot }
}

/** Whether an attached record fills the slot's `(type, service_uri)` exactly. */
export function strictlyMatches(slot: Pick<LocalAgentSkillCredential, 'slot' | 'type'>, record: Pick<ServiceCredentialDto, 'type' | 'serviceUri'>): boolean {
  return record.type === slot.type && record.serviceUri === slot.slot
}

/**
 * How the attachments judge one skill slot: the strictly matching attachment
 * (a ready one first), whether it fills the slot, and an attachment with the
 * slot's Service URI but another type — which `by_slot` would find and which
 * does not fit.
 */
export function judgeSkillSlot<T extends AttachedMetadata>(
  slot: Pick<LocalAgentSkillCredential, 'slot' | 'type'>,
  attached: readonly T[]
): { attachment: T | null; filled: boolean; typeMismatch: T | null } {
  const matching = attached.filter((record) => strictlyMatches(slot, record))
  const attachment = matching.find((record) => record.state === 'ready') ?? matching[0] ?? null
  const typeMismatch = matching.length === 0 ? attached.find((record) => record.serviceUri === slot.slot) ?? null : null
  return { attachment, filled: attachment?.state === 'ready', typeMismatch }
}

/**
 * Whether the user already chose something for this slot: any attachment
 * with its Service URI, ready or not, of its type or not. Auto-attach then
 * leaves the slot alone — it never adds a second record beside the user's
 * choice, and never replaces it.
 */
export function slotClaimed(slot: Pick<LocalAgentSkillCredential, 'slot'>, attached: readonly Pick<ServiceCredentialDto, 'serviceUri'>[]): boolean {
  return attached.some((record) => record.serviceUri === slot.slot)
}

/** The skill rows with each declared slot judged against the attachments (the scan's `filled`). */
export function judgeSkillRows(skills: LocalAgentSkill[], attached: readonly AttachedMetadata[]): LocalAgentSkill[] {
  for (const skill of skills) {
    skill.credentials = skill.credentials.map((declared) => {
      const { attachment, filled } = judgeSkillSlot(declared, attached)
      return { ...declared, filled, attachment: attachment ? { credentialId: attachment.id, state: attachment.state } : null }
    })
  }
  return skills
}
