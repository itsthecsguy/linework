// README gallery: one diagram of each type, light and dark, and styles.yaml in
// every style. Rebuild after a rendering change:
//   npm run build && node docs/gallery/build.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const { build } = await import(path.join(root, 'dist/api.js'))
const { DrawioBrowser } = await import(path.join(root, 'dist/render/browser.js'))

const TYPES = ['serverless-aws', 'gcp-ingest', 'orders-azure', 'refund-flow', 'job-state', 'pay-sequence', 'shop-er']
const STYLES = ['clean', 'soft', 'paper', 'dark', 'midnight', 'mono', 'bold', 'sketch', 'blueprint', 'c4']

const withTheme = (file, theme) => fs.readFileSync(file, 'utf8').replace(/^theme:.*\n/m, '') + `\ntheme: ${theme}\n`

const jobs = [
  ...TYPES.flatMap((t) => ['clean', 'dark'].map((th) => [path.join(root, 'examples', `${t}.yaml`), th, `${t}-${th === 'clean' ? 'light' : 'dark'}`])),
  // A small spec, so each style shows at full size in a three-column grid.
  ...STYLES.map((th) => [path.join(here, 'styles.yaml'), th, `style-${th}`]),
]

const b = await DrawioBrowser.launch()
let bad = 0
try {
  for (const [spec, theme, name] of jobs) {
    const out = path.join(here, `${name}.drawio.svg`)
    // Fresh layout every time: the gallery shows what a first build looks like.
    fs.rmSync(out, { force: true })
    const r = await build(withTheme(spec, theme), { out, browser: b })
    const errors = (r.check.findings ?? []).filter((f) => f.level === 'error')
    bad += errors.length
    console.log(name.padEnd(24), errors.length ? errors.map((f) => f.message).join('; ') : 'ok')
  }
} finally {
  await b.close()
}
if (bad) process.exit(1)
