import { useEffect, useState } from 'react'
import { Button } from './Button'
import './pageControls.css'

export function usePage(total: number, pageSize: number, selectedIndex: number) {
  const [page, setPage] = useState(() => Math.max(0, Math.floor(selectedIndex / pageSize)))
  const last = Math.max(0, Math.ceil(total / pageSize) - 1)
  const current = Math.min(page, last)
  useEffect(() => {
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / pageSize))
  }, [selectedIndex, pageSize])
  return {
    start: current * pageSize,
    end: Math.min((current + 1) * pageSize, total),
    total,
    hasPrevious: current > 0,
    hasNext: current < last,
    previous: () => setPage(Math.max(0, current - 1)),
    next: () => setPage(Math.min(last, current + 1))
  }
}

export function PageControls({ page, label }: { page: ReturnType<typeof usePage>; label: string }): JSX.Element | null {
  if (!page.hasPrevious && !page.hasNext) return null
  return (
    <nav className="page-controls" aria-label={label}>
      <Button size="sm" disabled={!page.hasPrevious} aria-label={`Previous page of ${label}`} onClick={page.previous}>Previous</Button>
      <span aria-live="polite">{page.start + 1}–{page.end} of {page.total}</span>
      <Button size="sm" disabled={!page.hasNext} aria-label={`Next page of ${label}`} onClick={page.next}>Next</Button>
    </nav>
  )
}
