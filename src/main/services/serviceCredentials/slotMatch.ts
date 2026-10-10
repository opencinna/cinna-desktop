/**
 * Which cloud credential records fit a manifest credential slot.
 *
 * The tiers are the scanner's (`credentialStates` in `scannerService`), which
 * decides whether an attachment satisfies a slot — so nothing is ever attached
 * or offered that readiness would not then count:
 *
 * 1. a slot with a `service_uri` takes records with that `serviceUri`;
 * 2. a slot without one takes records named like the slot, then records whose
 *    `serviceUri` is the slot's name.
 *
 * Within a tier, records the user owns come before records shared with them —
 * a tie-break among records the scanner would count anyway. Those are the
 * sub-tiers, in order; the first non-empty one is the match, and it is only a
 * *safe* match when it holds exactly one record. Two or more, and the user
 * picks. Change the tiers here and in the scanner together.
 *
 * Pure: metadata in, metadata out. No values are ever seen here.
 */
import { AGENT_API_KEY_PAUSED_STATUSES, type ServiceCredentialDto } from '../../../shared/serviceCredentials'

export interface SlotSpec {
  name: string
  type: string
  serviceUri?: string | null
}

type Record_ = Pick<ServiceCredentialDto, 'name' | 'type' | 'serviceUri' | 'relation' | 'localUseAllowed' | 'keyStatus'>

/** Revoked, removed, expired or unknown issued key: no use attaching it. Paused keys recover. */
export function isDeadKey(m: Pick<ServiceCredentialDto, 'type' | 'keyStatus'>): boolean {
  return m.type === 'agent_api' && m.keyStatus !== 'active' && !AGENT_API_KEY_PAUSED_STATUSES.includes(m.keyStatus ?? '')
}

/** A record this computer may use for this slot at all: same type, local use allowed, not a dead issued key. */
export function fitsSlot(slot: SlotSpec, m: Record_): boolean {
  return m.type === slot.type && m.localUseAllowed && !isDeadKey(m)
}

/** The sub-tiers, in order, of the records that fit; empty sub-tiers included. */
export function slotTiers<T extends Record_>(slot: SlotSpec, records: T[]): T[][] {
  const fit = records.filter((m) => fitsSlot(slot, m))
  const split = (group: T[]): T[][] => [group.filter((m) => m.relation === 'owned'), group.filter((m) => m.relation !== 'owned')]
  if (slot.serviceUri) return split(fit.filter((m) => m.serviceUri === slot.serviceUri))
  return [...split(fit.filter((m) => m.name === slot.name)), ...split(fit.filter((m) => m.serviceUri === slot.name))]
}

/** The one record to attach without asking, or null when there is none or the choice is not clear. */
export function autoMatch<T extends Record_>(slot: SlotSpec, records: T[]): T | null {
  const tier = slotTiers(slot, records).find((group) => group.length > 0)
  return tier && tier.length === 1 ? tier[0] : null
}

/** Every record that fits the slot, best first, each once: what the user may pick from. */
export function slotCandidates<T extends Record_>(slot: SlotSpec, records: T[]): T[] {
  return [...new Set(slotTiers(slot, records).flat())]
}
