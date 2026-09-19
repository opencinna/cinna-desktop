import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDelegationBrief, createDelegationRevision, handoverPaths, type DelegationFileInput } from './delegationFiles'
import { parseHandoverBrief, parseHandoverRevision } from '../../shared/handovers'

const folders: string[] = []
function fixture(): DelegationFileInput {
  const folder = mkdtempSync(join(tmpdir(), 'delegation-files-'))
  folders.push(folder)
  return { folder, id: 'test-work', title: 'A task: with punctuation', brief: 'Do the work.', execution: 'ask', status: 'ready', agentId: 'requester', chatId: 'chat', taskId: 'task', depth: 2 }
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
describe('main-authored handover files', () => {
  it('writes a parseable whole brief with authenticated origin and reporting footer', () => {
    const input = fixture()
    const result = createDelegationBrief(input)
    const parsed = parseHandoverBrief(readFileSync(result.briefPath, 'utf8'))
    expect(parsed).toMatchObject({ ok: true, brief: { title: input.title, depth: 2, origin: { agentId: 'requester', chatId: 'chat', taskId: 'task' } } })
    expect(readFileSync(result.briefPath, 'utf8')).toContain('report.md')
    expect(existsSync(result.reportPath)).toBe(false)
  })
  it('retries idempotently but never overwrites a different ready brief', () => {
    const input = fixture()
    const result = createDelegationBrief(input)
    expect(createDelegationBrief(input)).toEqual(result)
    expect(() => createDelegationBrief({ ...input, chatId: 'stranger' })).toThrow('different brief')
    expect(() => createDelegationBrief({ ...input, brief: 'Changed work' })).toThrow('different brief')
    expect(readFileSync(result.briefPath, 'utf8')).toContain('Do the work.')
  })
  it('supports drafts without converting them to ready on retry', () => {
    const input = { ...fixture(), status: 'draft' as const }
    createDelegationBrief(input)
    expect(createDelegationBrief({ ...input, status: 'ready' }).status).toBe('draft')
  })
  it('refuses traversal and symlinked protocol directories or brief files', () => {
    const input = fixture()
    expect(() => handoverPaths(input.folder, '../escape')).toThrow()
    const outside = fixture().folder
    symlinkSync(outside, join(input.folder, '.cinna'))
    expect(() => createDelegationBrief(input)).toThrow('real directory')
    expect(existsSync(join(outside, 'handovers'))).toBe(false)
    rmSync(join(input.folder, '.cinna'))
    const paths = handoverPaths(input.folder, input.id)
    mkdirSync(paths.folder, { recursive: true })
    const other = join(outside, 'brief.md')
    writeFileSync(other, 'Keep me')
    symlinkSync(other, paths.briefPath)
    expect(() => createDelegationBrief(input)).toThrow('regular file')
    expect(readFileSync(other, 'utf8')).toBe('Keep me')
  })
  it('writes consecutive immutable revision files without touching the report', () => {
    const input = fixture()
    const paths = createDelegationBrief(input)
    writeFileSync(paths.reportPath, 'Executor report')
    const first = createDelegationRevision(input.folder, input.id, 'Use option A.')
    const second = createDelegationRevision(input.folder, input.id, 'Also test it.')
    expect(first).toMatch(/001\.md$/)
    expect(second).toMatch(/002\.md$/)
    expect(parseHandoverRevision(readFileSync(first, 'utf8'))).toMatchObject({ ok: true, revision: { body: 'Use option A.' } })
    expect(readFileSync(paths.reportPath, 'utf8')).toBe('Executor report')
  })
})
