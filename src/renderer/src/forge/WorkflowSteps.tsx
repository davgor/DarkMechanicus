import type { ForgeSetupPlatform, ForgeSetupStep } from '../../../shared/desktop/forgeSetup'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import './forgeSetup.css'

const platforms: ReadonlyArray<{ id: ForgeSetupPlatform; name: string }> = [
  { id: 'win32', name: 'Windows' }, { id: 'darwin', name: 'macOS' }, { id: 'linux', name: 'Linux' }
]

export function WorkflowSteps({ steps }: { steps: readonly ForgeSetupStep[] }): JSX.Element {
  if (steps.length === 0) return <p className="muted">No setup steps yet.</p>
  return <ol className="forge-steps">
    {steps.map(step => <li key={step.id}>
      <strong>{step.title}</strong>
      {step.kind === 'instruction' ? <p>{step.instruction}</p> : <>
        <code>{[step.program, ...step.args.map(arg => JSON.stringify(arg))].join(' ')}</code>
        <p className="muted">Working directory: {step.cwd}</p>
      </>}
      {step.platforms?.length ? <p className="muted">{platforms.filter(platform => step.platforms?.includes(platform.id)).map(platform => platform.name).join(', ')}</p> : null}
    </li>)}
  </ol>
}

function PlatformFields({ step, update }: { step: ForgeSetupStep; update(step: ForgeSetupStep): void }): JSX.Element {
  const selected = step.platforms ?? []
  const toggle = (id: ForgeSetupPlatform): void => {
    const next = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]
    if (next.length > 0) update({ ...step, platforms: next })
    else {
      const { platforms: _platforms, ...all } = step
      update(all)
    }
  }
  return <fieldset className="forge-platforms">
    <legend>Platforms</legend>
    {platforms.map(platform => <label key={platform.id}>
      <input type="checkbox" checked={selected.includes(platform.id)} onChange={() => toggle(platform.id)} /> {platform.name}
    </label>)}
    <span className="muted">All platforms when no boxes are checked.</span>
  </fieldset>
}

function StepFields({ step, update }: { step: ForgeSetupStep; update(step: ForgeSetupStep): void }): JSX.Element {
  return <>
    <Field label="Step title" maxLength={120} value={step.title} onChange={title => update({ ...step, title })} />
    {step.kind === 'instruction' ? <Field label="Instructions" maxLength={4096} rows={3} value={step.instruction}
      onChange={instruction => update({ ...step, instruction })} /> : <>
      <Field label="Program" maxLength={64} value={step.program} onChange={program => update({ ...step, program })} />
      <Field label="Working directory" maxLength={240} value={step.cwd} onChange={cwd => update({ ...step, cwd })} hint="Repository-relative. Use . for the root." />
      <Field label="Arguments, one per line" rows={2} value={step.args.join('\n')}
        onChange={args => update({ ...step, args: args === '' ? [] : args.split('\n') })} />
    </>}
    <PlatformFields step={step} update={update} />
  </>
}

interface StepEditorProps {
  steps: ForgeSetupStep[]
  onChange(steps: ForgeSetupStep[]): void
  disabled: boolean
}

function newStep(kind: ForgeSetupStep['kind']): ForgeSetupStep {
  const id = 'step-' + crypto.randomUUID()
  return kind === 'instruction'
    ? { id, kind, title: '', instruction: '' }
    : { id, kind, title: '', cwd: '.', program: '', args: [] }
}

export function EditWorkflowSteps({ steps, onChange, disabled }: StepEditorProps): JSX.Element {
  const update = (index: number, step: ForgeSetupStep): void => onChange(steps.map((value, at) => at === index ? step : value))
  const move = (index: number, offset: -1 | 1): void => {
    const next = [...steps]
    const [step] = next.splice(index, 1)
    next.splice(index + offset, 0, step)
    onChange(next)
  }
  return <fieldset className="forge-step-editor" disabled={disabled}>
    <legend>Workflow steps</legend>
    {steps.map((step, index) => <fieldset className="forge-step" key={step.id}>
      <legend>Step {index + 1}</legend>
      <StepFields step={step} update={value => update(index, value)} />
      <div className="button-row">
        <Button size="sm" disabled={index === 0} onClick={() => move(index, -1)}>Move up</Button>
        <Button size="sm" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>Move down</Button>
        <Button size="sm" onClick={() => onChange(steps.filter(value => value.id !== step.id))}>Remove step</Button>
      </div>
    </fieldset>)}
    <div className="button-row">
      <Button size="sm" disabled={steps.length >= 32} onClick={() => onChange([...steps, newStep('command')])}>Add command</Button>
      <Button size="sm" disabled={steps.length >= 32} onClick={() => onChange([...steps, newStep('instruction')])}>Add instruction</Button>
    </div>
  </fieldset>
}
