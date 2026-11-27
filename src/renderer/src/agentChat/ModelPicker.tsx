import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { AgentChatModelChoice } from '../../../shared/agents/agentChat'
import { thinkingLevelSchema, type ThinkingLevel } from '../../../shared/agents/chat'
import { featuredModels, providerLabel, type ChatModelOption } from '../../../shared/agents/models'
import type { CommandResult } from '../../../shared/desktop/api'
import { Icon } from '../components/Icon'
import type { AgentChatState } from './agentChatModel'
import './modelPicker.css'

/** Each effort as the chip and the Effort control name it; short enough for five segments side by side. */
const EFFORT_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max'
}
const BUSY_HINT = 'Applies to next response'

interface ModelPickerProps {
  /** The chat's model (`provider/id`) and thinking level as its snapshot reports them, and whether it is busy. */
  state: Pick<AgentChatState, 'model' | 'thinking' | 'status'>
  /** Reads the chat's model catalog (`agentChat:models`). */
  load(): Promise<CommandResult<ChatModelOption[]>>
  /** Switches the chat's model and effort (`agentChat:setModel`) once. */
  choose(choice: AgentChatModelChoice): Promise<CommandResult<unknown>>
}

type Catalog = { status: 'loading' } | { status: 'ready'; options: ChatModelOption[] } | { status: 'failed'; message: string }
type Choice = { option: ChatModelOption; effort: ThinkingLevel | null }
type Apply = (option: ChatModelOption, effort: ThinkingLevel | null) => void
type Group = { provider: string; label: string; models: ChatModelOption[] }

const isLevel = (value: string): value is ThinkingLevel => thinkingLevelSchema.safeParse(value).success
/** The efforts a model takes that a switch can name. */
const effortsOf = (option: ChatModelOption): ThinkingLevel[] => option.efforts.filter(isLevel)
const keyOf = (option: ChatModelOption): string => `${option.provider}/${option.id}`
const messageOf = (cause: unknown, fallback: string): string => cause instanceof Error ? cause.message : fallback

/** The model's name under its provider's heading: `Claude Opus 5.5` reads `Opus 5.5`; other names stay whole. */
function shortName(option: ChatModelOption): string {
  const prefix = `${providerLabel(option.provider)} `
  return option.name.startsWith(prefix) && option.name.length > prefix.length ? option.name.slice(prefix.length) : option.name
}

/** `1M`, `272K`; null when the catalog gives no context window. */
function contextLabel(tokens: number | null): string | null {
  if (tokens === null || tokens <= 0) return null
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1_000)}K`
}

/** The effort a model starts on in the menu: the chat's current one when it takes it, else Medium, else its lowest. */
function startingEffort(option: ChatModelOption, thinking: ThinkingLevel | null): ThinkingLevel | null {
  const efforts = effortsOf(option)
  if (thinking !== null && efforts.includes(thinking)) return thinking
  return efforts.includes('medium') ? 'medium' : efforts[0] ?? null
}

/** What the chip reads: the switch in flight, else the chat's model by its catalog name (its id before the catalog arrives). */
function chipText(current: ChatModelOption | null, model: string | null, thinking: ThinkingLevel | null, pending: Choice | null): string {
  const known = current === null ? null : shortName(current)
  const name = pending === null ? known ?? model?.slice(model.indexOf('/') + 1) ?? 'Model' : shortName(pending.option)
  const effort = pending === null ? thinking : pending.effort
  return effort === null ? name : `${name} · ${EFFORT_LABELS[effort]}`
}

/** The chat's catalog, read once per chat and again on `retry` after a failure. */
function useCatalog(load: ModelPickerProps['load']): { catalog: Catalog; retry(): void } {
  const [catalog, setCatalog] = useState<Catalog>({ status: 'loading' })
  const request = useRef(0)
  const read = useCallback(() => {
    const sequence = ++request.current
    setCatalog({ status: 'loading' })
    load().then(
      (result) => {
        if (sequence === request.current) setCatalog(result.ok ? { status: 'ready', options: result.data } : { status: 'failed', message: result.error.message })
      },
      (cause: unknown) => {
        if (sequence === request.current) setCatalog({ status: 'failed', message: messageOf(cause, 'The models could not be read.') })
      }
    )
  }, [load])
  useEffect(() => {
    read()
    return () => { request.current++ }
  }, [read])
  return { catalog, retry: read }
}

/**
 * One switch at a time: the choice in flight, the last failure, and whether a switch made while the agent worked still
 * waits for its next response (cleared once the turn ends).
 */
function useModelSwitch(choose: ModelPickerProps['choose'], busy: boolean) {
  const [pending, setPending] = useState<Choice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)
  useEffect(() => {
    if (!busy) setQueued(false)
  }, [busy])
  async function apply(option: ChatModelOption, effort: ThinkingLevel | null): Promise<void> {
    if (pending !== null) return
    setError(null)
    setPending({ option, effort })
    try {
      const result = await choose({ provider: option.provider, modelId: option.id, ...(effort === null ? {} : { effort }) })
      if (!result.ok) setError(result.error.message)
      else if (busy) setQueued(true)
    } catch (cause) {
      setError(messageOf(cause, 'The model could not be switched.'))
    } finally {
      setPending(null)
    }
  }
  return { pending, error, queued, apply }
}

/** Closes the menu on a press outside the picker while it is open. */
function useDismiss(open: boolean, anchor: RefObject<HTMLElement>, close: (focusChip: boolean) => void): void {
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: MouseEvent): void => {
      if (!(event.target instanceof Node && anchor.current?.contains(event.target))) close(false)
    }
    document.addEventListener('mousedown', onPress)
    return () => document.removeEventListener('mousedown', onPress)
  }, [open, anchor, close])
}

/**
 * A Skitarii chat's model chip, just left of Send: `Opus 5.5 · High`. It opens an upward menu of the latest model of
 * each line by provider, a More models expander with every other model, and an Effort control for the chosen model.
 * Choosing a model and effort switches the chat once; the chip spins while it runs and reverts with an inline error
 * when it fails. While the agent works, the switch applies to its next response, and the chip says it is queued.
 */
export function ModelPicker({ state, load, choose }: ModelPickerProps): JSX.Element {
  const busy = state.status === 'busy'
  const thinking = state.thinking ?? null
  const { catalog, retry } = useCatalog(load)
  const current = catalog.status === 'ready' ? catalog.options.find((option) => keyOf(option) === state.model) ?? null : null
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const close = useCallback((focusChip: boolean) => {
    setOpen(false)
    if (focusChip) chip.current?.focus()
  }, [])
  useDismiss(open, anchor, close)
  const change = useModelSwitch(choose, busy)
  function toggle(): void {
    if (open) return close(false)
    setOpen(true)
    if (catalog.status === 'failed') retry()
  }
  return (
    <div className="model-picker" ref={anchor}>
      {change.error !== null && <span className="model-picker-error" role="alert">{change.error}</span>}
      <ModelChip chipRef={chip} open={open} menuId={menuId} label={chipText(current, state.model ?? null, thinking, change.pending)}
        spinning={change.pending !== null} queued={change.queued} busy={busy} toggle={toggle} close={close} />
      {open && <ModelMenu id={menuId} catalog={catalog} current={current} thinking={thinking} busy={busy} queued={change.queued}
        retry={retry} close={close} apply={(option, effort) => {
          close(true)
          void change.apply(option, effort)
        }} />}
    </div>
  )
}

function ModelChip({ chipRef, open, menuId, label, spinning, queued, busy, toggle, close }: {
  chipRef: RefObject<HTMLButtonElement>
  open: boolean
  menuId: string
  label: string
  spinning: boolean
  queued: boolean
  busy: boolean
  toggle(): void
  close(focusChip: boolean): void
}): JSX.Element {
  // Enter and Space open it as the native button they press; the arrows open it too, and Escape closes it in place.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !open) {
      event.preventDefault()
      toggle()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  }
  return (
    <button ref={chipRef} type="button" className="model-picker-chip" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} aria-busy={spinning} aria-label={`Model: ${label}${queued ? ', queued' : ''}`}
      title={busy ? BUSY_HINT : 'Model and effort'} onClick={toggle} onKeyDown={onKeyDown}>
      {spinning && <span className="model-picker-spinner" aria-hidden="true" />}
      <span className="model-picker-label">{label}</span>
      {queued && <span className="model-picker-queued">queued</span>}
      <Icon name="chevron-down" size={12} />
    </button>
  )
}

interface MenuProps {
  id: string
  catalog: Catalog
  current: ChatModelOption | null
  thinking: ThinkingLevel | null
  busy: boolean
  queued: boolean
  retry(): void
  apply: Apply
  close(focusChip: boolean): void
}

type FocusTarget = 'model' | 'effort' | 'first'
const FOCUS_SELECTORS: Readonly<Record<FocusTarget, string>> = {
  model: '[data-model][aria-checked="true"]', effort: '[data-effort][aria-checked="true"]', first: '[data-model]'
}

/**
 * Focuses the menu's checked model when it opens and the target of each later request once it has rendered; a request
 * waits until its element exists, so a catalog that arrives after the menu opened still gets focus.
 */
function useMenuFocus(menu: RefObject<HTMLElement>): (target: FocusTarget) => void {
  const request = useRef<FocusTarget | null>('model')
  useLayoutEffect(() => {
    const root = menu.current
    if (request.current === null || root === null) return
    const target = root.querySelector<HTMLElement>(FOCUS_SELECTORS[request.current]) ?? root.querySelector<HTMLElement>('[data-menu-item]')
    if (target === null) return
    target.focus()
    request.current = null
  })
  return useCallback((target: FocusTarget) => { request.current = target }, [])
}

/** Where each navigation key moves focus among `count` items from `at` (-1 when none has focus). */
const NAVIGATION: Readonly<Record<string, (at: number, count: number) => number>> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at <= 0 ? count - 1 : at - 1),
  Home: () => 0,
  End: (_at, count) => count - 1
}

/** The filter after a key: one more printable character, one fewer on Backspace; null for any other key. */
function typed(event: KeyboardEvent, query: string): string | null {
  if (event.key === 'Backspace') return query === '' ? null : query.slice(0, -1)
  const printable = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
  return printable ? query + event.key : null
}

/** The featured models (`featuredModels`) and the More groups whose names hold the filter, each grouped by provider. */
function visibleModels({ featured, more }: { featured: ChatModelOption[]; more: Group[] }, query: string): { featured: Group[]; more: Group[] } {
  const needle = query.toLowerCase()
  const matches = (option: ChatModelOption): boolean => option.name.toLowerCase().includes(needle)
  const groups: Group[] = []
  for (const option of featured.filter(matches)) {
    const group = groups.at(-1)
    if (group?.provider === option.provider) group.models.push(option)
    else groups.push({ provider: option.provider, label: providerLabel(option.provider), models: [option] })
  }
  return { featured: groups, more: more.map((group) => ({ ...group, models: group.models.filter(matches) })).filter((group) => group.models.length > 0) }
}

/** The open menu: models by provider, More models, Effort; arrows move, typing filters by name, Escape closes. */
function ModelMenu({ id, catalog, current, thinking, busy, queued, retry, apply, close }: MenuProps): JSX.Element {
  const groups = useMemo(() => featuredModels(catalog.status === 'ready' ? catalog.options : []), [catalog])
  const [draft, setDraft] = useState(current)
  const [query, setQuery] = useState('')
  const [moreOpen, setMoreOpen] = useState(() => current !== null && !groups.featured.includes(current))
  const menu = useRef<HTMLDivElement>(null)
  const focus = useMenuFocus(menu)
  const shown = visibleModels(groups, query)
  const showMore = moreOpen || query !== ''
  function pick(option: ChatModelOption): void {
    if (effortsOf(option).length === 0) return apply(option, null)
    setDraft(option)
    focus('effort')
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const navigate = NAVIGATION[event.key]
    const filter = typed(event, query)
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') return close(false)
    else if (navigate !== undefined) {
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
      items[navigate(items.indexOf(document.activeElement as HTMLElement), items.length)]?.focus()
    } else if (filter !== null) {
      setQuery(filter)
      focus('first')
    } else return
    event.preventDefault()
  }
  const checked = draft === null ? null : keyOf(draft)
  return (
    <div id={id} ref={menu} className="model-picker-menu glass-strong" role="menu" aria-label="Model and effort" onKeyDown={onKeyDown}>
      <MenuStatus catalog={catalog} busy={busy} queued={queued} query={query} empty={shown.featured.length + shown.more.length === 0} retry={retry} />
      <div className="model-picker-list">
        {shown.featured.map((group) => <ModelGroup key={group.provider} group={group} name={group.label} checked={checked} pick={pick} />)}
        {query === '' && groups.more.length > 0 && (
          <button type="button" role="menuitem" className="model-picker-more" aria-expanded={showMore} data-menu-item tabIndex={-1}
            onClick={() => setMoreOpen(!moreOpen)}>
            <Icon name={showMore ? 'chevron-down' : 'chevron-right'} size={12} />More models
          </button>
        )}
        {showMore && shown.more.map((group) => <ModelGroup key={`more:${group.provider}`} group={group} name={`More ${group.label}`} checked={checked} pick={pick} />)}
      </div>
      {draft !== null && <EffortControl draft={draft} current={current} thinking={thinking} apply={apply} close={close} />}
    </div>
  )
}

/** The menu's notes: the busy hint, the filter, and the catalog while it loads, fails or holds nothing to show. */
function MenuStatus({ catalog, busy, queued, query, empty, retry }: {
  catalog: Catalog; busy: boolean; queued: boolean; query: string; empty: boolean; retry(): void
}): JSX.Element {
  return (
    <>
      {busy && <p className="model-picker-hint">{queued ? `Queued · ${BUSY_HINT.toLowerCase()}` : BUSY_HINT}</p>}
      {query !== '' && <p className="model-picker-hint" aria-live="polite">Filter: {query}</p>}
      {catalog.status === 'loading' && <p className="model-picker-hint">Loading models…</p>}
      {catalog.status === 'failed' && <div className="model-picker-hint">
        <span role="alert">{catalog.message}</span>{' '}
        <button type="button" role="menuitem" className="model-picker-retry" data-menu-item tabIndex={-1} onClick={retry}>Retry</button>
      </div>}
      {catalog.status === 'ready' && empty
        && <p className="model-picker-hint">{query === '' ? 'No models are available.' : `No model matches “${query}”.`}</p>}
    </>
  )
}

/** One provider's models under its heading; each shows its name, context window and whether it reads images. */
function ModelGroup({ group, name, checked, pick }: {
  group: Group; name: string; checked: string | null; pick(option: ChatModelOption): void
}): JSX.Element {
  return (
    <div role="group" aria-label={name} className="model-picker-group">
      <div className="model-picker-heading" aria-hidden="true">{group.label}</div>
      {group.models.map((option) => {
        const context = contextLabel(option.contextWindow)
        const isChecked = checked === keyOf(option)
        return (
          <button key={keyOf(option)} type="button" role="menuitemradio" aria-checked={isChecked} className="model-picker-item"
            data-menu-item data-model tabIndex={-1} onClick={() => pick(option)}>
            <span className="model-picker-check" aria-hidden="true">{isChecked && <Icon name="check" size={14} strokeWidth={2} />}</span>
            <span className="model-picker-name">{shortName(option)}</span>
            {context !== null && <span className="model-picker-context"><span className="sr-only">, context </span>{context}</span>}
            {option.images && <span className="model-picker-images" title="Reads images">
              <Icon name="image" size={14} /><span className="sr-only">, reads images</span>
            </span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The chosen model's efforts as a segmented control. Choosing one switches to the chosen model at that effort, once;
 * the chat's own model and effort only close the menu.
 */
function EffortControl({ draft, current, thinking, apply, close }: {
  draft: ChatModelOption; current: ChatModelOption | null; thinking: ThinkingLevel | null; apply: Apply; close(focusChip: boolean): void
}): JSX.Element | null {
  const efforts = effortsOf(draft)
  const selected = startingEffort(draft, thinking)
  if (efforts.length === 0) return null
  return (
    <div className="model-picker-effort" role="group" aria-label="Effort">
      <span className="model-picker-effort-label" aria-hidden="true">
        {draft === current ? 'Effort' : `Effort for ${shortName(draft)}: choose one to switch`}
      </span>
      <div className="model-picker-segments">
        {efforts.map((level) => (
          <button key={level} type="button" role="menuitemradio" aria-checked={level === selected} className="model-picker-segment"
            data-menu-item data-effort tabIndex={-1}
            onClick={() => (draft === current && level === thinking ? close(true) : apply(draft, level))}>{EFFORT_LABELS[level]}</button>
        ))}
      </div>
    </div>
  )
}
