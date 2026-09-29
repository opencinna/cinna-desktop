import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { swapInto } from './treeSwap'

/**
 * The swap `make kit-sync` uses for `resources/cinna-agent-kit/` and the
 * workshop sync uses for `<root>/.cinna-kit/`: the target is replaced
 * wholesale, and never left missing.
 */
describe('swapInto', () => {
  it('puts the previous tree back when the swap fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-kit-swap-'))
    try {
      const target = join(root, 'bundle')
      const staging = join(root, 'work', 'staging-1')
      mkdirSync(target)
      writeFileSync(join(target, 'old.txt'), 'old')
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'new.txt'), 'new')
      const failing = (from: string, to: string): void => {
        if (from === staging) throw new Error('EXDEV')
        renameSync(from, to)
      }
      expect(() => swapInto(staging, target, failing)).toThrow('EXDEV')
      expect(readFileSync(join(target, 'old.txt'), 'utf8')).toBe('old')
      expect(existsSync(`${staging}.previous`)).toBe(false)
      expect(existsSync(staging)).toBe(false)

      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'new.txt'), 'new')
      swapInto(staging, target)
      // Wholesale: a file the new tree does not have is gone.
      expect(readdirSync(target)).toEqual(['new.txt'])
      expect(existsSync(`${staging}.previous`)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('installs into a target that does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-kit-swap-'))
    try {
      const staging = join(root, 'staging')
      mkdirSync(staging)
      writeFileSync(join(staging, 'a.txt'), 'a')
      swapInto(staging, join(root, 'target'))
      expect(readdirSync(join(root, 'target'))).toEqual(['a.txt'])
      expect(existsSync(staging)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not turn a finished swap into a failure when the parked tree cannot be removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-kit-swap-'))
    try {
      const target = join(root, 'bundle')
      const staging = join(root, 'staging')
      mkdirSync(target)
      writeFileSync(join(target, 'old.txt'), 'old')
      mkdirSync(staging)
      writeFileSync(join(staging, 'new.txt'), 'new')
      const failingRemove = (): void => {
        throw new Error('EBUSY')
      }
      expect(() => swapInto(staging, target, renameSync, failingRemove)).not.toThrow()
      expect(readdirSync(target)).toEqual(['new.txt'])
      // Left for the caller's next sweep.
      expect(existsSync(`${staging}.previous`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names where the previous tree is when it cannot be put back', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-kit-swap-'))
    try {
      const target = join(root, 'bundle')
      const staging = join(root, 'staging')
      mkdirSync(target)
      mkdirSync(staging)
      const failing = (from: string, to: string): void => {
        if (from === target) return renameSync(from, to)
        throw new Error('EIO')
      }
      expect(() => swapInto(staging, target, failing)).toThrow(`it is at ${staging}.previous`)
      expect(existsSync(`${staging}.previous`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
