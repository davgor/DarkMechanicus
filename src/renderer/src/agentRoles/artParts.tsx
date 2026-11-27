import { useId } from 'react'

export interface ArtProps {
  /** The rendered width and height in px; the art reads from 96 to 160. */
  size?: number
}

interface ArtIds {
  hood: string
  robe: string
  glow: string
}

/**
 * Per-instance ids for an illustration's gradients and glow filter, so two copies on one page never share a `<defs>`
 * entry. React's id punctuation is dropped so the ids stay plain inside `url(#…)`.
 */
export function useArtIds(): ArtIds {
  const base = `role-art-${useId().replace(/[^A-Za-z0-9]/g, '')}`
  return { hood: `${base}-hood`, robe: `${base}-robe`, glow: `${base}-glow` }
}

/** The shared defs: a lit-crimson hood gradient, a robe fading from crimson into shadow, and a soft glow blur. */
export function ArtDefs({ ids, blur }: { ids: ArtIds; blur: number }): JSX.Element {
  return (
    <defs>
      <linearGradient id={ids.hood} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className="ra-stop-crimson-lit" />
        <stop offset="1" className="ra-stop-crimson" />
      </linearGradient>
      <linearGradient id={ids.robe} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className="ra-stop-crimson" />
        <stop offset="1" className="ra-stop-void" />
      </linearGradient>
      <filter id={ids.glow} x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation={blur} />
      </filter>
    </defs>
  )
}
