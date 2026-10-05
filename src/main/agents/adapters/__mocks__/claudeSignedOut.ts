/**
 * A real signed-out Claude Code turn, as the Agent SDK streamed it. Recorded on 2026-10-05 by driving
 * the SDK (@anthropic-ai/claude-agent-sdk 0.3.289) against its own bundled claude.exe (Claude Code
 * 2.1.289, Windows) with an empty temporary CLAUDE_CONFIG_DIR and USERPROFILE and an empty
 * ANTHROPIC_API_KEY, so no login existed (`apiKeySource: 'none'`); nothing of the person's own
 * configuration was read and no login was run. The message was 'hello'; the CLI answered at once
 * with a synthetic assistant message that carries `error: 'authentication_failed'` and then a result
 * that is an error. Only the signed-out case could be recorded here; the SDK's types name the same
 * marker for every rejected sign-in (SDKAssistantMessageError 'authentication_failed'), so an expired
 * or revoked login is expected to look alike, but that was not captured.
 *
 * Trimmed, not edited: the init message lost its tool, slash-command, skill and plugin lists and
 * local paths, and the result lost its usage tables. Every other field is as received. Not shipped.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const recorded = {
  init: {
    type: 'system',
    subtype: 'init',
    session_id: 'b484c378-7c16-4f0b-86c1-253babb06c08',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    apiKeySource: 'none',
    claude_code_version: '2.1.289',
    output_style: 'default',
    uuid: '5f61da01-a8db-435b-b9b3-954bbe31ac64',
    cwd: '/work/repo'
  },
  status: {
    type: 'system',
    subtype: 'status',
    status: 'requesting',
    session_id: 'b484c378-7c16-4f0b-86c1-253babb06c08',
    uuid: '56a662c9-505a-4418-b5c1-e7b9dc565011'
  },
  assistant: {
    type: 'assistant',
    message: {
      diagnostics: null,
      id: 'ee995c66-e707-4aee-bf5b-6941cc41539f',
      container: null,
      model: '<synthetic>',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        output_tokens_details: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0
        },
        service_tier: null,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0
        },
        inference_geo: null,
        iterations: null,
        speed: null,
        fallback_credit: null
      },
      content: [
        {
          type: 'text',
          text: 'Not logged in · Please run /login'
        }
      ],
      context_management: null
    },
    parent_tool_use_id: null,
    session_id: 'b484c378-7c16-4f0b-86c1-253babb06c08',
    uuid: '6ae487ec-a8ab-4d6f-aae4-40b9e2cd7700',
    timestamp: '2026-10-05T02:23:47.265Z',
    error: 'authentication_failed',
    is_api_error_message: true
  },
  result: {
    duration_api_ms: 0,
    stop_reason: 'stop_sequence',
    session_id: 'b484c378-7c16-4f0b-86c1-253babb06c08',
    total_cost_usd: 0,
    permission_denials: [],
    terminal_reason: 'api_error',
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    is_error: true,
    num_turns: 1,
    subtype: 'success',
    api_error_status: null,
    result: 'Not logged in · Please run /login',
    type: 'result',
    duration_ms: 110,
    uuid: '57924347-c3d7-4ffc-b514-27ff45b7b2f0',
    queued_turn_count: 0,
    result_index: 0
  }
}

export const CLAUDE_SIGNED_OUT_SESSION = recorded.init.session_id

/** What the SDK yielded for one turn of a chat with no login, in order. */
export const CLAUDE_SIGNED_OUT: SDKMessage[] = [recorded.init, recorded.status, recorded.assistant, recorded.result] as unknown as SDKMessage[]

export const CLAUDE_SIGNED_OUT_MESSAGE = 'Not logged in · Please run /login'
