# Tool Schema Translation

## Purpose

MCP servers describe their tools with JSON Schema. Two of the three providers accept that verbatim; Gemini does not. This document covers how a tool's `inputSchema` is made acceptable to each provider without the user ever seeing a failed chat — and what is lost in the process.

For the wider cross-provider translation matrix see [Provider Integration](./provider_integration.md); for the abstraction itself see [Adapters](./adapters.md).

## Core Concepts

| Term | Definition |
|------|-----------|
| **`inputSchema`** | The raw JSON Schema an MCP server (or an agent's `cinna.mcp` descriptor) publishes for a tool. Arrives on `ToolDefinition` and is provider-agnostic |
| **Gemini `Schema`** | The `google.ai.generativelanguage.v1beta.Schema` proto — a narrow OpenAPI-3.0 subset with a fixed, closed set of 22 fields. **Not** JSON Schema, despite looking like it |
| **Sanitize** | The one-way walk from `inputSchema` to a Gemini `Schema`. Never throws; degrades instead |
| **Translate** | A keyword rewritten into a Gemini equivalent — the constraint survives in a different shape (`const` → single-value `enum`) |
| **Drop** | A keyword Gemini has no equivalent for — the constraint is gone and the model no longer sees it |
| **Degrade** | A node that can't be expressed at all is replaced by a weaker but valid one (a free-form object becomes a string asking for JSON) |
| **Sanitize report** | The `{ translated, dropped }` record of everything a tool's schema lost, surfaced in the `⌘\`` log |

## Why Gemini Is Different

Anthropic's `input_schema` and OpenAI's `parameters` are JSON Schema fields — unknown keywords are ignored. Gemini's `parameters` is a **proto message**, and the proto JSON parser rejects the *entire request* on the first field name it doesn't know:

> `[400 Bad Request] Invalid JSON payload received. Unknown name "const" at 'tools[0].function_declarations[1].parameters.properties[1].value': Cannot find field.`

The blast radius is the reason this matters: one stray keyword, from one property, of one tool, on one MCP server kills **every** tool call in the chat — including tools from unrelated servers, because all declarations ship in a single request. The user sees a generic provider error, not "server X has a bad schema".

This is why the sanitizer allowlists the fields Gemini documents rather than blocklisting the ones known to break. A blocklist only ever contains keywords that have already reached production and failed there — which is exactly how `const` got through the original implementation.

## Business Rules

### Field admission

- Only the 22 fields of the v1beta `Schema` message survive: `type`, `format`, `title`, `description`, `nullable`, `enum`, `items`, `anyOf`, `properties`, `required`, `propertyOrdering`, `minItems`, `maxItems`, `minProperties`, `maxProperties`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `default`, `example`.
- Everything else is removed and recorded — `additionalProperties`, `exclusiveMinimum`, `multipleOf`, `patternProperties`, `not`, `if`/`then`/`else`, `uniqueItems`, `readOnly`, `deprecated`, `$schema`, `$id`, `$comment`, and any keyword a future MCP server invents.

### Translation over removal

A keyword with a faithful equivalent is rewritten so the model keeps the constraint:

| JSON Schema | Sent to Gemini | Rationale |
|---|---|---|
| `const: "x"` | `{ type: 'string', enum: ['x'] }` | A one-value enum says the same thing |
| `const: 10`, non-string `enum` | Type inferred; value(s) appended to `description` | Gemini's `enum` is `repeated string` — numbers can't ride in it |
| `$ref` + `$defs` / `definitions` | Target inlined | Cycle-safe, max depth 4 |
| `oneOf` | `anyOf` | Gemini has no exclusive union; for tool *input* the distinction rarely binds |
| `allOf` | Members merged (`properties` unioned, `required` concatenated) | No intersection type exists |
| `type: ['string','null']` | `{ type: 'string', nullable: true }` | Gemini takes one type plus a flag |
| tuple `items: [A, B]`, `prefixItems` | `items: A` | `Schema.items` is one schema, never an array |

### Shape rules

Filtering field *names* is necessary but not sufficient — Gemini also rejects an allowed field carrying a wrong-shaped *value*, and container types with nothing in them. Three rules close that gap:

- **No typeless nodes.** A node left bare after filtering (e.g. `{ not: {...} }`) becomes `type: 'string'`. A node with `properties`/`items` infers `object`/`array`; `anyOf` carries its own types.
- **No empty containers.** An OBJECT with no `properties` — what a free-form `{ type: 'object', additionalProperties: true }` dict becomes once filtered — degrades to a `type: 'string'` whose description asks for a JSON-encoded object. An ARRAY with no `items` gets `items: { type: 'string' }`. Gemini answers both with `should be non-empty for OBJECT type`.
- **No `parameters` for a no-argument tool.** The schema root is exempt from the rule above: instead of degrading it to a string, the `parameters` field is omitted from the function declaration entirely.

### Failure posture

- The sanitizer **never throws**. A schema it cannot express is weakened, not rejected — a degraded tool the model can still call beats a chat that can't start.
- Data-valued keywords (`default`, `example`) are copied verbatim and never walked, so a payload that happens to contain a key named `const` isn't mangled into a schema.
- Nothing is silently lost: every translation and every drop lands in the sanitize report and, from there, in the debug log.

### Known limitations

- **`$defs` are indexed at the root only.** A nested `$defs` bucket, a `#/properties/…` pointer, or an external `$ref` URL can't be resolved; the node degrades to `type: 'string'` and reports `$ref:unresolved`. Root-level `$defs` covers the common zod/MCP shape.
- **Tuples lose their tail.** `[string, number]` keeps only the first position's type — Gemini cannot express per-position types at all.
- **Non-string enums become prose.** The model sees the allowed values in the description, but the provider no longer enforces them.
- **Recursive schemas flatten at depth 4.** Beyond that the ref degrades rather than expanding forever.

## Flow

1. `chatStreamingService` aggregates `ToolDefinition[]` from every attached MCP server and agent provider, and hands them to the adapter unchanged.
2. Anthropic and OpenAI pass `inputSchema` straight through to `input_schema` / `parameters`.
3. Gemini's adapter runs each schema through the sanitizer, collecting a per-tool report.
4. Anything the sanitizer changed is logged as `schema sanitized` with the tool name — `translated` for constraints that survived in another shape, `dropped` for those that didn't.
5. A tool that ends up with no parameters ships as a declaration with no `parameters` field.
6. The request goes out with every tool declaration; a malformed one would fail all of them, which is what the allowlist exists to prevent.

## Architecture Overview

```
MCP server / agent descriptor
  -> ToolDefinition.inputSchema (raw JSON Schema)
    -> chatStreamingService (aggregates, no translation)
      -> AnthropicAdapter -> input_schema   (verbatim)
      -> OpenAIAdapter    -> parameters     (verbatim)
      -> GeminiAdapter    -> toGeminiParameters()
                              -> sanitizeForGemini() walk
                                 - allowlist 22 Schema fields
                                 - translate const/$ref/oneOf/allOf/tuples
                                 - degrade empty containers
                                 - report { translated, dropped }
                              -> parameters | omitted
```

## Technical Details

### File Locations

- `src/main/llm/geminiSchema.ts` — the whole translation. Pure module: no Electron, SDK, DB, or logger imports, so it runs under the plain-Node vitest environment
  - `toGeminiParameters(schema, report)` — call-site entry point; returns the sanitized schema or `undefined` for a no-argument tool
  - `sanitizeForGemini(schema, report)` — the recursive walk
  - `createReport()` — fresh `{ translated, dropped }` accumulator
- `src/main/llm/gemini.ts` — `GeminiAdapter.convertTools()`: maps each `ToolDefinition`, calls `toGeminiParameters()`, emits the `schema sanitized` debug line
- `src/main/llm/anthropic.ts`, `src/main/llm/openai.ts` — pass `inputSchema` through untouched; no counterpart needed
- `src/main/llm/types.ts` — `ToolDefinition.inputSchema` (the provider-agnostic input)
- `src/main/llm/geminiSchema.test.ts` — unit tests

### Recursion Contract

Only `properties` values, `items`, and `anyOf` members are treated as nested schemas and walked. Every other admitted field is copied as data. This is what keeps `default: { const: … }` intact while still filtering a real `const` keyword one level up.

### Observability

`logger.debug('schema sanitized', { tool, translated, dropped })` fires once per tool, only when something changed. In the `⌘\`` log this answers "why did the model stop passing that argument?" without a round trip to the MCP server's source. See [Logger](../../development/logger/logger.md).

### Maintenance

The field list is not folklore — it is `Schema.properties` in Gemini's own discovery document, `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`. When Google adds a field (they have: `anyOf`, `title`, `default`, `propertyOrdering` are all recent), re-read it there and widen the allowlist rather than guessing from SDK typings — `@google/generative-ai`'s TypeScript `Schema` type is narrower than the wire format and would under-report.

`src/main/llm/geminiSchema.test.ts` holds a mirror of the field set inside `assertGeminiClean()`, a walker that re-checks every emitted node against the API's field names *and* shape rules (single-object `items`, array `anyOf`, non-empty containers). It runs against the output of every test, so a keyword added to the walker without being admitted by the API can't slip through. Update both lists together.

### Future Option

The v1beta `FunctionDeclaration` also exposes `parametersJsonSchema`, which accepts full JSON Schema and is mutually exclusive with `parameters`. Adopting it would retire most of this translation. It is newer, model-dependent, and unverified against the legacy `@google/generative-ai` SDK this project uses — treat it as a migration to evaluate, not a drop-in.

## Integration Points

- [Provider Integration](./provider_integration.md) — the cross-provider translation matrix this is one row of
- [Adapters](./adapters.md) — the `LLMAdapter` abstraction and provider configuration
- [Adapters Tech](./adapters_tech.md) — file paths, IPC channels, DB schema for the LLM domain
- [MCP Connections](../../mcp/connections/connections.md) — where `ToolDefinition[]` and its raw `inputSchema` come from
- [Chat Messaging](../../chat/messaging/messaging.md) — the tool-call loop that aggregates tools and drives the adapter
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — agents exposed as emulated MCP tools, whose descriptors go through the same path
- [Logger](../../development/logger/logger.md) — where the sanitize report surfaces
