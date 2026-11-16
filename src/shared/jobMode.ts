/**
 * The Assistant job mode, as Cinna Mobile writes it.
 *
 * A mobile job that runs as the Assistant syncs with the manifest `modeName`
 * `@assistant` — a reserved value, not a chat mode (mobile:
 * `src/jobs/jobMode.ts`). The desktop has no Assistant, so such a job never
 * runs here: it resolves to no mode on pull, keeps the marker through local
 * edits (`buildJobManifest`), and every run entry point refuses it. The marker
 * wins over a chat mode that happens to carry the same name, as on mobile.
 *
 * Pure, with no imports: main, renderer and the Hub core all read it.
 */

/** Manifest `modeName` of a job that runs as the Assistant on mobile. */
export const ASSISTANT_JOB_MODE = '@assistant'

/** Where a job's mode is shown on the desktop. */
export const ASSISTANT_JOB_MODE_LABEL = 'Assistant (runs on mobile)'

/** The one-line explanation beside a disabled Run control. */
export const ASSISTANT_JOB_RUN_HINT = 'Runs on mobile as the Assistant. Pick a desktop mode in Edit to run it here.'

/** The same, beside the Job's disabled New schedule control. */
export const ASSISTANT_JOB_SCHEDULE_HINT = 'Runs on mobile as the Assistant. Pick a desktop mode in Edit to schedule it here.'

/** Trim + lowercase compare, matching mobile's `isAssistantJobMode`. */
export function isAssistantJobMode(modeName: string | null | undefined): boolean {
  return (modeName ?? '').trim().toLowerCase() === ASSISTANT_JOB_MODE
}
