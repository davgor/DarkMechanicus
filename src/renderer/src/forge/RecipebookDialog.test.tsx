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
