import { useState } from 'react'
import { Download } from 'lucide-react'
import { useInstallRuntimeTool, useToolInstallPlan } from '../../hooks/useLocalTools'
import { InstallRuntimeDialog } from '../settings/InstallRuntimeDialog'
import { DEVELOPMENT_RUNTIME_NAMES } from '../../../../shared/developmentSession'

/** Reuse the same reviewed install plan and progress UI as Settings → Runtime. */
export function RuntimeInstallAction({ tool, onDone }: { tool: 'claude' | 'codex'; onDone: () => void }): React.JSX.Element | null {
  const plan = useToolInstallPlan(tool)
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const install = useInstallRuntimeTool({ onDone: (result) => {
    if (result.state !== 'done') { setFailure(result.error); return }
    setOpen(false)
    onDone()
  } })
  if (!plan) return null
  return <>
    <button type="button" onClick={() => { setFailure(null); setOpen(true) }} className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)]"><Download size={13} /> Install {DEVELOPMENT_RUNTIME_NAMES[tool]}</button>
    {open && <InstallRuntimeDialog plan={plan} willSelect={false} selectionDescription="After installation, Cinna checks this runtime so you can start building." install={install} failure={failure} onCancel={() => setOpen(false)} />}
  </>
}
