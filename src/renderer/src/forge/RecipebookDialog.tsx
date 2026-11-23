import { useEffect, useRef, useState } from 'react'
import type { ForgeRecipe, ForgeRecipebook, ForgeSetupApi, ForgeSetupFile } from '../../../shared/desktop/forgeSetup'
import { errorMessage } from '../api/dm'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { EditWorkflowSteps, WorkflowSteps } from './WorkflowSteps'

interface Props {
  api: Pick<ForgeSetupApi, 'recipebook' | 'saveRecipebook'>
  world: string
  onClose(): void
}

interface Book {
  value: ForgeRecipebook
  sha256: string | null
}

async function readBook(api: Props['api'], world: string): Promise<Book> {
  const saved = await api.recipebook(world)
  if (saved !== null) return saved
  const defaults = await api.recipebook()
  return { value: defaults?.value ?? { version: 1, recipes: [] }, sha256: null }
}

function copyRecipe(recipe: ForgeRecipe, book: Book): ForgeRecipe {
  const baseRecipeId = recipe.baseRecipeId ?? recipe.id
  const prefix = baseRecipeId.slice(0, 35) + '-copy'
  let id = prefix
  for (let suffix = 2; book.value.recipes.some(item => item.id === id); suffix += 1) id = prefix + '-' + suffix
  return { ...recipe, id, title: recipe.title + ' copy', baseRecipeId }
}

function withRecipe(book: Book, recipe: ForgeRecipe): ForgeRecipebook {
  const recipes = book.value.recipes
  return { version: 1, recipes: recipes.some(item => item.id === recipe.id)
    ? recipes.map(item => item.id === recipe.id ? recipe : item)
    : [...recipes, recipe] }
}

function useRecipebook(api: Props['api'], world: string) {
  const [book, setBook] = useState<Book | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [load, setLoad] = useState(0)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  useEffect(() => {
    let current = true
    void readBook(api, world).then(result => {
      if (current) { setBook(result); setError(null) }
    }, failure => {
      if (current) setError(errorMessage(failure))
    })
    return () => { current = false }
  }, [api, world, load])

  const save = async (recipe: ForgeRecipe): Promise<ForgeSetupFile<ForgeRecipebook> | null> => {
    if (book === null || saving.current) return null
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const saved = await api.saveRecipebook(world, { expectedSha256: book.sha256, value: withRecipe(book, recipe) })
      setBook(saved)
      return saved
    } catch (failure) {
      setError(errorMessage(failure))
      return null
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  return { book, error, busy, save, reload: () => setLoad(n => n + 1) }
}

function RecipePreview({ recipe }: { recipe: ForgeRecipe }): JSX.Element {
  return <section className="forge-recipe-preview" aria-label={recipe.title}>
    <p>{recipe.description}</p>
    {recipe.kind === 'conversion' && <p className="muted">Conversion required. Verify an Electron build and launch after setup.</p>}
    <p className="forge-provenance"><span>{recipe.source.repository}</span> <code>{recipe.source.commit}</code></p>
    {recipe.notes ? <p className="forge-notes">{recipe.notes}</p> : null}
    <WorkflowSteps steps={recipe.steps} />
  </section>
}

function RecipeFields({ recipe, change, busy }: { recipe: ForgeRecipe; change(recipe: ForgeRecipe): void; busy: boolean }): JSX.Element {
  return <fieldset className="forge-edit-fields" disabled={busy}>
    <legend>Custom recipe</legend>
    <Field label="Recipe name" value={recipe.title} onChange={title => change({ ...recipe, title })} />
    <Field label="Description" value={recipe.description} onChange={description => change({ ...recipe, description })} />
    <Field label="Recipe notes" rows={3} value={recipe.notes ?? ''} onChange={notes => change({ ...recipe, notes })} />
    <EditWorkflowSteps steps={recipe.steps} onChange={steps => change({ ...recipe, steps })} disabled={busy} />
  </fieldset>
}

function RecipePicker({ book, selection, select, edit }: {
  book: Book; selection: string; select(id: string): void; edit(recipe: ForgeRecipe): void
}): JSX.Element {
  const recipes = book.value.recipes
  const active = recipes.find(recipe => recipe.id === selection) ?? recipes[0]
  if (!active) return <p>No recipes are available.</p>
  return <>
    <label className="field"><span className="field-label">Recipe</span>
      <select className="input" value={active.id} onChange={e => select(e.target.value)}>
        {recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.title}</option>)}
      </select>
    </label>
    <RecipePreview recipe={active} />
    <div className="button-row">
      <Button onClick={() => edit(copyRecipe(active, book))}>Copy recipe</Button>
      {active.baseRecipeId !== undefined && <Button onClick={() => edit(active)}>Edit recipe</Button>}
    </div>
  </>
}

export function RecipebookDialog({ api, world, onClose }: Props): JSX.Element {
  const { book, error, busy, save, reload } = useRecipebook(api, world)
  const [selection, select] = useState('')
  const [draft, edit] = useState<ForgeRecipe | null>(null)
  const close = (): void => { if (!busy) onClose() }
  const saveDraft = async (): Promise<void> => {
    if (draft !== null && await save(draft) !== null) {
      select(draft.id)
      edit(null)
    }
  }
  return <Dialog title="Recipe book" onClose={close} actions={
    draft === null ? <Button onClick={close}>Close</Button> : <>
      <Button onClick={() => edit(null)} disabled={busy}>Cancel edits</Button>
      <Button variant="primary" busy={busy} disabled={!draft.title.trim() || !draft.description.trim()} onClick={() => void saveDraft()}>Save recipe</Button>
    </>
  }>
    {error !== null && <p role="alert" className="forge-error">{error}</p>}
    {book === null && (error === null ? <p role="status">Loading recipes…</p> : <Button onClick={reload}>Reload recipes</Button>)}
    {draft !== null && <RecipeFields recipe={draft} change={edit} busy={busy} />}
    {draft === null && book !== null && <RecipePicker book={book} selection={selection} select={select} edit={edit} />}
  </Dialog>
}
