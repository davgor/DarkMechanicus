import { describe, it, expect } from 'vitest';
import { buildRelatedTests, collectImports, resolveRelative } from '../src/importGraph.js';

type Files = Record<string, string | null>;

function existsIn(...files: string[]): (path: string) => boolean {
  const known = new Set(files);
  return (path) => known.has(path);
}

/** In-memory workspace; a `null` body models a file that exists but cannot be read. */
function relate(files: Files, tests: string[], modules: string[]) {
  const reads: string[] = [];
  const related = buildRelatedTests({
    tests,
    modules,
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  });
  return { related, reads };
}

const IMPORT_FLAVOURS = [
  "import def from './default';",
  "import { named } from './named';",
  "import * as ns from './namespace';",
  "import './side-effect';",
  "import type { T } from './types';",
  "import pkg from 'some-package';",
].join('\n');

const REEXPORTS = [
  "export { a } from './named-reexport';",
  "export * from './star';",
  "export * as ns from './star-as';",
  "export type { T } from './type-reexport';",
  'export const local = 1;',
  'export { local as alias };',
].join('\n');

describe('collectImports declarations', () => {
  it('collects static import specifiers of every flavour in source order', () => {
    expect(collectImports('src/a.test.ts', IMPORT_FLAVOURS)).toEqual([
      './default',
      './named',
      './namespace',
      './side-effect',
      './types',
      'some-package',
    ]);
  });

  it('collects re-export specifiers but not local exports', () => {
    expect(collectImports('src/index.ts', REEXPORTS)).toEqual([
      './named-reexport',
      './star',
      './star-as',
      './type-reexport',
    ]);
  });

  it('collects import-equals require declarations but not namespace aliases', () => {
    const source = "import fs = require('./cjs-style');\nimport Alias = Namespace.Member;";
    expect(collectImports('src/a.ts', source)).toEqual(['./cjs-style']);
  });
});

describe('collectImports normalisation', () => {
  it('reports each specifier once, in first-seen order', () => {
    const source = "import './b';\nimport './a';\nimport './b';\nexport * from './a';";
    expect(collectImports('src/a.ts', source)).toEqual(['./b', './a']);
  });

  it('returns nothing for a file without module references', () => {
    expect(collectImports('src/a.ts', 'export const a = 1;\n')).toEqual([]);
    expect(collectImports('src/empty.ts', '')).toEqual([]);
  });

  it('parses jsx and mts sources according to their extension', () => {
    const jsx = "const v = <a.b />;\nimport a from './a';";
    const mts = "const x = <string>'y';\nimport './b';";
    expect(collectImports('src/View.jsx', jsx)).toEqual(['./a']);
    expect(collectImports('src/util.mts', mts)).toEqual(['./b']);
  });
});

const DYNAMIC_IMPORTS = [
  "const a = await import('./lazy');",
  'const b = await import(`./template`);',
  "function load() { return import('./nested'); }",
].join('\n');

const COMPUTED_LOADS = [
  'const name = "x";',
  'await import(name);',
  'await import(`./dir/${name}`);',
  'await import();',
  'require(name);',
  'require();',
].join('\n');

const NOT_IMPORTS = [
  "vi.mock('./mocked');",
  "vi.doMock('./do-mocked', () => ({}));",
  "vi.importActual('./actual');",
  "helper.require('./member');",
  "requireLater('./other');",
  "const text = 'import \"./in-a-string\"';",
  "// import './in-a-comment';",
  "/* export * from './in-a-block'; */",
].join('\n');

describe('collectImports calls', () => {
  it('collects dynamic import() calls with literal specifiers', () => {
    expect(collectImports('src/a.ts', DYNAMIC_IMPORTS)).toEqual([
      './lazy',
      './template',
      './nested',
    ]);
  });

  it('collects literal require() calls', () => {
    const source = "const a = require('./commonjs');\nmodule.exports = require('pkg');";
    expect(collectImports('src/a.js', source)).toEqual(['./commonjs', 'pkg']);
  });

  it('ignores loader calls whose specifier is not a plain string literal', () => {
    expect(collectImports('src/a.ts', COMPUTED_LOADS)).toEqual([]);
  });

  it('does not treat mock helpers, strings, or comments as imports', () => {
    expect(collectImports('src/a.test.ts', NOT_IMPORTS)).toEqual([]);
  });
});

const PRIORITY = [
  'src/util',
  'src/util.ts',
  'src/util.tsx',
  'src/util.mts',
  'src/util.js',
  'src/util.mjs',
  'src/util.jsx',
  'src/util/index.ts',
  'src/util/index.tsx',
  'src/util/index.mts',
  'src/util/index.js',
  'src/util/index.mjs',
  'src/util/index.jsx',
];

describe('resolveRelative candidates', () => {
  it('returns the exact path when that file exists', () => {
    const exists = existsIn('src/b/util.ts');
    expect(resolveRelative('src/a/x.test.ts', '../b/util.ts', exists)).toBe('src/b/util.ts');
  });

  it.each([['.ts'], ['.tsx'], ['.mts'], ['.js'], ['.mjs'], ['.jsx']])(
    'appends %s when only that file exists',
    (ext) => {
      const exists = existsIn(`src/util${ext}`);
      expect(resolveRelative('src/x.ts', './util', exists)).toBe(`src/util${ext}`);
    }
  );

  it('prefers the exact path, then extensions in order, then index files', () => {
    const resolvedInOrder: string[] = [];
    let remaining = [...PRIORITY];
    for (let round = 0; round < PRIORITY.length; round += 1) {
      const resolved = resolveRelative('src/x.ts', './util', existsIn(...remaining));
      resolvedInOrder.push(String(resolved));
      remaining = remaining.filter((path) => path !== resolved);
    }
    expect(resolvedInOrder).toEqual(PRIORITY);
    expect(resolveRelative('src/x.ts', './util', existsIn(...remaining))).toBeNull();
  });
});

describe('resolveRelative directories and JS specifiers', () => {
  it('resolves directory imports to index files and prefers a sibling file', () => {
    const both = existsIn('src/dir.ts', 'src/dir/index.ts');
    expect(resolveRelative('src/x.ts', './dir', existsIn('src/dir/index.ts'))).toBe(
      'src/dir/index.ts'
    );
    expect(resolveRelative('src/x.ts', './dir/', existsIn('src/dir/index.tsx'))).toBe(
      'src/dir/index.tsx'
    );
    expect(resolveRelative('src/x.ts', './dir', both)).toBe('src/dir.ts');
  });

  it('maps JS-style specifiers onto TypeScript sources as a last resort', () => {
    const at = (specifier: string, ...files: string[]) =>
      resolveRelative('src/x.ts', specifier, existsIn(...files));
    expect(at('./util.js', 'src/util.ts')).toBe('src/util.ts');
    expect(at('./view.js', 'src/view.tsx')).toBe('src/view.tsx');
    expect(at('./view.jsx', 'src/view.tsx')).toBe('src/view.tsx');
    expect(at('./esm.mjs', 'src/esm.mts')).toBe('src/esm.mts');
    expect(at('./cjs.cjs', 'src/cjs.cts')).toBe('src/cjs.cts');
    expect(at('./util.js', 'src/util.js', 'src/util.ts')).toBe('src/util.js');
  });
});

describe('resolveRelative specifiers', () => {
  it('resolves ./ and ../ against the importing file directory', () => {
    const exists = existsIn('src/core/db/database.ts', 'src/shared/status.ts', 'top.ts');
    const from = 'src/core/db/database.test.ts';
    expect(resolveRelative(from, './database', exists)).toBe('src/core/db/database.ts');
    expect(resolveRelative(from, '../../shared/status', exists)).toBe('src/shared/status.ts');
    expect(resolveRelative('root.test.ts', './top', exists)).toBe('top.ts');
  });

  it('strips vite query and hash suffixes before resolving', () => {
    const exists = existsIn('src/notes.md', 'src/worker.ts');
    expect(resolveRelative('src/a.ts', './notes.md?raw', exists)).toBe('src/notes.md');
    expect(resolveRelative('src/a.ts', './worker?worker&inline', exists)).toBe('src/worker.ts');
    expect(resolveRelative('src/a.ts', './worker#fragment', exists)).toBe('src/worker.ts');
  });

  it('ignores bare, absolute, and protocol specifiers without probing the file system', () => {
    const probed: string[] = [];
    const exists = (path: string): boolean => {
      probed.push(path);
      return true;
    };
    const ignored = ['vitest', 'react-dom/client', '@scope/pkg', 'node:path', '/abs/path'];
    ignored.push('#internal', 'file:///x', '.hidden', '...', '');
    for (const specifier of ignored) {
      expect(resolveRelative('src/a.ts', specifier, exists)).toBeNull();
    }
    expect(probed).toEqual([]);
  });
});

describe('resolveRelative misses', () => {
  it('returns null when nothing matches', () => {
    expect(resolveRelative('src/a.ts', './missing', existsIn('src/other.ts'))).toBeNull();
  });

  it('returns null for paths that escape the repository root', () => {
    const exists = existsIn('../outside.ts', 'outside.ts');
    expect(resolveRelative('src/a.ts', '../../outside', exists)).toBeNull();
    expect(resolveRelative('a.ts', '..', existsIn('../index.ts'))).toBeNull();
  });

  it('resolves . and .. as directory imports', () => {
    const exists = existsIn('src/index.ts', 'src/core/index.tsx');
    expect(resolveRelative('src/core/a.ts', '..', exists)).toBe('src/index.ts');
    expect(resolveRelative('src/core/a.ts', '.', exists)).toBe('src/core/index.tsx');
  });
});

const TWO_MODULES: Files = {
  'src/add.ts': 'export const add = 1;',
  'src/sub.ts': 'export const sub = 1;',
  'src/z.test.ts': "import { add } from './add';\nimport { sub } from './sub';",
  'src/a.test.ts': "import { add } from './add';",
  'src/m.test.ts': "import { sub } from './sub';",
};

const TRANSITIVE: Files = {
  'src/leaf.ts': "import './cycle-a';\nexport const leaf = 1;",
  'src/lib/index.ts': "export * from './impl';",
  'src/lib/impl.ts': "export { leaf } from '../leaf';",
  'src/cycle-a.ts': "import './cycle-b';",
  'src/cycle-b.ts': "import './cycle-a';",
  'src/lazy.ts': 'export const lazy = 1;',
  'src/feature.test.ts': "import { leaf } from './lib';\nconst l = () => import('./lazy');",
};

describe('buildRelatedTests relations', () => {
  it('maps each module to the tests that import it, sorted', () => {
    const tests = ['src/z.test.ts', 'src/a.test.ts', 'src/m.test.ts'];
    const { related } = relate(TWO_MODULES, tests, ['src/add.ts', 'src/sub.ts']);
    expect(related.get('src/add.ts')).toEqual(['src/a.test.ts', 'src/z.test.ts']);
    expect(related.get('src/sub.ts')).toEqual(['src/m.test.ts', 'src/z.test.ts']);
    expect([...related.keys()]).toEqual(['src/add.ts', 'src/sub.ts']);
  });

  it('follows transitive imports, re-exports, index files and import cycles', () => {
    const modules = ['src/leaf.ts', 'src/lib/impl.ts', 'src/cycle-b.ts', 'src/lazy.ts'];
    const { related } = relate(TRANSITIVE, ['src/feature.test.ts'], modules);
    expect([...related.values()]).toEqual(modules.map(() => ['src/feature.test.ts']));
  });

  it('keeps modules that no test reaches with an empty list', () => {
    const files: Files = {
      'src/used.ts': 'export const used = 1;',
      'src/orphan.ts': 'export const orphan = 1;',
      'src/used.test.ts': "import { used } from './used';",
    };
    const tests = ['src/used.test.ts', 'src/used.test.ts'];
    const { related } = relate(files, tests, ['src/used.ts', 'src/orphan.ts']);
    expect(related.get('src/orphan.ts')).toEqual([]);
    expect(related.get('src/used.ts')).toEqual(['src/used.test.ts']);
  });

  it('returns an empty map when there are no modules', () => {
    expect(relate({}, ['src/a.test.ts'], []).related.size).toBe(0);
  });
});

const NON_RELATIONS: Files = {
  'src/mocked.ts': 'export const mocked = 1;',
  'src/computed.ts': 'export const computed = 1;',
  'src/a.test.ts': [
    "import { vi } from 'vitest';",
    "vi.mock('./mocked');",
    'const name = "computed";',
    'const load = () => import(`./${name}`);',
  ].join('\n'),
};

const SHARED_ASSETS: Files = {
  'src/shared.ts': "import data from './data.json';\nimport './style.css?inline';",
  'src/data.json': '{"import": "./never"}',
  'src/style.css': '@import "./never.css";',
  'src/one.test.ts': "import './shared';",
  'src/two.test.ts': "import './shared';",
  'src/three.test.ts': "import './shared';",
};

/** One hop per source extension: js -> mjs -> cjs -> tsx -> jsx -> mts -> cts. */
const EXTENSION_CHAIN: Files = {
  'src/chain.test.ts': "import './a.js';",
  'src/a.js': "import './b.mjs';",
  'src/b.mjs': "import './c.cjs';",
  'src/c.cjs': "require('./d');",
  'src/d.tsx': "import './e';",
  'src/e.jsx': "import './f';",
  'src/f.mts': "import './g.cts';",
  'src/g.cts': 'export const end = 1;',
};

describe('buildRelatedTests file access', () => {
  it('does not count mocks, packages, or computed imports as relations', () => {
    const modules = ['src/mocked.ts', 'src/computed.ts'];
    const { related } = relate(NON_RELATIONS, ['src/a.test.ts'], modules);
    expect(related.get('src/mocked.ts')).toEqual([]);
    expect(related.get('src/computed.ts')).toEqual([]);
  });

  it('reads every file at most once and never reads non-source files', () => {
    const tests = ['src/one.test.ts', 'src/two.test.ts', 'src/three.test.ts'];
    const { related, reads } = relate(SHARED_ASSETS, tests, ['src/shared.ts', 'src/data.json']);
    expect([...reads].sort()).toEqual([
      'src/one.test.ts',
      'src/shared.ts',
      'src/three.test.ts',
      'src/two.test.ts',
    ]);
    expect(related.get('src/data.json')).toHaveLength(3);
  });

  it('follows imports through every supported source extension', () => {
    const modules = ['src/a.js', 'src/b.mjs', 'src/c.cjs', 'src/d.tsx'];
    modules.push('src/e.jsx', 'src/f.mts', 'src/g.cts');
    const { related } = relate(EXTENSION_CHAIN, ['src/chain.test.ts'], modules);
    expect([...related.values()]).toEqual(modules.map(() => ['src/chain.test.ts']));
  });

  it('treats unreadable files as having no imports', () => {
    const files: Files = {
      'src/broken.ts': null,
      'src/ok.ts': 'export const ok = 1;',
      'src/a.test.ts': "import './broken';\nimport './ok';",
      'src/missing.test.ts': null,
    };
    const tests = ['src/a.test.ts', 'src/missing.test.ts', 'src/gone.test.ts'];
    const { related } = relate(files, tests, ['src/broken.ts', 'src/ok.ts']);
    expect(related.get('src/broken.ts')).toEqual(['src/a.test.ts']);
    expect(related.get('src/ok.ts')).toEqual(['src/a.test.ts']);
  });
});

function chainFiles(length: number): Files {
  const files: Files = {
    'src/chain.test.ts': "import './chain/n0';",
    'src/unrelated.ts': 'export const unrelated = 1;',
  };
  for (let i = 0; i < length; i += 1) {
    const last = i + 1 === length;
    files[`src/chain/n${i}.ts`] = last ? 'export const end = 1;' : `import './n${i + 1}';`;
  }
  return files;
}

describe('buildRelatedTests visit cap', () => {
  it('follows chains up to exactly 5000 visited files', () => {
    const modules = ['src/unrelated.ts', 'src/chain/n4998.ts'];
    const { related } = relate(chainFiles(4999), ['src/chain.test.ts'], modules);
    expect(related.get('src/chain/n4998.ts')).toEqual(['src/chain.test.ts']);
    expect(related.get('src/unrelated.ts')).toEqual([]);
  });

  it('relates a test to every module once its closure exceeds 5000 files', () => {
    const modules = ['src/unrelated.ts', 'src/chain/n4999.ts'];
    const { related } = relate(chainFiles(5000), ['src/chain.test.ts'], modules);
    expect(related.get('src/unrelated.ts')).toEqual(['src/chain.test.ts']);
    expect(related.get('src/chain/n4999.ts')).toEqual(['src/chain.test.ts']);
  });
});
