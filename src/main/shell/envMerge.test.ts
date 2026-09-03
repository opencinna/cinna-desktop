import { describe, it, expect } from 'vitest'
import {
  CHILD_ENV_ALLOWLIST,
  droppedChildEnvNames,
  mergeEnv,
  shellEnvForChild
} from './envMerge'

describe('mergeEnv', () => {
  it('keeps the base environment', () => {
    expect(mergeEnv({ PATH: '/usr/bin', HOME: '/Users/x' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x'
    })
  })

  it('lets the override win — a server-configured var beats the shell env', () => {
    expect(mergeEnv({ PATH: '/usr/bin', TOKEN: 'shell' }, { TOKEN: 'config' })).toEqual({
      PATH: '/usr/bin',
      TOKEN: 'config'
    })
  })

  it('adds overrides that the base lacks', () => {
    expect(mergeEnv({ PATH: '/usr/bin' }, { EXTRA: '1' }).EXTRA).toBe('1')
  })

  it('drops undefined values so the child-process env type is satisfied', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', UNSET: undefined }
    expect(Object.hasOwn(mergeEnv(env), 'UNSET')).toBe(false)
  })

  it('treats a null/absent override set as no overrides', () => {
    expect(mergeEnv({ PATH: '/usr/bin' }, null)).toEqual({ PATH: '/usr/bin' })
    expect(mergeEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})

/**
 * The rule the MCP stdio spawn implements: the SDK's inherit-allowlist, sourced
 * from the login-shell environment, with `config.env` merged on top. These
 * tests pin the security half — a secret exported in `.zshrc` must not reach a
 * third-party server binary just because we now read `.zshrc`.
 */
describe('shellEnvForChild', () => {
  /** What a real login shell hands back: the useful vars, and the dangerous ones. */
  const shellEnv: NodeJS.ProcessEnv = {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/x',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    GITHUB_TOKEN: 'ghp_secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    OPENAI_API_KEY: 'sk-secret'
  }

  it('passes PATH through — the whole point of resolving the login shell', () => {
    expect(shellEnvForChild(shellEnv).PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('does not leak a secret exported only in the shell profile', () => {
    const child = shellEnvForChild(shellEnv, CHILD_ENV_ALLOWLIST, {})
    for (const secret of [
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY'
    ]) {
      expect(Object.hasOwn(child, secret), secret).toBe(false)
    }
    expect(Object.values(child).join(' ')).not.toContain('secret')
  })

  it('inherits only the allowlisted names', () => {
    expect(
      Object.keys(shellEnvForChild(shellEnv, CHILD_ENV_ALLOWLIST, {})).every((k) =>
        CHILD_ENV_ALLOWLIST.includes(k)
      )
    ).toBe(true)
  })

  it('drops exported shell functions, which an interactive login shell emits', () => {
    // `parseEnvDump` cannot filter these itself — `BASH_FUNC_x%%=() { … }` has a
    // `=` at a positive index like any other record, so it parses as a variable.
    // Two defences catch it: the name is not allowlisted, and the value is
    // `()`-prefixed. Assert both, since either alone would be enough today but
    // an allowlisted name carrying a function value needs the second.
    const child = shellEnvForChild({
      'BASH_FUNC_x%%': '() { echo hi; }',
      SSH_AUTH_SOCK: '() { evil; }',
      TERM: '() { evil; }'
    })
    expect(Object.hasOwn(child, 'BASH_FUNC_x%%')).toBe(false)
    // Only the value filter catches this one: the key IS allowlisted.
    expect(CHILD_ENV_ALLOWLIST).toContain('SSH_AUTH_SOCK')
    expect(Object.hasOwn(child, 'SSH_AUTH_SOCK')).toBe(false)
    expect(Object.hasOwn(child, 'TERM')).toBe(false)
    // A normal value on the same keys is untouched.
    expect(shellEnvForChild({ TERM: 'xterm-256color' }).TERM).toBe('xterm-256color')
  })

  it('keeps the session variables a GUI-launched process already had', () => {
    // Narrowing to the SDK's six keys alone would take these away from a server
    // that declares a `config.env` — a real regression. `SSH_AUTH_SOCK` is the
    // sharp case: git-over-SSH loses agent auth on private repos without it.
    const child = shellEnvForChild({
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc/Listeners',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      TMPDIR: '/var/folders/ab/T/'
    })
    expect(child.SSH_AUTH_SOCK).toBe('/private/tmp/com.apple.launchd.abc/Listeners')
    expect(child.DISPLAY).toBe(':0')
    expect(child.WAYLAND_DISPLAY).toBe('wayland-0')
    expect(child.XAUTHORITY).toBe('/run/user/1000/gdm/Xauthority')
    expect(child.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
    expect(child.TMPDIR).toBe('/var/folders/ab/T/')
  })

  it('inherits TMPDIR, which launchd sets and the non-null branch has today', () => {
    expect(shellEnvForChild({ TMPDIR: '/var/folders/ab/T/' }).TMPDIR).toBe('/var/folders/ab/T/')
  })

  it('never takes a proxy or CA variable from the shell environment', () => {
    // A `.zshrc` export must not introduce these — that is the macOS case, and
    // it is the one place the rule is a refusal rather than a regression fix.
    const child = shellEnvForChild(
      {
        PATH: '/usr/bin',
        HTTP_PROXY: 'http://user:pass@proxy:8080',
        HTTPS_PROXY: 'http://user:pass@proxy:8080',
        NO_PROXY: 'localhost',
        ALL_PROXY: 'socks5://proxy:1080',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
        NODE_PATH: '/opt/node_modules',
        npm_config_registry: 'https://registry.corp'
      },
      CHILD_ENV_ALLOWLIST,
      {} // nothing in our own environment
    )
    expect(Object.keys(child)).toEqual(['PATH'])
  })

  it('excludes NODE_PATH and npm_config_* from both sources', () => {
    const child = shellEnvForChild({ PATH: '/usr/bin' }, CHILD_ENV_ALLOWLIST, {
      NODE_PATH: '/opt/node_modules',
      npm_config_registry: 'https://registry.corp'
    })
    expect(Object.keys(child)).toEqual(['PATH'])
  })

  it('takes a proxy or CA variable from our own environment — the Windows/Linux case', () => {
    // Windows inherits the full user environment from Explorer, and a Linux
    // display manager sources /etc/environment, so a server with a `config.env`
    // receives these today. Narrowing them away would be a real regression.
    const child = shellEnvForChild({ PATH: '/usr/bin' }, CHILD_ENV_ALLOWLIST, {
      HTTPS_PROXY: 'http://proxy.corp:8080',
      https_proxy: 'http://proxy.corp:8080',
      NO_PROXY: 'localhost,.corp',
      NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp.pem'
    })
    expect(child.HTTPS_PROXY).toBe('http://proxy.corp:8080')
    expect(child.https_proxy).toBe('http://proxy.corp:8080')
    expect(child.NO_PROXY).toBe('localhost,.corp')
    expect(child.NODE_EXTRA_CA_CERTS).toBe('C:\\certs\\corp.pem')
  })

  it('applies the () filter on the process.env path too', () => {
    const child = shellEnvForChild({ PATH: '/usr/bin' }, CHILD_ENV_ALLOWLIST, {
      HTTPS_PROXY: '() { evil; }'
    })
    expect(Object.hasOwn(child, 'HTTPS_PROXY')).toBe(false)
  })

  /**
   * These two pin the sourcing, and they matter more than they look.
   * `resolveShellEnv` returns `{ ...process.env, ...parsed }` — the shell dump
   * OVERWRITES `process.env` inside the value passed here as `base`. So the
   * whole guarantee rests on these keys being read from `processEnv` directly
   * rather than from `base`. Sourcing them from `base` would read as obviously
   * correct ("base is the resolved environment") and would silently reverse the
   * precedence, which is exactly the kind of change these tests exist to fail.
   */
  it('prefers our own environment when the shell env disagrees', () => {
    const child = shellEnvForChild(
      { PATH: '/usr/bin', HTTPS_PROXY: 'http://evil:8080' },
      CHILD_ENV_ALLOWLIST,
      { HTTPS_PROXY: 'http://good.corp:8080' }
    )
    expect(child.HTTPS_PROXY).toBe('http://good.corp:8080')
  })

  it('omits the key entirely when only the shell env has it', () => {
    const child = shellEnvForChild(
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://evil:8080',
        https_proxy: 'http://evil:8080',
        HTTP_PROXY: 'http://evil:8080',
        http_proxy: 'http://evil:8080',
        NODE_EXTRA_CA_CERTS: '/tmp/evil.pem'
      },
      CHILD_ENV_ALLOWLIST,
      {} // our own environment has none of them
    )
    // Both spellings, or a tool reading `https_proxy` and one reading
    // `HTTPS_PROXY` would disagree about where the traffic goes.
    for (const key of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NODE_EXTRA_CA_CERTS'
    ]) {
      expect(Object.hasOwn(child, key), key).toBe(false)
    }
    expect(Object.keys(child)).toEqual(['PATH'])
  })

  it('still lets a server opt into a proxy or CA bundle through config.env', () => {
    const child = mergeEnv(shellEnvForChild({ PATH: '/usr/bin' }, CHILD_ENV_ALLOWLIST, {}), {
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem'
    })
    expect(child.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(child.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp.pem')
  })

  it('skips allowlisted names the environment does not define', () => {
    expect(Object.hasOwn(shellEnvForChild({ PATH: '/usr/bin' }), 'HOME')).toBe(false)
  })
})

describe('the MCP stdio env rule', () => {
  const shellEnv: NodeJS.ProcessEnv = {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/x',
    ANTHROPIC_API_KEY: 'sk-ant-secret'
  }

  it('keeps the secret out when the server declares no env of its own', () => {
    const child = mergeEnv(shellEnvForChild(shellEnv, CHILD_ENV_ALLOWLIST, {}), undefined)
    expect(child.PATH).toBe('/opt/homebrew/bin:/usr/bin')
    expect(Object.hasOwn(child, 'ANTHROPIC_API_KEY')).toBe(false)
  })

  it('keeps the secret out when the server declares an env too — no asymmetry', () => {
    const child = mergeEnv(shellEnvForChild(shellEnv, CHILD_ENV_ALLOWLIST, {}), {
      MY_SERVER_TOKEN: 'from-config'
    })
    expect(child.PATH).toBe('/opt/homebrew/bin:/usr/bin')
    expect(child.MY_SERVER_TOKEN).toBe('from-config')
    expect(Object.hasOwn(child, 'ANTHROPIC_API_KEY')).toBe(false)
  })

  it('lets an explicitly configured value win over the allowlisted one', () => {
    const child = mergeEnv(shellEnvForChild(shellEnv, CHILD_ENV_ALLOWLIST, {}), {
      PATH: '/custom/bin'
    })
    expect(child.PATH).toBe('/custom/bin')
  })

  it('lets a server opt into a secret explicitly, which is the supported route', () => {
    const child = mergeEnv(shellEnvForChild(shellEnv, CHILD_ENV_ALLOWLIST, {}), {
      GITHUB_TOKEN: 'chosen-by-the-user'
    })
    expect(child.GITHUB_TOKEN).toBe('chosen-by-the-user')
  })
})

/**
 * The debug line that makes a post-rollout "my MCP server stopped working"
 * report diagnosable. Names only — never values.
 */
describe('droppedChildEnvNames', () => {
  const shellEnv: NodeJS.ProcessEnv = {
    PATH: '/opt/homebrew/bin',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    HTTPS_PROXY: 'http://user:pass@proxy:8080'
  }

  it('names what the narrowing removed', () => {
    expect(droppedChildEnvNames(shellEnv, undefined, {})).toEqual([
      'ANTHROPIC_API_KEY',
      'HTTPS_PROXY'
    ])
  })

  it('does not name what still reaches the child', () => {
    const dropped = droppedChildEnvNames(shellEnv, undefined, {})
    expect(dropped).not.toContain('PATH')
    expect(dropped).not.toContain('SSH_AUTH_SOCK')
  })

  it('does not report a proxy variable our own environment supplies', () => {
    // It reaches the child through the process.env path, so it is not dropped.
    expect(
      droppedChildEnvNames(shellEnv, undefined, { HTTPS_PROXY: 'http://proxy.corp:8080' })
    ).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('accounts for config.env, so an opted-in variable is not reported as dropped', () => {
    expect(droppedChildEnvNames(shellEnv, { HTTPS_PROXY: 'http://proxy:8080' }, {})).toEqual([
      'ANTHROPIC_API_KEY'
    ])
  })

  it('returns names only — no value ever appears in the output', () => {
    const serialized = JSON.stringify(droppedChildEnvNames(shellEnv, undefined, {}))
    expect(serialized).not.toContain('sk-ant-secret')
    expect(serialized).not.toContain('user:pass')
    expect(serialized).not.toContain('proxy:8080')
  })

  it('is empty when nothing is dropped', () => {
    expect(droppedChildEnvNames({ PATH: '/usr/bin' }, undefined, {})).toEqual([])
  })
})
