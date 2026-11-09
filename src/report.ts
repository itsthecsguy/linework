// Human-readable summaries shared by the CLI and the MCP server.
import type { BuildResult } from './api.js';
import type { CheckResult } from './lint/check.js';

export function buildLines(res: BuildResult, png?: string): string[] {
  const s = res.check.stats;
  const lines = [`wrote ${res.out} (${s.nodes} nodes, ${s.edges} edges, ${s.width}x${s.height}px, ${res.direction})`];
  if (res.merge) {
    const m = res.merge;
    const parts = [`kept ${m.kept} positions${m.handMoved ? ` (${m.handMoved} set by hand)` : ''}`];
    if (m.placed.length) parts.push(`placed ${m.placed.join(', ')}`);
    if (m.grown.length) parts.push(`grew ${m.grown.join(', ')}`);
    if (m.shrunk.length) parts.push(`closed up ${m.shrunk.join(', ')}`);
    if (m.removed.length) parts.push(`removed ${m.removed.join(', ')}`);
    if (m.rerouted) parts.push(`rerouted ${m.rerouted} edges`);
    if (m.carried) parts.push(`kept ${m.carried} notes/annotations`);
    lines.push(`merged into the existing layout: ${parts.join('; ')}`);
    if (m.keptUnknown.length)
      lines.push(
        `note: kept ${m.keptUnknown.join(', ')}: added by hand, and this spec didn't come from the current file. To work from the latest version run show first; to delete them, remove them from that output.`,
      );
  }
  if (res.discardedLayout) lines.push('relayout: discarded the hand-arranged layout and laid out from scratch');
  if (png) lines.push(`preview ${png}`);
  for (const w of res.warnings) lines.push(`spec warning: ${w.path}: ${w.message}`);
  return [...lines, ...checkLines(res.check)];
}

export function checkLines(res: CheckResult): string[] {
  const errors = res.findings.filter((f) => f.level === 'error');
  const warnings = res.findings.filter((f) => f.level === 'warning');
  return [
    `check: ${errors.length} errors, ${warnings.length} warnings, ${res.stats.crossings} edge crossings`,
    ...res.findings.map((f) => `  ${f.level}: ${f.message} [${f.rule}]`),
  ];
}
