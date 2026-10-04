import { useMemo, type MouseEvent, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline, type ListItem } from './parse'
import './markdown.css'

interface MarkdownProps {
  source: string
  className?: string
}

/**
 * Renders untrusted Markdown as React elements. No HTML string is ever injected: raw HTML shows
 * as text, and only allow-listed links are clickable; they open through the main process.
 */
export function Markdown(props: MarkdownProps): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(props.source), [props.source])
  const className = props.className ? `md ${props.className}` : 'md'
  return <div className={className}>{renderBlocks(blocks)}</div>
}

/** Markdown headings sit below the panel's own title, so `#` renders as h3. */
const HEADING_TAGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const

function renderBlocks(blocks: Block[]): JSX.Element[] {
  return blocks.map((block, index) => <BlockView key={index} block={block} />)
}

function renderInlines(nodes: Inline[]): JSX.Element[] {
  return nodes.map((node, index) => <InlineView key={index} node={node} />)
}

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAGS[block.level - 1] ?? 'h6'
      return <Tag className="md-heading">{renderInlines(block.children)}</Tag>
    }
    case 'paragraph':
      return <p>{renderInlines(block.children)}</p>
    case 'code':
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      )
    case 'list':
      return <ListView ordered={block.ordered} start={block.start} items={block.items} />
    case 'quote':
      return <blockquote>{renderBlocks(block.blocks)}</blockquote>
    case 'rule':
      return <hr />
  }
}

function ListView(props: { ordered: boolean; start: number; items: ListItem[] }): JSX.Element {
  const items = props.items.map((item, index) => <ListItemView key={index} item={item} />)
  return props.ordered ? <ol start={props.start}>{items}</ol> : <ul>{items}</ul>
}

/** A lone leading paragraph renders inline so tight lists stay compact. */
function ListItemView({ item }: { item: ListItem }): JSX.Element {
  const [first, ...rest] = item.blocks
  const lead = first?.kind === 'paragraph' ? renderInlines(first.children) : null
  return (
    <li className={item.task ? 'md-task' : undefined}>
      {item.task ? (
        <input type="checkbox" checked={item.task === 'done'} disabled readOnly aria-label="Task" />
      ) : null}
      {lead}
      {renderBlocks(lead === null ? item.blocks : rest)}
    </li>
  )
}

function InlineView({ node }: { node: Inline }): JSX.Element {
  switch (node.kind) {
    case 'text':
      return <>{node.text}</>
    case 'code':
      return <code className="md-inline-code">{node.text}</code>
    case 'em':
      return <em>{renderInlines(node.children)}</em>
    case 'strong':
      return <strong>{renderInlines(node.children)}</strong>
    case 'link':
      return <SafeLink href={node.href}>{renderInlines(node.children)}</SafeLink>
    case 'break':
      return <br />
  }
}

export function SafeLink(props: { href: string; children: ReactNode }): JSX.Element {
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    void window.dm.openExternal(props.href)
  }
  return (
    <a className="md-link" href={props.href} title={props.href} rel="noreferrer noopener" onClick={open}>
      {props.children}
    </a>
  )
}
