import { page, evalIn } from './cdp.mjs'
const c = await page(); console.log(JSON.stringify(await evalIn(c, process.argv[2]))); c.close(); process.exit(0)
