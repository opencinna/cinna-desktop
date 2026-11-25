import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const {
  ensureGithubGitConfig, writeGithubIdentity, githubGitConfigPath, githubIdentityPath, withGithubGitConfig, withoutGithubGitConfig,
  isOurGitConfig, profileFileKey, githubIdentityContent, withManagedBlock, githubIdentityKeySuffix, GITHUB_IDENTITY_DIR_NAME, MANAGED_BEGIN, MANAGED_END
} = await import('./githubGitConfig')

const NOREPLY = '42+octo@users.noreply.github.com'
const IDENTITY = { name: 'Octo Cat', email: NOREPLY }

const gitPath = (() => {
  const run = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' })
  return run.status === 0 && run.stdout.trim().startsWith('/') ? run.stdout.trim() : null
})()

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** userData with a space in it (macOS "Application Support"), a HOME, and a profile id. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gh-identity-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const dir = join(root, 'Application Support', 'Cinna', GITHUB_IDENTITY_DIR_NAME)
  return { root, home, dir }
}

describe('the env', () => {
  it('sets GIT_CONFIG_GLOBAL to ours, replaces an earlier one of ours, and never one the user set', () => {
    const ours = '/u/Application Support/Cinna/github-identity/p1.gitconfig'
    expect(withGithubGitConfig({ PATH: '/bin' }, ours)).toEqual({ PATH: '/bin', GIT_CONFIG_GLOBAL: ours })
    expect(withGithubGitConfig({ GIT_CONFIG_GLOBAL: '/u/x/github-identity/old.gitconfig' }, ours)).toEqual({ GIT_CONFIG_GLOBAL: ours })
    expect(withGithubGitConfig({ GIT_CONFIG_GLOBAL: '/home/me/.my-gitconfig' }, ours)).toEqual({ GIT_CONFIG_GLOBAL: '/home/me/.my-gitconfig' })
    expect(withGithubGitConfig({ GIT_CONFIG_GLOBAL: '' }, ours)).toEqual({ GIT_CONFIG_GLOBAL: '' })
    // No path (no endpoint, or it could not be written): ours goes, the user's stays.
    expect(withGithubGitConfig({ GIT_CONFIG_GLOBAL: ours }, null)).toEqual({})
    const user = { GIT_CONFIG_GLOBAL: '/home/me/.my-gitconfig' }
    expect(withoutGithubGitConfig(user)).toBe(user)
    expect(withoutGithubGitConfig({ GIT_CONFIG_GLOBAL: ours, HOME: '/h' })).toEqual({ HOME: '/h' })
    expect(isOurGitConfig('/x/github-identity/a.gitconfig.bak')).toBe(false)
  })

  it('keys a warm process by profile only when GIT_CONFIG_GLOBAL is ours', () => {
    const ours = '/u/Application Support/Cinna/github-identity/p1.gitconfig'
    expect(githubIdentityKeySuffix({ GIT_CONFIG_GLOBAL: ours }, 'p1')).toBe(':github-identity:p1')
    expect(githubIdentityKeySuffix({ GIT_CONFIG_GLOBAL: '/home/me/.mine' }, 'p1')).toBe('')
    expect(githubIdentityKeySuffix({}, 'p1')).toBe('')
    expect(githubIdentityKeySuffix({ GIT_CONFIG_GLOBAL: ours }, undefined)).toBe('')
  })

  it('names a plain profile id as it is, anything else by a hash', () => {
    expect(profileFileKey('guest')).toBe('guest')
    expect(profileFileKey('0b6c2f1e-aa')).toBe('0b6c2f1e-aa')
    expect(profileFileKey('../etc/x')).toMatch(/^[0-9a-f]{32}$/)
    expect(isOurGitConfig(githubGitConfigPath('/u/github-identity', '../etc/x'))).toBe(true)
  })

  it('quotes the identity, and refuses a newline', () => {
    expect(githubIdentityContent({ name: 'A "B" \\ C', email: NOREPLY })).toBe(`[user]\n\tname = "A \\"B\\" \\\\ C"\n\temail = "${NOREPLY}"\n`)
    expect(githubIdentityContent({ name: 'A\nB', email: NOREPLY })).toBeNull()
  })
})

describe('the files', () => {
  it('writes the config once, includes the user global files after the identity, and only rewrites a changed one', () => {
    const { home, dir } = fixture()
    const path = ensureGithubGitConfig(dir, 'p1', { HOME: home })!
    expect(path).toBe(githubGitConfigPath(dir, 'p1'))
    const content = readFileSync(path, 'utf8')
    expect(content.indexOf('hasconfig:remote.*.url:https://github.com/**')).toBeLessThan(content.indexOf('[include]'))
    expect(content).toContain(`path = "${join(home, '.config', 'git', 'config')}"\n\tpath = "${join(home, '.gitconfig')}"`)
    // Rewritten only in its managed block: what an agent's `git config --global` appended stays.
    expect(content.startsWith(`${MANAGED_BEGIN}\n`) && content.endsWith(`${MANAGED_END}\n`)).toBe(true)
    writeFileSync(path, `${content}[foo]\n\tbar = 1\n`)
    ensureGithubGitConfig(dir, 'p1', { HOME: home })
    expect(readFileSync(path, 'utf8')).toBe(`${content}[foo]\n\tbar = 1\n`)
    expect(ensureGithubGitConfig(dir, 'p1', { HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') })).toBe(path)
    const moved = readFileSync(path, 'utf8')
    expect(moved).toContain(join(home, 'xdg', 'git', 'config'))
    expect(moved.endsWith(`${MANAGED_END}\n[foo]\n\tbar = 1\n`)).toBe(true)
  })

  it('a file with no whole block (edited by hand) gets the block first, its content kept after it', () => {
    expect(withManagedBlock(null, 'B\n')).toBe('B\n')
    expect(withManagedBlock('[x]\n\ty = 1\n', 'B\n')).toBe('B\n[x]\n\ty = 1\n')
    expect(withManagedBlock(`[a]\n${MANAGED_BEGIN}\nold\n${MANAGED_END}\n[b]\n`, 'B\n')).toBe('[a]\nB\n[b]\n')
  })

  it('writes the identity while signed in and removes it on sign-out', () => {
    const { dir } = fixture()
    writeGithubIdentity(dir, 'p1', IDENTITY)
    expect(readFileSync(githubIdentityPath(dir, 'p1'), 'utf8')).toContain(NOREPLY)
    writeGithubIdentity(dir, 'p1', null)
    expect(existsSync(githubIdentityPath(dir, 'p1'))).toBe(false)
    writeGithubIdentity(dir, 'p1', null)
  })
})

describe.skipIf(!gitPath)('what a real git commits with', () => {
  function setup(options: { signedIn?: boolean; remote?: string } = {}) {
    const fx = fixture()
    if (options.signedIn !== false) writeGithubIdentity(fx.dir, 'p1', IDENTITY)
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: fx.home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: ensureGithubGitConfig(fx.dir, 'p1', { HOME: fx.home })!
    }
    const repo = join(fx.root, 'repo')
    const git = (...args: string[]) => spawnSync(gitPath!, args, { cwd: repo, env, encoding: 'utf8' })
    mkdirSync(repo)
    git('init', '-q')
    git('remote', 'add', 'origin', options.remote ?? 'https://github.com/acme/shop.git')
    const commit = (...pre: string[]) => {
      const out = git(...pre, 'commit', '-q', '--allow-empty', '-m', 'x')
      return out.status === 0 ? git('log', '-1', '--format=%ae|%ce|%an').stdout.trim() : `failed: ${out.stderr.trim()}`
    }
    return { ...fx, git, commit }
  }

  it('(a) no identity anywhere and a github.com remote: author and committer are the noreply', () => {
    expect(setup().commit()).toBe(`${NOREPLY}|${NOREPLY}|Octo Cat`)
  })

  it('(a) every github.com remote form', () => {
    for (const remote of ['git@github.com:acme/shop.git', 'ssh://git@github.com/acme/shop.git', 'https://x-access-token@github.com/acme/shop.git']) {
      expect(setup({ remote }).commit()).toBe(`${NOREPLY}|${NOREPLY}|Octo Cat`)
    }
  })

  it('(b) the user ~/.gitconfig identity wins, and so does the XDG one', () => {
    const fx = setup()
    writeFileSync(join(fx.home, '.gitconfig'), '[user]\n\tname = Real\n\temail = real@example.com\n')
    expect(fx.commit()).toBe('real@example.com|real@example.com|Real')
    rmSync(join(fx.home, '.gitconfig'))
    mkdirSync(join(fx.home, '.config', 'git'), { recursive: true })
    writeFileSync(join(fx.home, '.config', 'git', 'config'), '[user]\n\tname = Xdg\n\temail = xdg@example.com\n')
    expect(fx.commit()).toBe('xdg@example.com|xdg@example.com|Xdg')
  })

  it('(c) a repository-local identity wins', () => {
    const fx = setup()
    fx.git('config', 'user.email', 'local@example.com')
    expect(fx.commit().split('|').slice(0, 2)).toEqual(['local@example.com', 'local@example.com'])
  })

  it('(d) a remote that is not github.com: no noreply', () => {
    expect(setup({ remote: 'https://gitlab.com/acme/shop.git' }).commit()).not.toContain(NOREPLY)
  })

  it('(e) -c user.email wins', () => {
    expect(setup().commit('-c', 'user.email=cli@example.com').split('|')[0]).toBe('cli@example.com')
  })

  it('(f) signed out: no noreply, and a sign-in later reaches the same config path', () => {
    const fx = setup({ signedIn: false })
    expect(fx.commit()).not.toContain(NOREPLY)
    writeGithubIdentity(fx.dir, 'p1', IDENTITY)
    expect(fx.commit()).toBe(`${NOREPLY}|${NOREPLY}|Octo Cat`)
    writeGithubIdentity(fx.dir, 'p1', null)
    expect(fx.commit()).not.toContain(NOREPLY)
  })

  it('an agent `git config --global safe.directory` survives the next prepare, and the block stays current', () => {
    const fx = setup()
    const path = githubGitConfigPath(fx.dir, 'p1')
    expect(fx.git('config', '--global', '--add', 'safe.directory', '/x').status).toBe(0)
    // The next prepare, for a moved XDG config: the block changes, the agent's section stays.
    ensureGithubGitConfig(fx.dir, 'p1', { HOME: fx.home, XDG_CONFIG_HOME: join(fx.home, 'xdg') })
    expect(fx.git('config', '--global', '--get-all', 'safe.directory').stdout.trim()).toBe('/x')
    expect(readFileSync(path, 'utf8')).toContain(join(fx.home, 'xdg', 'git', 'config'))
    expect(fx.commit()).toBe(`${NOREPLY}|${NOREPLY}|Octo Cat`)
  })

  it('(g) this git understands hasconfig (2.36 or later)', () => {
    const version = spawnSync(gitPath!, ['--version'], { encoding: 'utf8' }).stdout.match(/(\d+)\.(\d+)/)
    expect(version).not.toBeNull()
    const [major, minor] = [Number(version![1]), Number(version![2])]
    expect(major > 2 || (major === 2 && minor >= 36)).toBe(true)
  })
})
