import { z } from 'zod'

const text = z.string().trim().min(1).max(4000)
const commit = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i)
const link = z.url({ protocol: /^https?$/ }).max(2048)

export const deliveryIntegration = z.strictObject({ branch: text, commit, verification: text })
export const deliveryMerge = z.strictObject({ pullRequest: link, checksUrl: link, branch: text, commit })
export const sprintDeployment = z.strictObject({
  pullRequest: link, commit, version: text, environment: text, verification: text, instructions: text
})
