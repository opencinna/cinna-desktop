import type { ComponentReference, ComponentReferenceAgent } from './dashboards'

/**
 * Component references (`x-references` in the kit's
 * `protocols/dashboards.schema.json`):
 *
 *   cinna://component/<agent>/<name>
 *   cinna://component/<agent>/<skill>/<name>
 *
 * `<agent>` is `id:<manifest id>`, `bundle:<bundle id>` or a bare slug. The
 * prefix is always written: a form is never guessed from the segment's shape,
 * so a dotted segment without `bundle:` is not a reference. Parsing is strict:
 * anything else is plain text. Pure, shared by main (the resolver) and the
 * renderer (the markdown plugin).
 */

export const COMPONENT_REFERENCE_PREFIX = 'cinna://component/'

/** The schema's `segment_patterns`, whole-string. */
const ID_SEGMENT = /^id:([0-9a-fA-F-]{36})$/
const BUNDLE_SEGMENT = /^bundle:([a-zA-Z0-9][a-zA-Z0-9.-]{1,253})$/
const SLUG_SEGMENT = /^[a-z0-9][a-z0-9-]{1,62}$/
const SKILL_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NAME_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/

function parseAgentSegment(segment: string): ComponentReferenceAgent | null {
  const id = ID_SEGMENT.exec(segment)
  if (id) return { kind: 'id', value: id[1].toLowerCase() }
  const bundle = BUNDLE_SEGMENT.exec(segment)
  if (bundle) return { kind: 'bundle', value: bundle[1] }
  if (segment.includes(':')) return null
  return SLUG_SEGMENT.test(segment) ? { kind: 'slug', value: segment } : null
}

/** A whole string that is exactly one reference, or null. No trailing slash, query or fragment. */
export function parseComponentReference(text: string): ComponentReference | null {
  if (!text.startsWith(COMPONENT_REFERENCE_PREFIX)) return null
  const segments = text.slice(COMPONENT_REFERENCE_PREFIX.length).split('/')
  if (segments.length !== 2 && segments.length !== 3) return null
  const agent = parseAgentSegment(segments[0])
  if (!agent) return null
  const skill = segments.length === 3 ? segments[1] : null
  const name = segments[segments.length - 1]
  if (skill !== null && !SKILL_SEGMENT.test(skill)) return null
  if (!NAME_SEGMENT.test(name)) return null
  return { raw: text, agent, skill, name }
}

/** The reference text for an agent segment and component, the inverse of the parser. */
export function formatComponentReference(agent: ComponentReferenceAgent, skill: string | null, name: string): string {
  const head = agent.kind === 'slug' ? agent.value : `${agent.kind}:${agent.value}`
  return `${COMPONENT_REFERENCE_PREFIX}${head}/${skill ? `${skill}/` : ''}${name}`
}

/** The prefix an agent prints for its own components: the bundle form when it has a bundle id, else the id form. */
export function ownReferencePrefix(manifestId: string, bundleId: string | null): string {
  return bundleId ? `${COMPONENT_REFERENCE_PREFIX}bundle:${bundleId}/` : `${COMPONENT_REFERENCE_PREFIX}id:${manifestId}/`
}

/** One identity per component, for "one card per component per message". */
export function componentReferenceKey(ref: ComponentReference): string {
  return `${ref.agent.kind}:${ref.agent.value}/${ref.skill ?? ''}/${ref.name}`
}
