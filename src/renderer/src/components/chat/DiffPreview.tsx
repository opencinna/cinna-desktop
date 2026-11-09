import { Fragment, useMemo } from 'react'
import { diffFileLabel, parseDiff, type DiffFile, type DiffHunk, type DiffRow, type ParsedDiff } from '../../utils/diffDocument'
import { MAX_HIGHLIGHT_CHARS, PreviewNote, plainTextNote } from './CodePreview'

const STATUS_LABEL: Partial<Record<DiffFile['status'], string>> = {
  added: 'New file',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  mode: 'Mode changed'
}

const ROW_TONE = {
  add: 'bg-[var(--color-success)]/10',
  del: 'bg-[var(--color-danger)]/10',
  context: ''
} as const
const MARK_TONE = {
  add: 'bg-[var(--color-success)]/30',
  del: 'bg-[var(--color-danger)]/30',
  context: ''
} as const
const SIGN = { add: '+', del: '−', context: '' } as const
const SIGN_TONE = {
  add: 'text-[var(--color-success)]',
  del: 'text-[var(--color-danger)]',
  context: ''
} as const

/**
 * A diff for a person to read rather than a tool to apply: file cards with what
 * changed in each, removals and additions on tinted rows, and inside a replaced
 * line the words that actually differ. Sign and line number are not selectable,
 * so a selection copies the text alone. Sits at the JSON tree's size (`text-xs`,
 * relaxed leading) so it reads as a sibling of the other previews.
 *
 * `parsed` comes from the modal, which also builds the Contents list from it;
 * the artifact preview passes none and it is parsed here.
 */
export function DiffPreview({ text, parsed }: { text: string; parsed?: ParsedDiff | null }): React.JSX.Element {
  const plain = text.length > MAX_HIGHLIGHT_CHARS
  const diff = useMemo(
    () => (plain ? null : parsed !== undefined ? parsed : parseDiff(text)),
    [plain, parsed, text]
  )
  if (!diff) {
    return (
      <>
        <PreviewNote>
          {plain ? plainTextNote('format') : "This doesn't read as a diff, so it is shown as text."}
        </PreviewNote>
        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-[var(--color-text)]">{text}</pre>
      </>
    )
  }
  if (diff.files.length === 0) {
    return <div className="text-xs italic text-[var(--color-text-muted)]">This diff is empty.</div>
  }
  return (
    <div data-testid="diff-preview" className="space-y-3 text-xs leading-relaxed text-[var(--color-text)]">
      {diff.preamble.length > 0 && <FreeText lines={diff.preamble} />}
      {diff.files.length > 1 && (
        <Summary label={`${diff.files.length} files changed`} additions={diff.additions} deletions={diff.deletions} />
      )}
      {diff.headerless && <div className="text-[var(--color-text-muted)]">{countChanges(diff.changes)}</div>}
      {diff.files.map((file) =>
        diff.headerless ? (
          <Hunks key={file.sourceLine} file={file} flowing={diff.flowing} />
        ) : (
          <Fragment key={file.sourceLine}>
            {file.preamble.length > 0 && <FreeText lines={file.preamble} />}
            <FileCard file={file} flowing={diff.flowing} />
          </Fragment>
        )
      )}
    </div>
  )
}

function countChanges(changes: number): string {
  return changes === 1 ? '1 change' : `${changes} changes`
}

function Counts({ additions, deletions }: { additions: number; deletions: number }): React.JSX.Element {
  return (
    <span className="shrink-0 whitespace-nowrap font-mono">
      {additions > 0 && <span className="text-[var(--color-success)]">+{additions}</span>}
      {additions > 0 && deletions > 0 && ' '}
      {deletions > 0 && <span className="text-[var(--color-danger)]">−{deletions}</span>}
    </span>
  )
}

function Summary({ label, additions, deletions }: { label: string; additions: number; deletions: number }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
      <span>{label}</span>
      <Counts additions={additions} deletions={deletions} />
    </div>
  )
}

/** A patch mail's envelope line and the `---` before its stat say nothing to a reader. */
const MAIL_NOISE = /^(?:From [0-9a-f]{4,40} Mon Sep 17 .*|---)$/

function FreeText({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <pre className="font-sans whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
      {lines.filter((line) => !MAIL_NOISE.test(line)).join('\n').trim()}
    </pre>
  )
}

function FileCard({ file, flowing }: { file: DiffFile; flowing: boolean }): React.JSX.Element {
  const status = STATUS_LABEL[file.status]
  const label = diffFileLabel(file)
  const hasRows = file.hunks.some((hunk) => hunk.rows.length > 0)
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--color-border)]">
      <header
        data-heading-line={file.sourceLine}
        className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5"
      >
        <span title={label} className="min-w-0 truncate font-mono font-semibold">
          {label}
        </span>
        {status && (
          <span className="shrink-0 rounded border border-[var(--color-border)] px-1.5 text-[10px] text-[var(--color-text-muted)]">
            {status}
          </span>
        )}
        <span className="flex-1" />
        <Counts additions={file.additions} deletions={file.deletions} />
      </header>
      {hasRows ? (
        <div className="py-1">
          <Hunks file={file} flowing={flowing} />
        </div>
      ) : (
        <div className="px-3 py-1.5 italic text-[var(--color-text-muted)]">
          {file.status === 'binary' ? 'Binary file, not shown.' : 'No changes to the content.'}
        </div>
      )}
      {file.trailing.length > 0 && (
        <div className="border-t border-[var(--color-border)] px-3 py-1.5">
          <FreeText lines={file.trailing} />
        </div>
      )}
    </section>
  )
}

/** Each hunk, under a line saying where it is once there is more than the start of the file to say. */
function Hunks({ file, flowing }: { file: DiffFile; flowing: boolean }): React.JSX.Element {
  // Wide enough for the file's largest line number, so the text column does not shift between hunks.
  const gutter = useMemo(() => {
    if (flowing) return 0
    let widest = 0
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.kind !== 'note' && row.line !== null && row.line > widest) widest = row.line
      }
    }
    return widest === 0 ? 0 : String(widest).length
  }, [file, flowing])
  return (
    <>
      {file.hunks.map((hunk, index) => (
        <div key={index} className={index > 0 ? 'mt-1' : undefined}>
          <HunkTitle hunk={hunk} first={index === 0} />
          <Rows rows={hunk.rows} gutter={gutter} flowing={flowing} />
        </div>
      ))}
    </>
  )
}

/** What the hunk is inside, when the diff says; otherwise a gap says "further on". The gutter has the line. */
function HunkTitle({ hunk, first }: { hunk: DiffHunk; first: boolean }): React.JSX.Element | null {
  if (!hunk.section) {
    return first ? null : <div aria-hidden className="py-1 text-center text-[var(--color-text-muted)]">⋯</div>
  }
  return (
    <div
      title={hunk.section}
      className="truncate bg-[var(--color-bg-hover)] px-3 py-0.5 font-mono text-[var(--color-text-secondary)]"
    >
      {hunk.section}
    </div>
  )
}

function Rows({ rows, gutter, flowing }: { rows: DiffRow[]; gutter: number; flowing: boolean }): React.JSX.Element {
  return (
    <>
      {rows.map((row, index) => {
        if (row.kind === 'note') {
          return (
            <div key={index} className="px-3 italic text-[var(--color-text-muted)]">
              {row.text}
            </div>
          )
        }
        // With no line numbers to tell changes apart, a gap does; a removal and
        // what replaced it stay together.
        const next = rows[index + 1]
        const endsChange =
          gutter === 0 && next && next.kind !== 'note' && next.kind !== row.kind && !(row.kind === 'del' && next.kind === 'add')
        return (
          <div
            key={index}
            data-diff-row={row.kind}
            className={`flex gap-2 pr-3 ${gutter > 0 ? 'pl-2' : 'pl-3'} ${ROW_TONE[row.kind]} ${endsChange ? 'mb-2' : ''}`}
          >
            {gutter > 0 && (
              <span
                aria-hidden
                style={{ width: `${gutter}ch` }}
                className="shrink-0 select-none text-right font-mono text-[var(--color-text-muted)]"
              >
                {/* A removal's number is the old file's: among the new file's it would point at the wrong line. */}
                {row.kind === 'del' ? null : row.line}
              </span>
            )}
            <span aria-hidden className={`w-2.5 shrink-0 select-none font-mono ${SIGN_TONE[row.kind]}`}>
              {SIGN[row.kind]}
            </span>
            <span
              className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${flowing ? '' : 'font-mono'} ${
                row.kind === 'context' ? 'text-[var(--color-text-secondary)]' : ''
              }`}
            >
              {row.segments
                ? row.segments.map((segment, at) =>
                    segment.changed ? (
                      <mark key={at} className={`rounded-sm text-inherit ${MARK_TONE[row.kind]}`}>
                        {segment.text}
                      </mark>
                    ) : (
                      segment.text
                    )
                  )
                : row.text}
            </span>
          </div>
        )
      })}
    </>
  )
}
