import type { ScriptAgentRef, ScriptStep, TaskScript } from '../../shared/taskScript'

export const MAX_SCRIPT_STEPS = 64
export const MAX_SCRIPT_TEXT = 64000
export const MAX_SCRIPT_OUTPUT = 16000
const MAX_DEFINITION_TEXT = 1024 * 1024
const identifier = /^[a-z][a-z0-9_-]{0,63}$/
const reserved = new Set(['goal', 'constructor', 'prototype', '__proto__'])
const reference = /\{\{\s*(goal|[a-z][a-z0-9_-]{0,63}\.text)\s*\}\}/g

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains an unsupported field.`)
}
function text(value: unknown, label: string, limit = MAX_SCRIPT_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} must contain 1–${limit} characters.`)
  return value
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifier.test(value) || reserved.has(value)) throw new Error(`${label} must be a lowercase identifier of at most 64 characters; reserved names cannot be used.`)
  return value
}
function url(value: unknown, label: string): string {
  const raw = text(value, label, 2048)
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error(`${label} must be an HTTP or HTTPS URL.`) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label} must be an HTTP or HTTPS URL without embedded credentials.`)
  return raw
}
function agentRef(value: unknown, label: string): ScriptAgentRef {
  const ref = object(value, label)
  if (ref.kind !== 'agent') throw new Error(`${label} must identify an agent.`)
  const name = ref.name === undefined ? {} : { name: text(ref.name, `${label} name`, 256) }
  switch (ref.source) {
    case 'folder':
      keys(ref, ['kind', 'source', 'manifestId', 'name'], label)
      return { kind: 'agent', source: 'folder', manifestId: text(ref.manifestId, `${label} manifest ID`, 256), ...name }
    case 'local':
      keys(ref, ['kind', 'source', 'cardUrl', 'name'], label)
      return { kind: 'agent', source: 'local', cardUrl: url(ref.cardUrl, `${label} card URL`), ...name }
    case 'remote':
      keys(ref, ['kind', 'source', 'remoteTargetId', 'remoteTargetType', 'serverUrl', 'name'], label)
      if (!['agent', 'app_mcp_route', 'identity'].includes(ref.remoteTargetType as string)) throw new Error(`${label} has an unsupported remote target type.`)
      return { kind: 'agent', source: 'remote', remoteTargetType: ref.remoteTargetType as string,
        remoteTargetId: text(ref.remoteTargetId, `${label} remote ID`, 256), serverUrl: url(ref.serverUrl, `${label} server URL`), ...name }
    default: throw new Error(`${label} has an unsupported agent source.`)
  }
}

/** Reject all unsupported syntax before creating tasks or dispatching an agent. */
export function validateTaskScript(input: unknown): TaskScript {
  const raw = object(input, 'Script')
  keys(raw, ['version', 'agents', 'steps'], 'Script')
  if (raw.version !== 1) throw new Error('This script version is not supported. Expected version 1.')
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > MAX_SCRIPT_STEPS) throw new Error(`A script must have 1–${MAX_SCRIPT_STEPS} steps.`)
  const refs = object(raw.agents, 'Script agents')
  if (Object.keys(refs).length > MAX_SCRIPT_STEPS) throw new Error(`A script can reference at most ${MAX_SCRIPT_STEPS} agents.`)
  const agents = Object.fromEntries(Object.entries(refs).map(([alias, ref]) => [id(alias, 'Agent alias'), agentRef(ref, `Agent ${alias}`)]))
  const seen = new Set<string>()
  let size = Buffer.byteLength(JSON.stringify(agents))
  const steps: ScriptStep[] = raw.steps.map((input) => {
    const step = object(input, 'Script step')
    keys(step, ['id', 'after', 'agent', 'prompt', 'ask_user'], 'Script step')
    const stepId = id(step.id, 'Step ID')
    if (seen.has(stepId)) throw new Error(`Duplicate script step: ${stepId}.`)
    seen.add(stepId)
    const after = step.after === undefined ? [] : step.after
    if (!Array.isArray(after) || after.length > MAX_SCRIPT_STEPS) throw new Error(`Step ${stepId} has an invalid dependency list.`)
    const dependencies = after.map((value) => id(value, `Dependency of ${stepId}`))
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`Step ${stepId} repeats a dependency.`)
    const base = { id: stepId, after: dependencies }
    let result: ScriptStep
    if (Object.hasOwn(step, 'ask_user')) {
      if (Object.hasOwn(step, 'agent') || Object.hasOwn(step, 'prompt')) throw new Error(`Step ${stepId} must choose either an agent or a human question.`)
      result = { ...base, ask_user: text(step.ask_user, `Question for ${stepId}`) }
    } else {
      const alias = id(step.agent, `Agent for ${stepId}`)
      if (!Object.hasOwn(agents, alias)) throw new Error(`Step ${stepId} references an unknown agent: ${alias}.`)
      result = { ...base, agent: alias, prompt: text(step.prompt, `Prompt for ${stepId}`) }
    }
    size += Buffer.byteLength(JSON.stringify(result))
    if (size > MAX_DEFINITION_TEXT) throw new Error('The script definition exceeds 1 MiB of text.')
    return result
  })
  const byId = new Map(steps.map((step) => [step.id, step]))
  const ancestors = new Map<string, Set<string>>()
  const visiting = new Set<string>()
  const visit = (step: ScriptStep): Set<string> => {
    const prior = ancestors.get(step.id)
    if (prior) return prior
    if (visiting.has(step.id)) throw new Error(`Script dependencies contain a cycle at ${step.id}.`)
    visiting.add(step.id)
    const result = new Set<string>()
    for (const dep of step.after ?? []) {
      const parent = byId.get(dep)
      if (!parent) throw new Error(`Step ${step.id} references an unknown dependency: ${dep}.`)
      result.add(dep)
      for (const ancestor of visit(parent)) result.add(ancestor)
    }
    visiting.delete(step.id)
    ancestors.set(step.id, result)
    return result
  }
  for (const step of steps) {
    const allowed = visit(step)
    const template = step.agent === undefined ? step.ask_user : step.prompt
    parseTemplate(template, (name) => {
      if (name !== 'goal' && !allowed.has(name.slice(0, -5))) throw new Error(`Step ${step.id} can only read the output of its dependencies: ${name}.`)
      return ''
    })
  }
  return { version: 1, agents, steps }
}

function parseTemplate(template: string, read: (name: string) => string): string {
  let position = 0
  let expanded = ''
  const append = (value: string): void => {
    if (expanded.length + value.length > MAX_SCRIPT_TEXT) throw new Error(`The expanded script prompt exceeds ${MAX_SCRIPT_TEXT} characters.`)
    expanded += value
  }
  for (const match of template.matchAll(reference)) {
    const literal = template.slice(position, match.index)
    if (literal.includes('{{') || literal.includes('}}')) throw new Error('Script templates only support {{goal}} and {{step.text}}.')
    append(literal)
    append(read(match[1]))
    position = match.index + match[0].length
  }
  const rest = template.slice(position)
  if (rest.includes('{{') || rest.includes('}}')) throw new Error('Script templates only support {{goal}} and {{step.text}}.')
  append(rest)
  return expanded
}

/** Single pass: braces in agent output are literal data, never re-evaluated. */
export function expandScriptTemplate(template: string, goal: string, outputs: Readonly<Record<string, string>>): string {
  if (typeof template !== 'string' || template.length > MAX_SCRIPT_TEXT) throw new Error('Invalid script template.')
  return parseTemplate(template, (name) => {
    if (name === 'goal') return goal
    const stepId = name.slice(0, -5)
    if (!Object.hasOwn(outputs, stepId) || typeof outputs[stepId] !== 'string') throw new Error(`No completed output is available for script step ${stepId}.`)
    return outputs[stepId]
  })
}

export function compactScriptOutput(value: string): string {
  const suffix = '\n[Output shortened for script context; full output is in the step conversation.]'
  return value.length <= MAX_SCRIPT_OUTPUT ? value : value.slice(0, MAX_SCRIPT_OUTPUT - suffix.length) + suffix
}

/** Stable definition order; the caller durably claims each step before dispatch. */
export function readyScriptSteps(script: TaskScript, states: Readonly<Record<string, string>>): ScriptStep[] {
  return script.steps.filter((step) => states[step.id] === 'pending' &&
    (step.after ?? []).every((dependency) => Object.hasOwn(states, dependency) && states[dependency] === 'completed'))
}
