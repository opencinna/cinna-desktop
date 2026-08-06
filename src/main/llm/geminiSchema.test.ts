import { describe, it, expect } from 'vitest'
import { createReport, sanitizeForGemini, toGeminiParameters } from './geminiSchema'

/**
 * Gemini 400s the entire request on the first thing it doesn't accept in a tool
 * schema, so every keyword an MCP server can emit must leave the sanitizer as
 * one of the v1beta `Schema` fields — carrying a value of the shape that field
 * expects — or not at all.
 *
 * The `const` case is the production regression that motivated the allowlist:
 *   [400] Invalid JSON payload received. Unknown name "const" at
 *   'tools[0].function_declarations[1].parameters.properties[1].value'
 */

const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'anyOf',
  'properties', 'required', 'propertyOrdering', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'default', 'example'
])

/**
 * Walk the sanitized output the way the API's proto parser would: unknown
 * field names, wrong-shaped values, and empty containers all 400.
 */
function assertGeminiClean(node: unknown, path = 'root', isRoot = true): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const obj = node as Record<string, unknown>

  for (const k of Object.keys(obj)) {
    expect(GEMINI_SCHEMA_KEYS.has(k), `unknown field "${k}" at ${path}`).toBe(true)
  }
  // `Schema.items` is `$ref: Schema` — a single object, never a tuple array.
  if ('items' in obj) {
    expect(Array.isArray(obj.items), `tuple "items" at ${path}`).toBe(false)
    assertGeminiClean(obj.items, `${path}.items`, false)
  }
  if ('anyOf' in obj) {
    expect(Array.isArray(obj.anyOf), `non-array "anyOf" at ${path}`).toBe(true)
    ;(obj.anyOf as unknown[]).forEach((s, i) => assertGeminiClean(s, `${path}.anyOf[${i}]`, false))
  }
  // Empty containers: "should be non-empty for OBJECT type". The root is
  // exempt — a no-argument tool omits `parameters` instead (see toGeminiParameters).
  if (obj.type === 'object' && !isRoot) {
    const props = obj.properties as Record<string, unknown> | undefined
    expect(!!props && Object.keys(props).length > 0, `empty OBJECT at ${path}`).toBe(true)
  }
  if (obj.type === 'array' && !isRoot) {
    expect(!!obj.items, `ARRAY without items at ${path}`).toBe(true)
  }
  if (obj.properties && typeof obj.properties === 'object') {
    for (const [name, sub] of Object.entries(obj.properties as Record<string, unknown>)) {
      assertGeminiClean(sub, `${path}.properties.${name}`, false)
    }
  }
}

describe('sanitizeForGemini', () => {
  it('rewrites a string `const` into a single-value enum', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        type: 'object',
        properties: {
          kind: { const: 'search' },
          query: { type: 'string' }
        }
      },
      report
    ) as any

    expect(out.properties.kind).toEqual({ type: 'string', enum: ['search'] })
    expect(report.translated).toContain('const')
    assertGeminiClean(out)
  })

  it('keeps a non-string `const` as prose, since Gemini enums are string-only', () => {
    const out = sanitizeForGemini({ type: 'object', properties: { limit: { const: 10 } } }) as any
    expect(out.properties.limit.type).toBe('integer')
    expect(out.properties.limit.description).toMatch(/Must be exactly 10\./)
    assertGeminiClean(out)
  })

  it('strips every non-Schema keyword an MCP server may emit', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'urn:tool',
        type: 'object',
        additionalProperties: false,
        unevaluatedProperties: false,
        properties: {
          n: { type: 'number', exclusiveMinimum: 0, multipleOf: 2, examples: [4] },
          s: { type: 'string', minLength: 1, pattern: '^a', not: { const: 'b' } },
          u: { type: 'string', uniqueItems: true, deprecated: true, readOnly: true }
        },
        required: ['n'],
        patternProperties: { '^x': { type: 'string' } }
      },
      report
    )

    assertGeminiClean(out)
    expect(report.dropped).toEqual(
      expect.arrayContaining(['$schema', 'additionalProperties', 'exclusiveMinimum', 'multipleOf', 'not'])
    )
  })

  it('preserves the fields Gemini does understand', () => {
    const schema = {
      type: 'object',
      title: 'Search',
      description: 'Run a search',
      properties: {
        q: { type: 'string', description: 'query', minLength: 1, maxLength: 80, pattern: '.+', default: '' },
        n: { type: 'integer', minimum: 1, maximum: 50, format: 'int32' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
        mode: { type: 'string', enum: ['fast', 'deep'] },
        opt: { type: 'string', nullable: true }
      },
      required: ['q']
    }
    const report = createReport()
    expect(sanitizeForGemini(structuredClone(schema), report)).toEqual(schema)
    expect(report).toEqual({ translated: [], dropped: [] })
  })

  it('inlines $ref/$defs instead of leaving an empty node', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        type: 'object',
        $defs: { Point: { type: 'object', properties: { x: { type: 'number' } } } },
        properties: { start: { $ref: '#/$defs/Point' } }
      },
      report
    ) as any

    expect(out.$defs).toBeUndefined()
    expect(out.properties.start).toEqual({ type: 'object', properties: { x: { type: 'number' } } })
    expect(report.translated).toContain('$ref')
    assertGeminiClean(out)
  })

  it('degrades an unresolvable $ref instead of shipping an empty node', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      { type: 'object', properties: { p: { $ref: 'https://example.com/Other' } } },
      report
    ) as any

    expect(out.properties.p).toEqual({ type: 'string' })
    expect(report.dropped).toContain('$ref:unresolved')
    assertGeminiClean(out)
  })

  it('terminates on a recursive $ref', () => {
    const out = sanitizeForGemini({
      type: 'object',
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
      properties: { root: { $ref: '#/$defs/Node' } }
    })
    assertGeminiClean(out)
  })

  it('converts oneOf to anyOf and merges allOf', () => {
    const out = sanitizeForGemini({
      type: 'object',
      properties: {
        choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        merged: {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }
          ]
        }
      }
    }) as any

    expect(out.properties.choice.anyOf).toHaveLength(2)
    expect(Object.keys(out.properties.merged.properties)).toEqual(['a', 'b'])
    expect(out.properties.merged.required).toEqual(['a', 'b'])
    assertGeminiClean(out)
  })

  it('records a oneOf that loses to an existing anyOf', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        type: 'object',
        properties: { p: { anyOf: [{ type: 'string' }], oneOf: [{ type: 'integer' }] } }
      },
      report
    ) as any

    expect(out.properties.p.anyOf).toEqual([{ type: 'string' }])
    expect(report.dropped).toContain('oneOf')
    assertGeminiClean(out)
  })

  it('drops a malformed non-array anyOf', () => {
    const report = createReport()
    const out = sanitizeForGemini({ type: 'object', properties: { p: { anyOf: { type: 'string' } } } }, report) as any
    expect(out.properties.p.anyOf).toBeUndefined()
    expect(report.dropped).toContain('anyOf')
    assertGeminiClean(out)
  })

  it('collapses tuple `items` to a single schema', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        type: 'object',
        properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } }
      },
      report
    ) as any

    expect(out.properties.pair.items).toEqual({ type: 'string' })
    expect(report.translated).toContain('items[]')
    assertGeminiClean(out)
  })

  it('promotes `prefixItems` into `items`', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        type: 'object',
        properties: { pair: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }] } }
      },
      report
    ) as any

    expect(out.properties.pair.items).toEqual({ type: 'number' })
    expect(report.translated).toContain('prefixItems')
    assertGeminiClean(out)
  })

  it('degrades a property-less object to a JSON string', () => {
    const report = createReport()
    const out = sanitizeForGemini(
      {
        type: 'object',
        properties: {
          meta: { type: 'object', additionalProperties: true, description: 'Extra data' },
          empty: { type: 'object', properties: {}, required: [] }
        }
      },
      report
    ) as any

    expect(out.properties.meta).toEqual({ type: 'string', description: 'Extra data JSON-encoded object.' })
    expect(out.properties.empty).toEqual({ type: 'string', description: 'JSON-encoded object.' })
    expect(report.dropped).toContain('object:no-properties')
    assertGeminiClean(out)
  })

  it('gives an item-less array an element type', () => {
    const report = createReport()
    const out = sanitizeForGemini({ type: 'object', properties: { list: { type: 'array' } } }, report) as any
    expect(out.properties.list.items).toEqual({ type: 'string' })
    expect(report.dropped).toContain('array:no-items')
    assertGeminiClean(out)
  })

  it('collapses a nullable union type onto `nullable`', () => {
    const out = sanitizeForGemini({
      type: 'object',
      properties: { maybe: { type: ['string', 'null'] } }
    }) as any
    expect(out.properties.maybe).toEqual({ type: 'string', nullable: true })
  })

  it('demotes a non-string enum to prose', () => {
    const out = sanitizeForGemini({
      type: 'object',
      properties: { level: { type: 'integer', enum: [1, 2, 3] } }
    }) as any
    expect(out.properties.level.enum).toBeUndefined()
    expect(out.properties.level.description).toMatch(/Allowed values: 1, 2, 3\./)
    assertGeminiClean(out)
  })

  it('never emits a typeless node', () => {
    const out = sanitizeForGemini({
      type: 'object',
      properties: { anything: {}, negated: { not: { type: 'string' } } }
    }) as any
    expect(out.properties.anything.type).toBe('string')
    expect(out.properties.negated.type).toBe('string')
  })

  it('leaves data-valued keywords untouched', () => {
    const out = sanitizeForGemini({
      type: 'object',
      properties: { cfg: { type: 'object', properties: { k: { type: 'string' } }, default: { const: 'not-a-keyword' } } }
    }) as any
    expect(out.properties.cfg.default).toEqual({ const: 'not-a-keyword' })
  })
})

describe('toGeminiParameters', () => {
  it('omits parameters for a no-argument tool', () => {
    expect(toGeminiParameters({ type: 'object', properties: {} })).toBeUndefined()
    expect(toGeminiParameters({ type: 'object' })).toBeUndefined()
    expect(toGeminiParameters({ type: 'object', additionalProperties: false })).toBeUndefined()
    expect(toGeminiParameters(undefined)).toBeUndefined()
  })

  it('returns the sanitized schema when the tool takes arguments', () => {
    const report = createReport()
    const out = toGeminiParameters({ type: 'object', properties: { q: { const: 'x' } } }, report)
    expect(out).toEqual({ type: 'object', properties: { q: { type: 'string', enum: ['x'] } } })
    expect(report.translated).toContain('const')
  })
})
