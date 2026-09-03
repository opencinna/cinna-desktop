import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { createLayoutView, parseLayout } from './layout'
import {
  readCommandCatalog,
  validateAgentFolder,
  validateManifest,
  type Finding,
  type ValidationReport
} from './validator'
import type { CinnaAgentManifest } from '../../shared/kit/manifest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const contractDir = join(repoRoot, 'resources/cinna-kit-contract')
const CONTRACT_VERSION = readFileSync(join(contractDir, 'VERSION'), 'utf8').trim()
const layout = createLayoutView(
  parseLayout(JSON.parse(readFileSync(join(contractDir, 'layout.json'), 'utf8')))
)

const OPTIONS = { layout, contractVersion: CONTRACT_VERSION }

/**
 * The scaffold Phase 2 will do for real: copy `templates/agent/`, restore the
 * dotted ignore files, substitute the tokens. Validating what the contract
 * actually ships is the point — a template that does not pass its own validator
 * is a broken contract.
 */
function scaffold(parent: string, slug: string): string {
  const agentDir = join(parent, slug)
  cpSync(join(contractDir, 'templates/agent'), agentDir, { recursive: true })
  // Read the dot-restore pairs from the contract, exactly as Phase 2's
  // scaffolder must — hard-coding them here would hide a missing pair.
  for (const [from, to] of layout.scaffoldIgnoreFiles('agent')) {
    renameSync(join(agentDir, from), join(agentDir, to))
  }

  const tokens: Record<string, string> = {
    SLUG: slug,
    NAME: 'Invoice Watcher',
    DESCRIPTION: 'Flags invoices that arrive without a purchase-order number.',
    ID: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    CONTRACT_VERSION,
    KIT_VERSION: CONTRACT_VERSION,
    CREATED_AT: '2026-09-02T10:00:00Z'
  }
  const substitute = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        substitute(abs)
        continue
      }
      const before = readFileSync(abs, 'utf8')
      const after = before.replace(/\{\{([A-Z_]+)\}\}/g, (match, token: string) => tokens[token] ?? match)
      if (after !== before) writeFileSync(abs, after)
    }
  }
  substitute(agentDir)
  return agentDir
}

function readManifest(agentDir: string): CinnaAgentManifest {
  return JSON.parse(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8'))
}

function patchManifest(agentDir: string, patch: (m: CinnaAgentManifest) => void): void {
  const manifest = readManifest(agentDir)
  patch(manifest)
  writeFileSync(join(agentDir, 'cinna-agent.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

const codes = (findings: Finding[]): string[] => findings.map((f) => f.code)

function expectError(report: ValidationReport, code: string): void {
  expect(codes(report.errors), `expected error ${code}`).toContain(code)
}

let home: string
let agentDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cinna-validate-'))
  mkdirSync(join(home, 'Local'), { recursive: true })
  agentDir = scaffold(join(home, 'Local'), 'invoice-watcher')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('validateAgentFolder — a freshly scaffolded agent', () => {
  it('passes with no errors', () => {
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(report.errors).toEqual([])
  })

  it('warns only about what is genuinely not filled in yet', () => {
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(codes(report.warnings).sort()).toEqual(['cloud.example_prompts.missing', 'cloud.unroutable'])
  })

  it('is cloud-ready once it has example prompts', () => {
    patchManifest(agentDir, (m) => {
      m.example_prompts = ['What is my status today?', 'Check the invoices from <last week>']
    })
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('resolves the /run: reference the template ships a command for', () => {
    patchManifest(agentDir, (m) => {
      m.status_refresh_command = '/run:status'
    })
    expect(validateAgentFolder(agentDir, OPTIONS).errors).toEqual([])
  })
})

describe('validateAgentFolder — manifest errors', () => {
  it('never throws on a truncated manifest, and reports it', () => {
    writeFileSync(join(agentDir, 'cinna-agent.json'), '{ "name": "half a mani')
    let report: ValidationReport | undefined
    expect(() => {
      report = validateAgentFolder(agentDir, OPTIONS)
    }).not.toThrow()
    expectError(report!, 'manifest.manifest_invalid_json')
  })

  it('reports a manifest that is not an object', () => {
    writeFileSync(join(agentDir, 'cinna-agent.json'), '["not", "a", "manifest"]')
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.manifest_not_object')
  })

  it('reports a missing manifest', () => {
    rmSync(join(agentDir, 'cinna-agent.json'))
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.manifest_not_found')
  })

  it('requires the stable id', () => {
    patchManifest(agentDir, (m) => {
      delete m.id
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.id.missing')
  })

  it('requires the id to be a UUID', () => {
    patchManifest(agentDir, (m) => {
      m.id = 'invoice-watcher'
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.id.invalid')
  })

  it('requires a description', () => {
    patchManifest(agentDir, (m) => {
      m.description = ''
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.description.empty')
  })

  it('requires the slug to match the folder name', () => {
    patchManifest(agentDir, (m) => {
      m.slug = 'payout-reconciler'
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.slug.folder_mismatch')
  })

  it('rejects a slug that is not a slug', () => {
    patchManifest(agentDir, (m) => {
      m.slug = 'Invoice Watcher'
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.slug.pattern')
  })

  it('rejects a credential env_prefix that is not upper snake case', () => {
    patchManifest(agentDir, (m) => {
      m.credentials = [{ name: 'Vendor Portal', type: 'api_token', env_prefix: 'vendor-portal' }]
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.credentials.env_prefix')
  })

  it('warns about a credential type it does not recognise but does not reject it', () => {
    patchManifest(agentDir, (m) => {
      m.credentials = [{ name: 'Something New', type: 'quantum_oauth', env_prefix: 'SOMETHING_NEW_' }]
    })
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(report.errors).toEqual([])
    expect(codes(report.warnings)).toContain('manifest.credentials.type_unknown')
  })

  it('requires a prompt on a static_prompt schedule and a command on a script_trigger', () => {
    patchManifest(agentDir, (m) => {
      m.schedules = [
        { name: 'daily', cron_string: '0 9 * * *', schedule_type: 'static_prompt' },
        { name: 'watch', cron_string: '*/5 * * * *', schedule_type: 'script_trigger' },
        { name: 'broken', cron_string: 'every day', schedule_type: 'static_prompt', prompt: 'go' }
      ]
    })
    const report = validateAgentFolder(agentDir, OPTIONS)
    expectError(report, 'manifest.schedules.prompt_required')
    expectError(report, 'manifest.schedules.command_required')
    expectError(report, 'manifest.schedules.cron')
  })

  it('rejects a handover target that is not a slug and warns when the sibling is absent', () => {
    patchManifest(agentDir, (m) => {
      m.handovers = [{ target_slug: 'Payout Reconciler' }, { target_slug: 'payout-reconciler' }]
    })
    const report = validateAgentFolder(agentDir, OPTIONS)
    expectError(report, 'manifest.handovers.target_slug')
    expect(codes(report.warnings)).toContain('manifest.handovers.target_missing')

    mkdirSync(join(home, 'Local/payout-reconciler'))
    patchManifest(agentDir, (m) => {
      m.handovers = [{ target_slug: 'payout-reconciler' }]
    })
    expect(codes(validateAgentFolder(agentDir, OPTIONS).warnings)).not.toContain(
      'manifest.handovers.target_missing'
    )
  })

  it('rejects a publication with no platform', () => {
    patchManifest(agentDir, (m) => {
      m.publications = [{ agent_id: 'a1' } as never]
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.publications.required')
  })

  it('rejects an API key parked in runtime.credential', () => {
    patchManifest(agentDir, (m) => {
      m.runtime = { model: 'claude-sonnet-4-5', credential: 'sk-ant-not-a-reference' }
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.runtime.credential_looks_like_secret')
  })

  it('accepts a runtime that references a credential by name', () => {
    patchManifest(agentDir, (m) => {
      m.runtime = { model: 'claude-sonnet-4-5', credential: 'anthropic', permissions: { bash: 'ask' } }
    })
    expect(validateAgentFolder(agentDir, OPTIONS).errors).toEqual([])
  })
})

describe('validateAgentFolder — the contract gate', () => {
  it('refuses a folder built against a newer major', () => {
    patchManifest(agentDir, (m) => {
      m.contract_version = '2.0.0'
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'contract.app_too_old')
  })

  it('tolerates a legacy schema_version-only manifest with a warning', () => {
    patchManifest(agentDir, (m) => {
      delete m.contract_version
      delete m.id
      m.schema_version = 1
    })
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(report.errors).toEqual([])
    expect(codes(report.warnings)).toContain('manifest.legacy')
  })

  it('notes the deprecated cloud stamp', () => {
    patchManifest(agentDir, (m) => {
      m.cloud = { platform_url: 'https://acme.test', agent_id: 'a1' }
    })
    expect(codes(validateAgentFolder(agentDir, OPTIONS).infos)).toContain('manifest.cloud.deprecated')
  })
})

describe('validateAgentFolder — file-level checks', () => {
  it('reports a prompt file the manifest points at but that is gone', () => {
    rmSync(join(agentDir, 'docs/WORKFLOW_PROMPT.md'))
    expectError(validateAgentFolder(agentDir, OPTIONS), 'files.prompt_missing')
  })

  it('reports a /run: reference that resolves to nothing', () => {
    patchManifest(agentDir, (m) => {
      m.status_refresh_command = '/run:nightly'
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'commands.run_reference_unresolved')
  })

  it('warns when a catalogued command has no Makefile target', () => {
    writeFileSync(
      join(agentDir, 'docs/CLI_COMMANDS.yaml'),
      'commands:\n  - name: reconcile\n    description: Reconcile\n    command: python scripts/reconcile.py\n'
    )
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(codes(report.warnings)).toContain('commands.makefile_target_missing')
  })

  it('warns about a script that is not in scripts/README.md', () => {
    writeFileSync(join(agentDir, 'scripts/fetch_invoices.py'), 'print(1)\n')
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(codes(report.warnings)).toContain('scripts.uncatalogued')
  })

  it('accepts a script once it is catalogued', () => {
    writeFileSync(join(agentDir, 'scripts/fetch_invoices.py'), 'print(1)\n')
    writeFileSync(
      join(agentDir, 'scripts/README.md'),
      `${readFileSync(join(agentDir, 'scripts/README.md'), 'utf8')}\n| \`fetch_invoices.py\` | Fetches invoices. |\n`
    )
    expect(codes(validateAgentFolder(agentDir, OPTIONS).warnings)).not.toContain('scripts.uncatalogued')
  })

  it('reports a .env that no ignore rule covers', () => {
    writeFileSync(join(agentDir, 'credentials/.env'), 'VENDOR_PORTAL_TOKEN=secret\n')
    // The scaffolded .gitignore covers it.
    expect(codes(validateAgentFolder(agentDir, OPTIONS).errors)).not.toContain('secrets.not_ignored')

    writeFileSync(join(agentDir, '.gitignore'), '# somebody emptied this\n')
    rmSync(join(agentDir, 'credentials/.gitignore'))
    expectError(validateAgentFolder(agentDir, OPTIONS), 'secrets.not_ignored')
  })

  it('flags a root credentials.json, which holds live values from the cloud', () => {
    writeFileSync(
      join(agentDir, 'credentials.json'),
      '{"Vendor Portal": {"token": "live-secret"}}\n'
    )
    // The scaffolded .gitignore names it, and the contract excludes it from export.
    const clean = validateAgentFolder(agentDir, OPTIONS)
    expect(codes(clean.errors)).not.toContain('secrets.not_ignored')
    expect(codes(clean.errors)).not.toContain('secrets.exported')

    writeFileSync(join(agentDir, '.gitignore'), 'app-data/\n')
    expectError(validateAgentFolder(agentDir, OPTIONS), 'secrets.not_ignored')
  })

  it('flags private key material the same way', () => {
    writeFileSync(join(agentDir, 'config/service-account.pem'), '-----BEGIN PRIVATE KEY-----\n')
    writeFileSync(join(agentDir, '.gitignore'), 'app-data/\n')
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(codes(report.errors)).toContain('secrets.not_ignored')
    expect(report.errors.find((f) => f.code === 'secrets.not_ignored')?.path).toBe(
      'config/service-account.pem'
    )
  })

  it('reports a secret the contract would let travel', () => {
    writeFileSync(join(agentDir, 'credentials.json'), '{"Vendor Portal": {"token": "x"}}\n')
    // A contract whose exclude list has lost the rule: the validator is the
    // second line of defence and must say so.
    const holed = createLayoutView(
      parseLayout(
        JSON.parse(readFileSync(join(contractDir, 'layout.json'), 'utf8'), (key, value) =>
          key === 'cloud_import_excludes' ? [] : value
        )
      )
    )
    expectError(validateAgentFolder(agentDir, { ...OPTIONS, layout: holed }), 'secrets.exported')
  })

  it('warns about a STATUS.md with no frontmatter', () => {
    writeFileSync(join(agentDir, 'app-data/storage/STATUS.md'), 'everything is fine\n')
    expect(codes(validateAgentFolder(agentDir, OPTIONS).warnings)).toContain(
      'status.frontmatter_missing'
    )
  })

  it('accepts the STATUS.md shape update_status.py writes', () => {
    writeFileSync(
      join(agentDir, 'app-data/storage/STATUS.md'),
      '---\nstatus: ok\nsummary: "42 invoices checked"\ntimestamp: 2026-09-02T10:15:00Z\n---\n'
    )
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(codes(report.warnings)).not.toContain('status.frontmatter_missing')
    expect(codes(report.warnings)).not.toContain('status.field_missing')
  })

  it('survives a folder that is not there at all', () => {
    let report: ValidationReport | undefined
    expect(() => {
      report = validateAgentFolder(join(home, 'Local/ghost'), OPTIONS)
    }).not.toThrow()
    expect(report!.errors.length).toBeGreaterThan(0)
  })
})


describe('the contract drives the scaffold', () => {
  it('names every dotless ignore file, including the one under app-data', () => {
    const pairs = layout.scaffoldIgnoreFiles('agent').map(([from, to]) => `${from} -> ${to}`)
    expect(pairs).toEqual([
      'gitignore -> .gitignore',
      'app-data/cache/gitignore -> app-data/cache/.gitignore'
    ])
    expect(layout.scaffoldIgnoreFiles('root').map(([from]) => from)).toEqual(['gitignore'])
  })

  it('leaves no dotless ignore file behind in a scaffolded agent', () => {
    expect(statSync(join(agentDir, '.gitignore')).isFile()).toBe(true)
    expect(statSync(join(agentDir, 'app-data/cache/.gitignore')).isFile()).toBe(true)
    expect(readdirSync(agentDir)).not.toContain('gitignore')
    expect(readdirSync(join(agentDir, 'app-data/cache'))).not.toContain('gitignore')
    // credentials/.gitignore keeps its dot in the template and is not a pair.
    expect(statSync(join(agentDir, 'credentials/.gitignore')).isFile()).toBe(true)
  })

  it('ships the pyproject.toml the local command rule tests for', () => {
    expect(statSync(join(agentDir, 'pyproject.toml')).isFile()).toBe(true)
    const command = readCommandCatalog(agentDir).commands[0].command
    expect(command).toBe('python scripts/update_status.py')
    expect(layout.localizeCommand(command, { hasPyproject: true })).toBe(
      'uv run scripts/update_status.py'
    )
  })
})

describe('validateAgentFolder — the command catalog', () => {
  it('refuses a command whose line this reader would mis-read', () => {
    writeFileSync(
      join(agentDir, 'docs/CLI_COMMANDS.yaml'),
      [
        'commands:',
        '  - name: status',
        '    description: Refresh the status file.',
        '    command: python scripts/update_status.py',
        '  - name: tag',
        '    description: Tag a run.',
        '    command: python scripts/tag.py --tag #1 --keep',
        ''
      ].join('\n')
    )
    const report = validateAgentFolder(agentDir, OPTIONS)
    expectError(report, 'commands.unparseable')
    expect(report.errors.find((f) => f.code === 'commands.unparseable')?.message).toContain('"tag"')

    // The good command is still read; only the unreadable entry is dropped.
    const catalog = readCommandCatalog(agentDir)
    expect(catalog.commands.map((c) => c.name)).toEqual(['status'])
    expect(catalog.unreadable.map((u) => u.name)).toEqual(['tag'])
  })

  it('reads the shipped catalog with nothing to refuse', () => {
    const catalog = readCommandCatalog(agentDir)
    expect(catalog.unreadable).toEqual([])
    expect(catalog.commands.map((c) => c.name)).toEqual(['status'])
  })
})

describe('validateAgentFolder — the ignore check decides per path', () => {
  it('does not let a rule scoped to credentials/ cover a stray root .env', () => {
    writeFileSync(join(agentDir, '.gitignore'), 'credentials/.env\n')
    writeFileSync(join(agentDir, 'notes.env'), 'TOKEN=leaked\n')
    const report = validateAgentFolder(agentDir, OPTIONS)
    expect(report.errors.find((f) => f.code === 'secrets.not_ignored')?.path).toBe('notes.env')
  })

  it('accepts the ignore patterns people actually write', () => {
    writeFileSync(join(agentDir, 'credentials/.env'), 'TOKEN=x\n')
    for (const rule of ['*.env*', '**/*.env', 'credentials/*', 'credentials/.env']) {
      writeFileSync(join(agentDir, '.gitignore'), `${rule}\n`)
      rmSync(join(agentDir, 'credentials/.gitignore'), { force: true })
      const codesFor = codes(validateAgentFolder(agentDir, OPTIONS).errors)
      expect(codesFor, `rule ${rule} should cover credentials/.env`).not.toContain(
        'secrets.not_ignored'
      )
    }
  })

  it('anchors a leading-slash pattern instead of treating it as slashless', () => {
    // Regression: `/credentials.json` is anchored to the ignore file's directory
    // in git. Reading it as slashless made it "cover" a nested credentials.json
    // that git would happily commit — a false negative in a secret check.
    writeFileSync(join(agentDir, 'scripts/credentials.json'), '{"S":{"k":"x"}}')
    writeFileSync(join(agentDir, '.gitignore'), '/credentials.json\n')
    const anchored = validateAgentFolder(agentDir, OPTIONS)
    expect(anchored.errors.find((f) => f.code === 'secrets.not_ignored')?.path).toBe(
      'scripts/credentials.json'
    )

    // Without the slash the same pattern matches at any depth, as git does.
    writeFileSync(join(agentDir, '.gitignore'), 'credentials.json\n')
    expect(codes(validateAgentFolder(agentDir, OPTIONS).errors)).not.toContain(
      'secrets.not_ignored'
    )
  })

  it('does not let a negation exonerate a secret', () => {
    writeFileSync(join(agentDir, 'credentials.json'), '{"S":{"k":"x"}}')
    writeFileSync(join(agentDir, '.gitignore'), 'credentials.json\n!credentials.json\n')
    expectError(validateAgentFolder(agentDir, OPTIONS), 'secrets.not_ignored')

    // ...including when the re-include is in the deeper of two ignore files.
    writeFileSync(join(home, 'Local/.gitignore'), 'credentials.json\n')
    writeFileSync(join(agentDir, '.gitignore'), '!credentials.json\n')
    expectError(validateAgentFolder(agentDir, OPTIONS), 'secrets.not_ignored')
  })

  it('reads a workshop-level ignore but not a sibling agent’s', () => {
    writeFileSync(join(agentDir, 'credentials.json'), '{"S":{"k":"x"}}')
    writeFileSync(join(agentDir, '.gitignore'), 'app-data/\n')

    writeFileSync(join(home, '.gitignore'), 'credentials.json\n')
    expect(codes(validateAgentFolder(agentDir, OPTIONS).errors)).not.toContain(
      'secrets.not_ignored'
    )

    rmSync(join(home, '.gitignore'))
    mkdirSync(join(home, 'Local/payout-reconciler'), { recursive: true })
    writeFileSync(join(home, 'Local/payout-reconciler/.gitignore'), 'credentials.json\n')
    expectError(validateAgentFolder(agentDir, OPTIONS), 'secrets.not_ignored')
  })

  it('honours a negation the way git does', () => {
    writeFileSync(join(agentDir, 'credentials/.env'), 'TOKEN=x\n')
    writeFileSync(join(agentDir, '.gitignore'), '*.env\n!credentials/.env\n')
    rmSync(join(agentDir, 'credentials/.gitignore'), { force: true })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'secrets.not_ignored')
  })
})

describe('validateAgentFolder — the compatibility gate cannot be lost', () => {
  it('never compares a version with itself', () => {
    patchManifest(agentDir, (m) => {
      m.contract_version = '99.0.0'
    })
    // A caller must pass the active contract version; the gate then fires.
    expectError(validateAgentFolder(agentDir, OPTIONS), 'contract.app_too_old')
  })

  it('says so rather than silently passing when no contract version is known', () => {
    const report = validateManifest(readManifest(agentDir), {})
    expect(codes(report.infos)).toContain('contract.unchecked')
    expect(codes(report.errors)).not.toContain('contract.app_too_old')
  })
})

describe('the shipped schema', () => {
  const schema = JSON.parse(
    readFileSync(join(contractDir, 'schema/cinna-agent.schema.json'), 'utf8')
  ) as {
    required: string[]
    allOf: { if: unknown; else: { required: string[] } }[]
  }

  it('does not require identity at the top level, so a legacy folder parses', () => {
    expect(schema.required).toEqual(['name', 'slug', 'description'])
  })

  it('requires identity of everything that is not legacy, exactly as checkIdentity does', () => {
    expect(schema.allOf[0].else.required).toEqual(['contract_version', 'id'])
    expect(JSON.stringify(schema.allOf[0].if)).toBe(
      JSON.stringify({
        allOf: [
          { required: ['schema_version'] },
          { not: { required: ['contract_version'] } },
          { not: { required: ['id'] } }
        ]
      })
    )
  })

  it('agrees with the validator on both sides of that rule', () => {
    // Legacy: parses under the schema's `then`, warns in the validator.
    patchManifest(agentDir, (m) => {
      delete m.contract_version
      delete m.id
      m.schema_version = 1
    })
    const legacy = validateAgentFolder(agentDir, OPTIONS)
    expect(legacy.errors).toEqual([])
    expect(codes(legacy.warnings)).toContain('manifest.legacy')

    // Re-stamped but missing the id: the schema's `else` requires it, so does the validator.
    patchManifest(agentDir, (m) => {
      m.contract_version = CONTRACT_VERSION
      delete m.id
    })
    expectError(validateAgentFolder(agentDir, OPTIONS), 'manifest.id.missing')
  })
})

describe('the shipped templates', () => {
  it('ships the dotless ignore files the contract changelog describes', () => {
    expect(statSync(join(contractDir, 'templates/agent/gitignore')).isFile()).toBe(true)
    expect(statSync(join(contractDir, 'templates/agent/app-data/cache/gitignore')).isFile()).toBe(true)
    expect(statSync(join(contractDir, 'templates/root/gitignore')).isFile()).toBe(true)
    // credentials/.gitignore keeps its dot on purpose.
    expect(statSync(join(contractDir, 'templates/agent/credentials/.gitignore')).isFile()).toBe(true)
  })

  it('leaves no unsubstituted token behind after a scaffold', () => {
    const unresolved: string[] = []
    const walk = (dir: string, rel = ''): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) walk(join(dir, entry.name), next)
        else if (/\{\{[A-Z_]+\}\}/.test(readFileSync(join(dir, entry.name), 'utf8'))) {
          unresolved.push(next)
        }
      }
    }
    walk(agentDir)
    expect(unresolved).toEqual([])
  })
})
