/**
 * The Linear MCP setup an agent's CLI needs once. The transfer guide (`skills/linear-transfer.md`) is the
 * source of truth: each `guide` text is copied verbatim from it, and a test pins that. `dm transfer`
 * and the app show `setup`, the same text without Markdown code marks.
 */
interface LinearSetupLine {
  /** The CLI the line is for, as the app labels it. */
  cli: string
  /** The guide's wording, Markdown included. */
  guide: string
  /** `guide` as plain text. */
  setup: string
}

function line(cli: string, guide: string): LinearSetupLine {
  return { cli, guide, setup: guide.replaceAll('`', '') }
}

export const LINEAR_SETUP_LINES: readonly LinearSetupLine[] = [
  line('Claude Code', '`claude mcp add --transport http linear-server https://mcp.linear.app/mcp`, then `/mcp` to sign in.'),
  line('Codex', '`codex mcp add linear --url https://mcp.linear.app/mcp`'),
  line('Cursor', 'add `https://mcp.linear.app/mcp` in its MCP settings.')
]
