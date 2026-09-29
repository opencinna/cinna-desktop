/**
 * The packaged copy of the agent kit, made whole again after electron-builder.
 *
 * electron-builder's directory walker (builder-util `walk`) drops every
 * `.gitkeep` and `.DS_Store` before any file pattern is consulted, and it does
 * not create empty directories. The kit's templates keep `files/`,
 * `app-data/uploads/` and `app-data/storage/` alive with a `.gitkeep`, so a
 * packaged app scaffolded agents without them and installed a workshop kit
 * that was not core's tree. No `extraResources` filter can bring them back, so
 * `afterPack` copies back whatever the bundle has and the shipped tree lacks,
 * then checks the result hashes to `scripts/kit-sync/kit.lock.json` — the same
 * tree hash `contractBundle.test.ts` pins the repo copy to
 * (`src/main/kit/contractTreeHash.ts`, restated here because this runs as
 * plain CommonJS inside electron-builder).
 */
const { createHash } = require('node:crypto')
const { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { dirname, join } = require('node:path')

const KIT_DIR = 'cinna-agent-kit'

/** `{ relative POSIX path: sha256 hex }` for every regular file under `root`. */
function listFiles(root) {
  const files = new Map()
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) files.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))
      else throw new Error(`packaged kit holds a non-regular entry: ${rel}`)
    }
  }
  walk(root, '')
  return files
}

function treeHash(files) {
  const digest = createHash('sha256')
  const paths = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  for (const rel of paths) digest.update(`${rel}\0${files.get(rel)}\n`, 'utf8')
  return digest.digest('hex')
}

/**
 * Copy into `shipped` every file of `source` it lacks, mode included, and
 * return the relative paths restored. Files already there are left alone: the
 * hash check afterwards is what says whether they are right.
 */
function restoreKitFiles(source, shipped) {
  const restored = []
  for (const rel of listFiles(source).keys()) {
    const target = join(shipped, ...rel.split('/'))
    try {
      statSync(target)
      continue
    } catch {
      /* missing: restore it */
    }
    const from = join(source, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(from, target)
    chmodSync(target, statSync(from).mode & 0o777)
    restored.push(rel)
  }
  return restored
}

/** Throw unless the tree at `shipped` is the one `lock` records. */
function verifyKit(shipped, lock) {
  const files = listFiles(shipped)
  const hash = treeHash(files)
  if (files.size !== lock.file_count || hash !== lock.tree_hash) {
    throw new Error(
      `packaged agent kit at ${shipped} is not the bundled one: ${files.size} files, tree ${hash}; ` +
        `kit.lock.json records ${lock.file_count} files, tree ${lock.tree_hash}`
    )
  }
  return files.size
}

/** The `afterPack` step: restore, then verify, the kit in `resourcesDir`. */
function completePackagedKit(projectDir, resourcesDir) {
  const source = join(projectDir, 'resources', KIT_DIR)
  const shipped = join(resourcesDir, KIT_DIR)
  const lock = JSON.parse(readFileSync(join(projectDir, 'scripts', 'kit-sync', 'kit.lock.json'), 'utf8'))
  const restored = restoreKitFiles(source, shipped)
  const count = verifyKit(shipped, lock)
  console.log(
    `Verified packaged agent kit: ${count} files` + (restored.length > 0 ? `, restored ${restored.join(', ')}` : '')
  )
}

module.exports = { restoreKitFiles, verifyKit, completePackagedKit }
