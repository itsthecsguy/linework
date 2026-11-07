// Record a stage to MP4, frame-exact: the kit's virtual clock moves one frame
// per step, each frame is screenshotted and piped to ffmpeg.
//
//   node scripts/record-video.mjs <url> --out video.mp4 [--fps 60] [--scale 1.5]
//        [--width 1280] [--height 720] [--tail 4000] [--max 60]
//
// Stops --tail ms after the stage's data-mark reads "end", or after --max seconds.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launch } from './browser.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : d
}
const url = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
const out = resolve(opt('out', 'video.mp4'))
const fps = Number(opt('fps', 60))
const scale = Number(opt('scale', 1.5))
const width = Number(opt('width', 1280))
const height = Number(opt('height', 720))
const tail = Number(opt('tail', 4000))
const max = Number(opt('max', 60))
const posterAt = opt('poster') // a data-mark: also save that frame as a PNG
if (!url) throw new Error('usage: record-video.mjs <url> --out video.mp4')

// The clock, as a self-contained init script that runs before the page's code
const bundled = await build({
  stdin: {
    contents: `import { installVirtualClock } from './kit/clock.ts'; installVirtualClock({ fps: ${fps}, epoch: Date.UTC(2026, 10, 6, 17, 0) })`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  write: false,
})
const initScript = bundled.outputFiles[0].text

const browser = await launch()
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => console.log(`[page error] ${e.message}`))
await page.addInitScript(initScript)
await page.goto(url)
await page.addStyleTag({ content: 'html,body{margin:0!important;padding:0!important;overflow:hidden!important} #example{padding:0!important;margin:0!important}' })

// Wait (in real time, from Node) for the stage, its fonts and its images
const real = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; ; i++) {
  const ready = await page.evaluate(async () => {
    const stage = document.querySelector('.ss-stage')
    if (!stage || !window.__stageshow?.clock) return false
    await document.fonts.ready
    const imgs = [...document.images]
    if (!imgs.every((im) => im.complete && im.naturalWidth > 0)) return false
    await Promise.all(imgs.map((im) => im.decode().catch(() => {})))
    return true
  })
  if (ready) break
  if (i > 200) throw new Error('stage never became ready')
  await real(50)
}
// Let measurement and the first layout land before frame 0
await page.evaluate(() => window.__stageshow.clock.flushLayout())
const box = await page.evaluate(() => {
  const r = document.querySelector('.ss-stage').getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
console.log('stage box', box)

const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
const done = new Promise((r, j) => ff.on('close', (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))))

let endAt = null
let posterSaved = false
const clip = { x: box.x, y: box.y, width: Math.min(box.width, width), height: Math.min(box.height, height) }
for (let f = 0; f < max * fps; f++) {
  const shot = await page.screenshot({ clip, type: 'png', caret: 'initial', animations: 'allow' })
  if (!ff.stdin.write(shot)) await new Promise((r) => ff.stdin.once('drain', r))
  const mark = await page.evaluate(async () => {
    await window.__stageshow.clock.step(1)
    return document.querySelector('.ss-stage')?.getAttribute('data-mark') ?? null
  })
  if (posterAt && !posterSaved && mark === posterAt) posterSaved = true
  if (mark === 'end' && endAt === null) endAt = f
  if (endAt !== null && f - endAt >= (tail / 1000) * fps) break
  if (f % fps === 0) process.stdout.write(`${f / fps}s ${mark ?? ''}\n`)
}
ff.stdin.end()
await done
await browser.close()
console.log(`wrote ${out}`)
