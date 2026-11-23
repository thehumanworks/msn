import { HttpError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "./http";

export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE };
/** About ten minutes. Minted on a one-minute boundary so a fast retry repeats the same URL. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_BUCKET_MS = 60 * 1000;

/** Images a browser may render inline. SVG and HTML are never in this list. */
export const INLINE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * SHA-256. Sync on purpose: preview URLs are signed inside a Durable Object transaction.
 * The message bit length is written in the low 32 bits only, so an input of 512 MiB or more
 * would hash wrong. Attachment bodies are capped at 25 MB, under that limit.
 */
export function sha256Bytes(message: Uint8Array): Uint8Array {
  const bitLen = message.length * 8;
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 64; j++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[j] + w[j]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const hashed = new DataView(out.buffer);
  for (const [offset, word] of [h0, h1, h2, h3, h4, h5, h6, h7].entries())
    hashed.setUint32(offset * 4, word, false);
  return out;
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const block = 64;
  const normalized = key.length > block ? sha256Bytes(key) : key;
  const padded = new Uint8Array(block);
  padded.set(normalized);
  const outer = new Uint8Array(block);
  const inner = new Uint8Array(block);
  for (let i = 0; i < block; i++) {
    outer[i] = padded[i] ^ 0x5c;
    inner[i] = padded[i] ^ 0x36;
  }
  const innerMessage = new Uint8Array(block + data.length);
  innerMessage.set(inner);
  innerMessage.set(data, block);
  const outerMessage = new Uint8Array(block + 32);
  outerMessage.set(outer);
  outerMessage.set(sha256Bytes(innerMessage), block);
  return sha256Bytes(outerMessage);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function headText(bytes: Uint8Array, max = 512): string {
  const n = Math.min(bytes.length, max);
  let text = "";
  for (let i = 0; i < n; i++) text += String.fromCharCode(bytes[i]);
  return text
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
}

function looksLikeUtf8(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * The type the bytes actually are. The file name, the multipart part type and a client
 * `mediaType` are not consulted: a `.png` full of HTML must not be served as an image.
 */
export function sniffedType(bytes: Uint8Array): string {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "image/gif";
  if (bytes.length >= 12 && starts(bytes, ascii("RIFF")) && starts(bytes.subarray(8), ascii("WEBP")))
    return "image/webp";
  if (starts(bytes, ascii("%PDF-"))) return "application/pdf";
  if (starts(bytes, [0x1f, 0x8b])) return "application/gzip";
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return "application/zip";
  const head = headText(bytes);
  if (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<script") ||
    head.startsWith("<iframe")
  )
    return "text/html";
  if (
    head.startsWith("<svg") ||
    (head.startsWith("<?xml") && head.includes("<svg")) ||
    head.startsWith("<!doctype svg")
  )
    return "image/svg+xml";
  if (looksLikeUtf8(bytes)) return "text/plain";
  return "application/octet-stream";
}

export function inlineMedia(mime: string): boolean {
  return INLINE_MEDIA_TYPES.includes(mime);
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

export type ImageSize = { width: number; height: number };

/**
 * Frame size. Absent when the file is that type but truncated, or when a crafted frame claims a
 * dimension below 1 (those are not sent to clients). Orientation is not applied.
 */
export function imageSize(bytes: Uint8Array, mime: string): ImageSize | null {
  const size =
    mime === "image/png" && bytes.length >= 24 && bytes[12] === 0x49 && bytes[13] === 0x48
      ? { width: u32(bytes, 16), height: u32(bytes, 20) }
      : mime === "image/gif" && bytes.length >= 10
        ? { width: u16(bytes, 6), height: u16(bytes, 8) }
        : mime === "image/jpeg"
          ? jpegSize(bytes)
          : mime === "image/webp"
            ? webpSize(bytes)
            : null;
  if (!size || size.width < 1 || size.height < 1) return null;
  return size;
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return null;
    // SOF0, SOF1, SOF2 hold the frame size. DHT/DAC/restart markers do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    i += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === "VP8X" && bytes.length >= 30) {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (fourcc === "VP8 " && bytes.length >= 30) {
    // Lossy frame: 3-byte frame tag at 20, start code at 23–25, 14-bit dimensions at 26 and 28.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16(bytes, 26) & 0x3fff, height: u16(bytes, 28) & 0x3fff };
  }
  if (fourcc === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Drops JPEG APP1 Exif and XMP, PNG `eXIf` chunks and WebP `EXIF` chunks.
 * A file that parses and has none of those is returned unchanged.
 * A truncated or inconsistent container is rejected: returning the original would keep GPS.
 * APP2 ICC, APP13 IPTC, JPEG COM, PNG text chunks and WebP XMP are not removed (ADR 0087).
 */
export function stripMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  if (mime === "image/jpeg") return stripJpeg(bytes);
  if (mime === "image/png") return stripPng(bytes);
  if (mime === "image/webp") return stripWebp(bytes);
  return bytes;
}

function malformed(what: string): HttpError {
  return new HttpError(400, "invalid_attachment", `This ${what} is truncated or malformed.`);
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (!starts(bytes, [0xff, 0xd8])) throw malformed("JPEG");
  const keep: Array<[number, number]> = [[0, 2]];
  let removed = false;
  let sawEnd = false;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw malformed("JPEG");
    const markerStart = i;
    i += 1;
    // Fill bytes: FF FF … then the real marker. Treating FF as a length field kept the EXIF.
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) throw malformed("JPEG");
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9) {
      keep.push([markerStart, i]);
      sawEnd = true;
      break;
    }
    if (marker === 0x00 || marker === 0xd8) throw malformed("JPEG");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push([markerStart, i]);
      continue;
    }
    if (i + 2 > bytes.length) throw malformed("JPEG");
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) throw malformed("JPEG");
    const end = i + length;
    const payload = bytes.subarray(i + 2, end);
    const drop =
      marker === 0xe1 &&
      (starts(payload, ascii("Exif\0\0")) || starts(payload, ascii("http://ns.adobe.com/xap/1.0/\0")));
    if (drop) removed = true;
    else keep.push([markerStart, end]);
    i = end;
    if (marker === 0xda) {
      // The compressed scan follows, with FF 00 stuffing. Keep it whole through the EOI.
      if (i < bytes.length) keep.push([i, bytes.length]);
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || i > bytes.length) throw malformed("JPEG");
  if (!removed) return bytes;
  return concatRanges(bytes, keep);
}

function stripPng(bytes: Uint8Array): Uint8Array {
  if (!starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw malformed("PNG");
  const keep: Array<[number, number]> = [[0, 8]];
  let removed = false;
  let i = 8;
  let ended = false;
  while (i + 12 <= bytes.length) {
    const length = u32(bytes, i);
    if (i + 12 + length > bytes.length) throw malformed("PNG");
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const end = i + 12 + length;
    if (type === "eXIf") removed = true;
    else keep.push([i, end]);
    i = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) throw malformed("PNG");
  if (!removed) return bytes;
  return concatRanges(bytes, keep);
}

function stripWebp(bytes: Uint8Array): Uint8Array {
  if (!(bytes.length >= 12 && starts(bytes, ascii("RIFF")) && starts(bytes.subarray(8), ascii("WEBP"))))
    throw malformed("WebP");
  const keep: Array<[number, number]> = [];
  let removed = false;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const length = new DataView(bytes.buffer, bytes.byteOffset + i + 4, 4).getUint32(0, true);
    const padded = length + (length & 1);
    if (i + 8 + padded > bytes.length) throw malformed("WebP");
    if (type === "EXIF") removed = true;
    else keep.push([i, i + 8 + padded]);
    i += 8 + padded;
  }
  if (i !== bytes.length) throw malformed("WebP");
  if (!removed) return bytes;
  const payload = keep.reduce((sum, [start, end]) => sum + (end - start), 0);
  const out = new Uint8Array(12 + payload);
  out.set(bytes.subarray(0, 4));
  new DataView(out.buffer).setUint32(4, payload + 4, true);
  out.set(bytes.subarray(8, 12), 8);
  let offset = 12;
  for (const [start, end] of keep) {
    out.set(bytes.subarray(start, end), offset);
    offset += end - start;
  }
  return out;
}

function concatRanges(bytes: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  const size = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const [start, end] of ranges) {
    out.set(bytes.subarray(start, end), offset);
    offset += end - start;
  }
  return out;
}

export function previewExpiry(now = Date.now()): number {
  return Math.floor(now / PREVIEW_BUCKET_MS) * PREVIEW_BUCKET_MS + PREVIEW_TTL_MS;
}

export function previewPayload(
  tenant: string,
  channel: string,
  message: number,
  index: number,
  exp: number,
): string {
  return `${tenant}/${channel}/${message}/${index}/${exp}`;
}

export function signPreview(secret: Uint8Array, payload: string): string {
  return hex(hmacSha256(secret, new TextEncoder().encode(payload)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** True only for a signature this workspace minted and that has not expired. */
export function previewValid(
  secret: Uint8Array,
  tenant: string,
  channel: string,
  message: number,
  index: number,
  expRaw: string | null,
  sig: string | null,
  now = Date.now(),
): boolean {
  if (!expRaw || !sig || !/^[1-9]\d+$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + PREVIEW_TTL_MS) return false;
  const expected = signPreview(secret, previewPayload(tenant, channel, message, index, exp));
  return timingSafeEqual(expected, sig);
}

function tooLarge(maxBytes = MAX_ATTACHMENT_BYTES): HttpError {
  return new HttpError(413, "attachment_too_large", `An attachment cannot exceed ${maxBytes} bytes.`);
}

function tooMany(maxFiles = MAX_ATTACHMENTS_PER_MESSAGE): HttpError {
  return new HttpError(413, "too_many_attachments", `A message can carry at most ${maxFiles} files.`);
}

/** Reads a raw body, stopping at `maxBytes + 1` so the extra byte is never stored. */
export async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes) {
    await request.body?.cancel();
    throw tooLarge(maxBytes);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw tooLarge(maxBytes);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!size) throw new HttpError(400, "invalid_attachment", "An attachment needs a non-empty body.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // Drop the chunk list before the caller parses or strips, so the peak is one buffer.
  chunks.length = 0;
  return bytes;
}

export type MultipartFile = { name: string; bytes: Uint8Array };
export type MultipartLimits = { maxBytes: number; maxFiles: number };

const FIELD_MAX = 32 * 1024;

function boundaryOf(contentType: string): string | null {
  const match = /boundary="?([A-Za-z0-9'()+_,\-./:=?]{1,70})"?/i.exec(contentType);
  return match ? match[1] : null;
}

/** RFC 5987 filename* or the quoted filename. The caller still rejects path characters. */
export function fileNameOf(disposition: string): string | null {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return null;
    }
  }
  const quoted = /filename="((?:\\.|[^"\\])*)"/i.exec(disposition);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");
  const plain = /filename=([^;]+)/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

class ByteBuf {
  private chunks: Uint8Array[] = [];
  /** Bytes already consumed in `chunks[0]`. */
  private offset = 0;
  size = 0;

  push(chunk: Uint8Array): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  /**
   * Index of `needle` at or after `from`, or -1. Scans each new chunk once and carries only
   * `needle.length - 1` bytes across the boundary, so a large part is not recopied or rescanned.
   */
  indexOf(needle: Uint8Array, from = 0): number {
    if (!needle.length || this.size < from + needle.length) return -1;
    const overlap = needle.length - 1;
    let carry: Uint8Array = new Uint8Array(0);
    let pos = 0;
    for (let c = 0; c < this.chunks.length; c++) {
      const start = c === 0 ? this.offset : 0;
      const view = this.chunks[c].subarray(start);
      const end = pos + view.length;
      if (end <= from) {
        pos = end;
        continue;
      }
      const sliceFrom = Math.max(0, from - pos);
      const piece = view.subarray(sliceFrom);
      const piecePos = pos + sliceFrom;
      const minFound = Math.max(0, from - (piecePos - carry.length));
      const found = findAcross(carry, piece, needle, minFound);
      if (found >= 0) return piecePos - carry.length + found;
      carry = tailOf(carry, piece, overlap);
      pos = end;
    }
    return -1;
  }

  peek(n: number): Uint8Array {
    const count = Math.min(n, this.size);
    const first = this.chunks[0];
    if (first && this.offset + count <= first.length) return first.subarray(this.offset, this.offset + count);
    return this.copy(count);
  }

  /** One copy of the next `n` bytes, then those bytes are dropped. */
  take(n: number): Uint8Array {
    const out = this.copy(Math.min(n, this.size));
    this.drop(out.length);
    return out;
  }

  drop(n: number): void {
    let left = Math.min(n, this.size);
    this.size -= left;
    while (left > 0 && this.chunks.length) {
      const have = this.chunks[0].length - this.offset;
      if (have > left) {
        this.offset += left;
        return;
      }
      left -= have;
      this.chunks.shift();
      this.offset = 0;
    }
  }

  private copy(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    for (let c = 0; c < this.chunks.length && filled < n; c++) {
      const start = c === 0 ? this.offset : 0;
      const view = this.chunks[c].subarray(start);
      const take = Math.min(view.length, n - filled);
      out.set(view.subarray(0, take), filled);
      filled += take;
    }
    return out;
  }
}

function findAcross(carry: Uint8Array, piece: Uint8Array, needle: Uint8Array, from = 0): number {
  if (!carry.length) return indexOfBytes(piece, needle, from);
  const combined = new Uint8Array(carry.length + piece.length);
  combined.set(carry);
  combined.set(piece, carry.length);
  return indexOfBytes(combined, needle, from);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (haystack.length < from + needle.length) return -1;
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function tailOf(carry: Uint8Array, piece: Uint8Array, n: number): Uint8Array {
  if (n <= 0) return new Uint8Array(0);
  const take = Math.min(n, carry.length + piece.length);
  const out = new Uint8Array(take);
  const fromPiece = Math.min(piece.length, take);
  out.set(piece.subarray(piece.length - fromPiece), take - fromPiece);
  const fromCarry = take - fromPiece;
  if (fromCarry) out.set(carry.subarray(carry.length - fromCarry));
  return out;
}

/**
 * Walks one multipart body. Each file is handed to `onFile` as soon as it ends, before the next
 * part is buffered. The byte cap and the file count fail with 413 as soon as they are crossed,
 * and the overflowing bytes are not kept.
 */
export async function readMultipart(
  request: Request,
  onFile: (file: MultipartFile) => Promise<void>,
  limits: MultipartLimits = { maxBytes: MAX_ATTACHMENT_BYTES, maxFiles: MAX_ATTACHMENTS_PER_MESSAGE },
  onField?: (name: string, value: string) => void,
): Promise<Record<string, string>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  const token = boundaryOf(contentType);
  if (!contentType.toLowerCase().includes("multipart/form-data") || !token)
    throw new HttpError(400, "invalid_attachment", "Multipart uploads need a boundary.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_attachment", "An attachment needs a non-empty body.");
  const dashBoundary = new TextEncoder().encode(`--${token}`);
  const fields: Record<string, string> = {};
  const buf = new ByteBuf();
  let fileCount = 0;

  const fill = async (need: number) => {
    while (buf.size < need) {
      const { done, value } = await reader.read();
      if (done) return false;
      buf.push(value);
    }
    return true;
  };
  const readUntil = async (needle: Uint8Array, cap: number): Promise<Uint8Array | null> => {
    let scanned = 0;
    for (;;) {
      // Recheck only the overlap with the previous chunk, not the bytes already scanned.
      const from = scanned > needle.length ? scanned - (needle.length - 1) : 0;
      const at = buf.indexOf(needle, from);
      if (at >= 0) {
        if (at > cap) return null;
        const body = buf.take(at);
        buf.drop(needle.length);
        return body;
      }
      if (buf.size > cap + needle.length) return null;
      scanned = buf.size;
      const { done, value } = await reader.read();
      if (done) throw new HttpError(400, "invalid_attachment", "The multipart body ended early.");
      buf.push(value);
    }
  };

  try {
    const opened = await readUntil(dashBoundary, FIELD_MAX);
    if (opened === null) throw new HttpError(400, "invalid_attachment", "Multipart boundary is missing.");
    for (;;) {
      if (!(await fill(2))) throw new HttpError(400, "invalid_attachment", "The multipart body ended early.");
      const marker = buf.peek(2);
      if (marker[0] === 45 && marker[1] === 45) break;
      if (marker[0] !== 13 || marker[1] !== 10)
        throw new HttpError(400, "invalid_attachment", "A multipart part is malformed.");
      buf.drop(2);
      const headerBytes = await readUntil(new TextEncoder().encode("\r\n\r\n"), FIELD_MAX);
      if (!headerBytes)
        throw new HttpError(400, "invalid_attachment", "A multipart part header is too large.");
      const headerText = new TextDecoder().decode(headerBytes);
      const disposition = /content-disposition:[ \t]*([^\r\n]*)/i.exec(headerText)?.[1] ?? "";
      const fieldName = /name="([^"]*)"/.exec(disposition)?.[1] ?? "";
      const filename = fileNameOf(disposition);
      const crlfBoundary = new Uint8Array(2 + dashBoundary.length);
      crlfBoundary.set([13, 10]);
      crlfBoundary.set(dashBoundary, 2);
      if (filename) {
        fileCount += 1;
        if (fileCount > limits.maxFiles) {
          await reader.cancel();
          throw tooMany(limits.maxFiles);
        }
        const body = await readUntil(crlfBoundary, limits.maxBytes);
        if (!body) {
          await reader.cancel();
          throw tooLarge(limits.maxBytes);
        }
        if (!body.length)
          throw new HttpError(400, "invalid_attachment", "An attachment needs a non-empty body.");
        await onFile({ name: filename, bytes: body });
      } else {
        const body = await readUntil(crlfBoundary, FIELD_MAX);
        if (!body) throw new HttpError(400, "invalid_attachment", "A multipart field is too large.");
        if (fieldName) {
          const value = new TextDecoder().decode(body);
          fields[fieldName] = value;
          onField?.(fieldName, value);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return fields;
}

export function isMultipart(request: Request): boolean {
  return (request.headers.get("Content-Type") ?? "").toLowerCase().includes("multipart/form-data");
}
