import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/davgo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const sharp = require('C:/Users/davgo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceDir = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(os.tmpdir(), 'dm-125-production-preview')
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: file:",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

await build({
  configFile: path.join(root, 'preview/mascot/vite.config.ts'),
  root,
  base: './',
  build: {
    outDir: outputDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        actions: path.join(root, 'preview/mascot/actions.html'),
        graph: path.join(root, 'preview/mascot/graph.html')
      }
    }
  }
})

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  if (pathname === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }
  const file = path.resolve(outputDir, `.${pathname}`)
  if (!file.startsWith(`${outputDir}${path.sep}`) && file !== path.join(outputDir, 'index.html')) {
    response.writeHead(403).end()
    return
  }
  try {
    const [body, info] = await Promise.all([readFile(file), stat(file)])
    response.writeHead(200, {
      'Content-Type': `${contentTypes[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
      'Content-Length': info.size,
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
})

await new Promise((resolve) => server.listen(5180, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const failures = []
const metadata = {
  build: { outputDir, entries: ['actions.html', 'graph.html'], productionCsp: csp },
  pages: {},
  checks: {}
}

function collectErrors(page, label) {
  page.on('console', (message) => { if (message.type() === 'error') failures.push(`${label}: console ${message.text()}`) })
  page.on('pageerror', (error) => failures.push(`${label}: pageerror ${error.message}`))
  page.on('requestfailed', (request) => failures.push(`${label}: requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`))
}

try {
  const actions = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  collectErrors(actions, 'actions')
  await actions.addInitScript(() => {
    const log = []
    Object.defineProperty(window, '__dm125MotionLog', { value: log })
    const capture = () => {
      const sprite = document.querySelector('.preview-board .pg-mascot-sprite')
      const state = document.querySelector('.preview-board .preview-state')
      if (!sprite || !state) return
      const item = `${sprite.getAttribute('data-action')} · ${state.textContent}`
      if (log.at(-1) !== item) log.push(item)
    }
    new MutationObserver(capture).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  const actionsResponse = await actions.goto('http://127.0.0.1:5180/preview/mascot/actions.html', { waitUntil: 'networkidle' })
  await actions.waitForSelector('.preview-board .pg-mascot-sprite')
  const atlas = JSON.parse(await readFile(path.join(root, 'src/renderer/src/assets/mascot/atlas.json'), 'utf8'))
  metadata.checks.atlasAlphaBounds = {}
  for (const [action, clip] of Object.entries(atlas.actions)) {
    const imagePath = path.join(root, 'src/renderer/src/assets/mascot', clip.image)
    const frames = []
    for (const frame of clip.frames) {
      const { data, info } = await sharp(imagePath).extract({ left: frame.x, top: frame.y, width: frame.width, height: frame.height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let minX = info.width
      let minY = info.height
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          if (data[(y * info.width + x) * info.channels + 3] <= 128) continue
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
        }
      }
      frames.push({ name: frame.name, visibleBounds: { minX, minY, maxX, maxY }, transparentPadding: { left: minX, top: minY, right: info.width - 1 - maxX, bottom: info.height - 1 - maxY }, hasClearCellPadding: minX > 0 && minY > 0 && maxX < info.width - 1 && maxY < info.height - 1 })
    }
    metadata.checks.atlasAlphaBounds[action] = frames
  }
  metadata.pages.actions = {
    status: actionsResponse?.status(),
    csp: actionsResponse?.headers()['content-security-policy'],
    atlasActions: await actions.locator('.preview-action').evaluateAll((items, alphaByAction) => items.map((item) => {
      const sprite = item.querySelector('.pg-mascot-sprite')
      const bounds = sprite.getBoundingClientRect()
      const parent = item.getBoundingClientRect()
      const action = item.querySelector('strong')?.textContent?.toLowerCase()
      const alpha = alphaByAction[action]?.[Number(sprite.dataset.frame)]?.visibleBounds
      const scale = bounds.width / 512
      const painted = alpha && {
        left: bounds.left + alpha.minX * scale,
        top: bounds.top + alpha.minY * scale,
        right: bounds.left + (alpha.maxX + 1) * scale,
        bottom: bounds.top + (alpha.maxY + 1) * scale
      }
      return {
        action,
        frame: sprite.dataset.frame,
        backgroundImage: getComputedStyle(sprite).backgroundImage,
        imageLoaded: getComputedStyle(sprite).backgroundImage.includes('/assets/'),
        paintedSpriteFitsTile: Boolean(painted && painted.left >= parent.left && painted.top >= parent.top && painted.right <= parent.right && painted.bottom <= parent.bottom)
      }
    }), metadata.checks.atlasAlphaBounds),
    boardMotionSamples: await actions.evaluate(() => window.__dm125MotionLog ?? [])
  }
  const capturedRoute = await actions.waitForFunction(() => {
    const trace = window.__dm125MotionLog ?? []
    return ['jump', 'climb', 'walk'].every((action) => trace.some((item) => item.startsWith(`${action} ·`)))
  }, null, { timeout: 20000 }).then(() => true).catch(() => false)
  metadata.checks.fullRouteObserved = capturedRoute
  metadata.pages.actions.boardMotionSamples = await actions.evaluate(() => window.__dm125MotionLog ?? [])
  await actions.waitForTimeout(250)
  await actions.screenshot({ path: path.join(evidenceDir, 'DM-125-actions-production.png'), fullPage: true })
  const boardSprite = actions.locator('.preview-board .pg-mascot-sprite')
  metadata.checks.boardSpriteBounds = await boardSprite.evaluate((sprite) => {
    const child = sprite.getBoundingClientRect()
    const parent = sprite.parentElement.getBoundingClientRect()
    return { rect: { left: child.left, top: child.top, right: child.right, bottom: child.bottom }, parent: { left: parent.left, top: parent.top, right: parent.right, bottom: parent.bottom }, fits: child.left >= parent.left && child.top >= parent.top && child.right <= parent.right && child.bottom <= parent.bottom }
  })

  const graph = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  collectErrors(graph, 'graph')
  const graphResponse = await graph.goto('http://127.0.0.1:5180/preview/mascot/graph.html', { waitUntil: 'networkidle' })
  await graph.waitForSelector('.react-flow__node')
  await graph.waitForTimeout(1400)
  metadata.pages.graph = {
    status: graphResponse?.status(),
    csp: graphResponse?.headers()['content-security-policy'],
    nodeCount: await graph.locator('.react-flow__node').count(),
    mascotPresent: await graph.locator('.pg-mascot-sprite').count(),
    pauseLabel: await graph.getByRole('button', { name: /mascot/i }).getAttribute('aria-label'),
    desktopGraphRect: await graph.locator('.preview-graph').boundingBox()
  }
  const ticketCard = graph.locator('[data-ticket="tk_1"]')
  const cardBox = await ticketCard.boundingBox()
  const modelXBefore = cardBox?.x ?? 0
  await ticketCard.click({ position: { x: 30, y: 20 } })
  metadata.checks.selection = await graph.locator('.preview-fixture-state').textContent()
  await graph.getByRole('button', { name: 'Move first ticket from model' }).click()
  const movedBox = await ticketCard.boundingBox()
  metadata.checks.modelMovement = { beforeX: modelXBefore, afterX: movedBox?.x ?? null, moved: movedBox !== null && movedBox.x !== modelXBefore }
  const dragBox = await ticketCard.boundingBox()
  if (dragBox) {
    await graph.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2)
    await graph.mouse.down()
    await graph.mouse.move(dragBox.x + dragBox.width / 2 + 72, dragBox.y + dragBox.height / 2 + 45, { steps: 6 })
    await graph.mouse.up()
    await graph.waitForTimeout(350)
  }
  metadata.checks.dragDrop = await graph.locator('.preview-fixture-state').textContent()
  const control = graph.getByRole('button', { name: /mascot/i })
  const actionBeforePause = await graph.locator('.pg-mascot-sprite').getAttribute('data-action')
  const frameBeforePause = await graph.locator('.pg-mascot-sprite').getAttribute('data-frame')
  await control.click()
  const pauseLabel = await control.getAttribute('aria-label')
  const pausedAction = await graph.locator('.pg-mascot-sprite').getAttribute('data-action')
  const pausedFrame = await graph.locator('.pg-mascot-sprite').getAttribute('data-frame')
  await graph.waitForTimeout(450)
  metadata.checks.pause = {
    labelAfterClick: pauseLabel,
    before: { action: actionBeforePause, frame: frameBeforePause },
    immediatelyAfter: { action: pausedAction, frame: pausedFrame },
    afterWait: { action: await graph.locator('.pg-mascot-sprite').getAttribute('data-action'), frame: await graph.locator('.pg-mascot-sprite').getAttribute('data-frame') }
  }
  await graph.emulateMedia({ reducedMotion: 'reduce' })
  await graph.waitForTimeout(300)
  metadata.checks.reducedMotion = {
    preferenceMatches: await graph.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    action: await graph.locator('.pg-mascot-sprite').getAttribute('data-action'),
    frame: await graph.locator('.pg-mascot-sprite').getAttribute('data-frame'),
    animationActive: await graph.locator('.pg-mascot-layer').getAttribute('data-animated')
  }
  await graph.emulateMedia({ reducedMotion: 'no-preference' })
  await graph.getByRole('button', { name: /mascot/i }).click()
  await graph.waitForTimeout(250)
  const xyflow = graph.locator('.react-flow__viewport')
  const transformBefore = await xyflow.getAttribute('style')
  await graph.mouse.move(700, 420)
  await graph.mouse.wheel(0, -320)
  await graph.waitForTimeout(350)
  metadata.checks.zoomTransformChanged = transformBefore !== await xyflow.getAttribute('style')
  const transformBeforePan = await xyflow.getAttribute('style')
  await graph.mouse.move(900, 600)
  await graph.mouse.down()
  await graph.mouse.move(970, 640, { steps: 6 })
  await graph.mouse.up()
  await graph.waitForTimeout(250)
  metadata.checks.panTransformChanged = transformBeforePan !== await xyflow.getAttribute('style')
  const viewportSizes = [[1100, 760], [760, 900], [1440, 1000]]
  metadata.checks.resize = []
  for (const [width, height] of viewportSizes) {
    await graph.setViewportSize({ width, height })
    await graph.waitForTimeout(250)
    const graphRect = await graph.locator('.preview-graph').boundingBox()
    const nodeRects = await graph.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }))
    const pageWidth = await graph.evaluate(() => document.documentElement.scrollWidth)
    metadata.checks.resize.push({ viewport: { width, height }, graphRect, pageWidth, noHorizontalPageOverflow: pageWidth <= width, nodeRects })
    if (width === 760) await graph.screenshot({ path: path.join(evidenceDir, 'DM-125-graph-narrow-production.png'), fullPage: true })
  }
  await graph.setViewportSize({ width: 1440, height: 1000 })
  await graph.screenshot({ path: path.join(evidenceDir, 'DM-125-graph-production.png'), fullPage: true })
  metadata.checks.consoleAndCspErrors = failures
  metadata.checks.noConsoleOrCspErrors = failures.length === 0
  metadata.checks.contracts = {
    allSixAtlasActionsRendered: metadata.pages.actions.atlasActions.length === 6 && metadata.pages.actions.atlasActions.every((action) => action.imageLoaded && action.paintedSpriteFitsTile),
    allThirtySixAtlasFramesHaveTransparentPadding: Object.values(metadata.checks.atlasAlphaBounds).flat().length === 36 && Object.values(metadata.checks.atlasAlphaBounds).flat().every((frame) => frame.hasClearCellPadding),
    deterministicJumpClimbWalkRouteObserved: metadata.checks.fullRouteObserved,
    boardSpriteWithinBounds: metadata.checks.boardSpriteBounds.fits,
    realPlanGraphRendered: metadata.pages.graph.status === 200 && metadata.pages.graph.nodeCount > 0 && metadata.pages.graph.mascotPresent === 1,
    ticketSelectionWorks: metadata.checks.selection.includes('Selected: tk_1'),
    modelMovementWorks: metadata.checks.modelMovement.moved,
    ticketDragDropWorks: metadata.checks.dragDrop.includes('Last drop: tk_1 at'),
    pauseFreezesFrame: metadata.checks.pause.labelAfterClick === 'Resume mascot animation' && metadata.checks.pause.immediatelyAfter.frame === metadata.checks.pause.afterWait.frame,
    reducedMotionShowsStaticIdlePose: metadata.checks.reducedMotion.preferenceMatches && metadata.checks.reducedMotion.action === 'idle' && metadata.checks.reducedMotion.frame === '0' && metadata.checks.reducedMotion.animationActive === 'false',
    graphZoomWorks: metadata.checks.zoomTransformChanged,
    graphPanWorks: metadata.checks.panTransformChanged,
    viewportResizeHasNoPageOverflow: metadata.checks.resize.length === 3 && metadata.checks.resize.every((item) => item.noHorizontalPageOverflow),
    noConsoleCspOrRequestErrors: metadata.checks.noConsoleOrCspErrors
  }
  metadata.checks.overallPassed = Object.values(metadata.checks.contracts).every(Boolean)
  metadata.artifacts = ['DM-125-actions-production.png', 'DM-125-graph-production.png', 'DM-125-graph-narrow-production.png'].map((name) => ({ path: name, bytes: 0 }))
  for (const artifact of metadata.artifacts) artifact.bytes = (await stat(path.join(evidenceDir, artifact.path))).size
  await readFile(path.join(evidenceDir, 'DM-125-actions-production.png'))
  await readFile(path.join(evidenceDir, 'DM-125-graph-production.png'))
  await readFile(path.join(evidenceDir, 'DM-125-graph-narrow-production.png'))
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(evidenceDir, 'DM-125-preview-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`))
  if (!metadata.checks.overallPassed) process.exitCode = 1
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
