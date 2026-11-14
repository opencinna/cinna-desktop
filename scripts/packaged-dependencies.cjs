const { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, renameSync, rmSync, statSync } = require('node:fs')
const { basename, dirname, join, relative, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { verifyCodexAcpPatch } = require('./patch-codex-acp.cjs')
const { verifyClaudeAgentAcpPatch } = require('./patch-claude-agent-acp.cjs')
const { completePackagedKit } = require('./packaged-kit.cjs')
const { readVaultGuestPin } = require('./vault/guest-pin.cjs')

// These are the app-owned entry points executed with ELECTRON_RUN_AS_NODE.
const CHILD_PACKAGES = [
  '@agentclientprotocol/claude-agent-acp',
  '@agentclientprotocol/codex-acp'
]

// Both launchers require the user's CLI. Keep these aligned with the files
// exclusions in electron-builder.yml; never unpack bundled CLI binaries.
function isExternalCli(name) {
  return name.startsWith('@anthropic-ai/claude-agent-sdk-') || name.startsWith('@openai/codex')
}

function findPackage(root, from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root) return null
    if (dirname(dir) === dir) throw new Error(`Package lookup escaped ${root}`)
  }
}

// Follow the installed layout, including nested versions and peers. Reading
// manifests directly also works for packages that hide package.json in exports.
// Resolution stops at the app root: global/developer packages cannot satisfy it.
function runtimePackages(appDir, roots = CHILD_PACKAGES) {
  const root = resolve(appDir)
  const visited = new Set()
  function visit(name, from, optional = false) {
    if (isExternalCli(name)) return
    const directory = findPackage(root, from, name)
    if (!directory) {
      if (optional) return
      throw new Error(`Missing runtime dependency ${name}, required from ${from}`)
    }
    if (visited.has(directory)) return
    visited.add(directory)
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const deps = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const dependency of Object.keys(deps)) {
      const optionalDependency = Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)
      const optionalPeer = !Object.hasOwn(pkg.dependencies ?? {}, dependency) &&
        pkg.peerDependenciesMeta?.[dependency]?.optional === true
      visit(dependency, directory, optionalDependency || optionalPeer)
    }
  }
  roots.forEach((name) => visit(name, root))
  return [...visited].map((directory) => relative(root, directory).split(sep).join('/')).sort()
}

// npm installs optional native payloads for the host, while electron/rebuild
// only rebuilds modules with binding.gyp. Canvas uses prebuilt N-API packages,
// so cross-builds need their target payload before dependency collection.
function canvasTargets(appDir, platform, arch) {
  const root = resolve(appDir)
  const canvas = findPackage(root, root, '@napi-rs/canvas')
  if (!canvas) throw new Error('Missing @napi-rs/canvas, required by packaged PDF.js')
  const pkg = JSON.parse(readFileSync(join(canvas, 'package.json'), 'utf8'))
  const targetArch = typeof arch === 'number' ? require('builder-util').Arch[arch] : arch
  const targetPlatform = platform === 'mas' ? 'darwin' : platform
  const arches = targetPlatform === 'darwin' && targetArch === 'universal' ? ['x64', 'arm64'] : [targetArch]
  return arches.map((cpu) => {
    // Linux release targets (AppImage/deb) use glibc, not the build host's libc.
    const suffix = {
      'darwin-x64': 'darwin-x64', 'darwin-arm64': 'darwin-arm64',
      'win32-x64': 'win32-x64-msvc', 'win32-arm64': 'win32-arm64-msvc',
      'linux-x64': 'linux-x64-gnu', 'linux-arm64': 'linux-arm64-gnu',
      'linux-armv7l': 'linux-arm-gnueabihf'
    }[`${targetPlatform}-${cpu}`]
    if (!suffix) throw new Error(`Unsupported packaged Canvas target ${targetPlatform}-${cpu}`)
    const name = `@napi-rs/canvas-${suffix}`
    const version = pkg.optionalDependencies?.[name]
    if (version !== pkg.version) throw new Error(`Canvas ${pkg.version} does not pin its ${name} payload`)
    return { name, version, binary: `skia.${suffix}.node` }
  })
}

function validateCanvasPayload(directory, target) {
  const manifest = join(directory, 'package.json')
  if (!existsSync(manifest)) throw new Error(`Missing packaged Canvas payload ${target.name}`)
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  if (pkg.name !== target.name || pkg.version !== target.version || pkg.main !== target.binary) {
    throw new Error(`Expected ${target.name}@${target.version} with entry ${target.binary} at ${directory}`)
  }
  const binary = join(directory, target.binary)
  if (!existsSync(binary) || !statSync(binary).isFile() || statSync(binary).size === 0) {
    throw new Error(`Missing native Canvas binary ${binary}`)
  }
}

function packWithNpm(record, scratch) {
  // Packing a locked tarball neither changes the app's manifests nor installs
  // unrelated optional binaries. cross-spawn handles npm.cmd on Windows.
  const result = require('cross-spawn').sync('npm', [
    'pack', record.resolved, '--ignore-scripts', '--json', '--pack-destination', scratch
  ], { cwd: scratch, encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Failed to fetch Canvas payload: ${result.stderr}`)
  const [packed] = JSON.parse(result.stdout)
  if (!packed?.filename || basename(packed.filename) !== packed.filename) {
    throw new Error('npm pack did not return a Canvas archive filename')
  }
  return join(scratch, packed.filename)
}

function prepareCanvasPayload(appDir, target, pack = packWithNpm) {
  const root = resolve(appDir)
  const canvas = findPackage(root, root, '@napi-rs/canvas')
  const installed = findPackage(root, canvas, target.name)
  if (installed) {
    validateCanvasPayload(installed, target)
    return
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const record = lock.packages?.[`node_modules/${target.name}`]
  if (record?.version !== target.version || !record.resolved || !record.integrity) {
    throw new Error(`Missing locked tarball/integrity for ${target.name}@${target.version}`)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'cinna-canvas-pack-'))
  const destination = join(root, 'node_modules', target.name)
  let stage
  try {
    const archive = pack(record, scratch)
    if (!require('ssri').checkData(readFileSync(archive), record.integrity)) {
      throw new Error(`Integrity mismatch for ${target.name}@${target.version}`)
    }
    // Stage on the destination filesystem, then publish only a verified tree.
    mkdirSync(dirname(destination), { recursive: true })
    stage = mkdtempSync(join(dirname(destination), '.cinna-canvas-'))
    require('tar').x({ file: archive, cwd: stage, strip: 1, sync: true, strict: true })
    validateCanvasPayload(stage, target)
    renameSync(stage, destination)
    console.log(`Prepared ${target.name}@${target.version} for packaging`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    if (stage) rmSync(stage, { recursive: true, force: true })
  }
}

function beforePack({ packager, electronPlatformName, arch }) {
  verifyCodexAcpPatch(packager.info.appDir)
  verifyClaudeAgentAcpPatch(packager.info.appDir)
  const canvas = canvasTargets(packager.info.appDir, electronPlatformName, arch)
  canvas.forEach((target) => prepareCanvasPayload(packager.info.appDir, target))
  // electron-builder may hoist a nested dependency while collecting production
  // packages. Match package names at every depth, not only npm's source paths.
  const patterns = runtimePackages(packager.info.appDir).map((directory) => {
    const name = directory.slice(directory.lastIndexOf('node_modules/') + 'node_modules/'.length)
    return `**/node_modules/${name}/**`
  })
  patterns.push(...canvas.map(({ name }) => `**/node_modules/${name}/**`))
  const existing = packager.config.asarUnpack ?? []
  packager.config.asarUnpack = [...new Set([
    ...(Array.isArray(existing) ? existing : [existing]), ...patterns
  ])]
}

// The macOS voice-input helper ships through extraResources, which copies
// whatever resources/speech holds and says nothing when it is empty. A package
// built without it loses voice input silently, so refuse it here.
function verifySpeechHelper(resourcesDir) {
  const helper = join(resourcesDir, 'speech', 'cinna-speech')
  const stat = existsSync(helper) ? statSync(helper) : null
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`Missing executable speech helper ${helper}: run sh scripts/build-speech-helper.sh before electron-builder`)
  }
  console.log('Verified speech helper')
}

// The Agent Vault helper (mac.extraFiles → Contents/Library/Helpers). It is
// excluded from electron-builder's signing (mac.signIgnore) because it must
// keep its own Developer ID signature, embedded "Mac Team Direct" profile and
// keychain-access-groups entitlement: without the entitlement the Secure
// Enclave key's access group is gone (D17), and a package with a test or dev
// flavor would ship approvals with no prompt or no parent check (D31). So an
// arm64 mac package must carry a release helper that still verifies, with the
// guest kernel and initrd inside. The helper is arm64-only: an x64 package
// drops it (the app reports the vault unavailable there). A `--dir` build only
// warns, so a local unsigned build still works without the helper.
const VAULT_HELPER_GROUP = 'G5E484HA2U.io.opencinna.desktop.vault-helper'
// Compiled only into the test flavor (native/vault/helper/Sources/Flavor.swift,
// TEST_GATE_MARKER): a binary that holds it auto-grants every approval, whatever
// its Info.plist says, so the bytes are checked as well as the plist.
const VAULT_TEST_GATE_MARKER = 'CINNA-VAULT-TEST-GATE-BUILD:7c1e9a4f-do-not-ship'

function runTool(command, args) {
  const r = require('node:child_process').spawnSync(command, args, { encoding: 'utf8' })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function vaultHelperProblems(helper, run = runTool) {
  const binary = join(helper, 'Contents', 'MacOS', 'VaultHelper')
  if (!existsSync(binary)) return ['it is missing']
  const problems = []
  if (readFileSync(binary).includes(VAULT_TEST_GATE_MARKER)) problems.push('its binary is a test-gate build')
  const flavor = run('plutil', ['-extract', 'CinnaVaultFlavor', 'raw', join(helper, 'Contents', 'Info.plist')])
  if (flavor.status !== 0 || flavor.output.trim() !== 'release') {
    problems.push(`its flavor is ${flavor.status === 0 ? flavor.output.trim() : 'unknown'}, not release`)
  }
  if (!existsSync(join(helper, 'Contents', 'embedded.provisionprofile'))) problems.push('it has no embedded provisioning profile')
  const entitlements = run('codesign', ['-d', '--entitlements', '-', '--xml', helper])
  if (entitlements.status !== 0 || !entitlements.output.includes(VAULT_HELPER_GROUP)) {
    problems.push(`its signature does not carry keychain-access-groups ${VAULT_HELPER_GROUP}`)
  }
  const verify = run('codesign', ['--verify', '--strict', '--deep', helper])
  if (verify.status !== 0) problems.push(`its signature does not verify (${verify.output.trim().split('\n')[0]})`)
  for (const file of ['Image', 'initrd.img']) {
    if (!existsSync(join(helper, 'Contents', 'Resources', 'guest', file))) problems.push(`guest ${file} is missing`)
  }
  return problems
}

// The guest the helper was built for (Contents/Resources/guest/guest.lock.json,
// copied there by build-helper.sh) against RUNTIME_PINS.vaultGuest: its verity
// root hash is compiled in, so a helper for another image could boot no vault
// the app downloads. An unpublished pin ships no image (the app reports
// image-missing) and asks nothing of the lock.
function vaultHelperGuestProblems(helper, pin) {
  if (!pin.published) return []
  const path = join(helper, 'Contents', 'Resources', 'guest', 'guest.lock.json')
  if (!existsSync(path)) return ['it carries no guest/guest.lock.json (build it with make vault-release)']
  let lock
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return ['its guest/guest.lock.json is not JSON']
  }
  const problems = []
  if (String(lock.version) !== pin.version) problems.push(`its guest is ${lock.version}, not the pinned ${pin.version}`)
  if (String(lock.rootHash).toLowerCase() !== pin.rootHash.toLowerCase()) problems.push(`its guest root hash is not the pinned one (RUNTIME_PINS.vaultGuest.rootHash)`)
  if (Number(lock.hashOffset) !== pin.hashOffset) problems.push(`its guest hash offset ${lock.hashOffset} is not the pinned ${pin.hashOffset}`)
  return problems
}

function verifyVaultHelper({ appPath, arch, dirOnly, projectDir = join(__dirname, '..') }, run = runTool) {
  const helper = join(appPath, 'Contents', 'Library', 'Helpers', 'VaultHelper.app')
  const targetArch = typeof arch === 'number' ? require('builder-util').Arch[arch] : arch
  if (targetArch === 'x64') {
    if (existsSync(helper)) {
      rmSync(helper, { recursive: true, force: true })
      console.log('Removed the arm64-only vault helper from the x64 package')
    }
    return
  }
  const pin = readVaultGuestPin(projectDir)
  // An unpublished guest pin ships no helper (make vault-release removes it):
  // the app reports Agent Vault unavailable. One that is there anyway must
  // still pass every release check: a test or dev helper never ships.
  if (!pin.published && !existsSync(helper)) {
    console.log('No vault helper: RUNTIME_PINS.vaultGuest is unpublished, so this package ships none (Agent Vault unavailable)')
    return
  }
  const problems = vaultHelperProblems(helper, run)
  if (existsSync(helper)) problems.push(...vaultHelperGuestProblems(helper, pin))
  if (problems.length === 0) {
    console.log('Verified vault helper (release flavor, profile, keychain group, guest image)')
    return
  }
  const message = `Agent Vault helper ${helper} cannot ship: ${problems.join('; ')}. Build it with make vault-release before electron-builder.`
  if (dirOnly) {
    console.warn(`WARNING ${message}`)
    return
  }
  throw new Error(message)
}

// The Agent Vault adapter tars (src/main/vault/adapterTar.ts), written by
// `electron-vite build` and streamed into a vault from inside app.asar. A move
// refuses any tar but the pinned one, so a package carrying another (a stale
// out/, a node_modules changed after the pin) would ship vaults that never
// move in: fail it here instead. arm64 only, like the helper.
const ADAPTER_TAR = 'out/vault/claude-adapter.tar'
const CODEX_ADAPTER_TAR = 'out/vault/codex-adapter.tar'

/** `RUNTIME_PINS.<engine>.vaultAdapterTarSha256`, read from the source the app compiles in. */
function pinnedAdapterTarSha256(projectDir, engine = 'claude') {
  const source = readFileSync(join(projectDir, 'src', 'shared', 'runtimePins.ts'), 'utf8')
  const block = new RegExp(`\\n  ${engine}: \\{[\\s\\S]*?vaultAdapterTarSha256:\\s*'([0-9a-f]{64})'`).exec(source)
  if (!block) throw new Error(`src/shared/runtimePins.ts pins no ${engine}.vaultAdapterTarSha256`)
  return block[1]
}

function readAsarFileFresh(archive, file) {
  require('@electron/asar/lib/disk').uncacheFilesystem(archive)
  return require('@electron/asar').extractFile(archive, file)
}

function verifyVaultAdapterTar(resourcesDir, pin, readAsarFile = readAsarFileFresh, file = ADAPTER_TAR, engine = 'claude') {
  let data = null
  try {
    data = readAsarFile(join(resourcesDir, 'app.asar'), file)
  } catch {
    data = null
  }
  if (!data) throw new Error(`app.asar holds no ${file}; run electron-vite build before electron-builder.`)
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (sha256 !== pin) {
    throw new Error(`The packaged ${file} hashes to ${sha256}, not the pinned ${pin} (RUNTIME_PINS.${engine}.vaultAdapterTarSha256). Rebuild with electron-vite build; if node_modules changed on purpose, re-pin with npm run vault:pin-adapter.`)
  }
  console.log(`Verified vault ${engine} adapter tar (${data.length} bytes, pinned sha256)`)
}

/** Both adapter tars a vault move streams: Claude's and Codex's. */
function verifyVaultAdapterTars(resourcesDir, projectDir, readAsarFile = readAsarFileFresh) {
  verifyVaultAdapterTar(resourcesDir, pinnedAdapterTarSha256(projectDir, 'claude'), readAsarFile, ADAPTER_TAR, 'claude')
  verifyVaultAdapterTar(resourcesDir, pinnedAdapterTarSha256(projectDir, 'codex'), readAsarFile, CODEX_ADAPTER_TAR, 'codex')
}

// What app.asar may hold at its top level. `files` in electron-builder.yml is a
// deny-list over the whole repo, so a local folder nobody excluded is packed and
// published: 0.11.3's macOS assets carried drafts/, plans/, .claude/ (with an
// agent worktree), docs/ and cinna.log. The app reads only out/, its
// node_modules, package.json and resources/ through the app path, so anything
// else fails the build instead of shipping.
const APP_TOP_LEVEL = new Set(['out', 'node_modules', 'package.json', 'resources', 'LICENSE'])

// @electron/asar caches an archive's header by path for the life of the
// process; read it fresh, since the archive may have been rewritten since.
function listAsarFresh(archive) {
  require('@electron/asar/lib/disk').uncacheFilesystem(archive)
  return require('@electron/asar').listPackage(archive, { isPack: false })
}

function verifyAppContents(resourcesDir, listAsar = listAsarFresh) {
  const top = new Set()
  for (const entry of listAsar(join(resourcesDir, 'app.asar'))) {
    const name = entry.split(/[\\/]/).filter(Boolean)[0]
    if (name) top.add(name)
  }
  const unpacked = join(resourcesDir, 'app.asar.unpacked')
  if (existsSync(unpacked)) for (const name of readdirSync(unpacked)) top.add(name)
  const stray = [...top].filter((name) => !APP_TOP_LEVEL.has(name)).sort()
  if (stray.length > 0) {
    throw new Error(`app.asar holds files the app never reads: ${stray.join(', ')}. Exclude them under files in electron-builder.yml, or add a name the app really loads to APP_TOP_LEVEL in scripts/packaged-dependencies.cjs.`)
  }
  console.log(`Verified app.asar top level: ${[...top].sort().join(', ')}`)
}

// The `--require` preload every ELECTRON_RUN_AS_NODE child starts with
// (runtimeHost.nodeRuntime). The NodeOptions fuse makes Electron ignore
// NODE_EXTRA_CA_CERTS, and this is what puts it back; a child cannot read it
// from inside app.asar, so it must be a real file (asarUnpack resources/**).
const EXTRA_CA_FILES = ['resources/node-extra-ca/preload.cjs', 'resources/node-extra-ca/extra-ca.cjs']

function verifyExtraCaPreload(resourcesDir) {
  const unpacked = join(resourcesDir, 'app.asar.unpacked')
  const missing = EXTRA_CA_FILES.filter((file) => !existsSync(join(unpacked, file)))
  if (missing.length > 0) {
    throw new Error(`Missing unpacked extra-CA preload: ${missing.join(', ')}. Every run-as-node child requires it; keep resources/** in asarUnpack.`)
  }
  console.log('Verified unpacked extra-CA preload')
}

function afterPack({ packager, appOutDir, electronPlatformName, arch, targets }) {
  // Runs for every target, including cross-builds, before signing/publishing.
  // Fail the build if file filtering or dependency collection lost a package.
  const unpacked = join(packager.getResourcesDir(appOutDir), 'app.asar.unpacked')
  const packages = runtimePackages(unpacked)
  verifyCodexAcpPatch(unpacked)
  verifyClaudeAgentAcpPatch(unpacked)
  console.log(`Verified ${packages.length} unpacked ACP runtime packages`)
  for (const target of canvasTargets(packager.info.appDir, electronPlatformName, arch)) {
    // Match the runtime's lookup origin even if electron-builder re-hoists it.
    const directory = findPackage(unpacked, join(unpacked, 'node_modules/@napi-rs/canvas'), target.name)
    if (!directory) throw new Error(`Missing packaged Canvas payload ${target.name}`)
    validateCanvasPayload(directory, target)
    console.log(`Verified unpacked ${target.name}@${target.version}`)
  }
  if (electronPlatformName === 'darwin') verifySpeechHelper(packager.getResourcesDir(appOutDir))
  if (electronPlatformName === 'darwin') {
    const productFilename = packager.appInfo?.productFilename ?? 'app'
    verifyVaultHelper({
      appPath: join(appOutDir, `${productFilename}.app`),
      arch,
      projectDir: packager.info.projectDir,
      dirOnly: Array.isArray(targets) && targets.length > 0 && targets.every((target) => target.name === 'dir')
    })
    const targetArch = typeof arch === 'number' ? require('builder-util').Arch[arch] : arch
    if (targetArch === 'arm64') verifyVaultAdapterTars(packager.getResourcesDir(appOutDir), packager.info.projectDir)
  }
  // electron-builder drops the kit's `.gitkeep` files; see packaged-kit.cjs.
  completePackagedKit(packager.info.projectDir, packager.getResourcesDir(appOutDir))
  verifyExtraCaPreload(packager.getResourcesDir(appOutDir))
  verifyAppContents(packager.getResourcesDir(appOutDir))
}

module.exports = { verifyVaultAdapterTar, verifyVaultAdapterTars, pinnedAdapterTarSha256, verifyAppContents, verifyExtraCaPreload, runtimePackages, canvasTargets, prepareCanvasPayload, validateCanvasPayload, verifySpeechHelper, verifyVaultHelper, vaultHelperProblems, vaultHelperGuestProblems, beforePack, afterPack }
