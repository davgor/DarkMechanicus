/**
 * DM-1042 spike: the pure kill decision for the physical-ESC switch, kept apart from the hook helper so it can be unit
 * tested. A key-down of Escape that the low-level keyboard hook did not flag as injected (`LLKHF_INJECTED`, or the
 * lower-integrity `LLKHF_LOWER_IL_INJECTED`) is a person's hand on the keyboard: it ends desktop control. An injected
 * Escape (the agent's own `SendInput`, OMP computer use, or any other synthetic source) passes through to the app.
 * Key-ups and every other key never kill. Imported by no product code.
 */

/** Windows virtual-key code of Escape. */
export const VK_ESCAPE = 0x1b

/**
 * @param {{ key?: string, vk?: number, injected?: boolean, down?: boolean }} event One hook event: `key` is the
 *   DOM-style name (`"Escape"`) or `vk` the virtual-key code; `injected` is the `LLKHF_INJECTED` bit; `down` is false
 *   only for a key-up. A missing `injected` flag is treated as injected (unknown provenance never kills).
 * @returns {boolean} Whether this event ends desktop control.
 */
export function shouldKill({ key, vk, injected, down = true }) {
  const escape = key === 'Escape' || vk === VK_ESCAPE
  return escape && down === true && injected === false
}
