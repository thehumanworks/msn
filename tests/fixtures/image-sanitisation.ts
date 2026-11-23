// Real 8×6 four-colour images generated with Pillow, including progressive JPEG and
// two-frame GIF, WebP and APNG. Asymmetry makes mirrored/rotated output testable.
const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export const JPEG = decode(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wgARCAAGAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAABCP/aAAwDAQACEAMQAAABjE9n/8QAGBAAAgMAAAAAAAAAAAAAAAAAAAMEBgj/2gAIAQEAAQUCzvDXbj//xAAhEQABAwEJAAAAAAAAAAAAAAABAgMFAAQGERIiMTJxgf/aAAgBAwEBPwF6CiL1uGVl2Q9aHOS1bnLpGPSQB5X/xAAhEQABAwEJAAAAAAAAAAAAAAABAgMFEwAEBgcIERIxkf/aAAgBAgEBPwHUS23h3OOTj40UmUUeKR0N7u0o+kk2/8QAHxAAAAQHAQAAAAAAAAAAAAAAARMUUQACBRESFSEx/9oACAEBAAY/AqxshGROnwI56Y92j//EABkQAAEFAAAAAAAAAAAAAAAAABEAATFhcf/aAAgBAQABPyG7ODFOcK//2gAMAwEAAgADAAAAEAP/xAAYEQEAAwEAAAAAAAAAAAAAAAABABEhMf/aAAgBAwEBPxCjl9Za24Qw+cE//8QAGREAAwADAAAAAAAAAAAAAAAAAREhADFR/9oACAECAQE/EOZx3GrZrLsnP//EABgQAQEAAwAAAAAAAAAAAAAAABEhATHB/9oACAEBAAE/EOe6juiAbysP/9k=",
);
export const PNG = decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAIElEQVR4nGP8z4AAjEgcJgYcAKcEIwMDQv///4wUGAUA4sMFCGHwu0gAAAAASUVORK5CYII=",
);
export const WEBP = decode(
  "UklGRjIAAABXRUJQVlA4TCYAAAAvB0ABAB8gEEjaH3qN+RcQFPk/2vwHXyRAIECYNGnSRkT/Y3eJCA==",
);
export const GIF = decode(
  "R0lGODlhCAAGAIEAAP//AAD/AP8AAAAA/yH/C05FVFNDQVBFMi4wAwECAAAh+QQACgAAACwAAAAACAAGAAAIHgAFCBQQoGCAgQQNIjQYYIDDAQAiAngIUSJFiQACAgAh+QQBFAAEACwAAAAACAAGAIH//wAA/wD/AAAAAP8IHgADCAwgoKCAgQQNIjQoAIBDAAMiDngIUSJFiQMCAgA7",
);
export const ANIMATED_WEBP = decode(
  "UklGRrgAAABXRUJQVlA4WAoAAAACAAAABwAABQAAQU5JTQYAAAAAAAAAAgBBTk1GQgAAAAAAAAAAAAcAAAUAAGQAAAJWUDhMKgAAAC8HQAEAHyAQSN4fOo35FxAU+T/a/EdODkBB2zZMSJZkSZ6NRET/w3pCCEFOTUZCAAAAAAAAAAAABwAABQAAyAAAAFZQOEwqAAAALwdAAQAfIBBI3h86jfkXEBT5P9r8R04OQEHbNkxIlmRJno1ERP9D/hAC",
);
export const APNG = decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAACGFjVEwAAAACAAAAAh2D8lwAAAAaZmNUTAAAAAAAAAAIAAAABgAAAAAAAAAAAAEACgAAHz2iFwAAACBJREFUeJxj/M+AAIxIHCYGHACnBCMDA0L///+MFBgFAOLDBQhh8LtIAAAAGmZjVEwAAAABAAAACAAAAAYAAAAAAAAAAAABAAUAAI8SD/4AAAAlZmRBVAAAAAJ4nGNk+M8AB/8ZEWwmBhwApwQLkkkMjEjmkm4UAKbiBAyyejiQAAAAAElFTkSuQmCC",
);

export const text = (value: string) => new TextEncoder().encode(value);
export function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function exif(orientation: number, secret = "private-camera-location", little = true): Uint8Array {
  const description = text(`${secret}\0`);
  const bytes = new Uint8Array(38 + description.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 2, little);
  view.setUint16(10, 0x0112, little);
  view.setUint16(12, 3, little);
  view.setUint32(14, 1, little);
  view.setUint16(18, orientation, little);
  view.setUint16(22, 0x010e, little);
  view.setUint16(24, 2, little);
  view.setUint32(26, description.length, little);
  view.setUint32(30, 38, little);
  bytes.set(description, 38);
  return bytes;
}

export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const n = payload.length + 2;
  return join(Uint8Array.of(255, marker, n >> 8, n & 255), payload);
}

export function privateJpeg(
  orientation: number,
  secret = "private-camera-location",
  little = true,
): Uint8Array {
  return join(
    JPEG.subarray(0, 2),
    jpegSegment(0xe1, join(text("Exif\0\0"), exif(orientation, secret, little))),
    jpegSegment(0xe1, text(`http://ns.adobe.com/xmp/extension/\0${secret}`)),
    jpegSegment(0xed, text(`Photoshop 3.0\0${secret}`)),
    jpegSegment(0xfe, text(secret)),
    JPEG.subarray(2),
  );
}

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(payload.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.length);
  bytes.set(text(type), 4);
  bytes.set(payload, 8);
  view.setUint32(bytes.length - 4, crc32(bytes, 4, bytes.length - 4));
  return bytes;
}

export function privatePng(orientation: number, secret = "private-camera-location"): Uint8Array {
  return join(
    PNG.subarray(0, 33),
    pngChunk("eXIf", exif(orientation, secret)),
    pngChunk("tEXt", text(`Comment\0${secret}`)),
    pngChunk("iTXt", text(`Description\0\0\0\0\0${secret}`)),
    pngChunk("zTXt", text(`Description\0\0${secret}`)),
    pngChunk("vpAg", text(secret)),
    PNG.subarray(33),
    text(secret),
  );
}

export function riffChunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length + (payload.length & 1));
  bytes.set(text(type));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

export function riff(...chunks: Uint8Array[]): Uint8Array {
  const bytes = join(text("RIFF"), new Uint8Array(4), text("WEBP"), ...chunks);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
}

export function privateWebp(orientation: number, secret = "private-camera-location"): Uint8Array {
  return riff(
    riffChunk("VP8X", Uint8Array.of(0x2c, 0, 0, 0, 7, 0, 0, 5, 0, 0)),
    riffChunk("ICCP", text(secret)),
    WEBP.subarray(12),
    riffChunk("EXIF", exif(orientation, secret)),
    riffChunk("XMP ", text(secret)),
    riffChunk("JUNK", text(secret)),
  );
}

// A genuine 4096×2132 RGB PNG with uncompressed DEFLATE blocks. Generate directly
// in one exact-cap buffer so the test itself doesn't need multiple 25 MiB allocations.
export function maxSizePng(): Uint8Array {
  const bytes = new Uint8Array(25 * 1024 * 1024);
  const view = new DataView(bytes.buffer);
  const width = 4096;
  const height = 2132;
  const pixels = (width * 3 + 1) * height;
  const blocks = Math.ceil(pixels / 65535);
  const compressed = 2 + blocks * 5 + pixels + 4;
  const header = new Uint8Array(13);
  const ihdr = new DataView(header.buffer);
  ihdr.setUint32(0, width);
  ihdr.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  bytes.set(PNG.subarray(0, 8));
  bytes.set(pngChunk("IHDR", header), 8);
  let at = 33;
  const padding = bytes.length - 33 - (12 + compressed) - 12 - 12;
  view.setUint32(at, padding);
  bytes.set(text("vpAg"), at + 4);
  view.setUint32(at + 8 + padding, crc32(bytes, at + 4, at + 8 + padding));
  at += 12 + padding;
  view.setUint32(at, compressed);
  bytes.set(text("IDAT"), at + 4);
  const start = at + 8;
  let p = start;
  bytes.set([0x78, 0x01], p);
  p += 2;
  for (let left = pixels; left > 0; ) {
    const n = Math.min(left, 65535);
    bytes[p] = n === left ? 1 : 0;
    view.setUint16(p + 1, n, true);
    view.setUint16(p + 3, ~n & 0xffff, true);
    p += 5 + n;
    left -= n;
  }
  // Adler-32 of a sequence of zero bytes.
  view.setUint32(p, ((pixels % 65521) << 16) | 1);
  p += 4;
  view.setUint32(p, crc32(bytes, at + 4, p));
  bytes.set(pngChunk("IEND", new Uint8Array()), p + 4);
  return bytes;
}
