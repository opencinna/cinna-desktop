/**
 * The one place a runtime version lives.
 *
 * Cinna runs three external CLIs — OpenCode, Codex and Claude Code — and two of
 * them through an ACP adapter that is an exact `package.json` pin. A version
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
 * `package.json` (the adapter versions) and `codexAdapterPatch.json` (read by
 * the CommonJS postinstall and packaging hooks). `runtimePins.test.ts` fails
 * when either disagrees with this manifest.
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
}

const CLAUDE_CLI = '2.1.276'
const CLAUDE_RELEASE =
  `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${CLAUDE_CLI}`

function claudeAsset(platform: string, sha256: string, size: number): RuntimePinAsset {
  return { file: 'claude', sha256, url: `${CLAUDE_RELEASE}/${platform}/claude`, format: 'executable', size }
}

const CODEX_CLI = '0.155.0'
const CODEX_RELEASE = `https://github.com/openai/codex/releases/download/rust-v${CODEX_CLI}`

function codexAsset(triple: string, archive: 'tar.gz' | 'zip', sha256: string, size: number): RuntimePinAsset {
  const windows = triple.endsWith('windows-msvc')
  const executable = `codex-${triple}${windows ? '.exe' : ''}`
  const file = `${executable}.${archive}`
  return { file, sha256, url: `${CODEX_RELEASE}/${file}`, executable, size }
}

export const RUNTIME_PINS = {
  claude: {
    cli: CLAUDE_CLI,
    /** Exactly what `claude --version` prints for the pin. */
    versionOutput: `${CLAUDE_CLI} (Claude Code)`,
    adapter: '0.76.0',
    /**
     * Anthropic's own release bucket — the one `claude`'s installer and updater
     * read. `<release>/manifest.json` lists `platforms.<key>.{binary, checksum,
     * size}`; the executable is `<release>/<key>/<binary>`, a single file, not an archive.
     *
     * Every row was hashed from real bytes on 2026-09-18 and then compared with
     * the manifest's `checksum` and `size`, which agreed: darwin-x64, linux-x64
     * and linux-arm64 were downloaded from the bucket; darwin-arm64 is the hash
     * of the vendor installer's own `~/.local/share/claude/versions/2.1.276`.
     *
     * Linux rows are the glibc builds (the manifest also has `-musl` keys; see
     * `engine/binaryResolver.ts` for why libc is not detected). **Windows is
     * absent**: the launcher's child-environment rules and the login probe are
     * POSIX-verified only, so a Windows user sets a Claude Path in Settings.
     */
    assets: {
      'darwin-arm64': claudeAsset('darwin-arm64', '9de364db11a410d53cbbb0f6b1f18c66c90053efc9a63370072856d10db66329', 215643408),
      'darwin-x64': claudeAsset('darwin-x64', 'cf0b4af7bce5d991a577d1150e86d45b7b83ef57cdb0384044ca54661ded24c6', 224441440),
      'linux-x64': claudeAsset('linux-x64', '8a56c8a14bd3cb246e2bdb7e60aefe0f609bff78c8bbcc5ea6b1817c111c6145', 232059192),
      'linux-arm64': claudeAsset('linux-arm64', 'e9ac3df956083645578a382ad64ec304468666e362c33bfdefd803cd6ff596b0', 231989488)
    } as Readonly<Record<string, RuntimePinAsset>>
  },
  codex: {
    cli: CODEX_CLI,
    /** Exactly what `codex --version` prints for the pin. */
    versionOutput: `codex-cli ${CODEX_CLI}`,
    adapter: '1.11.0',
    /** `@agentclientprotocol/codex-acp/dist/index.js` as published. */
    adapterOriginalSha256: '3527bdaf90a219175c742576963e6d9e943e4ea5fbdbc3e04e7f57f9a9e11343',
    /** The same file after `scripts/patch-codex-acp.cjs`. */
    adapterPatchedSha256: 'bf3f889fbad28a1304b0e358a3d4cb099cf95ffe317e80b529ceecf7bd76fc95',
    /**
     * The vendor's unmodified GitHub release archives for `rust-v0.155.0`, each
     * a single self-contained executable. Downloaded and hashed 2026-09-18;
     * each `size` is the byte count of that same download (`scripts/pin-assets.mjs`
     * prints it), so it is exact for the digest beside it.
     * Linux is the musl build — the only one the release ships.
     *
     * **Windows is absent deliberately.** Its release zip is not one
     * executable: `codex-<triple>.exe` ships beside
     * `codex-windows-sandbox-setup.exe` and a command runner, so "publish the
     * one file that was verified" does not describe it, and the restricted chat
     * policy is POSIX-only regardless. A Windows user sets the Codex path in
     * Settings, which is the answer an unlisted platform already gets.
     */
    assets: {
      'darwin-arm64': codexAsset(
        'aarch64-apple-darwin',
        'tar.gz',
        '5a584b7cddc2a97083cada53f10f5bc4231526b7f64105f6a5bb82d01ccdba49',
        90573064
      ),
      'darwin-x64': codexAsset(
        'x86_64-apple-darwin',
        'tar.gz',
        'cc84081b15284eea10c8b8d428818d1c8debdce5a7f0f4f5c04dfc7c72518174',
        98661335
      ),
      'linux-x64': codexAsset(
        'x86_64-unknown-linux-musl',
        'tar.gz',
        'e415cc3adb94ade16e8d44b4dd58a9201cc34b2ee51a5d6eddf2a3a00aecb6c0',
        101573733
      ),
      'linux-arm64': codexAsset(
        'aarch64-unknown-linux-musl',
        'tar.gz',
        '8b4a9c356916c515f7c93f918a01b8fa1371bcc9758addbfa723b85fbec5694b',
        94309776
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
  }
} as const
