import { useState } from 'react'
import type { DevelopmentContext } from '../../../../shared/developmentSession'
import { DEFAULT_DEVELOPMENT_COMPLEXITY, DEVELOPMENT_RUNTIME_NAMES } from '../../../../shared/developmentSession'
import { codexEffortForComplexity, isAgentEngine, type AgentEngine } from '../../../../shared/engine'
import { isWorkComplexity, WORK_COMPLEXITIES, WORK_COMPLEXITY_LABELS } from '../../../../shared/modelFamilies'
import type { RuntimeToolId } from '../../../../shared/localTools'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { useClaudeBinary, useCodexBinary, useDefaultRuntime } from '../../hooks/useEngine'
import { useInstallRuntimeTool, useLocalTools, useToolInstallPlan } from '../../hooks/useLocalTools'
import { useProviders } from '../../hooks/useProviders'
import { unwrapIpcError } from '../../utils/ipcError'
import { RuntimeChoiceButtons } from '../settings/RuntimeChoiceButtons'
import { InstallRuntimeDialog } from '../settings/InstallRuntimeDialog'
import { SettingsCard, SettingsLabel, SettingsSection, settingsDropdownRowClass, settingsInputClass } from '../settings/SettingsLayout'

import { DevelopmentRecheckButton } from './DevelopmentRecheckButton'

export function DevelopmentSettings({ data, onOpenWorkspace, onSetup, onCheck, checking }: {
  data?: DevelopmentContext
  onOpenWorkspace: () => void
  onSetup: () => void
  onCheck: () => Promise<unknown> | void
  checking?: boolean
}): React.JSX.Element {
  const { data: settings } = useAppSettings()
  const save = useSetAppSetting()
  const { data: defaultRuntime } = useDefaultRuntime()
  const { data: codexBinary } = useCodexBinary()
  const { data: claudeBinary } = useClaudeBinary()
  const { data: tools } = useLocalTools()
  const [installing, setInstalling] = useState<RuntimeToolId | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const plan = useToolInstallPlan(installing ?? 'claude')
  const select = (engine: AgentEngine | ''): void => {
    setFailure(null)
    save.mutate({ key: 'localDevelopmentEngine', value: engine })
  }
  const install = useInstallRuntimeTool({ onDone: (result) => {
    if (result.state !== 'done') { setFailure(result.error); return }
    if (installing && isAgentEngine(installing)) select(installing)
    setInstalling(null)
  } })
  const selected = isAgentEngine(settings?.localDevelopmentEngine) ? settings.localDevelopmentEngine : null
  const inheritedName = defaultRuntime ? DEVELOPMENT_RUNTIME_NAMES[defaultRuntime.engine] : 'Local-agent default'
  const complexity = isWorkComplexity(settings?.localDevelopmentComplexity) ? settings.localDevelopmentComplexity : DEFAULT_DEVELOPMENT_COMPLEXITY
  return <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
    <SettingsSection title="Local Development Runtime">
      <SettingsCard>
        <RuntimeChoiceButtons selected={selected} tools={tools} codexBinary={codexBinary} claudeBinary={claudeBinary}
          codexPathSet={(settings?.localAgentsCodexPath ?? '').trim() !== ''} claudePathSet={(settings?.localAgentsClaudePath ?? '').trim() !== ''}
          installing={install.isPending ? installing : null} disabled={!settings || save.isPending || install.isPending}
          defaultChoice={{ description: inheritedName, onSelect: () => select('') }}
          onSelect={select} onInstall={(tool) => { setFailure(null); setInstalling(tool) }} />
        <p className="mt-3 text-[13px] text-[var(--color-text-secondary)]">{selected ? 'Used for local build sessions on this computer.' : `Uses the local-agent default${defaultRuntime ? `: ${inheritedName}` : ''}. Changes to that default apply here too.`}</p>
        <div className={`${settingsDropdownRowClass} mt-4 border-t border-[var(--color-border)] pt-4`}>
          <SettingsLabel htmlFor="development-complexity" info={<p>Simple favors speed and lower cost; Medium balances capability and cost; Complex gives demanding builds more capability. Local Development defaults to Complex: Claude uses Opus, Codex uses high reasoning effort, and OpenCode selects a model from the Complex tier of your credential’s catalogue. This choice also applies when using Default Runtime.</p>}>
            Work complexity
          </SettingsLabel>
          <select id="development-complexity" className={settingsInputClass} value={complexity} disabled={!settings || save.isPending || install.isPending} onChange={(event) => save.mutate({ key: 'localDevelopmentComplexity', value: event.target.value })}>
            {WORK_COMPLEXITIES.map((tier) => <option key={tier} value={tier}>{WORK_COMPLEXITY_LABELS[tier]}</option>)}
          </select>
        </div>
        {selected === 'opencode' && <DevelopmentCredential />}
        {data && <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">Runs with {DEVELOPMENT_RUNTIME_NAMES[data.runtime.launcher]}{data.runtime.modelId ? ` · ${data.runtime.modelId}` : ''}{data.runtime.launcher === 'codex' ? ` · ${codexEffortForComplexity(data.complexity)} effort` : ''}</p>}
        {data?.blocker && <div className="mt-3 text-[13px]"><p className="text-[var(--color-danger)]">{data.blocker}</p><div className="mt-2"><DevelopmentRecheckButton onCheck={onCheck} fetching={checking} /></div></div>}
        {(save.error || failure) && <p role="alert" className="mt-3 text-[13px] text-[var(--color-danger)]">{failure ?? unwrapIpcError(save.error, 'Could not save the build runtime. Try again.')}</p>}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Cinna workspace">
      <SettingsCard>
        {data && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-[13px] text-[var(--color-text-secondary)]">
          <dt>Instance</dt><dd className="break-all">{data.serverUrl}</dd>
          <dt>Account</dt><dd>{data.accountName}</dd>
          <dt>Workspace</dt><dd className="break-all font-mono text-[12px]">{data.workspacePath}</dd>
          <dt>cinna-cli</dt><dd>{data.cliVersion}</dd>
        </dl>}
        <div className="mt-3 flex gap-4 text-[13px] font-medium text-[var(--color-accent)]">
          {data && <button type="button" onClick={onOpenWorkspace}>Open workspace</button>}
          <button type="button" onClick={onSetup}>Local Development setup</button>
        </div>
      </SettingsCard>
    </SettingsSection>
    {installing && plan && <InstallRuntimeDialog plan={plan} willSelect selectionDescription={`When it finishes, local build sessions use ${plan.label}.`} install={install} failure={failure} onCancel={() => setInstalling(null)} />}
  </div>
}

function DevelopmentCredential(): React.JSX.Element {
  const { data: settings } = useAppSettings()
  const { data: providers } = useProviders()
  const save = useSetAppSetting()
  const selected = settings?.localDevelopmentCredentialId ?? ''
  return <div className="mt-4 border-t border-[var(--color-border)] pt-4">
    <label htmlFor="development-credential" className="mb-2 block text-[13px] font-medium text-[var(--color-text)]">AI credential</label>
    <select id="development-credential" className={settingsInputClass} disabled={!providers || save.isPending} value={selected} onChange={(event) => save.mutate({ key: 'localDevelopmentCredentialId', value: event.target.value })}>
      <option value="">Default credential</option>
      {selected && providers && !providers.some((provider) => provider.id === selected) && <option value={selected}>Unavailable credential</option>}
      {(providers ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.enabled ? '' : ' (disabled)'}</option>)}
    </select>
    {save.error && <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{unwrapIpcError(save.error, 'Could not save the build credential.')}</p>}
  </div>
}
