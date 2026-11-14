/** rootfs boot.js (vault-init's disk step): the boot message parse (D39) and the format guard (D38). */
import { readFileSync } from 'node:fs'
import { Module } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Parsed { error?: string; diskKey?: Buffer; approvalKey?: Buffer; format?: boolean; growTo?: number; vaultId?: string }
// In the guest boot.js is CommonJS (no package.json beside it); the repo's "type": "module" would
// load it as ESM here, so compile it as a CommonJS module by hand.
const BOOT_JS = join(__dirname, '..', '..', 'rootfs', 'usr', 'lib', 'cinna', 'boot.js')
const mod = new Module(BOOT_JS) as Module & { _compile(src: string, file: string): void }
mod.filename = BOOT_JS
mod._compile(readFileSync(BOOT_JS, 'utf8'), BOOT_JS)
const boot = mod.exports as {
  parseBootMessage(line: Buffer): Parsed
  diskPlan(msg: { format: boolean; growTo?: number }, isLuks: boolean): Plan
  afterProbe(plan: Plan, blkidStatus: number): Plan | null
}
interface Plan { format: boolean; mkfs: boolean; probe: boolean; grow: boolean; kept: boolean }

const DISK = '1f'.repeat(32)
const APPROVAL = '2e'.repeat(32)
const line = (msg: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify(msg))

describe('boot message', () => {
  it('cuts both keys out as Buffers and zeroes the line', () => {
    const buf = line({ diskKey: DISK, approvalKey: APPROVAL, format: true, vaultId: 'v-1', growTo: 4096 })
    const msg = boot.parseBootMessage(buf)
    expect(msg.error).toBeUndefined()
    expect(Buffer.isBuffer(msg.diskKey) && msg.diskKey.toString('latin1')).toBe(DISK)
    expect(Buffer.isBuffer(msg.approvalKey) && msg.approvalKey.toString('latin1')).toBe(APPROVAL)
    expect(msg).toMatchObject({ format: true, vaultId: 'v-1', growTo: 4096 })
    expect(buf.every((b) => b === 0)).toBe(true)
  })

  it('refuses malformed keys and fields with a fixed word', () => {
    const base = { diskKey: DISK, approvalKey: APPROVAL, format: false, vaultId: 'v-1' }
    expect(boot.parseBootMessage(line({ ...base, diskKey: DISK.toUpperCase() })).error).toBe('disk-key')
    expect(boot.parseBootMessage(line({ ...base, diskKey: DISK.slice(2) })).error).toBe('disk-key')
    expect(boot.parseBootMessage(line({ ...base, approvalKey: 'ab' })).error).toBe('approval-key')
    expect(boot.parseBootMessage(line({ ...base, format: 'yes' })).error).toBe('message')
    expect(boot.parseBootMessage(line({ ...base, vaultId: '../x' })).error).toBe('message')
    expect(boot.parseBootMessage(Buffer.from('not json')).error).toBe('message')
  })
})

describe('disk plan (D38)', () => {
  it('formats only a disk without a LUKS header', () => {
    expect(boot.diskPlan({ format: true }, false)).toEqual({ format: true, mkfs: true, probe: false, grow: false, kept: false })
    expect(boot.diskPlan({ format: true }, true)).toEqual({ format: false, mkfs: false, probe: true, grow: false, kept: true })
    expect(boot.diskPlan({ format: true, growTo: 10 }, true)).toEqual({ format: false, mkfs: false, probe: true, grow: true, kept: true })
    expect(boot.diskPlan({ format: false }, true)).toEqual({ format: false, mkfs: false, probe: false, grow: false, kept: false })
  })

  it('makes a filesystem on a kept LUKS disk only when blkid finds none (first boot cut off before mkfs)', () => {
    const kept = boot.diskPlan({ format: true, growTo: 10 }, true)
    // A filesystem is there: never re-made, the grow still runs.
    expect(boot.afterProbe(kept, 0)).toEqual({ format: false, mkfs: false, probe: false, grow: true, kept: true })
    // Nothing identified: mkfs over the whole mapping, no grow.
    expect(boot.afterProbe(kept, 2)).toEqual({ format: false, mkfs: true, probe: false, grow: false, kept: false })
    // blkid could not tell: fail the boot, never format.
    expect(boot.afterProbe(kept, 1)).toBeNull()
    expect(boot.afterProbe(kept, 8)).toBeNull()
    // No probe asked (fresh format, or format:false): the plan stands.
    const fresh = boot.diskPlan({ format: true }, false)
    expect(boot.afterProbe(fresh, 2)).toBe(fresh)
    const reopen = boot.diskPlan({ format: false }, true)
    expect(boot.afterProbe(reopen, 2)).toEqual(reopen)
  })
})
