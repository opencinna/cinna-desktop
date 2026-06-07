import { FileDiff, FilePlus2, FileMinus2, FilePen, ArrowRight } from 'lucide-react'
import type { PatchFile, PatchOp } from '../../utils/applyPatch'
import { DisclosureBlock } from './DisclosureBlock'

/**
 * Renders an OpenCode / Codex `apply_patch` payload as a git-diff style view:
 * an op badge, the file path, an add/delete tally, and colorized hunk lines.
 * Purely presentational — the caller parses the patch (via {@link parsePatch})
 * and passes the structured files, so the parse doubles as the render guard.
 */

const OP_META: Record<PatchOp, { label: string; Icon: typeof FilePen; cls: string }> = {
  add: { label: 'Add', Icon: FilePlus2, cls: 'text-[var(--color-success)] bg-[var(--color-success)]/15' },
  update: { label: 'Update', Icon: FilePen, cls: 'text-[var(--color-accent)] bg-[var(--color-accent)]/15' },
  delete: { label: 'Delete', Icon: FileMinus2, cls: 'text-[var(--color-danger)] bg-[var(--color-danger)]/15' }
}

function FileDiffCard({ file }: { file: PatchFile }): React.JSX.Element {
  const { label, Icon, cls } = OP_META[file.op]
  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
        <Icon size={13} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${cls}`}>
          {label}
        </span>
        <span className="font-mono text-[11px] text-[var(--color-text)] truncate min-w-0 flex items-center gap-1">
          {file.path}
          {file.moveTo && (
            <>
              <ArrowRight size={11} className="shrink-0 text-[var(--color-text-muted)]" />
              {file.moveTo}
            </>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 font-mono text-[10px]">
          {file.additions > 0 && <span className="text-[var(--color-success)]">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-[var(--color-danger)]">−{file.deletions}</span>}
        </span>
      </div>
      {file.lines.length > 0 && (
        <div className="bg-[var(--color-bg)] overflow-x-auto max-h-80 overflow-y-auto">
          <pre className="text-[11px] font-mono leading-relaxed">
            {file.lines.map((ln, i) => {
              if (ln.type === 'hunk') {
                return (
                  <div key={i} className="px-2 py-0.5 text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]/50">
                    @@ {ln.text}
                  </div>
                )
              }
              const sign = ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '
              const lineCls =
                ln.type === 'add'
                  ? 'text-[var(--color-success)] bg-[var(--color-success)]/10'
                  : ln.type === 'del'
                    ? 'text-[var(--color-danger)] bg-[var(--color-danger)]/10'
                    : 'text-[var(--color-text-secondary)]'
              return (
                <div key={i} className={`px-2 whitespace-pre-wrap break-words ${lineCls}`}>
                  <span className="select-none opacity-60 mr-1">{sign}</span>
                  {ln.text}
                </div>
              )
            })}
          </pre>
        </div>
      )}
    </div>
  )
}

interface ApplyPatchBlockProps {
  /** Parsed patch files — produced by the caller via {@link parsePatch}. */
  files: PatchFile[]
  animate?: boolean
  animateDelay?: number
}

export function ApplyPatchBlock({ files, animate, animateDelay }: ApplyPatchBlockProps): React.JSX.Element {
  const fileLabel = files.length === 1 ? '1 file' : `${files.length} files`

  return (
    <DisclosureBlock
      icon={<FileDiff size={12} className="shrink-0 text-[var(--color-text-muted)]" />}
      header={
        <>
          <span className="font-medium">Applying patch</span>
          <span className="text-[var(--color-text-muted)]"> · {fileLabel}</span>
        </>
      }
      animate={animate}
      animateDelay={animateDelay}
    >
      <div className="px-2.5 pb-2.5 pt-0 space-y-2">
        {files.map((f, i) => (
          <FileDiffCard key={`${f.path}-${i}`} file={f} />
        ))}
      </div>
    </DisclosureBlock>
  )
}
