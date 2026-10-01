/** Skill sources are Markdown files bundled as text by Vite (`?raw`). */
declare module '*.md?raw' {
  const content: string
  export default content
}
