import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPONENT_NAME_PATTERN,
  DASHBOARDS_PROTOCOL,
  DASHBOARDS_SCHEMA_REPO_PATH,
  DASHBOARDS_SCHEMA_VERSION,
  ENDPOINT_NAME_PATTERN,
  ENDPOINT_RUNTIMES,
  ENDPOINT_SCRIPT_PATTERN,
  ENDPOINT_TIMEOUT_DEFAULT_S,
  ENDPOINT_TIMEOUT_MAX_S,
  ENTRY_PATTERN,
  FILE_SOURCE_EXTENSIONS,
  FILE_SOURCE_ROOTS,
  MAX_PROMPT_LABEL,
  MAX_PROMPT_TEXT,
  MAX_PROMPTS,
  PARAM_NAME_PATTERN,
  PARAM_TYPES,
  SOURCE_FILE_PATTERN
} from './dashboardsProtocol'

/**
 * The parity ratchet of the dashboards protocol: the rules the component
 * scanner applies by hand are the ones the bundled `dashboards.schema.json`
 * states. The schema is cinna-core's; when this fails after `make kit-sync`,
 * the constants in `dashboardsProtocol.ts` (and the scanner behind them)
 * follow the schema, never the other way round.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = JSON.parse(readFileSync(join(repoRoot, DASHBOARDS_SCHEMA_REPO_PATH), 'utf8')) as any
const component = schema.$defs.component
const endpoint = component.properties.endpoints.additionalProperties.properties

/** A JS regex written as the schema's pattern string (JSON Schema patterns are ECMA-262). */
const source = (re: RegExp): string => re.source.replace(/\\\//g, '/')

describe('dashboardsProtocol.ts matches dashboards.schema.json', () => {
  it('is the protocol and schema version this desktop reads', () => {
    expect(schema.cinna_protocol).toBe(DASHBOARDS_PROTOCOL)
    expect(schema.protocol_version).toBe(1)
    expect(component.properties.schema_version.const).toBe(DASHBOARDS_SCHEMA_VERSION)
  })

  it('names components, endpoints and params by the schema’s patterns', () => {
    expect(source(COMPONENT_NAME_PATTERN)).toBe(schema.$defs.component_name.pattern)
    expect(source(ENDPOINT_NAME_PATTERN)).toBe(schema.$defs.endpoint_name.pattern)
    expect(source(PARAM_NAME_PATTERN)).toBe(component.properties.params.propertyNames.pattern)
  })

  it('confines scripts, the entry and file sources by the schema’s patterns', () => {
    expect(source(ENDPOINT_SCRIPT_PATTERN)).toBe(endpoint.script.pattern)
    expect(source(ENTRY_PATTERN)).toBe(component.properties.entry.pattern)
    const fileSource = component.properties.source.oneOf.find((branch: { properties?: { file?: unknown } }) => branch.properties?.file)
    expect(source(SOURCE_FILE_PATTERN)).toBe(fileSource.properties.file.pattern)
  })

  it('derives the runtimes and file-source rules from those patterns', () => {
    const scriptExtensions = /\\\.\(([^)]+)\)\$$/.exec(endpoint.script.pattern)![1].split('|').map((e: string) => `.${e}`)
    expect(Object.keys(ENDPOINT_RUNTIMES).sort()).toEqual(scriptExtensions.sort())
    const fileExtensions = /\\\.\(([^)]+)\)\$$/.exec(SOURCE_FILE_PATTERN.source)![1].split('|').map((e) => `.${e}`)
    expect([...FILE_SOURCE_EXTENSIONS].sort()).toEqual(fileExtensions.sort())
    const roots = /^\^\(([^)]+)\)/.exec(SOURCE_FILE_PATTERN.source)![1].split('|').map((r) => `${r}/`)
    expect([...FILE_SOURCE_ROOTS].sort()).toEqual(roots.sort())
  })

  it('times endpoints out as the schema does', () => {
    expect(endpoint.timeout_s.default).toBe(ENDPOINT_TIMEOUT_DEFAULT_S)
    expect(endpoint.timeout_s.maximum).toBe(ENDPOINT_TIMEOUT_MAX_S)
  })

  it('knows the schema’s param types and prompt limits', () => {
    expect([...PARAM_TYPES]).toEqual(component.properties.params.additionalProperties.properties.type.enum)
    const prompts = component.properties.prompts
    expect(prompts.maxItems).toBe(MAX_PROMPTS)
    expect(prompts.items.properties.label.maxLength).toBe(MAX_PROMPT_LABEL)
    expect(prompts.items.properties.prompt.maxLength).toBe(MAX_PROMPT_TEXT)
  })
})
