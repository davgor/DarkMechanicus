import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeRecipe, ForgeRecipeAsset, ForgeRecipebook, ForgeSetupStep } from '../../shared/desktop/forgeSetup'
import manifest from './forgeStarterManifest.json'

const source = { repository: 'https://github.com/davgor/BoosterSeat.git', commit: 'd54f41d39f076a0b3a2b1e1d8ffacf9277fd8f62' }
const command = (id: string, title: string, program: string, ...args: string[]): ForgeSetupStep => ({
  kind: 'command', id, title, cwd: '.', program, args
})
const quality: ForgeSetupStep = {
  kind: 'instruction', id: 'quality', title: 'Agree on delivery workflows',
  instruction: 'Review the quality workflows in .github/workflow-templates with the user. Enable only agreed checks. Configure web or desktop publishing separately when the user asks.'
}

function reactRecipe(): ForgeRecipe {
  return {
    id: 'boosterseat-react', title: 'BoosterSeat React', kind: 'scaffold', source,
    description: 'React, Vite and a local CRUD example with reviewed CI workflow templates.',
    assets: manifest.filter(asset => !asset.source.startsWith('forge-additions/')),
    steps: [
      command('install', 'Install pinned npm dependencies', 'npm', 'ci'),
      command('build', 'Build React and Vite', 'npm', 'run', 'build'),
      quality
    ]
  }
}

function electronRecipe(): ForgeRecipe {
  return {
    id: 'boosterseat-electron', title: 'BoosterSeat Electron', kind: 'conversion', source,
    description: 'BoosterSeat React plus a Dark Mechanicus conversion procedure and Electron main, preload and renderer sources.',
    assets: manifest,
    steps: [
      command('convert', 'Add the Electron entry points', 'node', 'scripts/enable-electron.mjs'),
      command('install', 'Resolve the Electron dependencies and update the lockfile', 'npm', 'install'),
      command('build', 'Build the desktop application', 'npm', 'run', 'desktop:build'),
      {
        kind: 'instruction', id: 'verify', title: 'Verify the Electron application',
        instruction: 'On this machine, launch npm run desktop:start. Verify the renderer shows the CRUD application, the isolated preload reports the local platform, and the window closes cleanly. Record build and launch observations.'
      },
      quality
    ]
  }
}

export function bundledForgeRecipes(): ForgeRecipebook {
  return structuredClone({ version: 1, recipes: [{
    id: 'forge-world', title: 'Forge World', kind: 'world', source, description: 'A private repository for portable ticket records and setup recipes.',
    assets: [], steps: []
  }, reactRecipe(), electronRecipe()] })
}

const publishedAssets = new Map(manifest.map(asset => [asset.source, asset]))
const sameAsset = (a: ForgeRecipeAsset, b: ForgeRecipeAsset) => a.source === b.source && a.target === b.target && a.sha256 === b.sha256

function expectedAssets(recipe: ForgeRecipe): ForgeRecipeAsset[] {
  if (recipe.source?.repository !== source.repository || recipe.source?.commit !== source.commit) {
    throw new Error('This recipe does not use the bundled BoosterSeat revision.')
  }
  if (recipe.kind === 'scaffold') return reactRecipe().assets
  if (recipe.kind === 'conversion') return electronRecipe().assets
  throw new Error('Choose a code scaffold or conversion recipe.')
}

export function verifyForgeScaffold(recipe: ForgeRecipe): ForgeRecipe {
  const required = new Set(expectedAssets(recipe).map(asset => asset.source))
  for (const asset of recipe.assets) {
    const packaged = publishedAssets.get(asset.source)
    if (!packaged || !sameAsset(packaged, asset) || !required.delete(asset.source)) {
      throw new Error('The recipe contains a changed or unexpected scaffold file.')
    }
  }
  if (required.size !== 0) throw new Error('The recipe is missing required scaffold files.')
  return recipe
}

interface ScaffoldContext { name: string; repository: string }

function packageContents(file: string, context: ScaffoldContext): string {
  const pkg = JSON.parse(file)
  pkg.name = context.name.toLowerCase()
  pkg.author = ''
  pkg.repository = { type: 'git', url: context.repository }
  // Upstream installed Git hooks in npm's lifecycle. The copied delivery tooling is selected explicitly.
  delete pkg.scripts.prepare
  return JSON.stringify(pkg, null, 2) + '\n'
}

function lockContents(file: string, context: ScaffoldContext): string {
  const lock = JSON.parse(file)
  lock.name = context.name.toLowerCase()
  lock.packages[''].name = lock.name
  return JSON.stringify(lock, null, 2) + '\n'
}

function boardProbe(file: string): string {
  const search = '  let project = null;\n  const dmStat'
  if (!file.includes(search)) throw new Error('The embedded BoosterSeat board probe is unrecognized.')
  return file.replace(search, String.raw`  const linkPath = join(root, '.forge-world.json');
  const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (linkStat !== undefined) {
    try {
      if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > 4096) throw new Error();
      const link = JSON.parse(readFileSync(linkPath, 'utf8'));
      if (link.version !== 1 ||
          typeof link.worldRepository !== 'string' ||
          !/^https:\/\/github\.com\/[a-z0-9.-]+\/[a-z0-9._-]+\.git$/i.test(link.worldRepository) ||
          typeof link.projectFolder !== 'string' ||
          !/^[a-z0-9][a-z0-9._-]*$/i.test(link.projectFolder) ||
          /[. ]$/.test(link.projectFolder)) throw new Error();
      return { mode, ready: true, problems, warnings, project: { forgeMember: link.projectFolder } };
    } catch {
      problems.push('.forge-world.json is not a valid portable Forge World link.');
      return { mode, ready: false, problems, warnings, project: null };
    }
  }

  let project = null;
  const dmStat`).replace('  const { name, keyPrefix } = result.project;',
    '  if (result.project.forgeMember !== undefined) return "Forge World link: " + quote(result.project.forgeMember) + ". Confirm the ticket connection in Dark Mechanicus.";\n  const { name, keyPrefix } = result.project;')
}

function scaffoldContent(asset: ForgeRecipeAsset, contents: string, context: ScaffoldContext): string {
  switch (asset.target) {
    case 'package.json': return packageContents(contents, context)
    case 'package-lock.json': return lockContents(contents, context)
    case 'scripts/check-darkmechanicus.mjs': return boardProbe(contents)
    case '.gitignore': return contents + '\n# Electron build\nout/\n'
    default: return contents
  }
}

function assertScaffoldDirectory(path: string, allowCreate: boolean): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined && allowCreate) mkdirSync(path)
  else if (stat?.isDirectory() !== true || stat.isSymbolicLink()) throw new Error('The scaffold target must be an ordinary directory.')
}

function writeScaffoldFile(root: string, path: string, contents: string): void {
  const parts = path.split('/')
  let directory = root
  for (const segment of parts.slice(0, -1)) {
    directory = join(directory, segment)
    assertScaffoldDirectory(directory, true)
  }
  const file = join(root, path)
  const before = lstatSync(file, { throwIfNoEntry: false })
  if (before === undefined) writeFileSync(file, contents, { flag: 'wx' })
  else if (before.isSymbolicLink() || !before.isFile() || before.size !== Buffer.byteLength(contents) || readFileSync(file, 'utf8') !== contents) {
    throw new Error('The scaffold target already contains a different ' + path + '.')
  }
}

export async function materializeForgeScaffold(root: string, recipe: ForgeRecipe, context: ScaffoldContext, assertCurrent?: () => void) {
  const { assets } = verifyForgeScaffold(recipe)
  const bytes: Record<string, string> = (await import('./forgeStarterAssets.json')).default
  if (Object.keys(bytes).length !== publishedAssets.size) throw new Error('The packaged scaffold asset list changed.')
  const files = assets.map(asset => {
    const content = bytes[asset.source]
    if (typeof content !== 'string' || createHash('sha256').update(content).digest('hex') !== asset.sha256) {
      throw new Error('The packaged scaffold does not match its pinned asset checksums.')
    }
    return { path: asset.target, content: scaffoldContent(asset, content, context) }
  })
  assertCurrent?.()
  assertScaffoldDirectory(root, false)
  for (const file of files) writeScaffoldFile(root, file.path, file.content)
  return files
}
