/**
 * The one place a runtime version lives.
 *
 * Cinna runs four external agent runtimes — OpenCode, Codex, Claude Code and
 * Antigravity. Codex and Claude Code run through an ACP adapter that is an
 * exact `package.json` pin; Antigravity's server speaks ACP itself. Git is
 * downloaded too, only for a machine that has none. A version
 * that is compared, downloaded or displayed anywhere in the app is read from
 * here, so bumping a runtime is one edit plus the checksums that prove it.
 *
 * **Dependency-free on purpose.** This file is imported by main, by the
 * renderer, by the E2E fixtures and by plain-Node scripts running under
 * `node --experimental-strip-types` (the contract probe, the runtime
 * installer). It must stay a module of literals: no imports, no enums, nothing
 * a type-stripping loader cannot run.
 *
 * Two files cannot import TypeScript and therefore repeat a value from here:
 * `package.json` (the adapter versions) and `codexAdapterPatch.json` /
 * `claudeAdapterPatch.json` (read by the CommonJS postinstall and packaging
 * hooks). `runtimePins.test.ts` fails when any of them disagrees with this manifest.
 *
 * ## How the checksums were produced
 *
 * Each `sha256` was computed by downloading the asset from the vendor's own
 * release (for OpenCode, its npm registry packages) and hashing the bytes —
 * never copied from a listing. They pin *these
 * exact bytes*; they are not a signature (see `managed/managedAsset.ts`).
 * Bumping a version means recomputing every row for it.
 */

/** One downloadable release asset for one `${process.platform}-${process.arch}`. */
export interface RuntimePinAsset {
  /** Asset file name in the release. */
  file: string
  /** SHA-256 of the asset's exact bytes, hex. */
  sha256: string
  /** Where the asset is downloaded from. Absent when the tool derives it from the version. */
  url?: string
  /**
   * The executable's name *inside* the archive, when it differs from the name
   * it is installed under. Codex archives hold `codex-<target triple>`.
   */
  executable?: string
  /**
   * `executable` — the asset **is** the executable, not an archive holding it,
   * so nothing is unpacked: the verified file is moved into place under the
   * tool's binary name. Claude Code ships this way. Absent means an archive.
   *
   * `format`, not `kind`, and not the word "bare": both already mean something
   * else here — an agent folder's kind — and `kindBranches.test.ts` counts
   * every `.kind ===` in the tree.
   */
  format?: 'archive' | 'executable'
  /**
   * Exact byte length — the vendor's published one, or the count of the bytes
   * that were hashed for `sha256`. It is the download's size
   * ceiling for an asset larger than the default guard, and the denominator of
   * a progress line when the server declares no length.
   */
  size?: number
  /**
   * Further files installed **beside** the executable, each from its own pinned
   * archive of the same release. A managed install is not complete — and the
   * resolver repairs it — until every one is there. Codex needs one; see its
   * `assets`.
   */
  companions?: readonly RuntimePinCompanion[]
  /**
   * Further files the **same archive** holds beside the executable, by name.
   * Nothing extra is downloaded: the published directory is the one holding the
   * executable, so they arrive with it — but an install that lacks one is not
   * an install (a directory published half-way, or a later deletion), and the
   * resolver installs it again. Antigravity's server needs
   * `localharness_external` beside `agy_acp_server.par`.
   */
  siblings?: readonly string[]
}

/** A file that must sit beside a runtime's executable, pinned like the asset itself. */
export interface RuntimePinCompanion {
  /** Archive file name in the release. */
  file: string
  /** SHA-256 of the archive's exact bytes, hex. */
  sha256: string
  url: string
  /** The file's name inside the archive. */
  executable: string
  /** Its name once installed, in the same directory as the main executable. */
  installAs: string
  /** Exact byte length of the archive. */
  size: number
}

const CLAUDE_CLI = '2.1.318'
const CLAUDE_RELEASE =
  `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${CLAUDE_CLI}`

function claudeAsset(platform: string, sha256: string, size: number): RuntimePinAsset {
  return { file: 'claude', sha256, url: `${CLAUDE_RELEASE}/${platform}/claude`, format: 'executable', size }
}

const CODEX_CLI = '0.167.0'
const CODEX_RELEASE = `https://github.com/openai/codex/releases/download/rust-v${CODEX_CLI}`

/** The `codex-code-mode-host` archive of the same release and triple. POSIX tarballs only. */
function codexCodeModeHost(triple: string, sha256: string, size: number): RuntimePinCompanion {
  const executable = `codex-code-mode-host-${triple}`
  const file = `${executable}.tar.gz`
  return { file, sha256, url: `${CODEX_RELEASE}/${file}`, executable, installAs: 'codex-code-mode-host', size }
}

function codexAsset(
  triple: string,
  archive: 'tar.gz' | 'zip',
  sha256: string,
  size: number,
  host: { sha256: string; size: number }
): RuntimePinAsset {
  const windows = triple.endsWith('windows-msvc')
  const executable = `codex-${triple}${windows ? '.exe' : ''}`
  const file = `${executable}.${archive}`
  return {
    file,
    sha256,
    url: `${CODEX_RELEASE}/${file}`,
    executable,
    size,
    companions: [codexCodeModeHost(triple, host.sha256, host.size)]
  }
}

const ANTIGRAVITY_CLI = '1.4.5'

/** One Antigravity ACP server zip: `<os>` is `macos` or `linux` in Google's release path. */
function antigravityAsset(os: 'macos' | 'linux', file: string, sha256: string, size: number): RuntimePinAsset {
  return {
    file,
    sha256,
    url: `https://dl.google.com/agy-extensions/releases/${os}/${file}`,
    executable: 'agy_acp_server.par',
    size,
    siblings: ['localharness_external']
  }
}

const OPENCODE_CLI = '2.2.5'

/**
 * One `@opencode/cli-<target>` platform tarball from the npm registry. npm
 * names the Windows packages `windows-*`; the executable sits at
 * `package/bin/opencode` (`opencode.exe` on Windows).
 */
function opencodeAsset(target: string, sha256: string, size: number): RuntimePinAsset {
  const file = `cli-${target}-${OPENCODE_CLI}.tgz`
  return {
    file,
    sha256,
    url: `https://registry.npmjs.org/@opencode/cli-${target}/-/${file}`,
    executable: target.startsWith('windows-') ? 'opencode.exe' : 'opencode',
    size
  }
}

const GIT_CLI = '2.56.0'
/** dugite-native's release tag; its second repackaging of git 2.56.0. */
const GIT_RELEASE_TAG = 'v2.56.0-2'
const GIT_RELEASE = `https://github.com/desktop/dugite-native/releases/download/${GIT_RELEASE_TAG}`
/** Asset names carry the git version and the short commit dugite-native built from, not the tag. */
const GIT_ASSET_PREFIX = `dugite-native-v${GIT_CLI}-a44aeca`

/** One dugite-native tarball: `<plat>` is the release's own platform name. */
function gitAsset(plat: string, sha256: string, size: number): RuntimePinAsset {
  const file = `${GIT_ASSET_PREFIX}-${plat}.tar.gz`
  return { file, sha256, url: `${GIT_RELEASE}/${file}`, size }
}

export const RUNTIME_PINS = {
  claude: {
    cli: CLAUDE_CLI,
    /** Exactly what `claude --version` prints for the pin. */
    versionOutput: `${CLAUDE_CLI} (Claude Code)`,
    adapter: '0.101.0',
    /** `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` as published (checked against the locked npm tarball). */
    adapterOriginalSha256: 'aa7681b597fc44748ae57877c1eb92dae9e701bc02d6594cbb718540a9217b50',
    /** The same file after `scripts/patch-claude-agent-acp.cjs` (the `_cinna/contextUsage` request, and `air.client` forced off). */
    adapterPatchedSha256: 'b009fefc2ae0a0ccb57136e29fcc28483d5e9dc8653358b93ba09dc7f0d801cb',
    /** `dist/native-subagents.js` as published, from the same tarball. */
    adapterSubagentsOriginalSha256: '4417e917642de18b63d2c3de2ddfc849b4995bbdd3de93b18786a9db7e11835f',
    /** The same file after `scripts/patch-claude-agent-acp.cjs` (a SendMessage-resumed subagent keyed by the Agent call its frames name, and not ended by that call's late notification; `subagent_spawned` names the Agent call the child runs under). */
    adapterSubagentsPatchedSha256: '1820e3cabc76e20878ece2a2f33d911f79813cbc6204608ba77ff41c415807c8',
    /**
     * Anthropic's own release bucket — the one `claude`'s installer and updater
     * read. `<release>/manifest.json` lists `platforms.<key>.{binary, checksum,
     * size}`; the executable is `<release>/<key>/<binary>`, a single file, not an archive.
     *
     * Every row was downloaded from the bucket and hashed on 2026-11-06 (`make
     * pin-assets` with `--verify`), and agreed with the manifest's `checksum`
     * and `size`.
     *
     * Linux rows are the glibc builds (the manifest also has `-musl` keys; see
     * `engine/binaryResolver.ts` for why libc is not detected). **Windows is
     * absent**: the launcher's child-environment rules and the login probe are
     * POSIX-verified only, so a Windows user sets a Claude Path in Settings.
     */
    assets: {
      'darwin-arm64': claudeAsset('darwin-arm64', '677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d', 319598464),
      'darwin-x64': claudeAsset('darwin-x64', 'ee9c8577a528aa8efa478bf552b17efa40bb58aa4981d2913c13d383a4d409a4', 334272544),
      'linux-x64': claudeAsset('linux-x64', '708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd', 337814032),
      'linux-arm64': claudeAsset('linux-arm64', '53a0d7e219d7b0804ecba5dbc002745e89f786cc946d2de85a6470d5b2d1fb06', 337438136)
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  codex: {
    cli: CODEX_CLI,
    /** Exactly what `codex --version` prints for the pin. */
    versionOutput: `codex-cli ${CODEX_CLI}`,
    adapter: '2.5.0',
    /** `@agentclientprotocol/codex-acp/dist/index.js` as published (checked against the locked npm tarball). */
    adapterOriginalSha256: '15de6b2dd5203876a48b12861378bcf87040d623ab2159e05052dc9d54c32b16',
    /** The same file after `scripts/patch-codex-acp.cjs` (MCP merge, session instructions, `isAirClient` forced false, the whole command output on the completing update, and a cancel that interrupts the subagent threads too). */
    adapterPatchedSha256: 'f1dc49e2a08c26832c29df4f2fb949715a985c198383f9cfaa1fde76eac8a7da',
    /**
     * The vendor's unmodified GitHub release archives for `rust-v0.167.0`: the
     * `codex` archive, and beside it the `codex-code-mode-host` archive of the
     * same triple as a companion. Every archive, main and companion, was
     * downloaded and hashed 2026-11-06 (`make pin-assets`); each `size` is the
     * byte count of that same download, so it is exact for the digest beside
     * it. Linux is the musl build — the only one the release ships.
     *
     * **Why the host is needed.** From 0.155.0 the `code_mode_host` feature is
     * stable and on by default, and a bare (non-package) install looks for
     * `codex-code-mode-host` in the directory of its own executable; without it
     * Code Mode is unavailable and the agent reports "the required
     * codex-code-mode-host executable is missing". So the managed install is two files, and a bump recomputes the
     * companion rows as well as the main ones. From 0.166.0 a release also
     * ships `codex-exec-server-<triple>`, the standalone remote executor; it is
     * not a companion: `codex` links the same executor in (`codex exec-server`)
     * and the contract runs green on the two files alone.
     *
     * **Windows is absent deliberately.** Its release zip is not one
     * executable: `codex-<triple>.exe` ships beside
     * `codex-windows-sandbox-setup.exe` and a command runner, none of which the
     * companion rows describe, and the restricted chat
     * policy is POSIX-only regardless. A Windows user sets the Codex path in
     * Settings, which is the answer an unlisted platform already gets.
     */
    assets: {
      'darwin-arm64': codexAsset(
        'aarch64-apple-darwin',
        'tar.gz',
        '4b22a2a971be2791c3e31f912f3e77a88ebd64a65812a7289ccba65dd6425fe9',
        108379331,
        { sha256: '876a3e263348ef0edaeae5cf5bc52a5c121141cefd15157ab0eeca305f3eb563', size: 25262553 }
      ),
      'darwin-x64': codexAsset(
        'x86_64-apple-darwin',
        'tar.gz',
        'd8eb4a865a0b17319cde10347523e5bab0978d01725b39f4a639f40905e01221',
        117941240,
        { sha256: '612d0dc2c7316fbf05ee922796f4d740a285b76a55d4c78e1b946ba621bdcc91', size: 27285629 }
      ),
      'linux-x64': codexAsset(
        'x86_64-unknown-linux-musl',
        'tar.gz',
        '9d64836106d5b374e90ee4454c7ebcde7ca7106558bd7e41a34b9f26ebda251a',
        122587028,
        { sha256: 'b5074d5dd64643b2c073927e494a588eff31c1f5a27f12c1e2c45f9a6cf07dd4', size: 29079293 }
      ),
      'linux-arm64': codexAsset(
        'aarch64-unknown-linux-musl',
        'tar.gz',
        '843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281',
        114300898,
        { sha256: '6e99948fa20ca816a01f222a56afa261b321e00cbed611d76bb92c765fd11ec6', size: 27500578 }
      )
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  antigravity: {
    cli: ANTIGRAVITY_CLI,
    /**
     * Google's own release zips. Each holds `agy_acp_server.par` (the ACP
     * server, installed under that name) and `localharness_external` at the
     * archive root, so both land in one directory with nothing else to fetch.
     * Every row was downloaded and hashed on 2026-11-06; `size` is the byte
     * count of that download, and must stay set — the Linux zips are larger
     * than the download guard's default ceiling.
     *
     * The server is never asked for `--version` (it prints absl build info,
     * not a version line, and is slow), so nothing here records a version
     * line: the digest is the only proof of version.
     * **Windows is absent**: Cinna does not ship there for this engine.
     */
    assets: {
      'darwin-arm64': antigravityAsset(
        'macos',
        `agy-acp-server-${ANTIGRAVITY_CLI}-darwin-arm64.zip`,
        '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f',
        97923855
      ),
      'darwin-x64': antigravityAsset(
        'macos',
        `agy-acp-server-${ANTIGRAVITY_CLI}-darwin-x86_64.zip`,
        'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a',
        103577295
      ),
      'linux-x64': antigravityAsset(
        'linux',
        `agy-acp-server-${ANTIGRAVITY_CLI}-linux-x86_64.zip`,
        '923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b',
        321783181
      ),
      'linux-arm64': antigravityAsset(
        'linux',
        `agy-acp-server-${ANTIGRAVITY_CLI}-linux-arm64.zip`,
        '7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056',
        307829008
      )
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  opencode: {
    cli: OPENCODE_CLI,
    /** Exactly what `opencode --version` prints for the pin (1.x printed the bare version). */
    versionOutput: `opencode v${OPENCODE_CLI}`,
    /**
     * The npm platform packages of `@opencode/cli` — OpenCode 2 publishes no
     * GitHub release, so the registry is the vendor's own channel. Every
     * tarball was downloaded and hashed on 2026-11-06 (`make pin-assets`):
     * the `sha256` is ours, from those bytes, and the same bytes' sha512
     * matched the package's `dist.integrity`. `size` is the byte count of
     * that download.
     *
     * Linux rows are the glibc builds (npm also has `-musl` and `-baseline`
     * packages; see `engine/binaryResolver.ts` for why libc is not detected).
     */
    assets: {
      'darwin-arm64': opencodeAsset('darwin-arm64', 'dfd827de3281b4c3ca2b0bfc8f4beb103fa660c419d148a1a515c4344f9e9c02', 105814595),
      'darwin-x64': opencodeAsset('darwin-x64', '304f4666e7e37eac338de258f763b7f5b8987ab1bde2341dc1a613a8205c0010', 111044366),
      'linux-x64': opencodeAsset('linux-x64', '92690eee07a680d3cb760ca02ba43878de9eab1b4e5d5dfae8795518c53628f4', 118637290),
      'linux-arm64': opencodeAsset('linux-arm64', 'f8c5a82075fede9b5b044ed6c8a6d13ad807a7e62caea1cd0a878adef49eb053', 117223869),
      'win32-x64': opencodeAsset('windows-x64', '7a9e1dbe80965b75ace78d512c91ce4e6c9e4683fa5a5a25b00ff0b736f1c15c', 121997426),
      'win32-arm64': opencodeAsset('windows-arm64', '0aec456e313a0bd4c65dd6e3834bf6a3005280a311d8cc449933931ccbbbe389', 115455350)
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  git: {
    cli: GIT_CLI,
    release: GIT_RELEASE_TAG,
    /** Exactly what `git --version` prints for the pin. */
    versionOutput: `git version ${GIT_CLI}`,
    /**
     * GitHub Desktop's relocatable git (`desktop/dugite-native`), installed only
     * when a machine has no usable git of its own — a Mac without Apple's
     * command line developer tools, where `/usr/bin/git` is the stub that pops
     * the install dialog, or a Linux without a `git` package. Any real git wins;
     * see `main/shell/managedGit.ts`.
     *
     * Each tarball unpacks to a tree — `bin/git`, `libexec/git-core/`,
     * `share/git-core/templates`, `etc/gitconfig` (and `ssl/cacert.pem` on
     * Linux) — that runs from anywhere only with the environment dugite itself
     * sets, which is why it is run through a wrapper script and not by path.
     *
     * Every row was downloaded from the release and hashed on 2026-11-06, and
     * agreed with the digest GitHub publishes for the asset; `size` is the byte
     * count of the same download. **Windows is absent**: the wrapper is a POSIX
     * shell script, and a Windows git ships as its own installer anyway.
     */
    assets: {
      'darwin-arm64': gitAsset('macOS-arm64', '1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7', 63488287),
      'darwin-x64': gitAsset('macOS-x64', '52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659', 67470398),
      'linux-x64': gitAsset('ubuntu-x64', '1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9', 67467493),
      'linux-arm64': gitAsset('ubuntu-arm64', 'd5ce120515bf3013a014e6a918aa87ec0f7a6f5f9687c48d50127e637cb9b6c2', 25250010)
    } as Readonly<Record<string, RuntimePinAsset>>
  }
} as const
