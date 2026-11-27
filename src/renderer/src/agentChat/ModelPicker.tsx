import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentChatModelChoice } from '../../../shared/agents/agentChat'
import { thinkingLevelSchema, type ThinkingLevel } from '../../../shared/agents/chat'
import { featuredModels, providerLabel, type ChatModelOption } from '../../../shared/agents/models'
import type { CommandResult } from '../../../shared/desktop/api'
import { Icon } from '../components/Icon'
import './modelPicker.css'

/** Each effort as the chip and the Effort control name it; short enough for five segments side by side. */
const EFFORT_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max'
}
const BUSY_HINT = 'Applies to next response'

interface ModelPickerProps {
  /** The chat's model (`provider/id`) as its snapshot reports it; null when none is known yet. */
  model: string | null
  /** The chat's thinking level as its snapshot reports it. */
  thinking: ThinkingLevel | null
  /** The agent is working: a switch applies from its next model request. */
  busy: boolean
  /** Reads the chat's model catalog (`agentChat:models`). */
  load(): Promise<CommandResult<ChatModelOption[]>>
  /** Switches the chat's model and effort (`agentChat:setModel`) once. */
  choose(choice: AgentChatModelChoice): Promise<CommandResult<unknown>>
}

type Catalog = { status: 'loading' } | { status: 'ready'; options: ChatModelOption[] } | { status: 'failed'; message: string }

const isLevel = (value: string): value is ThinkingLevel => thinkingLevelSchema.safeParse(value).success
/** The efforts a model takes that a switch can name. */
const effortsOf = (option: ChatModelOption): ThinkingLevel[] => option.efforts.filter(isLevel)
const keyOf = (option: ChatModelOption): string => `${option.provider}/${option.id}`

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

/** The effort a newly chosen model starts on: the chat's current one when it takes it, else Medium, else its lowest. */
function startingEffort(option: ChatModelOption, thinking: ThinkingLevel | null): ThinkingLevel | null {
  const efforts = effortsOf(option)
  if (thinking !== null && efforts.includes(thinking)) return thinking
  return efforts.includes('medium') ? 'medium' : efforts[0] ?? null
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
        if (sequence === request.current) setCatalog({ status: 'failed', message: cause instanceof Error ? cause.message : 'The models could not be read.' })
      }
    )
  }, [load])
  useEffect(() => {
    read()
    return () => { request.current++ }
  }, [read])
  return { catalog, retry: read }
}

/** Consecutive models of one provider under its label, in the order given. */
function byProvider(options: readonly ChatModelOption[]): { provider: string; label: string; models: ChatModelOption[] }[] {
  const groups: { provider: string; label: string; models: ChatModelOption[] }[] = []
  for (const option of options) {
    const group = groups.at(-1)
    if (group?.provider === option.provider) group.models.push(option)
    else groups.push({ provider: option.provider, label: providerLabel(option.provider), models: [option] })
  }
  return groups
}

/**
 * A Skitarii chat's model chip, just left of Send: `Opus 5.5 · High`. It opens an upward menu of the latest model of
 * each line by provider, a More models expander with every other model, and an Effort control for the chosen model.
 * Choosing a model and effort switches the chat once; the chip spins while it runs and reverts with an inline error
 * when it fails. While the agent works, the switch applies to its next response, and the chip says it is queued.
 */
export function ModelPicker({ model, thinking, busy, load, choose }: ModelPickerProps): JSX.Element {
  const { catalog, retry } = useCatalog(load)
  const options = catalog.status === 'ready' ? catalog.options : null
  const current = options?.find((option) => keyOf(option) === model) ?? null
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<{ option: ChatModelOption; effort: ThinkingLevel | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useEffect(() => {
    if (!busy) setQueued(false)
  }, [busy])

  const close = useCallback((focusChip: boolean) => {
    setOpen(false)
    if (focusChip) chip.current?.focus()
  }, [])
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: MouseEvent): void => {
      if (!(event.target instanceof Node && anchor.current?.contains(event.target))) close(false)
    }
    document.addEventListener('mousedown', onPress)
    return () => document.removeEventListener('mousedown', onPress)
  }, [open, close])

  async function apply(option: ChatModelOption, effort: ThinkingLevel | null): Promise<void> {
    close(true)
    if (pending !== null) return
    setError(null)
    setPending({ option, effort })
    try {
      const result = await choose({ provider: option.provider, modelId: option.id, ...(effort === null ? {} : { effort }) })
      if (!result.ok) setError(result.error.message)
      else if (busy) setQueued(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The model could not be switched.')
    } finally {
      setPending(null)
    }
  }

  const name = current !== null ? shortName(current) : model === null ? 'Model' : model.slice(model.indexOf('/') + 1)
  const [shown, effort] = pending === null ? [name, thinking] : [shortName(pending.option), pending.effort]
  const label = effort === null ? shown : `${shown} · ${EFFORT_LABELS[effort]}`
  return (
    <div className="model-picker" ref={anchor}>
      {error !== null && <span className="model-picker-error" role="alert">{error}</span>}
      <button ref={chip} type="button" className="model-picker-chip" aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} aria-busy={pending !== null} aria-label={`Model: ${label}${queued ? ', queued' : ''}`}
        title={busy ? BUSY_HINT : 'Model and effort'}
        onClick={() => {
          if (open) return close(false)
          setOpen(true)
          if (catalog.status === 'failed') retry()
        }}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !open) {
            event.preventDefault()
            setOpen(true)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          }
        }}>
        {pending !== null && <span className="model-picker-spinner" aria-hidden="true" />}
        <span className="model-picker-label">{label}</span>
        {queued && <span className="model-picker-queued">queued</span>}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && <ModelMenu id={menuId} catalog={catalog} current={current} thinking={thinking} busy={busy} queued={queued}
        retry={retry} apply={(option, effort) => { void apply(option, effort) }} close={close} />}
    </div>
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
  apply(option: ChatModelOption, effort: ThinkingLevel | null): void
  close(focusChip: boolean): void
}

type FocusRequest = 'model' | 'effort' | 'first' | null

/** The open menu: models by provider, More models, Effort; arrows move, typing filters by name, Escape closes. */
function ModelMenu({ id, catalog, current, thinking, busy, queued, retry, apply, close }: MenuProps): JSX.Element {
  const options = useMemo(() => catalog.status === 'ready' ? catalog.options : [], [catalog])
  const groups = useMemo(() => featuredModels(options), [options])
  const [draft, setDraft] = useState<ChatModelOption | null>(current)
  const [query, setQuery] = useState('')
  const [moreOpen, setMoreOpen] = useState(() => current !== null && !groups.featured.includes(current))
  const menu = useRef<HTMLDivElement>(null)
  // The element to focus once the menu has rendered it: kept until it exists, so a catalog that arrives later still gets it.
  const focusRequest = useRef<FocusRequest>('model')
  useLayoutEffect(() => {
    const request = focusRequest.current
    const root = menu.current
    if (request === null || root === null) return
    const selector = request === 'effort' ? '[data-effort][aria-checked="true"]' : request === 'model' ? '[data-model][aria-checked="true"]' : '[data-model]'
    const target = root.querySelector<HTMLElement>(selector) ?? root.querySelector<HTMLElement>('[data-menu-item]')
    if (target !== null) {
      target.focus()
      focusRequest.current = null
    }
  })

  const needle = query.toLowerCase()
  const matches = (option: ChatModelOption): boolean => option.name.toLowerCase().includes(needle)
  const featured = byProvider(groups.featured.filter(matches))
  const more = groups.more.map((group) => ({ ...group, models: group.models.filter(matches) })).filter((group) => group.models.length > 0)
  const showMore = moreOpen || query !== ''
  const efforts = draft === null ? [] : effortsOf(draft)
  const effort = draft === null ? null : startingEffort(draft, thinking)

  function pick(option: ChatModelOption): void {
    if (effortsOf(option).length === 0) return apply(option, null)
    setDraft(option)
    focusRequest.current = 'effort'
  }
  function pickEffort(level: ThinkingLevel): void {
    if (draft === null) return
    if (draft === current && level === thinking) return close(true)
    apply(draft, level)
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const move = (index: number): void => {
      event.preventDefault()
      items.at(index % items.length)?.focus()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at <= 0 ? items.length - 1 : at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(items.length - 1)
    else if (event.key === 'Tab') close(false)
    else if (event.key === 'Backspace' && query !== '') {
      event.preventDefault()
      setQuery(query.slice(0, -1))
      focusRequest.current = 'first'
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      setQuery(query + event.key)
      focusRequest.current = 'first'
    }
  }

  const item = (option: ChatModelOption): JSX.Element => {
    const context = contextLabel(option.contextWindow)
    const checked = draft !== null && keyOf(draft) === keyOf(option)
    return (
      <button key={keyOf(option)} type="button" role="menuitemradio" aria-checked={checked} className="model-picker-item" data-menu-item data-model
        tabIndex={-1} onClick={() => pick(option)}>
        <span className="model-picker-check" aria-hidden="true">{checked && <Icon name="check" size={14} strokeWidth={2} />}</span>
        <span className="model-picker-name">{shortName(option)}</span>
        {context !== null && <span className="model-picker-context"><span className="sr-only">, context </span>{context}</span>}
        {option.images && <span className="model-picker-images" title="Reads images"><Icon name="image" size={14} /><span className="sr-only">, reads images</span></span>}
      </button>
    )
  }
  const group = ({ provider, label, models }: { provider: string; label: string; models: ChatModelOption[] }, prefix: string): JSX.Element => (
    <div key={`${prefix}${provider}`} role="group" aria-label={prefix === '' ? label : `More ${label}`} className="model-picker-group">
      <div className="model-picker-heading" aria-hidden="true">{label}</div>
      {models.map(item)}
    </div>
  )

  return (
    <div id={id} ref={menu} className="model-picker-menu glass-strong" role="menu" aria-label="Model and effort" onKeyDown={onKeyDown}>
      {busy && <p className="model-picker-hint">{queued ? `Queued · ${BUSY_HINT.toLowerCase()}` : BUSY_HINT}</p>}
      {query !== '' && <p className="model-picker-hint" aria-live="polite">Filter: {query}</p>}
      <div className="model-picker-list">
        {catalog.status === 'loading' && <p className="model-picker-hint">Loading models…</p>}
        {catalog.status === 'failed' && <div className="model-picker-hint">
          <span role="alert">{catalog.message}</span>{' '}
          <button type="button" role="menuitem" className="model-picker-retry" data-menu-item tabIndex={-1} onClick={retry}>Retry</button>
        </div>}
        {catalog.status === 'ready' && featured.length === 0 && more.length === 0
          && <p className="model-picker-hint">{query === '' ? 'No models are available.' : `No model matches “${query}”.`}</p>}
        {featured.map((entry) => group(entry, ''))}
        {query === '' && groups.more.length > 0 && (
          <button type="button" role="menuitem" className="model-picker-more" aria-expanded={showMore} data-menu-item tabIndex={-1}
            onClick={() => setMoreOpen(!moreOpen)}>
            <Icon name={showMore ? 'chevron-down' : 'chevron-right'} size={12} />More models
          </button>
        )}
        {showMore && more.map((entry) => group(entry, 'more:'))}
      </div>
      {draft !== null && efforts.length > 0 && (
        <div className="model-picker-effort" role="group" aria-label="Effort">
          <span className="model-picker-effort-label" aria-hidden="true">
            {draft === current ? 'Effort' : `Effort for ${shortName(draft)}: choose one to switch`}
          </span>
          <div className="model-picker-segments">
            {efforts.map((level) => (
              <button key={level} type="button" role="menuitemradio" aria-checked={level === effort} className="model-picker-segment"
                data-menu-item data-effort tabIndex={-1} onClick={() => pickEffort(level)}>{EFFORT_LABELS[level]}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
