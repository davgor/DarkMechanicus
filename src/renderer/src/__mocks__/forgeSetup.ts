import { vi } from 'vitest'
import type { ForgeRecipe, ForgeSetupApi, ForgeSetupProjectView } from '../../../shared/desktop/forgeSetup'
import { folderView } from './fixtures'

export const forgeWorld = folderView({
  path: '/tickets/world', name: 'Forge World Fixture', initialized: false,
  forgeWorld: { version: 1, owner: 'fixture', syncMinutes: 5, projects: [{ folder: 'Alpha', repository: 'https://github.com/fixture/alpha.git' }] }
})

export const forgeMember = folderView({ path: '/tickets/world/Alpha', name: 'Alpha', forgeParent: forgeWorld.path })
export const repository = 'https://github.com/fixture/alpha.git'
export const codePath = '/code/alpha'
export const checkoutRevision = 'a'.repeat(40)
export const workflowHash = 'b'.repeat(64)
export const recipebookHash = 'c'.repeat(64)

export const reactRecipe: ForgeRecipe = {
  id: 'react-vite', title: 'React and Vite', kind: 'scaffold', description: 'A CRUD web app.',
  source: { repository: 'https://github.com/davgor/BoosterSeat.git', commit: checkoutRevision },
  assets: [], steps: [{ id: 'verify', kind: 'command', title: 'Build the project', cwd: '.', program: 'npm', args: ['run', 'build'] }]
}

export const electronRecipe: ForgeRecipe = {
  ...reactRecipe, id: 'electron', title: 'Electron', kind: 'conversion', description: 'Convert a React app to Electron.'
}

export function setupProject(patch: Partial<ForgeSetupProjectView> = {}): ForgeSetupProjectView {
  return {
    member: forgeMember.path, repository, state: 'configured',
    value: {
      value: {
        version: 1, repository, revision: 2, notes: 'Keep the existing local database.',
        detection: { status: 'detected', detectorVersion: 1, source: { repository, commit: checkoutRevision },
          facts: [{ kind: 'node', value: '>=22', source: 'package.json' }] },
        workflow: { state: 'configured', basedOn: 'a'.repeat(64), steps: reactRecipe.steps }
      },
      sha256: workflowHash
    },
    onboarding: { state: 'opened', chatId: 'chat_onboarding', message: null },
    ...patch
  }
}

export function fakeForgeSetup() {
  return {
    provision: vi.fn<ForgeSetupApi['provision']>().mockResolvedValue(null),
    provisioning: vi.fn<ForgeSetupApi['provisioning']>().mockResolvedValue([]),
    resumeProvision: vi.fn<ForgeSetupApi['resumeProvision']>(),
    recipebook: vi.fn<ForgeSetupApi['recipebook']>().mockResolvedValue({
      sha256: recipebookHash, value: { version: 1, recipes: [reactRecipe, electronRecipe] }
    }),
    saveRecipebook: vi.fn<ForgeSetupApi['saveRecipebook']>(),
    project: vi.fn<ForgeSetupApi['project']>().mockResolvedValue(setupProject()),
    saveWorkflow: vi.fn<ForgeSetupApi['saveWorkflow']>(),
    refresh: vi.fn<ForgeSetupApi['refresh']>().mockResolvedValue(setupProject()),
    prepare: vi.fn<ForgeSetupApi['prepare']>().mockResolvedValue({ state: 'opened', chatId: 'chat_onboarding', message: null }),
    run: vi.fn<ForgeSetupApi['run']>().mockResolvedValue({ state: 'opened', chatId: 'chat_onboarding', message: null,
      run: { state: 'submitted', workflowSha256: workflowHash, chatId: 'chat_setup' } })
  } satisfies ForgeSetupApi
}
