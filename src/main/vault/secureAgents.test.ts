import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/** README "SecureAgents/ is a reserved name": no walker enters it, nothing is named it, no foreign one is adopted. */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

const { classifyEvent, classifyExternalEvent } = await import('../services/localAgents/watcherService')
const { discoverBareAgents } = await import('../services/localAgents/externalScan')
const { scannerService } = await import('../services/localAgents/scannerService')
const { scaffoldService } = await import('../services/localAgents/scaffoldService')
const { agentsHomeService } = await import('../services/localAgents/agentsHomeService')
const { foreignSecureAgentsDir } = await import('./secureAgentsDir')

let root = ''
beforeEach(() => {
  holder.current = createTestDatabase()
  root = mkdtempSync(join(tmpdir(), 'cinna-secure-'))
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
  rmSync(root, { recursive: true, force: true })
})

describe('SecureAgents/', () => {
  it('is ignored by both watchers, any case and any depth', () => {
    expect(classifyEvent(root, 'SecureAgents')).toEqual({ kind: 'ignore' })
    expect(classifyEvent(root, join('secureagents', 'v1', 'data.img'))).toEqual({ kind: 'ignore' })
    expect(classifyExternalEvent(root, join('SecureAgents', 'v1', 'AGENT.md'))).toEqual({ kind: 'ignore' })
    expect(classifyExternalEvent(root, join('proj', 'SECUREAGENTS'))).toEqual({ kind: 'ignore' })
  })

  it('is never walked for bare agents, nor listed as a kit agent folder', () => {
    mkdirSync(join(root, 'SecureAgents', 'v1'), { recursive: true })
    writeFileSync(join(root, 'SecureAgents', 'v1', 'AGENT.md'), '# hidden\n')
    mkdirSync(join(root, 'real'), { recursive: true })
    writeFileSync(join(root, 'real', 'AGENT.md'), '# real\n')
    expect(discoverBareAgents(root).found.map((found) => found.relPath)).toEqual(['real'])

    mkdirSync(join(root, 'Local', 'SecureAgents'), { recursive: true })
    mkdirSync(join(root, 'Local', 'helper'), { recursive: true })
    expect(scannerService.listAgentDirs(root)).toEqual([join(root, 'Local', 'helper')])
  })

  it('is refused as an agent name or folder name', () => {
    expect(() => scaffoldService.scaffoldAgent({ rootPath: root, slug: 'secureagents', name: 'Vault things', description: 'x' })).toThrow(/reserved/)
    expect(() => scaffoldService.scaffoldAgent({ rootPath: root, slug: 'my-agent', name: 'SecureAgents', description: 'x' })).toThrow(/reserved/)
  })

  it('makes a root that has one Cinna did not make unadoptable, and says why', () => {
    mkdirSync(join(root, 'SecureAgents'))
    expect(foreignSecureAgentsDir(root)).toBe(join(root, 'SecureAgents'))
    expect(() => agentsHomeService.addExternalRoot('__default__', root)).toThrow(/reserved for Agent Vault/)
    expect(() => agentsHomeService.addRoot('__default__', root)).toThrow(/reserved for Agent Vault/)
    // Cinna's own (with its marker) is no obstacle.
    writeFileSync(join(root, 'SecureAgents', '.cinna-vaults'), '')
    expect(foreignSecureAgentsDir(root)).toBeNull()
  })
})
