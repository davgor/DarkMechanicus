import { compareCodeUnits } from './order'

/** One shipped fact file: its repository path (`skills/knowledge/...`) and raw text. */
interface BuiltinKnowledgeSource {
  path: string
  source: string
}

// Bundled at build time, like the skill guides in `src/mcp/skills.ts`; keys are relative to this file.
const sources = import.meta.glob<string>('../../../skills/knowledge/**/*.md', { query: '?raw', import: 'default', eager: true })

/** The built-in knowledge layer, sorted by path. */
export const BUILTIN_KNOWLEDGE: readonly BuiltinKnowledgeSource[] = Object.entries(sources)
  .map(([key, source]) => ({ path: key.replace(/^(\.\.\/)+/, ''), source }))
  .sort((a, b) => compareCodeUnits(a.path, b.path))
