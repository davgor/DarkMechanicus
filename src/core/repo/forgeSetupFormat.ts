import { isAlias, isNode, isPair, isScalar, parseDocument, stringify, visit } from 'yaml'
import { z } from 'zod'
import { FORGE_SETUP_FACT_VALUE_MAX, type ForgeRecipebook, type ForgeSetupWorkflow } from '../../shared/desktop/forgeSetup'
import { fail } from '../errors'
import { githubRemote } from './forgeManifest'

export const FORGE_WORKFLOW_BYTES = 64 * 1024
export const FORGE_RECIPEBOOK_BYTES = 256 * 1024

const credentials = /(?:https?:\/\/[^/\s]+@|\b(?:gh[pousr]_|github_pat_)[a-z0-9_]{16,}|\bbearer\s+[a-z0-9._-]{16,}|-----BEGIN [^-]*PRIVATE KEY-----|(?:^|[\s;&])(?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY))\s*=\s*['"]?[a-z0-9][a-z0-9_./+-]*)/i
const privatePath = /(?:[a-z]:[\\/]users[\\/]|(?:^|[\s='"])[/](?:users|home)\/[^/\s]+|file:\/\/)/i
// A single slash can introduce an installer switch or a pattern. Match known POSIX roots with a slash after the root name.
const absoluteArgumentPath = /(?:^|[\s="'(,;])(?:[a-z]:[\\/]|\\\\|\/\/|\/(?:etc|home|media|mnt|opt|private|root|run|srv|tmp|usr|users|var|volumes|workspaces?)\/)/i
const device = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i
const shell = /^(?:sh|bash|dash|zsh|fish|ksh|cmd|command|powershell|pwsh|wsl)(?:\.(?:exe|cmd|bat|ps1))?$/i

function portablePath(value: string): boolean {
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' &&
    !/[<>:"|?*\\\p{Cc}]/u.test(segment) && !/[. ]$/.test(segment) && !device.test(segment.trimEnd()) &&
    !/^\.(?:git|darkmechanicus)$/i.test(segment))
}

const text = (max: number) => z.string().max(max)
  .refine((value) => !credentials.test(value) && !privatePath.test(value) && !value.includes('\0'))
const requiredText = (max: number) => text(max).refine((value) => value.trim().length > 0)
export const forgeSetupId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const gitDigest = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const repository = z.string().max(300).refine((value) => {
  try { return githubRemote(value) === value } catch { return false }
})
const source = z.strictObject({ repository, commit: gitDigest })
const path = text(240).refine(portablePath)
const platforms = z.array(z.enum(['win32', 'darwin', 'linux'])).min(1).max(3)
  .refine((items) => new Set(items).size === items.length).optional()
const stepIdentity = { id: forgeSetupId, title: requiredText(120), platforms }
const steps = z.array(z.discriminatedUnion('kind', [
  z.strictObject({
    ...stepIdentity,
    kind: z.literal('command'),
    cwd: z.union([z.literal('.'), path]),
    program: text(64).refine((value) => /^[a-z0-9][a-z0-9._+-]*$/i.test(value) && !shell.test(value) && !device.test(value)),
    args: z.array(text(512).refine((value) => !absoluteArgumentPath.test(value))).max(24)
  }),
  z.strictObject({ ...stepIdentity, kind: z.literal('instruction'), instruction: requiredText(4096) })
])).max(32).refine((items) => new Set(items.map((step) => step.id)).size === items.length)

const detectionFields = {
  detectorVersion: z.literal(1),
  source: source.nullable(),
  facts: z.array(z.strictObject({
    kind: z.enum(['node', 'package-manager', 'lockfile', 'electron', 'script']),
    value: requiredText(FORGE_SETUP_FACT_VALUE_MAX),
    source: path
  })).max(64)
}

const detection = z.union([
  z.strictObject({ ...detectionFields, status: z.literal('detected'), source, facts: detectionFields.facts.min(1) }),
  z.strictObject({
    ...detectionFields,
    status: z.enum(['unsupported', 'unavailable', 'ambiguous']),
    reason: z.enum(['no-node-manifest', 'invalid-descriptor', 'descriptor-limits', 'conflicting-requirements', 'source-unavailable'])
  })
])

const workflow = z.strictObject({
  version: z.literal(1),
  repository,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  recipeId: forgeSetupId.optional(),
  detection,
  workflow: z.strictObject({ state: z.enum(['needs-discovery', 'configured']), basedOn: digest.nullable(), steps }),
  notes: text(8192).optional()
}).refine((value) => !value.detection.source || value.repository.toLowerCase() === value.detection.source.repository.toLowerCase())
  .refine((value) => value.workflow.state !== 'configured' || (value.workflow.basedOn !== null && value.workflow.steps.length > 0))

const assets = z.array(z.strictObject({ source: path, target: path, sha256: digest })).max(128).refine((items) => {
  const targets = new Set(items.map((asset) => asset.target.toLowerCase()))
  return targets.size === items.length && [...targets].every((target) => {
    const parts = target.split('/')
    return parts.every((_, index) => index === parts.length - 1 || !targets.has(parts.slice(0, index + 1).join('/')))
  })
})

const recipebook = z.strictObject({
  version: z.literal(1),
  recipes: z.array(z.strictObject({
    id: forgeSetupId, source, assets, steps,
    title: requiredText(120),
    description: requiredText(1024),
    kind: z.enum(['world', 'scaffold', 'conversion']),
    baseRecipeId: forgeSetupId.optional(),
    notes: text(8192).optional()
  })).max(24)
}).refine((value) => {
  const recipes = new Map(value.recipes.map((recipe) => [recipe.id, recipe]))
  if (recipes.size !== value.recipes.length) return false
  return value.recipes.every((recipe) => {
    const seen = new Set([recipe.id])
    let base = recipe.baseRecipeId
    while (base !== undefined) {
      const ancestor = recipes.get(base)
      if (!ancestor || seen.has(base)) return false
      seen.add(base)
      base = ancestor.baseRecipeId
    }
    return true
  })
})

function assertOrdinaryNode(node: unknown): void {
  if (isAlias(node)) throw new Error('unsupported alias')
  if (isNode(node) && (node.tag || ('anchor' in node && node.anchor))) throw new Error('explicit tag or anchor')
  if (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== 'string' ||
    ['<<', '__proto__', 'constructor', 'prototype'].includes(node.key.value))) throw new Error('unsupported key')
}

function checkedYaml<T>(input: string, limit: number, model: z.ZodType<T>, label: string) {
  if (Buffer.byteLength(input) > limit || /^(?:\uFEFF)?%/m.test(input)) fail('invalid_input', 'Invalid ' + label + ' YAML.')
  try {
    const document = parseDocument(input, { schema: 'core', strict: true, uniqueKeys: true })
    if (document.errors.length || document.warnings.length) throw new Error('invalid document')
    let nodes = 0
    visit(document, (_key, node, ancestors) => {
      if (++nodes > 24_000 || ancestors.length > 20) throw new Error('document too large')
      assertOrdinaryNode(node)
    })
    return { value: model.parse(document.toJS({ maxAliasCount: 0 })), document }
  } catch {
    fail('invalid_input', 'Invalid ' + label + ' YAML.')
  }
}

function encode<T>(value: T, limit: number, model: z.ZodType<T>, label: string): string {
  const validated = model.safeParse(value)
  if (!validated.success) fail('invalid_input', 'Invalid ' + label + '.')
  const output = stringify(validated.data, { aliasDuplicateObjects: false, lineWidth: 0 })
  if (Buffer.byteLength(output) > limit) fail('invalid_input', 'Invalid ' + label + ' size.')
  return output
}

export function parseForgeSetupWorkflow(input: string): ForgeSetupWorkflow {
  return checkedYaml(input, FORGE_WORKFLOW_BYTES, workflow, 'Forge setup workflow').value
}

export function encodeForgeSetupWorkflow(value: ForgeSetupWorkflow): string {
  return encode(value, FORGE_WORKFLOW_BYTES, workflow, 'Forge setup workflow')
}

/** Update the generated fields without re-creating the YAML nodes for authored steps or comments. */
export function updateForgeSetupEvidence(input: string, next: ForgeSetupWorkflow): string {
  const validated = workflow.safeParse(next)
  if (!validated.success) fail('invalid_input', 'Invalid Forge setup workflow.')
  const { document } = checkedYaml(input, FORGE_WORKFLOW_BYTES, workflow, 'Forge setup workflow')
  document.set('revision', next.revision)
  document.set('detection', next.detection)
  const output = document.toString({ lineWidth: 0 })
  if (Buffer.byteLength(output) > FORGE_WORKFLOW_BYTES) fail('invalid_input', 'Invalid Forge setup workflow size.')
  return output
}

export function parseForgeRecipebook(input: string): ForgeRecipebook {
  return checkedYaml(input, FORGE_RECIPEBOOK_BYTES, recipebook, 'Forge recipebook').value
}

export function encodeForgeRecipebook(value: ForgeRecipebook): string {
  return encode(value, FORGE_RECIPEBOOK_BYTES, recipebook, 'Forge recipebook')
}
