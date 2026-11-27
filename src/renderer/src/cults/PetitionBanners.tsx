/**
 * The run's pending petitions, newest first, as scroll banners over the room's top edge. Each names its kind, reason
 * and the member who raised it (the Magos: only it may petition), with Approve and Deny. An acolytes petition is
 * granted a count from 1 to what was asked, never past the ceiling of 24; folder access names the folder; Allow save
 * warns what saving lets the Magos do.
 */
import { useState } from 'react'
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import type { CultPetitionView, PetitionKind } from '../../../shared/cults/cult'
import { Button } from '../components/Button'
import { boundedGrant, capRoom, pendingPetitions } from './cultPageModel'

const KIND_TEXT: Readonly<Record<PetitionKind, string>> = {
  acolytes: 'More acolytes',
  allow_save: 'Allow save',
  folder_access: 'Folder access'
}

interface BannersProps {
  run: CultRunDetail
  /** Who raises petitions: the run's Magos. */
  petitioner: string
}

export function PetitionBanners({ run, petitioner }: BannersProps): JSX.Element | null {
  const pending = pendingPetitions(run)
  if (pending.length === 0) return null
  return (
    <ol className="cult-petitions" aria-label="Pending petitions">
      {pending.map((petition) => <PetitionBanner key={petition.id} petition={petition} cap={run.run.cap} petitioner={petitioner} />)}
    </ol>
  )
}

interface BannerProps {
  petition: CultPetitionView
  cap: number
  petitioner: string
}

function PetitionBanner({ petition, cap, petitioner }: BannerProps): JSX.Element {
  const [granted, setGranted] = useState(() => String(boundedGrant(Number.POSITIVE_INFINITY, petition, cap)))
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const full = petition.kind === 'acolytes' && capRoom(cap) === 0
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true)
    const count = approve && petition.kind === 'acolytes' ? boundedGrant(Number(granted), petition, cap) : undefined
    const result = await window.dm.cults.decidePetition(petition.id, approve, count)
    setBusy(false)
    setRefusal(result.ok ? null : result.error.message)
  }
  return (
    <li className="cult-petition" aria-label={`${KIND_TEXT[petition.kind]} petition from ${petitioner}`}>
      <div className="cult-petition-head">
        <span className="cult-petition-kind">{KIND_TEXT[petition.kind]}</span>
        <span className="cult-petition-from">{petitioner}</span>
      </div>
      <p className="cult-petition-reason">{petition.reason}</p>
      <PetitionDetail petition={petition} cap={cap} granted={granted} onGranted={setGranted} />
      <div className="cult-petition-actions">
        <Button size="sm" variant="primary" busy={busy} disabled={full} onClick={() => void decide(true)}>Approve</Button>
        <Button size="sm" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
      </div>
      {refusal === null ? null : <p className="cult-refusal" role="alert">{refusal}</p>}
    </li>
  )
}

interface DetailProps {
  petition: CultPetitionView
  cap: number
  granted: string
  onGranted(value: string): void
}

function PetitionDetail({ petition, cap, granted, onGranted }: DetailProps): JSX.Element {
  if (petition.kind === 'folder_access') return <p className="cult-petition-detail mono">{petition.folderPath}</p>
  if (petition.kind === 'allow_save') {
    return <p className="cult-petition-warning" role="note">Warning: approving lets the Magos save plans and change the board in this workspace for the rest of the run.</p>
  }
  const most = Math.min(petition.additional ?? 0, capRoom(cap))
  if (most === 0) return <p className="cult-petition-detail">{`Asks for ${petition.additional}; the run is at the ceiling of 24.`}</p>
  return (
    <label className="cult-petition-detail">
      {`Asks for ${petition.additional}. Grant `}
      <input className="input mono cult-grant" type="number" min={1} max={most} value={granted} aria-label="Acolytes to grant"
        onChange={(event) => onGranted(event.target.value)} />
      {` of at most ${most}`}
    </label>
  )
}
