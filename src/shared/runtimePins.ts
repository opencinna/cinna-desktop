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
 * release and hashing the bytes — never copied from a listing. They pin *these
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

const CLAUDE_CLI = '2.1.296'
const CLAUDE_RELEASE =
  `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${CLAUDE_CLI}`

function claudeAsset(platform: string, sha256: string, size: number): RuntimePinAsset {
  return { file: 'claude', sha256, url: `${CLAUDE_RELEASE}/${platform}/claude`, format: 'executable', size }
}

const CODEX_CLI = '0.162.1'
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

const ANTIGRAVITY_CLI = '1.3.0'

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

const GIT_CLI = '2.53.0'
/** dugite-native's release tag; its fourth packaging of git 2.53.0. */
const GIT_RELEASE_TAG = 'v2.53.0-4'
const GIT_RELEASE = `https://github.com/desktop/dugite-native/releases/download/${GIT_RELEASE_TAG}`
/** Asset names carry the git version and the short commit dugite-native built from, not the tag. */
const GIT_ASSET_PREFIX = `dugite-native-v${GIT_CLI}-4098283`

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
    adapter: '0.89.1',
    /** `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` as published (checked against the locked npm tarball). */
    adapterOriginalSha256: 'f00fea811d7144360a6e70bc87e38e36d00a807d15825a8179e2458520b71784',
    /** The same file after `scripts/patch-claude-agent-acp.cjs` (the `_cinna/contextUsage` request, and `air.client` forced off). */
    adapterPatchedSha256: 'd9d4d9ac13623f29745c8a3e1e790dd7ce04000714794a01d820e905ce11c4aa',
    /**
     * Anthropic's own release bucket — the one `claude`'s installer and updater
     * read. `<release>/manifest.json` lists `platforms.<key>.{binary, checksum,
     * size}`; the executable is `<release>/<key>/<binary>`, a single file, not an archive.
     *
     * Every row was downloaded from the bucket and hashed on 2026-10-11 (`make
     * pin-assets` with `--verify`), and agreed with the manifest's `checksum`
     * and `size`.
     *
     * Linux rows are the glibc builds (the manifest also has `-musl` keys; see
     * `engine/binaryResolver.ts` for why libc is not detected). **Windows is
     * absent**: the launcher's child-environment rules and the login probe are
     * POSIX-verified only, so a Windows user sets a Claude Path in Settings.
     */
    assets: {
      'darwin-arm64': claudeAsset('darwin-arm64', 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937', 240664432),
      'darwin-x64': claudeAsset('darwin-x64', 'a6bf4f30be241053a923f3820ad23c5991d2f5ac2935b3a8dd64da218d9cc603', 249194752),
      'linux-x64': claudeAsset('linux-x64', '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de', 257068216),
      'linux-arm64': claudeAsset('linux-arm64', 'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa', 256434168)
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  codex: {
    cli: CODEX_CLI,
    /** Exactly what `codex --version` prints for the pin. */
    versionOutput: `codex-cli ${CODEX_CLI}`,
    adapter: '2.2.2',
    /** `@agentclientprotocol/codex-acp/dist/index.js` as published (checked against the locked npm tarball). */
    adapterOriginalSha256: '6b1bb4e7e9caaf4aeca1042ae4aec2dc2433b0b0e4b1614b38a4d41699902aaa',
    /** The same file after `scripts/patch-codex-acp.cjs` (MCP merge, session instructions, `isAirClient` forced false, and the whole command output on the completing update). */
    adapterPatchedSha256: 'ca1f79d5ea308f092753a24140ac182dac5af0c8f52e43132ca265f8fa5922fa',
    /**
     * The vendor's unmodified GitHub release archives for `rust-v0.162.1`: the
     * `codex` archive, and beside it the `codex-code-mode-host` archive of the
     * same triple as a companion. Every archive, main and companion, was
     * downloaded and hashed 2026-10-11 (`make pin-assets`); each `size` is the
     * byte count of that same download, so it is exact for the digest beside
     * it. Linux is the musl build — the only one the release ships.
     *
     * **Why the host is needed.** From 0.155.0 the `code_mode_host` feature is
     * stable and on by default, and a bare (non-package) install looks for
     * `codex-code-mode-host` in the directory of its own executable; without it
     * Code Mode is unavailable and the agent reports "the required
     * codex-code-mode-host executable is missing". So the managed install is two files, and a bump recomputes the
     * companion rows as well as the main ones.
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
        'b293a0fcdd871900a44c0a4f40a1aa401b31e02854f790ebdb8bd5d1177fd1fe',
        98104184,
        { sha256: '1f464a2894adbc916e431b6bf19bef2cb485cf7e13e636d42578c581962b3727', size: 23826262 }
      ),
      'darwin-x64': codexAsset(
        'x86_64-apple-darwin',
        'tar.gz',
        'd68e39d8f62639f33f7d00656554cb9c3ef7809e664a3827e62ab3ace3c21b21',
        107055460,
        { sha256: 'cd52af8a6884b18239aaf36d0c99bc990e7dcf75b0917155474ffde88a111d37', size: 25706483 }
      ),
      'linux-x64': codexAsset(
        'x86_64-unknown-linux-musl',
        'tar.gz',
        '86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057',
        111350218,
        { sha256: '458239ea45c1fc508d89695f180ab352f2834709a8a46929a4466f4f04399ada', size: 27500770 }
      ),
      'linux-arm64': codexAsset(
        'aarch64-unknown-linux-musl',
        'tar.gz',
        'bf3ca2719f1143b1440fbd85c149379e696c782c50ad7991f8bfcec60b2600c1',
        103595962,
        { sha256: '1395ce9367f8acd280674dff083edf25bf221d908b8351d5bd4f3fdde9181e9a', size: 26003900 }
      )
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  antigravity: {
    cli: ANTIGRAVITY_CLI,
    /**
     * Google's own release zips. Each holds `agy_acp_server.par` (the ACP
     * server, installed under that name) and `localharness_external` at the
     * archive root, so both land in one directory with nothing else to fetch.
     * Every row was downloaded and hashed on 2026-10-11; `size` is the byte
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
        '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
        111456962
      ),
      'darwin-x64': antigravityAsset(
        'macos',
        `agy-acp-server-${ANTIGRAVITY_CLI}-darwin-x86_64.zip`,
        'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
        117245544
      ),
      'linux-x64': antigravityAsset(
        'linux',
        `agy-acp-server-${ANTIGRAVITY_CLI}-linux-x86_64.zip`,
        '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
        333727150
      ),
      'linux-arm64': antigravityAsset(
        'linux',
        `agy-acp-server-${ANTIGRAVITY_CLI}-linux-arm64.zip`,
        '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
        321690363
      )
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  opencode: {
    cli: '1.18.27',
    /**
     * Release assets of `anomalyco/opencode` for the pinned version. Linux uses
     * the glibc builds; see `engine/binaryResolver.ts` for the musl gap.
     */
    assets: {
      'darwin-arm64': {
        file: 'opencode-darwin-arm64.zip',
        sha256: '149b0c6d272d0059b8b5ffcd18c84b24f1d6cbf585942b10e60c601211992eb1'
      },
      'darwin-x64': {
        file: 'opencode-darwin-x64.zip',
        sha256: 'e182eab3a6bf095ff773d303bbc7938d3551a636eab00625b599ad6383fabd88'
      },
      'linux-x64': {
        file: 'opencode-linux-x64.tar.gz',
        sha256: '4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702'
      },
      'linux-arm64': {
        file: 'opencode-linux-arm64.tar.gz',
        sha256: '8cbc134eb5e100baf61ee7196150f503e352056e703276e2d8637c38bafd2c39'
      },
      'win32-x64': {
        file: 'opencode-windows-x64.zip',
        sha256: 'ac26bb6f0309e9a6de279b64dc7bec5e69ab9b79c1a4e2d947d68d213b7eb575'
      },
      'win32-arm64': {
        file: 'opencode-windows-arm64.zip',
        sha256: '59174ffeb6ce327bd2c534bf5147d0005e8db3b5889414de10490d00e640c908'
      }
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
     * Every row was downloaded from the release and hashed on 2026-09-29, and
     * agreed with the digest GitHub publishes for the asset; `size` is the byte
     * count of the same download. **Windows is absent**: the wrapper is a POSIX
     * shell script, and a Windows git ships as its own installer anyway.
     */
    assets: {
      'darwin-arm64': gitAsset('macOS-arm64', 'f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe', 62348987),
      'darwin-x64': gitAsset('macOS-x64', 'ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680', 66136060),
      'linux-x64': gitAsset('ubuntu-x64', 'cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901', 65269219),
      'linux-arm64': gitAsset('ubuntu-arm64', 'a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af', 23223345)
    } as Readonly<Record<string, RuntimePinAsset>>
  }
} as const
