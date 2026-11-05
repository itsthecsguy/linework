import fs from 'node:fs';
import { parseSpecText } from '../src/spec/parse.js';
import { layout } from '../src/layout/layout.js';
import { DrawioBrowser } from '../src/render/browser.js';
const b = await DrawioBrowser.launch();
for (const f of ['checkout', 'refund-flow', 'serverless-aws', 'payment-state']) {
  const { diagram } = parseSpecText(fs.readFileSync(`examples/${f}.yaml`, 'utf8'));
  const l = await layout(diagram, (r) => b.measure(r));
  console.log(f, l.direction, Math.round(l.width), 'x', Math.round(l.height));
}
await b.close();
