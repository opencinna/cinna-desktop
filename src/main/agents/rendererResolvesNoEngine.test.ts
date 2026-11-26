import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * **The renderer never works out which engine an agent runs on.**
 *
 * `effectiveEngine` (`shared/engine.ts`) reads a runtime block against this
 * machine's Default runtime. It was called in five renderer surfaces, each
 * with the block and the default it happened to have — and once the stored
 * Runs-on choice outranked the file (`drafts/runtime_engine_conflict`), every
 * one of those copies would have named the file's engine while the turn ran on
 * the choice. Main resolves it once (`services/localAgents/runsOn.ts`) and
 * ships it whole as `LocalAgentDto.resolvedRuntime`; the renderer reads that.
 *
 * So no production file under `src/renderer` may import `effectiveEngine`,
 * call it, or reach it through a namespace import of `shared/engine`. Read
 * from the AST, not by grep: comments explaining the rule are not uses of it,
 * and ChatModeCard's own local `effectiveEngine` (a chat mode's engine, not an
 * agent's) is a different binding. Test files are exempt: their fixtures stand
 * in for main.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const RENDERER = 'src/renderer/src'
const NAME = 'effectiveEngine'

function sourceFiles(dir: string, out: string[] = []): string[] {
  const entries: Dirent[] = readdirSync(join(repoRoot, dir), { withFileTypes: true })
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('__')) sourceFiles(rel, out)
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

/** Every use of the shared resolver in one file, as `line: text`. */
function usesOf(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const namespaces = new Set<string>()
  const at = (node: ts.Node): string => `${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText().slice(0, 80)}`
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /shared\/engine$/.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === NAME) found.push(at(element))
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text)
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === NAME && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      found.push(at(node))
    }
    // A dynamic `import('…/shared/engine')` destructured or dotted to it.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.getText(source).includes('shared/engine') && /effectiveEngine/.test(node.parent.getText(source))) {
      found.push(at(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('the renderer resolves no engine of its own', () => {
  it('no production renderer file uses effectiveEngine', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      for (const use of usesOf(file, readFileSync(join(repoRoot, file), 'utf8'))) offenders.push(`${file}:${use}`)
    }
    expect(offenders, 'read agent.resolvedRuntime.engine (resolved in main) instead').toEqual([])
  })

  it('catches the shapes it claims to', () => {
    // The detector itself, so a future refactor of it cannot pass vacuously.
    expect(usesOf('a.ts', "import { DEFAULT_AGENT_ENGINE, effectiveEngine } from '../../shared/engine'\nconst e = effectiveEngine(r, d)")).toHaveLength(1)
    expect(usesOf('a.ts', "import { effectiveEngine as pick } from '../shared/engine'")).toHaveLength(1)
    expect(usesOf('a.tsx', "import * as engine from '../../shared/engine'\nconst e = engine.effectiveEngine(r, d)")).toHaveLength(1)
    // Not uses: a comment, and a local binding of the same name.
    expect(usesOf('a.ts', '// `effectiveEngine` is main’s now\nconst effectiveEngine = mode.engine ?? fallback')).toEqual([])
  })
})
