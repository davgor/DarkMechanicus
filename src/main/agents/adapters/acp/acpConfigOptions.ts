/**
 * The model an ACP session runs on and the ones it offers, read from its session config options: the
 * `select` option with id `model` that `session/new`, `session/load`, `session/set_config_option`
 * and the `config_option_update` notification carry (https://agentclientprotocol.com/protocol/session-config-options).
 * Each choice's `value` is the model id and its `name` the label.
 */
import type { ModelOption } from '../../../../shared/agents/chat'
import { objectOf } from './acpJson'
import { stringOf } from './acpToolCalls'

export interface ModelConfig {
  /** The model the session runs on; null when it did not say. */
  current: string | null
  options: ModelOption[]
}

function choicesOf(options: unknown): ModelOption[] {
  if (!Array.isArray(options)) {
    return []
  }
  return options.flatMap((entry: unknown) => {
    const choice = objectOf(entry)
    const id = stringOf(choice?.value)
    return id === null ? [] : [{ id, label: stringOf(choice?.name) ?? id }]
  })
}

/** The `model` option of a list of config options, or null when the list has none. */
export function modelConfigOf(configOptions: unknown): ModelConfig | null {
  if (!Array.isArray(configOptions)) {
    return null
  }
  const model = configOptions.map((entry: unknown) => objectOf(entry)).find((option) => option?.id === 'model')
  if (model === undefined || model === null) {
    return null
  }
  return { current: stringOf(model.currentValue), options: choicesOf(model.options) }
}
