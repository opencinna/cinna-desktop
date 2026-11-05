/**
 * Where skill folders taken out of an agent are kept: Replace with Version N's
 * backup of the folder it replaces, and the leftover sweep's set-aside copies
 * it does not put back. Outside the agent, under `<userData>/skill-backups/`,
 * per agent. Its own module so both skill services can use it without
 * importing each other.
 */

import { join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'

/** Where the leftover sweep moves a set-aside copy it does not put back: beside Replace's backups, marked as such. */
export function leftoverBackup(agentId: string): (skill: string, at: number) => string {
  return (skill, at) => `${skillBackupDir(agentId, skill, new Date(at))}-set-aside`
}

/** Where Replace keeps the folder it replaces: outside the agent, per agent, one folder per replace. */
export function skillBackupDir(agentId: string, name: string, at: Date = new Date()): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'agent'
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return join(runtimeHost.getPath('userData'), 'skill-backups', safe(agentId), `${name}-${stamp}`)
}
