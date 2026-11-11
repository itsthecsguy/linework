// The files an Excalidraw scene travels in. Besides plain .excalidraw JSON,
// Excalidraw reads a scene back out of an image it is embedded in: an SVG with
// the scene in a <metadata> block (.excalidraw.svg), or a PNG with it in a tEXt
// chunk (.excalidraw.png). Those show as pictures in a README and on GitHub and
// still open for editing, which is what a .drawio.svg does for draw.io.
//
// Here the picture is linework's own render of the diagram. Excalidraw draws
// its own the first time someone saves the file from it.
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { DrawioModel } from '../drawio/read.js';
import type { DrawioBrowser } from '../render/browser.js';
import type { ExcalidrawFile } from './export.js';

const MIME = 'application/vnd.excalidraw+json';

export type SceneKind = 'json' | 'svg' | 'png';

/** Which Excalidraw file a path names, if any. */
export function sceneKind(file: string): SceneKind | undefined {
  if (/\.excalidraw(\.json)?$/i.test(file)) return 'json';
  if (/\.excalidraw\.svg$/i.test(file)) return 'svg';
  if (/\.excalidraw\.png$/i.test(file)) return 'png';
  return undefined;
}

// ---------- Excalidraw's envelope: {version, encoding, compressed, encoded} ----------

/** The scene deflated, as a string with one character per byte, in the JSON wrapper Excalidraw expects. */
export function encodeScene(text: string): string {
  return JSON.stringify({ version: '1', encoding: 'bstring', compressed: true, encoded: zlib.deflateSync(Buffer.from(text, 'utf8')).toString('latin1') });
}

export function decodeScene(wrapper: string): string {
  const data = JSON.parse(wrapper) as { encoded?: string; encoding?: string; compressed?: boolean; type?: string };
  // Old Excalidraw wrote the scene itself, with no wrapper.
  if (data.encoded == null) {
    if (data.type === 'excalidraw') return wrapper;
    throw new Error('no Excalidraw scene in it');
  }
  const bytes = Buffer.from(data.encoded, 'latin1');
  return (data.compressed ? zlib.inflateSync(bytes) : bytes).toString('utf8');
}

// ---------- SVG ----------

export function embedInSvg(svg: string, sceneText: string): string {
  const payload = Buffer.from(encodeScene(sceneText), 'latin1').toString('base64');
  const meta = `<!-- svg-source:excalidraw --><metadata><!-- payload-type:${MIME} --><!-- payload-version:2 --><!-- payload-start -->${payload}<!-- payload-end --></metadata>`;
  // The draw.io model would go stale the first time Excalidraw saves this file, so it is left out.
  const bare = svg.replace(/(<svg\b[^>]*?)\scontent="[^"]*"/, '$1');
  const open = /<svg\b[^>]*>/.exec(bare);
  if (!open) throw new Error('not an SVG');
  const at = open.index + open[0].length;
  return bare.slice(0, at) + meta + bare.slice(at);
}

export function sceneFromSvg(svg: string): string {
  if (!svg.includes(`payload-type:${MIME}`)) throw new Error('no Excalidraw scene in it. Excalidraw embeds one when you export an SVG with "Embed scene" on');
  const m = /<!-- payload-start -->\s*([\s\S]+?)\s*<!-- payload-end -->/.exec(svg);
  if (!m) throw new Error('its Excalidraw scene is cut short');
  const version = /<!-- payload-version:(\d+) -->/.exec(svg)?.[1] ?? '1';
  const raw = Buffer.from(m[1]!, 'base64');
  // Version 1 held the UTF-8 of the wrapper; version 2 holds it one byte per character.
  return decodeScene(raw.toString(version === '1' ? 'utf8' : 'latin1'));
}

// ---------- PNG ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunks(png: Buffer): Array<{ type: string; data: Buffer; start: number; end: number }> {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  const out = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > png.length) break;
    out.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length), start: at, end });
    at = end;
  }
  return out;
}

const isSceneChunk = (c: { type: string; data: Buffer }) => c.type === 'tEXt' && c.data.toString('latin1', 0, MIME.length + 1) === `${MIME}\0`;

export function embedInPng(png: Buffer, sceneText: string): Buffer {
  const chunks = pngChunks(png);
  if (!chunks.some((c) => c.type === 'IEND')) throw new Error('not a complete PNG');
  const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`${MIME}\0`, 'latin1'), Buffer.from(encodeScene(sceneText), 'latin1')]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  // The scene goes just before the end marker, in place of any the picture already carried.
  const parts = [png.subarray(0, 8)];
  for (const c of chunks) {
    if (isSceneChunk(c)) continue;
    if (c.type === 'IEND') parts.push(chunk);
    parts.push(png.subarray(c.start, c.end));
  }
  return Buffer.concat(parts);
}

export function sceneFromPng(png: Buffer): string {
  for (const c of pngChunks(png)) {
    if (isSceneChunk(c)) return decodeScene(c.data.toString('latin1', MIME.length + 1));
  }
  throw new Error('no Excalidraw scene in it. Excalidraw embeds one when you export a PNG with "Embed scene" on');
}

// ---------- files ----------

/** A scene as the bytes of the file `kind` names. The picture, for an image, is the diagram as linework draws it. */
export async function writeScene(kind: SceneKind, scene: ExcalidrawFile, m: DrawioModel, b: DrawioBrowser): Promise<string | Buffer> {
  if (kind === 'json') return JSON.stringify(scene, null, 2) + '\n';
  const text = JSON.stringify(scene);
  return kind === 'svg' ? embedInSvg(await b.renderSvg(m.xml), text) : embedInPng(await b.renderPng(m.xml), text);
}

/** Read a scene from .excalidraw, .excalidraw.svg or .excalidraw.png (or any SVG or PNG Excalidraw embedded one in). */
export function readScene(file: string): ExcalidrawFile {
  let text: string;
  try {
    if (/\.png$/i.test(file)) text = sceneFromPng(fs.readFileSync(file));
    else if (/\.svg$/i.test(file)) text = sceneFromSvg(fs.readFileSync(file, 'utf8'));
    else text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text) as ExcalidrawFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} doesn't exist`);
    throw new Error(`${file} isn't an Excalidraw file: ${(e as Error).message}`);
  }
}
