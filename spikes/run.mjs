import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { buildGraph, toMxfile } from './lib/build.mjs';
import { buildSequence } from './lib/sequence.mjs';
import { startDrawio } from './lib/drawio.mjs';

const dir = path.join(import.meta.dirname, 'specs');
const out = path.join(import.meta.dirname, 'out');
const only = process.argv[2];
const dio = await startDrawio();
try {
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const name = path.basename(f, '.yaml');
    if (only && name !== only) continue;
    const spec = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const xml = spec.type === 'sequence' ? buildSequence(spec) : toMxfile(await buildGraph(spec));
    await dio.render(xml, path.join(out, name));
    console.log('ok', name);
  }
} finally {
  await dio.close();
}
