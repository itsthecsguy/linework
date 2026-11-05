import { Bar, Code, Stage, Text, Window } from '../../kit'
import light from './diagram-light.png'
import dark from './diagram-dark.png'
import './hero.css'

// aiviz README hero. A still. The story: the YAML an agent writes on the left
// becomes the diagram in the design doc behind it.
//
// - Copied from `overlap`: one window with chrome, one card a level above it.
// - The window spans the stage so the diagram reads at nearly full size; it is
//   pinned top and runs off the bottom. Only the doc's placeholder lines bleed.
// - The card sits over the doc's filler under the diagram, never on the diagram.
// - The card's lines are the spec that drew the diagram, so both surfaces tell
//   one thing. Real strings: the doc title, the spec, the diagram.

const SPEC = [
  'type: architecture',
  'nodes:',
  '  web:    { label: Web app, kind: client }',
  '  api:    { label: Checkout API, highlight: true }',
  '  db:     { label: Orders, kind: database }',
  '  bus:    { label: order-events, kind: queue }',
  '  stripe: { label: Stripe, kind: external }',
  'edges:',
  '  - web ==> api: HTTPS',
  '  - api ==> stripe: charge',
]

export default function AivizHero() {
  return (
    <Stage width={960} height={675} className="avh">
      {() => (
        <>
          <Window title="checkout.md" className="avh-win">
            <div className="avh-doc">
              <Text className="avh-title">Checkout redesign</Text>
              <div className="avh-lede">
                <Bar w={520} h={7} r={4} tone={2} />
              </div>
              <img className="avh-img avh-light" src={light} alt="" />
              <img className="avh-img avh-dark" src={dark} alt="" />
              <div className="avh-para">
                {[560, 610, 500, 580, 540, 600].map((w, i) => (
                  <Bar key={i} w={w} h={7} r={4} tone={2} />
                ))}
              </div>
            </div>
          </Window>

          <section className="avh-card">
            <div className="avh-file">
              <Text className="avh-name">checkout.yaml</Text>
            </div>
            <Code lines={SPEC} highlight={false} />
          </section>
        </>
      )}
    </Stage>
  )
}
