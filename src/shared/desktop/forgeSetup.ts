export const FORGE_RECIPEBOOK_FILE = 'forge-recipes.yaml'
export const FORGE_SETUP_DIRECTORY = 'forge-setup'
export const FORGE_SETUP_WORKFLOW_FILE = 'workflow.yaml'
export const FORGE_SETUP_GUIDE_FILE = 'guide.md'

export type ForgeSetupPlatform = 'win32' | 'darwin' | 'linux'

interface ForgeSetupStepIdentity {
  id: string
  title: string
  platforms?: ForgeSetupPlatform[]
}

export type ForgeSetupStep = ForgeSetupStepIdentity & (
  | { kind: 'command'; cwd: string; program: string; args: string[] }
  | { kind: 'instruction'; instruction: string }
)

export interface ForgeSourceRevision {
  repository: string
  commit: string
}

export interface ForgeRecipeAsset {
  source: string
  target: string
  sha256: string
}

export interface ForgeRecipe {
  id: string
  title: string
  kind: 'world' | 'scaffold' | 'conversion'
  description: string
  source: ForgeSourceRevision
  assets: ForgeRecipeAsset[]
  steps: ForgeSetupStep[]
}

export interface ForgeRecipebook {
  version: 1
  recipes: ForgeRecipe[]
}

export interface ForgeSetupFact {
  kind: 'node' | 'package-manager' | 'lockfile' | 'electron' | 'script'
  value: string
  source: string
}

interface ForgeSetupDetectionBase {
  detectorVersion: 1
  source: ForgeSourceRevision | null
  facts: ForgeSetupFact[]
}

export type ForgeSetupDetection = ForgeSetupDetectionBase & (
  | { status: 'detected' }
  | { status: 'unsupported' | 'unavailable' | 'ambiguous'; reason: ForgeSetupDetectionReason }
)

export type ForgeSetupDetectionReason =
  | 'no-node-manifest'
  | 'invalid-descriptor'
  | 'descriptor-limits'
  | 'conflicting-requirements'
  | 'source-unavailable'

export interface ForgeSetupWorkflow {
  version: 1
  repository: string
  revision: number
  recipeId?: string
  detection: ForgeSetupDetection
  workflow: {
    state: 'needs-discovery' | 'configured'
    basedOn: string | null
    steps: ForgeSetupStep[]
  }
  notes?: string
}

export interface ForgeSetupFile<T> {
  value: T
  sha256: string
}
