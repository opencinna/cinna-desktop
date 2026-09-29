import { agentFileExtension, agentFileName } from '../../../shared/agentFiles'
import { splitFrontmatter } from './frontmatter'

/** A heading-derived title is cut here, as a transcript excerpt's is. */
const MAX_HEADING_TITLE = 80

/** Saved as written: the note is markdown, and a `.txt` reads as prose. */
const RAW_EXTENSIONS = new Set(['md', 'markdown', 'txt'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

/** Extension → the fence's language tag; anything absent gets an untagged fence. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['ts', 'ts'], ['tsx', 'tsx'], ['mts', 'ts'], ['cts', 'ts'],
  ['js', 'js'], ['jsx', 'jsx'], ['mjs', 'js'], ['cjs', 'js'],
  ['py', 'py'], ['pyi', 'py'],
  ['json', 'json'], ['jsonl', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['toml', 'toml'], ['ini', 'ini'], ['cfg', 'ini'], ['conf', 'ini'],
  ['sh', 'sh'], ['bash', 'bash'], ['zsh', 'zsh'],
  ['sql', 'sql'], ['xml', 'xml'], ['html', 'html'], ['css', 'css'], ['csv', 'csv'], ['tsv', 'tsv'],
  ['rb', 'ruby'], ['go', 'go'], ['rs', 'rust'], ['java', 'java'], ['kt', 'kotlin'], ['swift', 'swift'],
  ['c', 'c'], ['h', 'c'], ['cpp', 'cpp']
])

/** Conventional extensionless names with a language of their own. */
const LANGUAGE_BY_NAME: ReadonlyMap<string, string> = new Map([
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
  ['dockerfile', 'dockerfile'],
  ['containerfile', 'dockerfile']
])

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

interface Heading {
  level: number
  text: string
}

/** ATX and setext headings in order, outside fenced code blocks. */
function headings(markdown: string): Heading[] {
  const out: Heading[] = []
  const lines = markdown.split(/\r?\n/)
  let fence: string | null = null
  let previous: string | null = null
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      previous = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      previous = null
      continue
    }
    const atx = ATX_HEADING.exec(line)
    if (atx) {
      const text = (atx[2] ?? '').trim()
      if (text) out.push({ level: atx[1].length, text })
      previous = null
      continue
    }
    const underline = SETEXT_UNDERLINE.exec(line)
    if (underline && previous !== null && previous.trim() !== '') {
      out.push({ level: underline[1][0] === '=' ? 1 : 2, text: previous.trim() })
      previous = null
      continue
    }
    previous = line.trim() === '' ? null : line
  }
  return out
}

/** Frontmatter `title:`, else the first H1, else the first heading of any level. */
function markdownTitle(text: string): string | null {
  const { frontmatter, body } = splitFrontmatter(text)
  const entry = frontmatter?.entries.find((e) => e.key.toLowerCase() === 'title')
  if (entry?.value.kind === 'text' && entry.value.text.trim()) return entry.value.text.trim()
  const found = headings(body)
  return (found.find((h) => h.level === 1) ?? found[0])?.text ?? null
}

/** The longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

/** The fence language for a file name, `''` when there is none worth naming. */
export function fenceLanguageFor(fileName: string): string {
  const base = agentFileName(fileName).toLowerCase()
  return LANGUAGE_BY_NAME.get(base) ?? LANGUAGE_BY_EXTENSION.get(agentFileExtension(base)) ?? ''
}

/**
 * The note **Save to Notes** makes from a file's contents.
 *
 * Title: for markdown, its frontmatter `title:`, else its first H1, else its
 * first heading, else the file name; for anything else, the file name.
 * Body: markdown and `.txt` as written; anything else in a fenced block tagged
 * with its language, the fence longer than any backtick run inside.
 */
export function fileNoteFromContents(path: string, text: string): { title: string; body: string } {
  const name = agentFileName(path)
  const extension = agentFileExtension(name)
  const heading = MARKDOWN_EXTENSIONS.has(extension) ? markdownTitle(text) : null
  const title = heading ? heading.slice(0, MAX_HEADING_TITLE) : name
  if (RAW_EXTENSIONS.has(extension)) return { title, body: text }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  const content = text.endsWith('\n') ? text : `${text}\n`
  return { title, body: `${fence}${fenceLanguageFor(name)}\n${content}${fence}` }
}
