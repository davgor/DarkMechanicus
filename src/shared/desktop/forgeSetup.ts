export const FORGE_RECIPEBOOK_FILE = 'forge-recipes.yaml'
export const FORGE_SETUP_DIRECTORY = 'forge-setup'
export const FORGE_SETUP_WORKFLOW_FILE = 'workflow.yaml'
export const FORGE_SETUP_GUIDE_FILE = 'guide.md'
export const FORGE_SETUP_FACT_VALUE_MAX = 120

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
  baseRecipeId?: string
  assets: ForgeRecipeAsset[]
  steps: ForgeSetupStep[]
  notes?: string
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

export interface ForgeRecipebookEdit {
  expectedSha256: string | null
  value: ForgeRecipebook
}

export interface ForgeSetupWorkflowEdit {
  expectedSha256: string
  workflow: Pick<ForgeSetupWorkflow['workflow'], 'state' | 'steps'>
  notes?: string
}

export interface ForgeSetupConversationStatus {
  state: 'preparing' | 'opened' | 'needs-attention' | 'uncertain'
  chatId: string | null
  message: string | null
  run?: {
    state: 'pending' | 'submitted' | 'uncertain' | 'failed'
    workflowSha256: string
    /** The execution chat. The parent chatId continues to identify onboarding. */
    chatId: string | null
  } | null
}

export interface ForgeSetupProjectView {
  member: string
  repository: string
  value: ForgeSetupFile<ForgeSetupWorkflow> | null
  state: 'missing' | 'needs-discovery' | 'configured' | 'stale'
  onboarding: ForgeSetupConversationStatus | null
}

export interface ForgeProvisionRequest {
  world: { kind: 'new'; name: string } | { kind: 'existing'; folder: string }
  code?: { name: string; visibility: 'private' | 'public'; recipeId: string }
  agent?: string
}

export interface ForgeProvisionStatus {
  id: string
  request: ForgeProvisionRequest
  phase: 'checking' | 'world-remote' | 'world-checkout' | 'code-remote' | 'code-checkout' | 'member' | 'publish' | 'complete'
  state: 'running' | 'needs-attention' | 'complete'
  message: string | null
  world?: string
  member?: string
  checkout?: string
}

/** A refusal is certain only before any new journal entry or external effect. Null means the picker was cancelled. */
export type ForgeProvisionResult = ForgeProvisionStatus | { state: 'refused'; message: string } | null

export interface ForgeSetupApi {
  /** A new client-generated UUID identifies this request even if its IPC reply is lost. */
  provision(input: ForgeProvisionRequest, operationId: string): Promise<ForgeProvisionResult>
  provisioning(): Promise<ForgeProvisionStatus[]>
  resumeProvision(id: string): Promise<ForgeProvisionStatus>
  recipebook(world?: string): Promise<ForgeSetupFile<ForgeRecipebook> | null>
  saveRecipebook(world: string, input: ForgeRecipebookEdit): Promise<ForgeSetupFile<ForgeRecipebook>>
  project(member: string): Promise<ForgeSetupProjectView>
  saveWorkflow(member: string, input: ForgeSetupWorkflowEdit): Promise<ForgeSetupProjectView>
  refresh(member: string): Promise<ForgeSetupProjectView>
  prepare(member: string, agent?: string): Promise<ForgeSetupConversationStatus>
  /** The checkout is the one the person reviewed. Main verifies its actual mapping before running setup. */
  run(member: string, expectedSha256: string, expectedCheckout: string): Promise<ForgeSetupConversationStatus>
}
