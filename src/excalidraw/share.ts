// A link that opens a scene at excalidraw.com, made the way Excalidraw's own
// "Shareable link" button makes one: the scene is compressed, encrypted with a
// fresh key, and the ciphertext is stored on Excalidraw's server. The key is
// never sent anywhere; it sits after the "#" in the link, which browsers keep
// to themselves. Whoever has the whole link can read the drawing.
import { webcrypto } from 'node:crypto';
import zlib from 'node:zlib';
import type { ExcalidrawFile } from './export.js';

const STORE = 'https://json.excalidraw.com/api/v2/post/';

/** Excalidraw's framing for several buffers in one: a version, then each buffer behind its length. */
export function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const out = Buffer.alloc(4 + buffers.reduce((n, b) => n + 4 + b.byteLength, 0));
  out.writeUInt32BE(1, 0);
  let at = 4;
  for (const b of buffers) {
    out.writeUInt32BE(b.byteLength, at);
    out.set(b, at + 4);
    at += 4 + b.byteLength;
  }
  return out;
}

export function splitBuffers(joined: Uint8Array): Buffer[] {
  const buf = Buffer.from(joined.buffer, joined.byteOffset, joined.byteLength);
  if (buf.readUInt32BE(0) !== 1) throw new Error('unknown framing version');
  const out: Buffer[] = [];
  for (let at = 4; at < buf.length; ) {
    const n = buf.readUInt32BE(at);
    out.push(buf.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

const importKey = (k: string, use: 'encrypt' | 'decrypt') =>
  webcrypto.subtle.importKey('jwk', { alg: 'A128GCM', ext: true, k, key_ops: ['encrypt', 'decrypt'], kty: 'oct' }, { name: 'AES-GCM', length: 128 }, false, [use]);

/** What a share link stores: the scene without its images (those are kept elsewhere, and linework has no access to it). */
export function shareable(scene: ExcalidrawFile): { text: string; images: number } {
  const elements = scene.elements.filter((e) => e.type !== 'image' && !e.isDeleted);
  return { text: JSON.stringify({ ...scene, elements, files: {} }), images: scene.elements.length - elements.length };
}

export async function seal(text: string): Promise<{ payload: Uint8Array; key: string }> {
  const made = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
  const key = (await webcrypto.subtle.exportKey('jwk', made)).k!;
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plain = zlib.deflateSync(concatBuffers(Buffer.from('null'), Buffer.from(text, 'utf8')));
  const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key, 'encrypt'), new Uint8Array(plain)));
  const info = Buffer.from(JSON.stringify({ version: 2, compression: 'pako@1', encryption: 'AES-GCM' }));
  return { payload: concatBuffers(info, iv, sealed), key };
}

export async function unseal(payload: Uint8Array, key: string): Promise<string> {
  const [, iv, sealed] = splitBuffers(payload);
  if (!iv || !sealed) throw new Error('not a sealed scene');
  const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, await importKey(key, 'decrypt'), new Uint8Array(sealed)));
  return splitBuffers(zlib.inflateSync(plain))[1]!.toString('utf8');
}

/** Store the scene and return the link to it. This sends the (encrypted) drawing to excalidraw.com. */
export async function shareLink(scene: ExcalidrawFile, post: typeof fetch = fetch): Promise<{ url: string; images: number }> {
  const { text, images } = shareable(scene);
  const { payload, key } = await seal(text);
  let res: Response;
  try {
    res = await post(STORE, { method: 'POST', body: new Uint8Array(payload) });
  } catch (e) {
    throw new Error(`couldn't reach excalidraw.com to store the drawing: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; error_class?: string };
  if (body.error_class === 'RequestTooLargeError') throw new Error('the drawing is too large for an excalidraw.com link');
  if (!res.ok || !body.id) throw new Error(`excalidraw.com didn't store the drawing (HTTP ${res.status})`);
  return { url: `https://excalidraw.com/#json=${body.id},${key}`, images };
}
