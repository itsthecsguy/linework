// Linework brand assets: the icon (one continuous line drawing two boxes and
// the edge between them) and the Sacramento wordmark, outlined to paths.
//
// Needs opentype.js and Sacramento-Regular.ttf (Google Fonts, OFL):
//   npm i opentype.js@1.3.4 && node build.mjs docs/brand Sacramento-Regular.ttf
import fs from 'node:fs'
import opentype from 'opentype.js'

const out = process.argv[2]
const font = opentype.loadSync(process.argv[3])
fs.mkdirSync(out, { recursive: true })

const BLUE = '#2B50F5'
const INK = '#0F1729'
const PAPER = '#F2F4F8'

// One stroke: box A, out its right side, an elbow down, into box B's top, round box B.
export const LINE =
  'M60 43V37Q60 30 53 30H33Q26 30 26 37V49Q26 56 33 56H53Q60 56 60 49V43H78Q86 43 86 51V72H95Q102 72 102 79V91Q102 98 95 98H77Q70 98 70 91V79Q70 72 77 72H86'

const stroke = (color, w = 7) => `fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`

const icon = (size = 128) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="30" fill="${BLUE}"/>
  <path d="${LINE}" ${stroke('#FFFFFF')}/>
</svg>
`
const mark = (color) => `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <path d="${LINE}" ${stroke(color)}/>
</svg>
`

// The wordmark, outlined. Sacramento is a hairline; a matching stroke on the
// outline gives it the weight of the icon's line at lockup size.
function word(size) {
  const p = font.getPath('Linework', 0, 0, size)
  const bb = p.getBoundingBox()
  return { d: p.toPathData(2), bb }
}

function lockup(text, tile) {
  const w = word(150)
  const pad = 6
  const ww = w.bb.x2 - w.bb.x1
  const wh = w.bb.y2 - w.bb.y1
  const H = 128
  // Optical: the script's x-height sits on the icon's middle
  const gap = 34
  const W = 128 + gap + ww + pad * 2
  const ty = H / 2 - (w.bb.y1 + wh * 0.58)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${H}" viewBox="0 0 ${Math.ceil(W)} ${H}">
  <rect width="128" height="128" rx="30" fill="${tile}"/>
  <path d="${LINE}" ${stroke('#FFFFFF')}/>
  <path transform="translate(${(128 + gap - w.bb.x1 + pad).toFixed(1)} ${ty.toFixed(1)})" d="${w.d}" fill="${text}" stroke="${text}" stroke-width="1.6" stroke-linejoin="round"/>
</svg>
`
}

function wordmark(text) {
  const w = word(150)
  const pad = 8
  const W = Math.ceil(w.bb.x2 - w.bb.x1 + pad * 2)
  const H = Math.ceil(w.bb.y2 - w.bb.y1 + pad * 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <path transform="translate(${(pad - w.bb.x1).toFixed(1)} ${(pad - w.bb.y1).toFixed(1)})" d="${w.d}" fill="${text}" stroke="${text}" stroke-width="1.6" stroke-linejoin="round"/>
</svg>
`
}

fs.writeFileSync(`${out}/icon.svg`, icon())
fs.writeFileSync(`${out}/mark.svg`, mark(INK))
fs.writeFileSync(`${out}/logo-light.svg`, lockup(INK, BLUE))
fs.writeFileSync(`${out}/logo-dark.svg`, lockup(PAPER, BLUE))
fs.writeFileSync(`${out}/wordmark-light.svg`, wordmark(INK))
fs.writeFileSync(`${out}/wordmark-dark.svg`, wordmark(PAPER))
console.log('wrote', fs.readdirSync(out).join(' '))
