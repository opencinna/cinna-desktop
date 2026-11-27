import { isAgentEngine, type LocalAgentRuntimeInput, type RunsOnChoice } from '../../src/shared/engine'

/**
 * The Runs-on choice a spec means when it pins an engine or a credential on a
 * kit agent's runtime.
 *
 * Since the app's own choice (`runsOn` in `app-data/desktop.json`) outranks the
 * file, a spec that writes only `cinna-agent.json`'s runtime gets an
 * `unrecorded` conflict and runs on the Default runtime. The Runtime card's
 * Runs-on pick records both in one `updateField` call; this is that call's
 * `runsOn`. An OpenCode credential is a `credential` choice, any other engine
 * an `engine` choice. Null when the block names neither (a tier or a model
 * alone is no Runs-on pick).
 */
export function runsOnFor(runtime: Pick<LocalAgentRuntimeInput, 'engine' | 'credential'>): RunsOnChoice | null {
  const credential = runtime.credential?.trim() ?? ''
  if (credential !== '' && (runtime.engine === 'opencode' || runtime.engine === null)) {
    return { kind: 'credential', name: credential }
  }
  if (runtime.engine !== null && isAgentEngine(runtime.engine)) return { kind: 'engine', engine: runtime.engine }
  return null
}

/** `runtime` with the {@link runsOnFor} choice attached, for `updateField({ field: 'runtime' })`. */
export function withRunsOn(runtime: LocalAgentRuntimeInput): LocalAgentRuntimeInput {
  const runsOn = runsOnFor(runtime)
  return runsOn === null ? runtime : { ...runtime, runsOn }
}
