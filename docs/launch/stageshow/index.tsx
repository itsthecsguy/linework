import { Bar, Caret, Code, Collapse, Prompt, Roll, Stage, Text, Window, type Act } from '../../kit'
import clean from './d/hero-clean.drawio.svg'
import soft from './d/hero-soft.drawio.svg'
import dark from './d/hero-dark.drawio.svg'
import sketch from './d/hero-sketch.drawio.svg'
import blueprint from './d/hero-blueprint.drawio.svg'
import c4 from './d/hero-c4.drawio.svg'
import flow from './d/refund-flow.drawio.svg'
import sequence from './d/pay-sequence.drawio.svg'
import state from './d/payment-state.drawio.svg'
import aws from './d/serverless-aws.drawio.svg'
import er from './d/billing-er.drawio.svg'
import wordmark from './wordmark-light.svg'
import './launch.css'

// Linework launch video, 1280 x 720, played once and recorded frame by frame.
//
// 1. Title.
// 2. An agent gets the ask in a terminal, writes the spec, runs the build.
// 3. The diagram drops into the design doc behind it. The payoff holds.
// 4. The same diagram in all six styles; the theme line rolls with it.
// 5. A pan across the other diagram types.
// 6. End card with the install command.

type Scene = 'title' | 'agent' | 'styles' | 'types' | 'end'

type S = {
  scene: Scene
  /** The title's icon draws itself, then the wordmark is written on */
  intro: boolean
  term: boolean
  typed: string
  thinking: boolean
  lines: number
  cmd: string
  checked: boolean
  drawn: boolean
  style: number
  pan: boolean
}

const initial: S = { scene: 'title', intro: false, term: false, typed: '', thinking: false, lines: 0, cmd: '', checked: false, drawn: false, style: 0, pan: false }

const ASK = 'Add an architecture diagram of checkout to docs/design.md'
const CMD = 'linework build checkout.yaml -o checkout.drawio.svg'

const SPEC = [
  'type: architecture',
  'direction: LR',
  'groups: { vpc: Production VPC }',
  'nodes:',
  '  web:    { label: Web app, kind: client, tech: Next.js }',
  '  api:    { label: Checkout API, tech: Go, highlight: true, in: vpc }',
  '  db:     { label: Orders, kind: database, tech: Postgres, in: vpc }',
  '  bus:    { label: order-events, kind: queue, tech: Kafka, in: vpc }',
  '  stripe: { label: Stripe, kind: external }',
  'edges:',
  '  - web ==> api: HTTPS',
  '  - api -> db: SQL',
  '  - api -.-> bus: OrderPlaced',
  '  - api ==> stripe: charge',
]

const STYLES = [
  { name: 'clean', src: clean, ground: '#ffffff' },
  { name: 'soft', src: soft, ground: '#ffffff' },
  { name: 'dark', src: dark, ground: '#0d1117' },
  { name: 'sketch', src: sketch, ground: '#ffffff' },
  { name: 'blueprint', src: blueprint, ground: '#f6f8fc' },
  { name: 'c4', src: c4, ground: '#ffffff' },
]

// Each tile is as wide as its diagram at the strip's art height, within limits
const ART_H = 530
const TYPES = [
  { name: 'Sequence', src: sequence, w: 848, h: 769 },
  { name: 'Flowchart', src: flow, w: 460, h: 971 },
  { name: 'State machine', src: state, w: 426, h: 703 },
  { name: 'AWS', src: aws, w: 420, h: 828 },
  { name: 'Entity relationship', src: er, w: 868, h: 382 },
].map((t) => ({ ...t, art: Math.round(Math.min(640, Math.max(300, (t.w / t.h) * ART_H))) }))
const GAP = 24
const STRIP = TYPES.reduce((n, t) => n + t.art + 40, 0) + GAP * (TYPES.length - 1)
// Pan until the last tile's right edge sits on the right gutter
const PAN = STRIP - 1152

const CAPTIONS = {
  agent: 'Ask your agent for a diagram.',
  drawn: 'It writes a short spec. Linework draws it.',
  styles: 'Six styles. One line to switch.',
  types: 'Sequences, flows, state machines, cloud and ER.',
} as const

async function script(a: Act<S>) {
  a.mark('title')
  await a.wait(200)
  await a.set({ intro: true })
  await a.wait(2000)

  // The agent: the terminal comes in with the doc, so the ask starts at once
  await a.set({ scene: 'agent' })
  a.mark('agent')
  // Once the doc has landed, so the dark terminal never fades in over a fading page
  await a.wait(800)
  await a.set({ term: true })
  await a.wait(350)
  await a.type('typed', ASK, { interval: 16 })
  await a.wait(200)
  await a.set({ thinking: true })
  await a.wait(150)
  for (let i = 1; i <= SPEC.length; i++) {
    await a.set({ lines: i })
    await a.wait(36)
  }
  await a.wait(150)
  await a.set({ cmd: CMD })
  await a.wait(450)
  await a.set({ checked: true })
  a.mark('checked')
  await a.wait(550)

  // The payoff: the terminal steps back, the diagram lands in the doc
  await a.set({ term: false })
  await a.wait(300)
  await a.set({ drawn: true })
  a.mark('drawn')
  await a.wait(2600)

  // Styles
  await a.set({ scene: 'styles' })
  a.mark('styles')
  await a.wait(1300)
  for (let i = 1; i < STYLES.length; i++) {
    await a.set({ style: i })
    await a.wait(1150)
  }
  await a.set({ style: 0 })
  await a.wait(900)

  // Types, sequences first
  await a.set({ scene: 'types' })
  a.mark('types')
  await a.wait(500)
  await a.set({ pan: true })
  await a.wait(6600)

  // End
  await a.set({ scene: 'end' })
  a.mark('end')
  await a.wait(3800)
}

const POSTER: S = { ...initial, intro: true, scene: 'agent', drawn: true }

// One stroke: box A, out its right side, an elbow down, into box B's top, round box B
const LINE = 'M60 43V37Q60 30 53 30H33Q26 30 26 37V49Q26 56 33 56H53Q60 56 60 49V43H78Q86 43 86 51V72H95Q102 72 102 79V91Q102 98 95 98H77Q70 98 70 91V79Q70 72 77 72H86'

function Logo({ draw, size }: { draw: boolean; size: number }) {
  return (
    <div className="lwl-logo" data-draw={draw} style={{ height: size }}>
      <svg className="lwl-icon" viewBox="0 0 128 128" width={size} height={size} aria-hidden>
        <rect width="128" height="128" rx="30" fill="#2B50F5" />
        <path d={LINE} pathLength={1} fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <img className="lwl-word" src={wordmark} alt="Linework" style={{ height: size * 0.98 }} />
    </div>
  )
}

export default function LineworkLaunch() {
  return (
    <Stage width={1280} height={720} initial={initial} poster={POSTER} script={script} play="once" className="lwl">
      {(s) => (
        <>
          {(Object.keys(CAPTIONS) as (keyof typeof CAPTIONS)[]).map((k) => (
            <p key={k} className="lwl-caption" data-show={(s.scene === 'agent' && s.drawn ? 'drawn' : s.scene) === k}>
              {CAPTIONS[k]}
            </p>
          ))}

          {/* 1. Title */}
          <section className="lwl-layer lwl-title" data-show={s.scene === 'title'} data-intro={s.intro}>
            <Logo draw={s.intro} size={112} />
            <p>Diagrams your agent draws and you can edit.</p>
          </section>

          {/* 2 and 3. The doc, with the agent's terminal in front */}
          <section className="lwl-layer" data-show={s.scene === 'agent'}>
            <Window title="design.md" className="lwl-doc">
              <div className="lwl-page">
                <Text className="lwl-h1">Checkout redesign</Text>
                <div className="lwl-lede">
                  <Bar w={760} h={8} r={4} tone={2} />
                  <Bar w={540} h={8} r={4} tone={2} />
                </div>
                <Text className="lwl-h2">Architecture</Text>
                <Collapse open={s.drawn} reveal="drop">
                  <img className="lwl-diagram" src={clean} alt="" />
                </Collapse>
                <div className="lwl-para">
                  {[880, 960, 820, 910, 700].map((w, i) => (
                    <Bar key={i} w={w} h={8} r={4} tone={2} />
                  ))}
                </div>
              </div>
            </Window>

            <Window chrome="terminal" title="shop — agent" className="lwl-term" data-show={s.term}>
              <Prompt path="~/shop">
                {s.typed}
                {!s.thinking && <Caret />}
              </Prompt>
              <div className="lwl-step" data-show={s.thinking}>
                <span className="dim">Writing</span> docs/diagrams/checkout.yaml
              </div>
              <Code lines={SPEC} count={s.lines} numbers={false} highlight={false} className="lwl-spec" style={{ opacity: s.lines ? 1 : 0 }} />
              <div className="lwl-step" data-show={!!s.cmd}>
                <span className="dim">Running</span> {s.cmd}
              </div>
              <div className="lwl-step ok" data-show={s.checked}>
                check: 0 errors, 0 warnings
              </div>
            </Window>
          </section>

          {/* 4. Styles */}
          <section className="lwl-layer" data-show={s.scene === 'styles'}>
            <div className="lwl-panel" style={{ background: STYLES[s.style]!.ground }}>
              {STYLES.map((st, i) => (
                <img key={st.name} className="lwl-style" src={st.src} alt="" data-show={i === s.style} />
              ))}
            </div>
            <div className="lwl-file">
              <div className="lwl-file-name">checkout.yaml</div>
              <div className="lwl-file-body">
                <div><span className="k">type:</span> architecture</div>
                <div className="lwl-file-on">
                  <span className="k">theme:</span> <Roll>{STYLES[s.style]!.name}</Roll>
                </div>
                <div><span className="k">direction:</span> LR</div>
              </div>
            </div>
          </section>

          {/* 5. Types */}
          <section className="lwl-layer" data-show={s.scene === 'types'}>
            <div className="lwl-strip" style={{ gap: GAP, transform: `translateX(${s.pan ? -PAN : 0}px)` }}>
              {TYPES.map((t) => (
                <figure key={t.name} className="lwl-tile" style={{ width: t.art + 40 }}>
                  <figcaption>{t.name}</figcaption>
                  <div className="lwl-tile-art">
                    <img src={t.src} alt="" />
                  </div>
                </figure>
              ))}
            </div>
          </section>

          {/* 6. End */}
          <section className="lwl-layer lwl-end" data-show={s.scene === 'end'}>
            <Logo draw size={96} />
            <code className="lwl-cmd">npx skills add itsthecsguy/linework</code>
            <p>Claude Code, Codex, Cursor, Antigravity and any agent with a shell.</p>
            <p className="lwl-url">github.com/itsthecsguy/linework</p>
          </section>
        </>
      )}
    </Stage>
  )
}
