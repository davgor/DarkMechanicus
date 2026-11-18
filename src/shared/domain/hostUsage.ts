/**
 * Host usage at the measurement boundary: the provider usage formats Dark Mechanicus normalizes into metric reports
 * (`src/core/space/hostUsage.ts`), and which built-in agents' hosts can report usage at all.
 *
 * A provider's token categories overlap differently: OpenAI and Codex count cached input inside input and reasoning
 * inside output, Gemini counts cached input inside the prompt but thoughts apart from the candidates, Anthropic counts
 * cache reads and writes apart from input and thinking inside output without reporting it. Reports keep each
 * provider's own definition (stated in their attributes) and carry a non-duplicated `tokens_total` only where the
 * provider reports one or its categories are known to be disjoint.
 */
import type { BuiltInAgentKind } from '../desktop/api'

/**
 * - `anthropic_messages`: the Messages API `usage` (also Claude Code's session `message.usage`).
 * - `openai_chat`: Chat Completions `usage` (`prompt_tokens`, `completion_tokens`, details).
 * - `openai_responses`: Responses API `usage` (`input_tokens`, `output_tokens`, details).
 * - `gemini`: `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, …).
 * - `codex`: Codex CLI `TokenUsage` (`token_count` events' `total_token_usage` and `last_token_usage`).
 * - `omp`: OMP (Skitarii) session `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`).
 */
const USAGE_FORMATS = ['anthropic_messages', 'openai_chat', 'openai_responses', 'gemini', 'codex', 'omp'] as const
export type UsageFormat = (typeof USAGE_FORMATS)[number]

/**
 * How the host account pays for tokens. Only `api_key` billing has a marginal price per token; a `subscription`
 * (Claude Max, ChatGPT plans) costs the same whatever one run uses, so a list price is never its marginal cost.
 */
export const USAGE_BILLINGS = ['api_key', 'subscription', 'unknown'] as const
export type UsageBilling = (typeof USAGE_BILLINGS)[number]

/** `host`: the in-app agent's host transcript is read (`dm usage`); `unavailable`: it cannot be, use the MCP route. */
type HostUsageSupportState = 'host' | 'unavailable'

export interface HostUsageSupport {
  tokens: HostUsageSupportState
  activeTime: HostUsageSupportState
  /** Where the usage is read from, or why it cannot be. One line, shown to people and agents. */
  detail: string
}

/**
 * What each built-in agent's host can report through `dm usage`. An agent marked `unavailable` reports nothing by
 * itself: its usage reads as unavailable (never as zero or an estimate) unless the orchestrator or an external MCP host
 * relays real numbers with `record_attempt_metrics` / `record_run_metrics`. A custom agent is always `unavailable`.
 */
export const HOST_USAGE_SUPPORT: Readonly<Record<BuiltInAgentKind, HostUsageSupport>> = {
  omp: {
    tokens: 'host',
    activeTime: 'host',
    detail: 'OMP session files ($PI_SESSION_FILE and its subagent files): tokens per request, request and tool spans.'
  },
  claude: {
    tokens: 'host',
    activeTime: 'host',
    detail: 'Claude Code session JSONL (main file and subagents/agent-*.jsonl): message usage and line times.'
  },
  codex: {
    tokens: 'unavailable',
    activeTime: 'unavailable',
    detail: 'The in-app Codex chat does not know its rollout file; relay its token_count totals over MCP.'
  },
  cursor: { tokens: 'unavailable', activeTime: 'unavailable', detail: 'Cursor Agent writes no token usage.' },
  autonomous: { tokens: 'unavailable', activeTime: 'unavailable', detail: 'Autonomous exposes no usage to Dark Mechanicus.' }
}
