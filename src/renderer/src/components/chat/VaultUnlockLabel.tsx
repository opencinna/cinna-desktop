import { Loader2, LockOpen } from 'lucide-react'
import { StableLabel } from './ComposerNoticePanel'

/**
 * The label of an Unlock button on a locked vault's body (the locked chat
 * card, the file preview): Unlock, then "Unlocking…", then "Unlocking… 40%"
 * while the first unlock after an update downloads the guest image. Sized for
 * "Unlocking… 100%" from the start, so the button never widens.
 */
export function VaultUnlockLabel({ pending, percent }: { pending: boolean; percent: number | null }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-[6.5rem] justify-center">
      <StableLabel
        pending={pending}
        reserve={<><Loader2 size={14} />Unlocking… 100%</>}
        label={<><LockOpen size={14} aria-hidden="true" />Unlock</>}
        pendingLabel={<><Loader2 size={14} className="animate-spin" aria-hidden="true" />{percent === null ? 'Unlocking…' : `Unlocking… ${percent}%`}</>}
      />
    </span>
  )
}
