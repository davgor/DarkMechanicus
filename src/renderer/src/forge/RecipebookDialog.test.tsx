// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { fakeForgeSetup, forgeWorld, reactRecipe, recipebookHash } from '../__mocks__/forgeSetup'
import { settle } from '../__mocks__/settle'
import { RecipebookDialog } from './RecipebookDialog'

afterEach(cleanup)

it('makes a custom recipe copy without editing the pinned recipe, and keeps the draft on a save conflict', async () => {
  const api = fakeForgeSetup()
  api.saveRecipebook.mockRejectedValueOnce(new Error('The recipe book changed on disk.'))
  render(<RecipebookDialog api={api} world={forgeWorld.path} onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy recipe' }))
  fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Local CRUD checklist' } })
  fireEvent.change(screen.getByLabelText('Recipe notes'), { target: { value: 'Use the existing development database.' } })
  fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Build before starting' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
  await settle()

  const [world, request] = api.saveRecipebook.mock.calls[0]
  expect(world).toBe(forgeWorld.path)
  expect(request.expectedSha256).toBe(recipebookHash)
  expect(request.value.recipes.find(recipe => recipe.id === reactRecipe.id)).toEqual(reactRecipe)
  expect(request.value.recipes.find(recipe => recipe.baseRecipeId === reactRecipe.id)).toMatchObject({
    title: 'Local CRUD checklist', notes: 'Use the existing development database.',
    steps: [{ title: 'Build before starting', program: 'npm' }], source: reactRecipe.source
  })
  expect(screen.getByRole('alert').textContent).toContain('The recipe book changed on disk.')
  expect(screen.getByLabelText<HTMLTextAreaElement>('Recipe notes').value).toBe('Use the existing development database.')
})

it('reviews a newer recipe book before retaining edits as a separate copy', async () => {
  const api = fakeForgeSetup()
  api.saveRecipebook.mockRejectedValueOnce(new Error('The recipe book changed on disk.'))
  render(<RecipebookDialog api={api} world={forgeWorld.path} onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy recipe' }))
  fireEvent.change(screen.getByLabelText('Recipe notes'), { target: { value: 'My local setup notes.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
  await settle()
  const initial = api.saveRecipebook.mock.calls[0][1].value
  const competing = { ...initial.recipes.at(-1)!, notes: 'Another person’s setup notes.' }
  const current = { sha256: 'd'.repeat(64), value: { ...initial, recipes: [...initial.recipes.slice(0, -1), competing] } }
  api.recipebook.mockResolvedValue(current)
  api.saveRecipebook.mockImplementation(async (_world, edit) => ({ sha256: 'e'.repeat(64), value: edit.value }))

  fireEvent.click(screen.getByRole('button', { name: 'Reload saved recipes' }))
  await settle()
  expect(screen.getByLabelText<HTMLTextAreaElement>('Recipe notes').value).toBe('My local setup notes.')
  expect(screen.getByText('Another person’s setup notes.')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save recipe' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft as a new copy' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
  await settle()
  const saved = api.saveRecipebook.mock.calls[1][1]
  expect(saved.expectedSha256).toBe(current.sha256)
  expect(saved.value.recipes.find(recipe => recipe.id === competing.id)).toEqual(competing)
  expect(saved.value.recipes.find(recipe => recipe.notes === 'My local setup notes.')?.id).not.toBe(competing.id)
})

it('recognizes that the exact draft was saved before its response was lost', async () => {
  const api = fakeForgeSetup()
  api.saveRecipebook.mockImplementationOnce(async (_world, edit) => {
    const recipes = edit.value.recipes.map(({ notes, ...recipe }) => ({ notes, ...recipe }))
    api.recipebook.mockResolvedValue({ sha256: 'd'.repeat(64), value: { ...edit.value, recipes } })
    throw new Error('The save response was interrupted.')
  })
  render(<RecipebookDialog api={api} world={forgeWorld.path} onClose={() => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy recipe' }))
  fireEvent.change(screen.getByLabelText('Recipe notes'), { target: { value: 'These exact notes were saved.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reload saved recipes' }))
  expect(await screen.findByText('This draft is already saved in the recipe book.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Keep draft as a new copy' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View saved recipe' }))
  expect(screen.getByText('These exact notes were saved.')).toBeTruthy()
  expect(api.saveRecipebook).toHaveBeenCalledTimes(1)
})
