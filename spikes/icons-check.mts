// Glyph icons on plain and highlighted nodes in every style.
import { build } from '../src/api.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { THEMES } from '../src/spec/model.js';
const b = await DrawioBrowser.launch();
for (const t of THEMES) {
  const spec = `type: architecture\ntheme: ${t}\nnodes:\n  u: { label: Users, kind: person, icon: aws.users }\n  h: { label: Picked, kind: person, icon: aws.users, highlight: true }\n  g: { label: Cloud Run, icon: gcp.cloud_run }\n  a: { label: Azure SQL, icon: azure.sql_database, highlight: true }\n  k: { label: Pod, icon: k8s.pod }\nedges:\n  - u -> g\n  - h -> a\n  - g -> k\n`;
  const out = `out/styles/_icons-${t}.drawio.svg`;
  const r = await build(spec, { out, png: out.replace('.drawio.svg', '.png'), browser: b });
  console.log(t, r.check.findings.length);
}
await b.close();
