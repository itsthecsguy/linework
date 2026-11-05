import fs from 'node:fs';
import YAML from 'yaml';
import { buildGraph, toMxfile } from './lib/build.mjs';
import { startDrawio } from './lib/drawio.mjs';
const spec = YAML.parse(fs.readFileSync('specs/checkout.yaml', 'utf8'));
const g = await buildGraph(spec);
const dio = await startDrawio();
const move = `const c = model.getCell('api'); graph.moveCells([c], 96, 40);`;
for (const wp of [true, false]) {
  const xml = toMxfile(g, { waypoints: wp });
  const tag = wp ? 'wp' : 'nowp';
  await dio.render(xml, `out/checkout.${tag}`);
  const moved = await dio.roundTrip(xml, move);
  await dio.render(`<mxfile><diagram name="x">${moved}</diagram></mxfile>`, `out/checkout.${tag}.moved`);
}
await dio.close();
