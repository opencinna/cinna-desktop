/**
 * Gemini tool-schema sanitizer.
 *
 * `function_declarations[].parameters` is NOT JSON Schema — it's the `Schema`
 * message of the v1beta API, a narrow OpenAPI-3.0 subset. The proto JSON
 * parser rejects the WHOLE request with a 400 when it meets a field it doesn't
 * know ("Invalid JSON payload received. Unknown name \"const\" … Cannot find
 * field"), so a single stray JSON-Schema keyword emitted by one MCP server
 * kills every tool call in the chat.
 *
 * Anthropic and OpenAI take `inputSchema` verbatim; only Gemini needs this.
 *
 * The allowed field list below is the authoritative one from the v1beta
 * discovery document (`Schema.properties` in
 * `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`).
 * We allowlist rather than blocklist: a blocklist only ever knows about the
 * keywords that have already broken us in production (that's how `const` got
 * through), while an allowlist is closed by construction.
 *
 * Filtering keys is necessary but not sufficient — Gemini also rejects an
 * allowed key carrying a wrong-shaped value (`items` must be one schema, never
 * a tuple array) and container types with nothing in them (an OBJECT with no
 * `properties`, an ARRAY with no `items`). `walk()` normalizes all three.
 *
 * Keywords with a faithful Gemini equivalent are translated instead of dropped
 * (`const` → single-value `enum`, `oneOf` → `anyOf`, `allOf` → merge,
 * `$ref` → inlined `$defs`), so the model keeps the constraint.
 */

/** Fields of `google.ai.generativelanguage.v1beta.Schema` — everything else 400s. */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'anyOf',
  'properties',
  'required',
  'propertyOrdering',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'default',
  'example'
])

/** Keys holding nested schemas — recursed into. The rest is copied verbatim. */
const SCHEMA_VALUED_KEYS = new Set(['items'])
const SCHEMA_MAP_KEYS = new Set(['properties'])
const SCHEMA_LIST_KEYS = new Set(['anyOf'])

/** Object-only keys, meaningless once a property-less OBJECT degrades to STRING. */
const OBJECT_ONLY_KEYS = ['properties', 'required', 'propertyOrdering', 'minProperties', 'maxProperties']

/** Cap on `$ref` inlining so a recursive schema can't expand forever. */
const MAX_REF_DEPTH = 4

type Obj = Record<string, unknown>

/**
 * What the sanitizer had to change, for the `schema sanitized` debug line.
 * The split matters when reading the log: a translated keyword kept its
 * constraint in a different shape, a dropped one is gone.
 */
export interface SanitizeReport {
  translated: string[]
  dropped: string[]
}

interface Ctx {
  defs: Map<string, Obj>
  report: SanitizeReport
}

export function createReport(): SanitizeReport {
  return { translated: [], dropped: [] }
}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function note(bucket: string[], key: string): void {
  if (!bucket.includes(key)) bucket.push(key)
}

/**
 * Sanitize an MCP `inputSchema` into something Gemini's `Schema` accepts.
 * Prefer `toGeminiParameters()` at the call site — it also decides whether the
 * declaration should carry `parameters` at all.
 */
export function sanitizeForGemini(schema: unknown, report: SanitizeReport = createReport()): unknown {
  if (!isObj(schema)) return schema
  return walk(schema, { defs: collectDefs(schema), report }, [], true)
}

/**
 * The `parameters` value for a `FunctionDeclaration`, or `undefined` when the
 * tool takes no arguments — Gemini rejects an object schema whose `properties`
 * map is empty ("should be non-empty for OBJECT type"), so a no-argument tool
 * must omit the field entirely rather than send `{ type: 'object' }`.
 */
export function toGeminiParameters(
  schema: unknown,
  report: SanitizeReport = createReport()
): Record<string, unknown> | undefined {
  const sanitized = sanitizeForGemini(schema, report)
  if (!isObj(sanitized)) return undefined
  return hasProperties(sanitized) ? sanitized : undefined
}

function hasProperties(node: Obj): boolean {
  return isObj(node.properties) && Object.keys(node.properties).length > 0
}

/** Index `$defs` / `definitions` by the `#/…` pointer a `$ref` would use. */
function collectDefs(root: Obj): Map<string, Obj> {
  const defs = new Map<string, Obj>()
  for (const bucket of ['$defs', 'definitions']) {
    const node = root[bucket]
    if (!isObj(node)) continue
    for (const [name, def] of Object.entries(node)) {
      if (isObj(def)) defs.set(`#/${bucket}/${name}`, def)
    }
  }
  return defs
}

function walk(node: unknown, ctx: Ctx, refStack: string[], isRoot = false): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, ctx, refStack))
  if (!isObj(node)) return node

  let src: Obj = { ...node }
  let stack = refStack

  // $ref — inline the target so the property keeps a shape. An unresolvable or
  // cyclic ref degrades to a plain value rather than an empty (typeless) node.
  // Only root-level `$defs` / `definitions` are indexed; anything else (nested
  // buckets, `#/properties/…` pointers, external URLs) takes the degrade path.
  if (typeof src.$ref === 'string') {
    const ref = src.$ref
    const target = ctx.defs.get(ref)
    delete src.$ref
    if (target && !stack.includes(ref) && stack.length < MAX_REF_DEPTH) {
      src = { ...target, ...src }
      stack = [...stack, ref]
      note(ctx.report.translated, '$ref')
    } else {
      note(ctx.report.dropped, '$ref:unresolved')
    }
  }

  // allOf — merge the members into the node (Gemini has no intersection type).
  if (Array.isArray(src.allOf)) {
    const members = src.allOf.filter(isObj)
    delete src.allOf
    note(ctx.report.translated, 'allOf')
    let merged: Obj = {}
    for (const m of members) merged = mergeSchemas(merged, m)
    src = mergeSchemas(merged, src)
  }

  // oneOf — Gemini only knows `anyOf`; for tool input the two are close enough.
  if (Array.isArray(src.oneOf)) {
    if (!src.anyOf) {
      src.anyOf = src.oneOf
      note(ctx.report.translated, 'oneOf')
    } else {
      note(ctx.report.dropped, 'oneOf')
    }
  }
  delete src.oneOf

  // const — a one-value enum says the same thing for strings; other types keep
  // the constraint in prose since Gemini's `enum` is string-only.
  if ('const' in src) {
    const value = src.const
    delete src.const
    note(ctx.report.translated, 'const')
    if (typeof value === 'string') {
      src.enum = [value]
      src.type ??= 'string'
    } else if (value !== undefined) {
      src.type ??= jsonType(value)
      src.description = withHint(src.description, `Must be exactly ${JSON.stringify(value)}.`)
    }
  }

  // A `{ type: 'null' }` alternative — Gemini takes `nullable` on the node.
  // Done before the alternatives are walked, where it would turn into a
  // nullable string of its own (see normalizeNullType).
  if (Array.isArray(src.anyOf)) {
    const members = src.anyOf.filter((m) => !(isObj(m) && m.type === 'null'))
    if (members.length !== src.anyOf.length) {
      src.nullable = true
      note(ctx.report.translated, 'anyOf:null')
      if (members.length) src.anyOf = members
      else delete src.anyOf
    }
  }

  // `type: ['string', 'null']` — Gemini takes a single type plus `nullable`.
  if (Array.isArray(src.type)) {
    const types = src.type.filter((t) => t !== 'null')
    if (src.type.length !== types.length) src.nullable = true
    src.type = types[0] ?? 'string'
    note(ctx.report.translated, 'type[]')
  }

  // A scalar's `type` binds every alternative; one without its own inherits it
  // here, before the walk would default it to a string and
  // `separateTypeAndAnyOf` drops the outer one. (A container's alternatives are
  // dropped there, read for a required-field hint.)
  if (typeof src.type === 'string' && !['null', 'object', 'array'].includes(src.type) && Array.isArray(src.anyOf)) {
    const type = src.type
    src.anyOf = src.anyOf.map((m) => (isObj(m) && m.type === undefined ? { ...m, type } : m))
  }

  normalizeItems(src, ctx.report)

  const out: Obj = {}
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) {
      note(ctx.report.dropped, k)
      continue
    }
    if (SCHEMA_VALUED_KEYS.has(k)) {
      out[k] = walk(v, ctx, stack)
    } else if (SCHEMA_LIST_KEYS.has(k)) {
      // A non-array `anyOf` would 400 on value shape — drop it rather than ship it.
      if (!Array.isArray(v)) {
        note(ctx.report.dropped, k)
        continue
      }
      out[k] = v.map((s) => walk(s, ctx, stack))
    } else if (SCHEMA_MAP_KEYS.has(k)) {
      if (!isObj(v)) continue
      const props: Obj = {}
      for (const [name, sub] of Object.entries(v)) props[name] = walk(sub, ctx, stack)
      out[k] = props
    } else {
      // Values like `default` / `example` are data, not schemas — copy as-is.
      out[k] = v
    }
  }

  normalizeEnum(out, ctx.report)
  normalizeNullType(out, ctx.report)
  inferType(out)
  separateTypeAndAnyOf(out, ctx.report)
  // The root keeps its OBJECT shape even when empty — `toGeminiParameters()`
  // turns that case into an omitted `parameters` field instead.
  if (!isRoot) degradeEmptyContainers(out, ctx.report)
  // A node stripped bare (e.g. `{ "not": {…} }`) would be a typeless schema;
  // Gemini wants a type on every node, and a string is the safest carrier.
  if (Object.keys(out).length === 0) out.type = 'string'
  return out
}

/**
 * Gemini's `items` is a single `Schema`. Draft-07 tuple form (`items: [...]`)
 * and 2020-12 `prefixItems` both describe per-position types Gemini can't
 * express — keep the first position so the array at least has an element type.
 */
function normalizeItems(src: Obj, report: SanitizeReport): void {
  if (Array.isArray(src.items)) {
    const first = src.items.find(isObj)
    if (first) src.items = first
    else delete src.items
    note(report.translated, 'items[]')
  }
  if ('prefixItems' in src) {
    const prefix = src.prefixItems
    delete src.prefixItems
    if (!src.items && Array.isArray(prefix)) {
      const first = prefix.find(isObj)
      if (first) src.items = first
    }
    note(report.translated, 'prefixItems')
  }
}

/** Shallow schema merge that still unions `properties` and `required`. */
function mergeSchemas(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a, ...b }
  if (isObj(a.properties) || isObj(b.properties)) {
    out.properties = { ...(isObj(a.properties) ? a.properties : {}), ...(isObj(b.properties) ? b.properties : {}) }
  }
  if (Array.isArray(a.required) || Array.isArray(b.required)) {
    const req = [...(Array.isArray(a.required) ? a.required : []), ...(Array.isArray(b.required) ? b.required : [])]
    out.required = [...new Set(req)]
  }
  return out
}

/**
 * Gemini's `enum` is `repeated string` and only meaningful on STRING nodes.
 * Numeric / boolean enums move into the description so nothing 400s and the
 * model still sees the allowed values.
 */
function normalizeEnum(out: Obj, report: SanitizeReport): void {
  if (!('enum' in out)) return
  const values = Array.isArray(out.enum) ? out.enum : []
  if (values.length === 0) {
    delete out.enum
    note(report.dropped, 'enum')
    return
  }
  const allStrings = values.every((v) => typeof v === 'string')
  if (allStrings && (out.type === undefined || out.type === 'string')) {
    out.type = 'string'
    return
  }
  delete out.enum
  note(report.translated, 'enum')
  out.description = withHint(out.description, `Allowed values: ${values.map((v) => JSON.stringify(v)).join(', ')}.`)
}

/**
 * `null` is not a type of its own here: a node that can only be null is a
 * nullable string (a `{ type: 'null' }` alternative was already folded into
 * its parent's `nullable` in `walk`). The `@google/genai` request builder throws on a lone
 * `type: 'null'` before anything is sent.
 */
function normalizeNullType(out: Obj, report: SanitizeReport): void {
  if (out.type === 'null') {
    out.type = 'string'
    out.nullable = true
    note(report.translated, 'type:null')
  }
}

/**
 * A node may carry `type` or `anyOf`, not both — the `@google/genai` request
 * builder throws "type and anyOf cannot be both populated" and the whole turn
 * fails. On a container (`properties` / `items`) the alternatives only add
 * constraints such as "one of these is required", so they go — a choice of
 * required fields survives as a hint in the description. A scalar with an
 * `enum` keeps its type: the enum already names every value it may take, and
 * alternatives beside it (`const`s, typically) can only narrow it. Otherwise
 * each alternative carries its own type (see `inferType`), so the outer one goes.
 */
function separateTypeAndAnyOf(out: Obj, report: SanitizeReport): void {
  if (out.type === undefined || !Array.isArray(out.anyOf)) return
  if (out.properties !== undefined || out.items !== undefined) {
    const hint = requiredChoiceHint(out.anyOf)
    delete out.anyOf
    if (hint) out.description = withHint(out.description, hint)
    note(report.dropped, 'anyOf:with-type')
  } else if (Array.isArray(out.enum)) {
    delete out.anyOf
    note(report.dropped, 'anyOf:with-enum')
  } else {
    delete out.type
    note(report.dropped, 'type:with-anyOf')
  }
}

/**
 * "Provide one of: url, path." for alternatives that each name the fields
 * they require (`anyOf: [{ required: ['url'] }, { required: ['path'] }]`),
 * so the model still learns the rule the dropped `anyOf` stated. Null when
 * any alternative says something else.
 */
function requiredChoiceHint(alternatives: unknown[]): string | null {
  const choices: string[] = []
  for (const alternative of alternatives) {
    const required = isObj(alternative) ? alternative.required : undefined
    if (!Array.isArray(required) || required.length === 0 || !required.every((name) => typeof name === 'string')) return null
    choices.push(required.join(' and '))
  }
  return choices.length ? `Provide one of: ${[...new Set(choices)].join(', ')}.` : null
}

/** Gemini rejects a node with no `type`; recover it from the node's shape. */
function inferType(out: Obj): void {
  if (out.type !== undefined) return
  if (out.properties !== undefined) out.type = 'object'
  else if (out.items !== undefined) out.type = 'array'
  else if (out.anyOf !== undefined) return // anyOf carries the types
  else if (Object.keys(out).length > 0) out.type = 'string'
}

/**
 * Gemini rejects empty containers ("should be non-empty for OBJECT type"), and
 * a free-form dict (`{ type: 'object', additionalProperties: true }`) becomes
 * exactly that once `additionalProperties` is filtered out. Ask for a JSON
 * string instead — the model can still express arbitrary content.
 */
function degradeEmptyContainers(out: Obj, report: SanitizeReport): void {
  if (out.type === 'object' && !hasProperties(out)) {
    for (const k of OBJECT_ONLY_KEYS) delete out[k]
    out.type = 'string'
    out.description = withHint(out.description, 'JSON-encoded object.')
    note(report.dropped, 'object:no-properties')
  }
  if (out.type === 'array' && !isObj(out.items)) {
    out.items = { type: 'string' }
    note(report.dropped, 'array:no-items')
  }
}

function jsonType(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return 'string'
}

function withHint(description: unknown, hint: string): string {
  const base = typeof description === 'string' && description.trim() ? `${description.trim()} ` : ''
  return `${base}${hint}`
}
