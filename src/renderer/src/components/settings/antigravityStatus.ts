import {
  ANTIGRAVITY_TIER_MODEL,
  antigravityModelForComplexity,
  type EngineBinaryState
} from '../../../../shared/engine'
import type { WorkComplexity } from '../../../../shared/modelFamilies'
import { ANTIGRAVITY_CLI, cliStatusText, cliToolCell, cliVersionLabel } from './managedCliStatus'

/** The pinned **Antigravity ACP server**'s sentences — `codexStatus.ts`'s twin over the same module. */
export const antigravityStatusText = (binary: EngineBinaryState | undefined, configured = false): string =>
  cliStatusText(ANTIGRAVITY_CLI, binary, configured)

export const antigravityVersionLabel = (binary: EngineBinaryState | undefined, configured = false): string =>
  cliVersionLabel(ANTIGRAVITY_CLI, binary, configured)

export const antigravityToolCell = (binary: EngineBinaryState | undefined, configured = false): { text: string; mono: boolean } =>
  cliToolCell(ANTIGRAVITY_CLI, binary, configured)

/**
 * The model the Antigravity server runs when Cinna sets none — no tier and no
 * model on the agent. `complex` resolves to it too (see `ANTIGRAVITY_TIER_MODEL`).
 */
export const ANTIGRAVITY_SERVER_DEFAULT_MODEL = ANTIGRAVITY_TIER_MODEL.complex

/**
 * `gemini-3.8-flash-high` → `Gemini 3.8 Flash (high)`: a Gemini id with a
 * thinking level, as a person would say it. Anything else stays its id.
 */
export function antigravityModelName(id: string): string {
  const match = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)-(low|medium|high)$/.exec(id)
  if (!match) return id
  const [, version, family, level] = match
  return `Gemini ${version} ${family[0].toUpperCase()}${family.slice(1)} (${level})`
}

/**
 * The model an Antigravity agent actually runs, named for the panel: a model
 * set on the agent wins and is shown as set (main's `runtimeService.resolve`
 * applies it over any tier); otherwise the tier's Flash level, or the server's
 * default when no tier is chosen.
 */
export function antigravityRunModelLabel(declaredModel: string | null, complexity: WorkComplexity | null): string {
  if (declaredModel) return declaredModel
  return antigravityModelName(antigravityModelForComplexity(complexity) ?? ANTIGRAVITY_SERVER_DEFAULT_MODEL)
}

/** The tier select's empty option: `Default (Flash high)`, the server default's family and level. */
export function antigravityDefaultOptionLabel(): string {
  const match = /^gemini-[\d.]+-([a-z]+)-(low|medium|high)$/.exec(ANTIGRAVITY_SERVER_DEFAULT_MODEL)
  if (!match) return 'Default'
  return `Default (${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]})`
}
