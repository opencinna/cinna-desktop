import { test, expect } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The `/run:status` failure, as a test: scaffold an agent through the app and
 * run the command `uv` would run. The unit sweep in `scaffoldService.test.ts`
 * catches a leftover token; only this catches a file `uv` refuses for some
 * other reason, because only this runs `uv`.
 */

function walk(dir: string, out: string[] = []): string[] {
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const hasUv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0

test('a scaffolded agent has no leftover tokens and its status script runs under uv', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Status Probe', 'Scaffolded by the E2E suite; says "hi".')
  expect(agent.slug).toBe('status-probe')
  expect(agent.readiness).toBe('ok')
  expect(agent.path.startsWith(root.path)).toBe(true)

  const leftovers = walk(agent.path)
    .filter((file) => /\{\{[A-Z_]+\}\}/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(agent.path, file))
  expect(leftovers).toEqual([])

  test.skip(!hasUv, 'uv is not on PATH')
  const run = spawnSync('uv', ['run', 'scripts/update_status.py'], {
    cwd: agent.path,
    encoding: 'utf8',
    timeout: 120_000
  })
  expect(run.stderr, run.stderr).not.toContain('Failed to parse')
  expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)
})
