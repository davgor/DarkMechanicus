/**
 * Steps through the corrective planner of a rendered Improvement tab (`renderImprovement`): find it, tick an
 * experiment, open a work item's edit form and preview. Each planner test plans in a folder named after the test.
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { expect } from 'vitest'
import { settle } from './settle'

/** The planner store is per folder: each test plans in its own. */
export function plannerFolder(): string {
  return `C:/planner-steps/${expect.getState().currentTestName ?? ''}`
}

export function plannerRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Corrective work' })
}

export function tickExperiment(id: string): void {
  fireEvent.click(screen.getByRole('checkbox', { name: `Select ${id} for corrective work` }))
}

/** Opens the edit form of the `at`-th work item of the selection. */
export function editWork(at: number): HTMLElement {
  fireEvent.click(within(plannerRegion()).getAllByRole('button', { name: 'Edit title, body, criteria or prerequisites' })[at]!)
  return within(plannerRegion()).getByRole('group', { name: /^Edit / })
}

export async function previewWork(): Promise<void> {
  fireEvent.click(within(plannerRegion()).getAllByRole('button', { name: /^Preview/ })[0]!)
  await settle()
}
