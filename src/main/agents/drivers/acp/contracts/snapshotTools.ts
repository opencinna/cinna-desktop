/**
 * What the two contract tests share about snapshots: a stable key order, and a
 * readable diff. Moved out of `codex.contract.test.ts` when Claude's contract
 * needed the same two functions — the diff is the "what changed" report, and two
 * copies of it would be two formats to read.
 */
type Json = Record<string, unknown>

/** A unified-style line diff (two lines of context). Empty when equal. The files are ~150 lines, so plain LCS. */
export function lineDiff(before: string, after: string): string {
  if (before === after) return ''
  const a = before.split('\n'), b = after.split('\n')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const lines: { mark: ' ' | '-' | '+'; text: string }[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ mark: ' ', text: a[i] }); i++; j++ }
    else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) lines.push({ mark: '-', text: a[i++] })
    else lines.push({ mark: '+', text: b[j++] })
  }
  const keep = lines.map((line, index) => line.mark !== ' ' || lines.slice(Math.max(0, index - 2), index + 3).some((near) => near.mark !== ' '))
  const out: string[] = []
  lines.forEach((line, index) => {
    if (!keep[index]) return
    if (index > 0 && !keep[index - 1]) out.push(`@@ line ${index + 1} @@`)
    out.push(`${line.mark} ${line.text}`)
  })
  return out.join('\n')
}

export const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as Json).sort().map((key) => [key, sorted((value as Json)[key])]))
  : value
