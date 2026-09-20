import ts from 'typescript'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const main = join(root, 'src/main')
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)])
}
const desktop = file => /^(host\/desktop\/|ipc\/|window\/|index\.ts$)/.test(relative(main, file))
const test = file => /(?:\.test\.tsx?$|\/testSupport\/|\/__golden__\/)/.test(file)
function imports(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text)
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) result.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
const errors = []
for (const file of files(main).filter(f => f.endsWith('.ts') && !test(f) && !desktop(f))) {
  for (const specifier of imports(file)) {
    const path = specifier.startsWith('.') ? resolve(dirname(file), specifier) : ''
    const target = [path, `${path}.ts`, join(path, 'index.ts')].find(f => existsSync(f) && f.endsWith('.ts'))
    if (/^(electron(?:\/|$)|electron-updater$|@electron-toolkit\/)/.test(specifier) || (target && desktop(target))) {
      errors.push(`${relative(root, file)} -> ${specifier}`)
    }
    // Local Development orchestration is installed by the desktop root, never imported by core.
    if (target && /\/localdev\/(localDevService|developmentSessionService)\.ts$/.test(target) && !file.includes('/localdev/')) {
      errors.push(`${relative(root, file)} -> desktop feature ${specifier}`)
    }
  }
}
// Renderer and preload must never get a direct path into persistence/runtime.
for (const dir of ['src/renderer', 'src/preload', 'src/shared']) {
  for (const file of files(join(root, dir)).filter(f => /\.tsx?$/.test(f) && !test(f))) {
    for (const specifier of imports(file)) {
      if (specifier.startsWith('.') && resolve(dirname(file), specifier).startsWith(main + '/')) {
        errors.push(`${relative(root, file)} -> main process ${specifier}`)
      }
    }
  }
}
if (errors.length) throw new Error(`Hub boundary violations:\n${errors.join('\n')}`)
console.log('Hub boundary: no core runtime imports of Electron or desktop UI; renderer/preload/shared remain outside main.')
