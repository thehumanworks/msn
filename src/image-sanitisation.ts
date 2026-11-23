import { HttpError } from "./http";

export type ImageSize = { width: number; height: number };
type SanitisedImage = { bytes: Uint8Array; size: ImageSize | null };

function valid(condition: unknown, format: string): asserts condition {
  if (!condition) throw new HttpError(400, "invalid_attachment", `This ${format} is malformed or unsupported.`);
}

const ascii = (bytes: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...bytes.subarray(at, at + n));
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const le24 = (bytes: Uint8Array, at: number) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);

// One output allocation, no per-chunk range list or decoded pixel buffers. The small extra
// capacity covers canonical headers. The caller checks the actual stored length against its cap.
class Output {
  readonly data: Uint8Array;
  readonly view: DataView;
  length = 0;

  constructor(input: Uint8Array) {
    this.data = new Uint8Array(input.length + 64);
    this.view = viewOf(this.data);
  }

  write(bytes: Uint8Array): void {
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }

  byte(value: number): void {
    this.data[this.length++] = value;
  }

  insert(at: number, bytes: Uint8Array): void {
    this.data.copyWithin(at + bytes.length, at, this.length);
    this.data.set(bytes, at);
    this.length += bytes.length;
  }

  finish(input: Uint8Array): Uint8Array {
    const result = this.data.subarray(0, this.length);
    return result.length === input.length && result.every((byte, i) => byte === input[i]) ? input : result;
  }
}

function orientationTiff(value: number): Uint8Array {
  return Uint8Array.of(
    73,
    73,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    0x12,
    1,
    3,
    0,
    1,
    0,
    0,
    0,
    value,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
}

// Only IFD0's SHORT orientation is interpreted. No source EXIF bytes are copied, and no
// pointers to thumbnails, GPS, maker notes or further directories are followed.
function readOrientation(payload: Uint8Array): number | null {
  const bytes = ascii(payload, 0, 6) === "Exif\0\0" ? payload.subarray(6) : payload;
  const view = viewOf(bytes);
  valid(bytes.length >= 8, "EXIF");
  const order = view.getUint16(0);
  valid(order === 0x4949 || order === 0x4d4d, "EXIF");
  const little = order === 0x4949;
  valid(view.getUint16(2, little) === 42, "EXIF");
  const offset = view.getUint32(4, little);
  valid(offset >= 8 && offset + 2 <= bytes.length, "EXIF");
  const count = view.getUint16(offset, little);
  valid(offset + 2 + count * 12 + 4 <= bytes.length, "EXIF");
  let orientation: number | null = null;
  for (let i = offset + 2; i < offset + 2 + count * 12; i += 12) {
    if (view.getUint16(i, little) !== 0x0112) continue;
    valid(view.getUint16(i + 2, little) === 3 && view.getUint32(i + 4, little) === 1, "EXIF");
    const value = view.getUint16(i + 8, little);
    valid(value >= 1 && value <= 8 && (orientation === null || orientation === value), "EXIF");
    orientation = value;
  }
  return orientation;
}

function combineOrientation(previous: number | null, payload: Uint8Array): number | null {
  const next = readOrientation(payload);
  valid(previous === null || next === null || previous === next, "EXIF");
  return next ?? previous;
}

function displaySize(size: ImageSize, orientation: number | null): ImageSize {
  return orientation !== null && orientation >= 5 ? { width: size.height, height: size.width } : size;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.length + 4);
  result.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]);
  result.set(payload, 4);
  return result;
}

function jpeg(bytes: Uint8Array): SanitisedImage {
  valid(bytes[0] === 0xff && bytes[1] === 0xd8, "JPEG");
  const output = new Output(bytes);
  output.write(bytes.subarray(0, 2));
  let at = 2;
  let size: ImageSize | null = null;
  let orientation: number | null = null;
  let sawScan = false;
  let jfif = false;
  let adobe: number | null = null;
  while (at < bytes.length) {
    valid(bytes[at++] === 0xff, "JPEG");
    while (bytes[at] === 0xff) at++;
    valid(at < bytes.length, "JPEG");
    const marker = bytes[at++];
    if (marker === 0xd9) {
      valid(size && sawScan, "JPEG");
      output.write(Uint8Array.of(0xff, 0xd9));
      // JFIF and Adobe headers carry only canonical colour interpretation fields, never
      // embedded thumbnails, source density, versions or arbitrary application data.
      let insertAt = 2;
      if (jfif) {
        const segment = jpegSegment(0xe0, Uint8Array.of(74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0));
        output.insert(insertAt, segment);
        insertAt += segment.length;
      }
      if (orientation !== null && orientation !== 1) {
        const payload = new Uint8Array(32);
        payload.set([69, 120, 105, 102, 0, 0]);
        payload.set(orientationTiff(orientation), 6);
        const segment = jpegSegment(0xe1, payload);
        output.insert(insertAt, segment);
        insertAt += segment.length;
      }
      if (adobe !== null) {
        output.insert(
          insertAt,
          jpegSegment(0xee, Uint8Array.of(65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, adobe)),
        );
      }
      return { bytes: output.finish(bytes), size: displaySize(size, orientation) };
    }
    valid(at + 2 <= bytes.length, "JPEG");
    const length = (bytes[at] << 8) | bytes[at + 1];
    const end = at + length;
    valid(length >= 2 && end <= bytes.length, "JPEG");
    const payload = bytes.subarray(at + 2, end);
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe1 && ascii(payload, 0, 6) === "Exif\0\0") {
        orientation = combineOrientation(orientation, payload);
      } else if (marker === 0xe0 && ascii(payload, 0, 5) === "JFIF\0") {
        valid(payload.length >= 14, "JPEG");
        jfif = true;
      } else if (marker === 0xee && ascii(payload, 0, 5) === "Adobe") {
        valid(payload.length >= 12 && payload[11] <= 2 && (adobe === null || adobe === payload[11]), "JPEG");
        adobe = payload[11];
      }
    } else if (marker !== 0xfe) {
      // Ordinary sequential/progressive JPEG plus lossless/arithmetic frame markers.
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      valid(sof || [0xc4, 0xcc, 0xda, 0xdb, 0xdd].includes(marker), "JPEG");
      if (sof) {
        valid(
          !size && payload.length >= 6 && payload[5] > 0 && payload.length === 6 + 3 * payload[5],
          "JPEG",
        );
        size = { width: (payload[3] << 8) | payload[4], height: (payload[1] << 8) | payload[2] };
        valid(size.width > 0 && size.height > 0, "JPEG");
      }
      if (marker === 0xda) {
        valid(size && payload.length >= 6 && payload[0] > 0 && payload.length === 4 + 2 * payload[0], "JPEG");
        sawScan = true;
      }
      output.write(Uint8Array.of(0xff, marker));
      output.write(bytes.subarray(at, end));
    }
    at = end;
    if (marker !== 0xda) continue;
    // Scan entropy data without decoding it. FF00 is a stuffed data byte; restart
    // markers belong to the scan. All other markers return to the container parser.
    const scanStart = at;
    for (;;) {
      const ff = bytes.indexOf(0xff, at);
      valid(ff !== -1, "JPEG");
      at = ff + 1;
      while (bytes[at] === 0xff) at++;
      valid(at < bytes.length, "JPEG");
      const next = bytes[at];
      if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
        at++;
        continue;
      }
      output.write(bytes.subarray(scanStart, ff));
      at = ff;
      break;
    }
  }
  throw new HttpError(400, "invalid_attachment", "This JPEG has no end marker.");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngExif(orientation: number): Uint8Array {
  const chunk = new Uint8Array(38);
  const view = viewOf(chunk);
  view.setUint32(0, 26);
  chunk.set([101, 88, 73, 102], 4);
  chunk.set(orientationTiff(orientation), 8);
  view.setUint32(34, crc32(chunk, 4, 34));
  return chunk;
}

function png(bytes: Uint8Array): SanitisedImage {
  valid(bytes.length >= 33, "PNG");
  const view = viewOf(bytes);
  const output = new Output(bytes);
  output.write(bytes.subarray(0, 8));
  let size: ImageSize | null = null;
  let orientation: number | null = null;
  let colour = -1;
  let depth = 0;
  let palette = 0;
  let firstData = -1;
  let dataEnded = false;
  let frames = 0;
  let frameControls = 0;
  let sequence = 0;
  let at = 8;
  const seen = new Set<string>();
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    const p = at + 8;
    const end = p + length;
    valid(end + 4 <= bytes.length && /^[A-Za-z]{4}$/.test(type), "PNG");
    valid(view.getUint32(end) === crc32(bytes, at + 4, end), "PNG");
    valid(size || type === "IHDR", "PNG");
    let keep = true;
    if (firstData !== -1 && type !== "IDAT") dataEnded = true;
    switch (type) {
      case "IHDR": {
        valid(!size && length === 13 && at === 8, "PNG");
        size = { width: view.getUint32(p), height: view.getUint32(p + 4) };
        depth = bytes[p + 8];
        colour = bytes[p + 9];
        const depths: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        valid(
          size.width > 0 && size.height > 0 && size.width <= 0x7fffffff && size.height <= 0x7fffffff,
          "PNG",
        );
        valid(
          depths[colour]?.includes(depth) && bytes[p + 10] === 0 && bytes[p + 11] === 0 && bytes[p + 12] <= 1,
          "PNG",
        );
        break;
      }
      case "PLTE":
        valid(
          !palette &&
            firstData === -1 &&
            length > 0 &&
            length <= 768 &&
            length % 3 === 0 &&
            colour !== 0 &&
            colour !== 4,
          "PNG",
        );
        palette = length / 3;
        valid(colour !== 3 || palette <= 2 ** depth, "PNG");
        break;
      case "IDAT":
        valid(!dataEnded && (colour !== 3 || palette > 0), "PNG");
        if (firstData === -1) firstData = output.length;
        break;
      case "IEND":
        valid(size && length === 0 && firstData !== -1 && frameControls === frames, "PNG");
        output.write(bytes.subarray(at, end + 4));
        if (orientation !== null && orientation !== 1) output.insert(firstData, pngExif(orientation));
        return { bytes: output.finish(bytes), size: displaySize(size, orientation) };
      case "eXIf":
        orientation = combineOrientation(orientation, bytes.subarray(p, end));
        keep = false;
        break;
      case "tRNS":
        valid(
          firstData === -1 &&
            ((colour === 0 && length === 2) ||
              (colour === 2 && length === 6) ||
              (colour === 3 && length > 0 && length <= palette)),
          "PNG",
        );
        break;
      case "cHRM":
      case "gAMA":
      case "sRGB":
      case "cICP":
      case "sBIT":
      case "bKGD":
      case "pHYs": {
        const lengths: Record<string, number> = {
          cHRM: 32,
          gAMA: 4,
          sRGB: 1,
          cICP: 4,
          sBIT: [1, 0, 3, 3, 2, 0, 4][colour],
          bKGD: [2, 0, 6, 1, 2, 0, 6][colour],
          pHYs: 9,
        };
        valid(firstData === -1 && length === lengths[type], "PNG");
        break;
      }
      case "acTL":
        valid(length === 8 && firstData === -1 && frames === 0, "PNG");
        frames = view.getUint32(p);
        valid(frames > 0, "PNG");
        break;
      case "fcTL": {
        valid(size && frames > 0 && length === 26 && view.getUint32(p) === sequence++, "PNG");
        const width = view.getUint32(p + 4);
        const height = view.getUint32(p + 8);
        valid(
          width > 0 &&
            height > 0 &&
            view.getUint32(p + 12) + width <= size.width &&
            view.getUint32(p + 16) + height <= size.height,
          "PNG",
        );
        valid(bytes[p + 24] <= 2 && bytes[p + 25] <= 1 && ++frameControls <= frames, "PNG");
        break;
      }
      case "fdAT":
        valid(
          frames > 0 &&
            frameControls > 0 &&
            firstData !== -1 &&
            length >= 4 &&
            view.getUint32(p) === sequence++,
          "PNG",
        );
        break;
      default:
        // Unknown critical chunks cannot safely be removed; ancillary data is not trusted.
        valid(type.charCodeAt(0) >= 97, "PNG");
        keep = false;
    }
    if (keep) {
      if (type !== "IDAT" && type !== "fcTL" && type !== "fdAT") {
        valid(!seen.has(type), "PNG");
        seen.add(type);
      }
      output.write(bytes.subarray(at, end + 4));
    }
    at = end + 4;
  }
  throw new HttpError(400, "invalid_attachment", "This PNG has no end chunk.");
}

function riffChunk(output: Output, type: string, payload: Uint8Array): void {
  output.write(Uint8Array.from(type, (c) => c.charCodeAt(0)));
  const at = output.length;
  output.write(new Uint8Array(4));
  output.view.setUint32(at, payload.length, true);
  output.write(payload);
  if (payload.length & 1) output.byte(0);
}

function webpFrame(type: string, payload: Uint8Array): { size: ImageSize; alpha: boolean } {
  if (type === "VP8L") {
    valid(payload.length >= 5 && payload[0] === 0x2f, "WebP");
    const bits = viewOf(payload).getUint32(1, true);
    valid(bits >>> 29 === 0, "WebP");
    return {
      size: { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 },
      alpha: Boolean(bits & 0x10000000),
    };
  }
  valid(payload.length >= 10 && (payload[0] & 1) === 0 && payload[3] === 0x9d && payload[4] === 1 && payload[5] === 0x2a, "WebP");
  const view = viewOf(payload);
  const size = { width: view.getUint16(6, true) & 0x3fff, height: view.getUint16(8, true) & 0x3fff };
  valid(size.width > 0 && size.height > 0, "WebP");
  return { size, alpha: false };
}

function sameSize(a: ImageSize, b: ImageSize): boolean {
  return a.width === b.width && a.height === b.height;
}

function webp(bytes: Uint8Array): SanitisedImage {
  valid(bytes.length >= 12, "WebP");
  const view = viewOf(bytes);
  const limit = view.getUint32(4, true) + 8;
  valid(limit >= 12 && limit <= bytes.length && limit % 2 === 0, "WebP");
  const output = new Output(bytes);
  output.write(bytes.subarray(0, 12));
  let canvas: ImageSize | null = null;
  let frame: ImageSize | null = null;
  let orientation: number | null = null;
  let alpha = false;
  let alphaChunk = false;
  let animated = false;
  let frames = 0;
  let extendedAt = -1;
  let at = 12;
  while (at + 8 <= limit) {
    const type = ascii(bytes, at, 4);
    const length = view.getUint32(at + 4, true);
    const p = at + 8;
    const end = p + length;
    valid(end + (length & 1) <= limit, "WebP");
    const payload = bytes.subarray(p, end);
    switch (type) {
      case "VP8X":
        valid(at === 12 && length === 10, "WebP");
        canvas = { width: le24(payload, 4) + 1, height: le24(payload, 7) + 1 };
        valid(canvas.width * canvas.height <= 0xffffffff, "WebP");
        extendedAt = output.length + 8;
        riffChunk(output, type, payload);
        output.data.fill(0, extendedAt, extendedAt + 4);
        break;
      case "EXIF":
        valid(canvas, "WebP");
        orientation = combineOrientation(orientation, payload);
        break;
      case "ALPH":
        valid(canvas && !animated && !frame && !alphaChunk && length > 1 && (payload[0] & 0xc0) === 0, "WebP");
        alphaChunk = true;
        alpha = true;
        riffChunk(output, type, payload);
        break;
      case "VP8 ":
      case "VP8L": {
        valid(!animated && !frame && !(alphaChunk && type === "VP8L"), "WebP");
        const decoded = webpFrame(type, payload);
        frame = decoded.size;
        valid(!canvas || sameSize(canvas, frame), "WebP");
        alpha ||= decoded.alpha;
        riffChunk(output, type, payload);
        break;
      }
      case "ANIM":
        valid(canvas && !animated && !frame && !alphaChunk && length === 6, "WebP");
        animated = true;
        riffChunk(output, type, payload);
        break;
      case "ANMF": {
        valid(canvas && animated && length >= 16 && (payload[15] & 0xfc) === 0, "WebP");
        const size = { width: le24(payload, 6) + 1, height: le24(payload, 9) + 1 };
        valid(le24(payload, 0) * 2 + size.width <= canvas.width && le24(payload, 3) * 2 + size.height <= canvas.height, "WebP");
        const header = output.length;
        output.write(bytes.subarray(at, p + 16));
        let sub = p + 16;
        let found = false;
        let hasAlpha = false;
        while (sub + 8 <= end) {
          const subType = ascii(bytes, sub, 4);
          const n = view.getUint32(sub + 4, true);
          const next = sub + 8 + n + (n & 1);
          valid(next <= end, "WebP");
          const data = bytes.subarray(sub + 8, sub + 8 + n);
          if (subType === "ALPH") {
            valid(!found && !hasAlpha && n > 1 && (data[0] & 0xc0) === 0, "WebP");
            hasAlpha = true;
            riffChunk(output, subType, data);
          } else if (subType === "VP8 " || subType === "VP8L") {
            valid(!found && !(hasAlpha && subType === "VP8L"), "WebP");
            const decoded = webpFrame(subType, data);
            valid(sameSize(decoded.size, size), "WebP");
            alpha ||= hasAlpha || decoded.alpha;
            found = true;
            riffChunk(output, subType, data);
          }
          sub = next;
        }
        valid(sub === end && found, "WebP");
        output.view.setUint32(header + 4, output.length - header - 8, true);
        frames++;
        break;
      }
      // ICCP, XMP and all unknown chunks are dropped, including their padding.
    }
    at = end + (length & 1);
  }
  valid(at === limit && (animated ? frames > 0 : frame !== null), "WebP");
  const size = canvas ?? frame;
  valid(size, "WebP");
  const oriented = orientation !== null && orientation !== 1;
  if (orientation !== null && orientation !== 1) riffChunk(output, "EXIF", orientationTiff(orientation));
  if (extendedAt !== -1) output.data[extendedAt] = (alpha ? 0x10 : 0) | (oriented ? 8 : 0) | (animated ? 2 : 0);
  output.view.setUint32(4, output.length - 8, true);
  return { bytes: output.finish(bytes), size: displaySize(size, orientation) };
}

// Returns the first byte after a terminated GIF sub-block sequence.
function gifBlocks(bytes: Uint8Array, at: number): number {
  while (at < bytes.length) {
    const count = bytes[at++];
    if (!count) return at;
    valid(at + count <= bytes.length, "GIF");
    at += count;
  }
  throw new HttpError(400, "invalid_attachment", "This GIF has an unterminated block.");
}

function gif(bytes: Uint8Array): SanitisedImage {
  valid(bytes.length >= 13, "GIF");
  const view = viewOf(bytes);
  const size = { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  valid(size.width > 0 && size.height > 0, "GIF");
  const palette = (packed: number) => (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0);
  let at = 13 + palette(bytes[10]);
  valid(at <= bytes.length, "GIF");
  const output = new Output(bytes);
  output.write(bytes.subarray(0, at));
  let frames = 0;
  let loop: number | null = null;
  while (at < bytes.length) {
    const start = at;
    const marker = bytes[at++];
    if (marker === 0x3b) {
      valid(frames > 0, "GIF");
      output.byte(marker);
      return { bytes: output.finish(bytes), size };
    }
    if (marker === 0x2c) {
      valid(at + 9 <= bytes.length, "GIF");
      const width = view.getUint16(at + 4, true);
      const height = view.getUint16(at + 6, true);
      valid(width > 0 && height > 0 && view.getUint16(at, true) + width <= size.width && view.getUint16(at + 2, true) + height <= size.height, "GIF");
      at += 9 + palette(bytes[at + 8]);
      valid(at < bytes.length && bytes[at] >= 2 && bytes[at] <= 8, "GIF");
      at = gifBlocks(bytes, at + 1);
      frames++;
      output.write(bytes.subarray(start, at));
      continue;
    }
    valid(marker === 0x21 && at < bytes.length, "GIF");
    const label = bytes[at++];
    if (label === 0xf9) {
      valid(at + 6 <= bytes.length && bytes[at] === 4 && bytes[at + 5] === 0 && (bytes[at + 1] & 0xe0) === 0, "GIF");
      at += 6;
      output.write(bytes.subarray(start, at));
      continue;
    }
    // Plain text is a rendering block, not a comment. Reject instead of silently
    // changing the displayed animation or retaining arbitrary text.
    valid(label !== 0x01, "GIF");
    const end = gifBlocks(bytes, at);
    if (label === 0xff && bytes[at] === 11) {
      const app = ascii(bytes, at + 1, 11);
      if (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") {
        valid(end === at + 17 && bytes[at + 12] === 3 && bytes[at + 13] === 1, "GIF");
        const count = view.getUint16(at + 14, true);
        valid(loop === null || loop === count, "GIF");
        if (loop === null) {
          loop = count;
          output.write(Uint8Array.of(0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, count & 255, count >> 8, 0));
        }
      }
    }
    at = end;
  }
  throw new HttpError(400, "invalid_attachment", "This GIF has no trailer.");
}

/** Sanitise recognised inline images before hashing or storage; non-images are unchanged.
 * This validates container boundaries, not compressed pixel data. No decoder or encoder runs.
 */
export function sanitiseImage(bytes: Uint8Array, mime: string): SanitisedImage {
  switch (mime) {
    case "image/jpeg":
      return jpeg(bytes);
    case "image/png":
      return png(bytes);
    case "image/webp":
      return webp(bytes);
    case "image/gif":
      return gif(bytes);
    default:
      return { bytes, size: null };
  }
}
