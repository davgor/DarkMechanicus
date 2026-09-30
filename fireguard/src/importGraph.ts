import { posix } from 'node:path';
import ts from 'typescript';

/**
 * Most files a single test may reach before its closure is considered unknown.
 * Past the cap the test is conservatively related to every module (see buildRelatedTests).
 */
const MAX_VISITED_FILES = 5000;

/** Files whose contents can hold further imports; everything else (json, css, ...) is a leaf. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** `.`, `..`, `./x`, `../x` — everything else is a package or alias and is not followed. */
const RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/;
/** Vite-style `?raw` / `?worker` / `#hash` suffixes. */
const QUERY_OR_HASH = /[?#].*$/;
const APPENDED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];
/** TypeScript ESM projects write `./x.js` for a file that is really `x.ts`. */
const TS_SOURCE_FOR_JS: Partial<Record<string, string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function literalText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function declarationSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return literalText(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return literalText(node.moduleReference.expression);
  }
  return undefined;
}

function isModuleLoader(callee: ts.Expression): boolean {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(callee) && callee.text === 'require';
}

function callSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !isModuleLoader(node.expression)) return undefined;
  return literalText(node.arguments[0]);
}

/**
 * Module specifiers a file loads: static `import`/`export ... from`, `import x = require()`,
 * and `import()` / `require()` calls with a plain string literal. Each specifier is reported
 * once, in source order. `vi.mock('...')` and other string arguments are not imports.
 */
export function collectImports(path: string, source: string): string[] {
  // The script kind (ts, tsx, js, ...) is inferred from the file extension.
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    const specifier = declarationSpecifier(node) ?? callSpecifier(node);
    if (specifier !== undefined) specifiers.add(specifier);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers];
}

function candidatePaths(base: string): string[] {
  const ext = posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const tsSources = (TS_SOURCE_FOR_JS[ext] ?? []).map((tsExt) => `${stem}${tsExt}`);
  return [
    base,
    ...APPENDED_EXTENSIONS.map((suffix) => `${base}${suffix}`),
    ...APPENDED_EXTENSIONS.map((suffix) => posix.join(base, `index${suffix}`)),
    ...tsSources,
  ];
}

/**
 * Resolve a relative specifier against the importing file. Paths are repo-relative with
 * forward slashes. Tries the exact path, then appended extensions, then index files, then
 * (for `./x.js` style specifiers) the TypeScript source. Returns null for package/alias
 * specifiers, paths that leave the repository, and files that do not exist.
 * `exists` must be true for regular files only, so a directory never matches the exact path.
 */
export function resolveRelative(
  fromFile: string,
  specifier: string,
  exists: (path: string) => boolean
): string | null {
  const cleaned = specifier.replace(QUERY_OR_HASH, '');
  if (!RELATIVE_SPECIFIER.test(cleaned)) return null;
  const base = posix.join(posix.dirname(fromFile), cleaned);
  if (base === '..' || base.startsWith('../')) return null;
  return candidatePaths(base).find((candidate) => exists(candidate)) ?? null;
}

type EdgeLookup = (path: string) => string[];

function readEdges(
  path: string,
  io: { readFile: (path: string) => string | null; exists: (path: string) => boolean }
): string[] {
  if (!SOURCE_FILE.test(path)) return [];
  const source = io.readFile(path);
  if (source === null) return [];
  const resolved = collectImports(path, source).map((specifier) =>
    resolveRelative(path, specifier, io.exists)
  );
  return [...new Set(resolved.filter((target): target is string => target !== null))];
}

/** Parses and resolves each file's imports once, however many tests reach it. */
function createEdgeLookup(io: {
  readFile: (path: string) => string | null;
  exists: (path: string) => boolean;
}): EdgeLookup {
  const cache = new Map<string, string[]>();
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const edges = readEdges(path, io);
    cache.set(path, edges);
    return edges;
  };
}

function reachableFrom(
  start: string,
  edgesOf: EdgeLookup
): { files: Set<string>; truncated: boolean } {
  const files = new Set<string>([start]);
  const queue = [start];
  for (const current of queue) {
    for (const next of edgesOf(current)) {
      if (files.has(next)) continue;
      if (files.size >= MAX_VISITED_FILES) return { files, truncated: true };
      files.add(next);
      queue.push(next);
    }
  }
  return { files, truncated: false };
}

/**
 * For each module, the sorted graded tests whose transitive relative-import closure contains
 * it (only those tests can kill its mutants). Modules no test reaches map to an empty list.
 * If a test's closure exceeds 5,000 files it is unknown, so the test is conservatively
 * related to every module rather than silently dropped.
 */
export function buildRelatedTests(options: {
  tests: string[];
  modules: string[];
  readFile: (path: string) => string | null;
  exists: (path: string) => boolean;
}): Map<string, string[]> {
  const related = new Map<string, string[]>(
    options.modules.map((path): [string, string[]] => [path, []])
  );
  const edgesOf = createEdgeLookup(options);
  // Tests are visited in sorted order so every module's list comes out sorted.
  for (const test of [...new Set(options.tests)].sort()) {
    const reach = reachableFrom(test, edgesOf);
    for (const [modulePath, tests] of related) {
      if (reach.truncated || reach.files.has(modulePath)) tests.push(test);
    }
  }
  return related;
}
