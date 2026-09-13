// Launched by check-packaged-main.cjs in an isolated Electron environment.
// Main-process imports need Electron's asar filesystem support.
const { app } = require('electron')
const assert = require('node:assert/strict')
const { cpSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { isBuiltin, registerHooks } = require('node:module')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

const resources = process.argv[2]
if (!resources) throw new Error('Usage: npm run test:packaged:main -- <resources directory>')
const scratch = mkdtempSync(join(tmpdir(), 'cinna-packaged-main-'))
app.setPath('userData', scratch)
const deadline = setTimeout(() => {
  console.error('Packaged main-process checks timed out')
  finish(1)
}, 30_000)

function finish(code) {
  clearTimeout(deadline)
  process.noAsar = true
  rmSync(scratch, { recursive: true, force: true })
  app.exit(code)
}

app.whenReady().then(async () => {
  try {
    // Preserve the actual archive boundary, but remove repository ancestors
    // that could supply a package missing from the distribution.
    process.noAsar = true
    try {
      copyFileSync(join(resolve(resources), 'app.asar'), join(scratch, 'app.asar'))
      cpSync(join(resolve(resources), 'app.asar.unpacked'), join(scratch, 'app.asar.unpacked'), { recursive: true })
    } finally { process.noAsar = false }
    const main = join(scratch, 'app.asar/out/main')
    const specifiers = new Set()
    for (const name of readdirSync(main).filter((name) => name.endsWith('.js'))) {
      const source = ts.createSourceFile(name, readFileSync(join(main, name), 'utf8'), ts.ScriptTarget.Latest)
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue
        const specifier = statement.moduleSpecifier.text
        if (!specifier.startsWith('.') && !isBuiltin(specifier) && specifier !== 'electron') specifiers.add(specifier)
      }
    }
    assert.ok(specifiers.size > 0, 'No packaged main-process imports found')
    const here = pathToFileURL(__filename).href
    const packagedMain = pathToFileURL(join(main, 'index.js')).href
    registerHooks({ resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, context.parentURL === here ? { ...context, parentURL: packagedMain } : context)
    } })
    for (const specifier of specifiers) await import(specifier)
    console.log(`Packaged main: ${specifiers.size} external imports passed`)

    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    try { assert.equal(db.prepare('select 42 as answer').get().answer, 42) } finally { db.close() }
    console.log('Packaged SQLite native binding passed')

    const { default: sodium } = await import('libsodium-wrappers-sumo')
    await sodium.ready
    assert.equal(sodium.crypto_generichash(32, 'packaged crypto check').length, 32)
    console.log('Packaged libsodium initialization and hashing passed')

    const { createCanvas } = await import('@napi-rs/canvas')
    const canvas = createCanvas(2, 2)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ff0000'
    context.fillRect(0, 0, 2, 2)
    assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], [255, 0, 0, 255])
    console.log('Packaged Canvas native drawing passed')

    const { parseOffice } = await import('officeparser')
    const text = 'Packaged attachment check'
    assert.ok((await parseOffice(Buffer.from(`{\\rtf1\\ansi ${text}}`))).toText().includes(text))
    assert.ok((await parseOffice(pdfFixture(text))).toText().includes(text))
    console.log('Packaged RTF and PDF extraction (including PDF.js worker) passed')
    finish(0)
  } catch (error) {
    console.error(error)
    finish(1)
  }
})

function pdfFixture(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const start = Buffer.byteLength(pdf)
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(pdf)
}
