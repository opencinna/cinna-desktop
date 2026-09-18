const { existsSync, readFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, statSync } = require('node:fs')
const { basename, dirname, join, relative, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const { verifyCodexAcpPatch } = require('./patch-codex-acp.cjs')

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

function afterPack({ packager, appOutDir, electronPlatformName, arch }) {
  // Runs for every target, including cross-builds, before signing/publishing.
  // Fail the build if file filtering or dependency collection lost a package.
  const unpacked = join(packager.getResourcesDir(appOutDir), 'app.asar.unpacked')
  const packages = runtimePackages(unpacked)
  verifyCodexAcpPatch(unpacked)
  console.log(`Verified ${packages.length} unpacked ACP runtime packages`)
  for (const target of canvasTargets(packager.info.appDir, electronPlatformName, arch)) {
    // Match the runtime's lookup origin even if electron-builder re-hoists it.
    const directory = findPackage(unpacked, join(unpacked, 'node_modules/@napi-rs/canvas'), target.name)
    if (!directory) throw new Error(`Missing packaged Canvas payload ${target.name}`)
    validateCanvasPayload(directory, target)
    console.log(`Verified unpacked ${target.name}@${target.version}`)
  }
}

module.exports = { runtimePackages, canvasTargets, prepareCanvasPayload, validateCanvasPayload, beforePack, afterPack }
