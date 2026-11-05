// Text metrics for sizing boxes. Words are measured once in the browser, with the
// bundled font the diagram renders in, then lines are wrapped greedily the way
// draw.io's HTML labels wrap them. So a box sized here fits its text exactly.
import type { Measure } from './layout.js';

export interface FontSpec {
  size: number;
  weight: number;
  family: string;
  /** Extra space after each character, in px (CSS letter-spacing). */
  tracking?: number;
}

export interface Wrapped {
  lines: string[];
  /** Widest line in px. Can exceed the limit when one word is longer than it. */
  width: number;
}

const key = (f: FontSpec) => `${f.weight} ${f.size} ${f.family}`;

export class TextMeasurer {
  private widths = new Map<string, number>();
  constructor(private measure: Measure) {}

  /** Measure every word (and the space) of these texts. Call before wrap/width. */
  async prepare(items: Array<readonly [string | undefined, FontSpec]>): Promise<void> {
    const reqs: Array<[string, number, number, string]> = [];
    const keys: string[] = [];
    const add = (word: string, f: FontSpec) => {
      const k = `${key(f)}|${word}`;
      if (this.widths.has(k) || keys.includes(k)) return;
      keys.push(k);
      reqs.push([word, f.size, f.weight, f.family]);
    };
    for (const [text, f] of items) {
      if (!text) continue;
      add(' ', f);
      add(text, f);
      for (const w of words(text)) add(w, f);
    }
    if (!reqs.length) return;
    const out = await this.measure(reqs);
    keys.forEach((k, i) => this.widths.set(k, out[i]!));
  }

  private get(word: string, f: FontSpec): number {
    const w = this.widths.get(`${key(f)}|${word}`);
    if (w == null) throw new Error(`aiviz: text not measured: "${word}"`);
    return w + (f.tracking ?? 0) * word.length;
  }

  /** Width of the text on one line. */
  width(text: string | undefined, f: FontSpec): number {
    return text ? this.get(text, f) : 0;
  }

  /** Greedy word wrap at maxW. */
  wrap(text: string | undefined, f: FontSpec, maxW: number): Wrapped {
    if (!text) return { lines: [], width: 0 };
    const whole = this.get(text, f);
    if (whole <= maxW) return { lines: [text], width: whole };
    const space = this.get(' ', f);
    const lines: string[] = [];
    let cur = '', curW = 0, width = 0;
    for (const w of words(text)) {
      const ww = this.get(w, f);
      if (cur && curW + space + ww > maxW) {
        lines.push(cur);
        width = Math.max(width, curW);
        cur = w;
        curW = ww;
      } else {
        curW = cur ? curW + space + ww : ww;
        cur = cur ? `${cur} ${w}` : w;
      }
    }
    if (cur) {
      lines.push(cur);
      width = Math.max(width, curW);
    }
    // Summing word widths drops kerning across spaces; round up a hair.
    return { lines, width: Math.ceil(width + 1) };
  }
}

const words = (t: string) => t.split(/\s+/).filter(Boolean);
