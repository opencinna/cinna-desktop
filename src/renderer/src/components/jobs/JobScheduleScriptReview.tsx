import type { TaskScript } from '../../../../shared/taskScript'

/** The reviewed script is the same captured definition as the save token. */
export function JobScheduleScriptReview({ script }: { script?: TaskScript | null }) {
  if (!script) return null
  return <details open className="rounded-md border border-[var(--color-border)] p-3">
    <summary className="cursor-pointer text-[13px] font-medium text-[var(--color-accent)]">Script steps ({script.steps.length})</summary>
    <ol className="mt-3 space-y-3 text-[12px]">
      {script.steps.map((step, index) => <li key={step.id} className="space-y-1">
        <p className="font-medium text-[var(--color-text)]">{index + 1}. {step.id} · {step.agent ? script.agents[step.agent]?.name ?? step.agent : 'Question for you'}</p>
        <p className="text-[var(--color-text-secondary)]">{step.after?.length ? `Runs after: ${step.after.join(', ')}` : 'Ready at the start'}</p>
        <pre aria-label={`Instructions for ${step.id}`} className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-[12px] text-[var(--color-text)]">{step.prompt ?? step.ask_user}</pre>
      </li>)}
    </ol>
  </details>
}
