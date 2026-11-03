/**
 * Guided first build: the `build_brief_propose` tool a blank kit agent ends
 * its interview with, and the message the brief card's Start building sends.
 *
 * Shared because both processes read the same input: main validates the call
 * (`buildBriefToolProvider.ts`) and the renderer parses the persisted row back
 * into the card, so the two can never disagree about what a brief is.
 */

/** The tool, as the agent's session lists it on the `cinna` server. */
export const BUILD_BRIEF_TOOL = 'build_brief_propose'

/** The provider name its transcript row carries (`tool_call.toolProvider`). */
export const BUILD_BRIEF_PROVIDER_NAME = 'Cinna guided build'

/** What the tool answers on a valid brief. The turn is not parked: the agent stops by itself. */
export const BUILD_BRIEF_RESULT =
  'The brief is shown to the person with a Start building button. Stop here and wait for their reply.'

export const BUILD_BRIEF_CAPABILITY_IDS = [
  'credentials',
  'schedules',
  'status',
  'commands',
  'skills',
  'multi_agent',
  'artifacts'
] as const
export type BuildBriefCapabilityId = (typeof BUILD_BRIEF_CAPABILITY_IDS)[number]

export const BUILD_BRIEF_CAPABILITY_STATES = ['used', 'maybe', 'not_needed'] as const
export type BuildBriefCapabilityState = (typeof BUILD_BRIEF_CAPABILITY_STATES)[number]

export const BUILD_BRIEF_EFFORT_LEVELS = ['low', 'medium', 'high'] as const
export type BuildBriefEffortLevel = (typeof BUILD_BRIEF_EFFORT_LEVELS)[number]

/** Each capability by what it gives the person in the app — never a file or a manifest field. */
export const BUILD_BRIEF_CAPABILITY_LABELS: Record<BuildBriefCapabilityId, string> = {
  credentials: 'Credentials',
  schedules: 'Schedules',
  status: 'Status on the agent',
  commands: '/run: commands',
  skills: 'Skills',
  multi_agent: 'Handing work to other agents',
  artifacts: 'Published dashboards'
}

/** One line each, in plain words: the "What can agents do?" popover and the card's rows. */
export const BUILD_BRIEF_CAPABILITY_HINTS: Record<BuildBriefCapabilityId, string> = {
  credentials: 'Keeps the access it needs (an account, a key) in its Credentials tab.',
  schedules: 'Runs on its own at set times, from its Schedules tab.',
  status: 'Shows how things stand right on the agent, so you see it at a glance.',
  commands: 'One-click /run: commands for jobs you start often.',
  skills: 'A separate skill for each kind of request, so each stays simple.',
  multi_agent: 'Hands part of the work to another agent.',
  artifacts: 'Publishes dashboards and reports you open in Cinna.'
}

/** The manifest's work-complexity tier an effort level is applied as (`runtime.complexity`). */
export const BUILD_BRIEF_EFFORT_COMPLEXITY: Record<BuildBriefEffortLevel, 'simple' | 'medium' | 'complex'> = {
  low: 'simple',
  medium: 'medium',
  high: 'complex'
}

export interface BuildBriefCapability {
  id: BuildBriefCapabilityId
  state: BuildBriefCapabilityState
  note: string
}

export interface BuildBrief {
  summary: string
  prompt: string
  capabilities: BuildBriefCapability[]
  skills: { name: string; purpose: string }[]
  credentials: { name: string }[]
  effort: { level: BuildBriefEffortLevel; reason: string } | null
}

/** Bounds, shared by the schema the agent sees and the check its call meets. */
export const BUILD_BRIEF_LIMITS = {
  summary: 300,
  prompt: 2000,
  note: 240,
  skills: 8,
  skillName: 64,
  skillPurpose: 240,
  credentials: 10,
  credentialName: 80,
  effortReason: 240
} as const

/** The input schema the agent sees. */
export const BUILD_BRIEF_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'prompt', 'capabilities'],
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: BUILD_BRIEF_LIMITS.summary,
      description: 'One sentence: the job this agent will do, in the person’s words.'
    },
    prompt: {
      type: 'string',
      minLength: 1,
      maxLength: BUILD_BRIEF_LIMITS.prompt,
      description:
        'The starting build prompt, written as the person would say it ("Build me an agent that…"), at most about 1500 characters, holding only what they said or chose: a suggestion of yours belongs in `capabilities` as `maybe`. It becomes the first message of the building chat, followed by the capabilities they include.'
    },
    capabilities: {
      type: 'array',
      maxItems: BUILD_BRIEF_CAPABILITY_IDS.length,
      description: 'Each capability you considered, at most once: `used` when the answers call for it, `maybe` when it is the person’s choice, `not_needed` when it does not apply now.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'state', 'note'],
        properties: {
          id: { type: 'string', enum: [...BUILD_BRIEF_CAPABILITY_IDS] },
          state: { type: 'string', enum: [...BUILD_BRIEF_CAPABILITY_STATES] },
          note: {
            type: 'string',
            maxLength: BUILD_BRIEF_LIMITS.note,
            description: 'Why, in one short phrase the person understands ("checks your inbox every weekday at 8").'
          }
        }
      }
    },
    skills: {
      type: 'array',
      maxItems: BUILD_BRIEF_LIMITS.skills,
      description: 'Only when separate kinds of request call for separate skills.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'purpose'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: BUILD_BRIEF_LIMITS.skillName },
          purpose: { type: 'string', minLength: 1, maxLength: BUILD_BRIEF_LIMITS.skillPurpose }
        }
      }
    },
    credentials: {
      type: 'array',
      maxItems: BUILD_BRIEF_LIMITS.credentials,
      description: 'The access the agent will need, by name only ("Gmail"). Never a value.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: BUILD_BRIEF_LIMITS.credentialName } }
      }
    },
    effort: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'reason'],
      description: 'How hard the work is, when it is clearly not medium.',
      properties: {
        level: { type: 'string', enum: [...BUILD_BRIEF_EFFORT_LEVELS] },
        reason: { type: 'string', maxLength: BUILD_BRIEF_LIMITS.effortReason }
      }
    }
  }
} as const

export type BuildBriefParse = { ok: true; brief: BuildBrief } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`\`${field}\` is required.`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`\`${field}\` must be a string.`)
  const trimmed = value.trim()
  if (required && trimmed === '') throw new Error(`\`${field}\` must not be empty.`)
  if (trimmed.length > max) throw new Error(`\`${field}\` is longer than ${max} characters; shorten it.`)
  return trimmed
}

function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`\`${field}\` must be an array.`)
  if (value.length > max) throw new Error(`\`${field}\` has more than ${max} entries.`)
  return value
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`\`${field}\` must be one of ${allowed.map((v) => `\`${v}\``).join(', ')}.`)
}

/**
 * Read a `build_brief_propose` input. Total: never throws, and an error is one
 * sentence the agent can correct its call from.
 */
export function parseBuildBrief(input: unknown): BuildBriefParse {
  try {
    if (!isRecord(input)) throw new Error('The input must be an object.')
    const summary = text(input.summary, 'summary', BUILD_BRIEF_LIMITS.summary, true)
    const prompt = text(input.prompt, 'prompt', BUILD_BRIEF_LIMITS.prompt, true)
    const seen = new Set<BuildBriefCapabilityId>()
    const capabilities = list(input.capabilities, 'capabilities', BUILD_BRIEF_CAPABILITY_IDS.length).map((raw, i) => {
      if (!isRecord(raw)) throw new Error(`\`capabilities[${i}]\` must be an object.`)
      const id = oneOf(raw.id, `capabilities[${i}].id`, BUILD_BRIEF_CAPABILITY_IDS)
      if (seen.has(id)) throw new Error(`\`${id}\` is listed twice in \`capabilities\`.`)
      seen.add(id)
      return {
        id,
        state: oneOf(raw.state, `capabilities[${i}].state`, BUILD_BRIEF_CAPABILITY_STATES),
        note: text(raw.note, `capabilities[${i}].note`, BUILD_BRIEF_LIMITS.note, false)
      }
    })
    if (input.capabilities === undefined) throw new Error('`capabilities` is required.')
    const skills = list(input.skills, 'skills', BUILD_BRIEF_LIMITS.skills).map((raw, i) => {
      if (!isRecord(raw)) throw new Error(`\`skills[${i}]\` must be an object.`)
      return {
        name: text(raw.name, `skills[${i}].name`, BUILD_BRIEF_LIMITS.skillName, true),
        purpose: text(raw.purpose, `skills[${i}].purpose`, BUILD_BRIEF_LIMITS.skillPurpose, true)
      }
    })
    const credentials = list(input.credentials, 'credentials', BUILD_BRIEF_LIMITS.credentials).map((raw, i) => {
      if (!isRecord(raw)) throw new Error(`\`credentials[${i}]\` must be an object.`)
      return { name: text(raw.name, `credentials[${i}].name`, BUILD_BRIEF_LIMITS.credentialName, true) }
    })
    let effort: BuildBrief['effort'] = null
    if (input.effort !== undefined && input.effort !== null) {
      if (!isRecord(input.effort)) throw new Error('`effort` must be an object.')
      effort = {
        level: oneOf(input.effort.level, 'effort.level', BUILD_BRIEF_EFFORT_LEVELS),
        reason: text(input.effort.reason, 'effort.reason', BUILD_BRIEF_LIMITS.effortReason, false)
      }
    }
    const known = new Set(['summary', 'prompt', 'capabilities', 'skills', 'credentials', 'effort'])
    const extra = Object.keys(input).filter((key) => !known.has(key))
    if (extra.length > 0) throw new Error(`Unknown field \`${extra[0]}\`.`)
    return { ok: true, brief: { summary, prompt, capabilities, skills, credentials, effort } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The first message of the building chat: the prompt (as the person edited
 * it), then what to set up and what to leave for now.
 *
 * `includedMaybe` holds the `maybe` capabilities the person chose to include;
 * every other `maybe` is left out and named under "Not now". `not_needed` ones
 * are not mentioned: the agent said they do not apply.
 */
export function composeBuildMessage(
  brief: BuildBrief,
  prompt: string,
  includedMaybe: ReadonlySet<BuildBriefCapabilityId>
): string {
  const included = (c: BuildBriefCapability): boolean =>
    c.state === 'used' || (c.state === 'maybe' && includedMaybe.has(c.id))
  const setUp = brief.capabilities.filter(included)
  const leftOut = brief.capabilities.filter((c) => c.state === 'maybe' && !includedMaybe.has(c.id))
  const skillsLeftOut = leftOut.some((c) => c.id === 'skills')
  const credentialsLeftOut = leftOut.some((c) => c.id === 'credentials')
  const skillList = brief.skills.map((s) => `${s.name} (${s.purpose})`).join('; ')
  const credentialList = brief.credentials.map((c) => c.name).join(', ')

  const lines: string[] = []
  const covered = new Set<BuildBriefCapabilityId>()
  for (const capability of setUp) {
    covered.add(capability.id)
    let line = `- ${BUILD_BRIEF_CAPABILITY_LABELS[capability.id]}`
    if (capability.note) line += ` — ${capability.note}`
    if (capability.id === 'skills' && skillList) line += `: ${skillList}`
    if (capability.id === 'credentials' && credentialList) line += `: ${credentialList}`
    lines.push(line)
  }
  // Skills or credentials the brief names without listing the capability itself.
  if (!covered.has('skills') && !skillsLeftOut && skillList) lines.push(`- Skills: ${skillList}`)
  if (!covered.has('credentials') && !credentialsLeftOut && credentialList) lines.push(`- Credentials: ${credentialList}`)

  const parts = [prompt.trim()]
  if (lines.length > 0) parts.push(['Set up:', ...lines].join('\n'))
  if (leftOut.length > 0) parts.push(`Not now: ${leftOut.map((c) => BUILD_BRIEF_CAPABILITY_LABELS[c.id]).join(', ')}.`)
  return parts.join('\n\n')
}
