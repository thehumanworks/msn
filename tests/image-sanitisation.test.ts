import { describe, expect, it } from "vitest";
import { sanitiseImage } from "../src/image-sanitisation";
import {
  ANIMATED_WEBP,
  APNG,
  exif,
  GIF,
  JPEG,
  join,
  jpegSegment,
  maxSizePng,
  PNG,
  pngChunk,
  privateJpeg,
  privatePng,
  privateWebp,
  riff,
  riffChunk,
  text,
  WEBP,
} from "./fixtures/image-sanitisation";

const clean = (bytes: Uint8Array, mime: string) => sanitiseImage(bytes, `image/${mime}`);
const readable = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const invalid = (bytes: Uint8Array, mime: string) => {
  expect(() => clean(bytes, mime)).toThrow(expect.objectContaining({ status: 400, code: "invalid_attachment" }));
};

describe("image sanitisation", () => {
  it("keeps clean compressed frames and animation byte-for-byte", () => {
    for (const [bytes, mime] of [
      [JPEG, "jpeg"],
      [PNG, "png"],
      [WEBP, "webp"],
      [GIF, "gif"],
      [ANIMATED_WEBP, "webp"],
      [APNG, "png"],
    ] as const) {
      const result = clean(bytes, mime);
      expect(result.size).toEqual({ width: 8, height: 6 });
      expect(result.bytes).toBe(bytes);
    }
  });

  it("retains only canonical orientation, in both TIFF byte orders, for all eight values", () => {
    for (let orientation = 1; orientation <= 8; orientation++) {
      for (const [input, other, mime] of [
        [privateJpeg(orientation), privateJpeg(orientation, "other-camera", false), "jpeg"],
        [privatePng(orientation), privatePng(orientation, "other-camera"), "png"],
        [privateWebp(orientation), privateWebp(orientation, "other-camera"), "webp"],
      ] as const) {
        const result = clean(input, mime);
        expect(result.size).toEqual(orientation >= 5 ? { width: 6, height: 8 } : { width: 8, height: 6 });
        expect(readable(result.bytes)).not.toContain("private-camera-location");
        expect(result.bytes).toEqual(clean(other, mime).bytes);
        expect(clean(result.bytes, mime).bytes).toBe(result.bytes);
        const tag = Uint8Array.of(73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0);
        const at = result.bytes.findIndex((_, i) => tag.every((v, j) => result.bytes[i + j] === v));
        expect(at !== -1).toBe(orientation !== 1);
        if (mime === "webp") {
          expect(result.bytes[20]).toBe(orientation === 1 ? 0 : 8);
          expect(new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(4, true)).toBe(result.bytes.length - 8);
        }
      }
    }
  });

  it("removes JPEG comments between progressive scans and data after EOI", () => {
    // A progressive fixture contains multiple SOS markers. Insert before a later SOS,
    // after the first entropy-coded scan, rather than testing only the header.
    const first = JPEG.findIndex((v, i) => v === 255 && JPEG[i + 1] === 0xda);
    const later = JPEG.findIndex((v, i) => i > first && v === 255 && JPEG[i + 1] === 0xda);
    expect(later).toBeGreaterThan(first);
    const dirty = join(JPEG.subarray(0, later), jpegSegment(0xfe, text("secret")), JPEG.subarray(later), text("secret"));
    expect(clean(dirty, "jpeg").bytes).toEqual(JPEG);
    expect(clean(join(JPEG, text("secret")), "jpeg").bytes).toEqual(JPEG);
  });

  it("removes PNG text, unknown ancillary chunks and trailing bytes without changing image data", () => {
    expect(clean(privatePng(1), "png").bytes).toEqual(PNG);
    const dirty = join(APNG.subarray(0, 33), pngChunk("tEXt", text("Comment\0secret")), APNG.subarray(33));
    expect(clean(dirty, "png").bytes).toEqual(APNG);
    invalid(join(PNG.subarray(0, 33), pngChunk("ABCD", text("secret")), PNG.subarray(33)), "png");
  });

  it("removes WebP metadata and canonicalises nested unknown chunks and padding", () => {
    const input = privateWebp(6);
    const result = clean(input, "webp").bytes;
    expect(readable(result)).not.toMatch(/ICCP|XMP |JUNK/);
    expect(readable(result)).toContain("EXIF");
    // Insert an unknown chunk inside the first ANMF. Its bytes and pad must disappear.
    const animated = ANIMATED_WEBP;
    const start = 44; // RIFF(12), VP8X(18), ANIM(14)
    const view = new DataView(animated.buffer, animated.byteOffset);
    const end = start + 8 + view.getUint32(start + 4, true);
    const unknown = riffChunk("JUNK", text("secret!"));
    unknown[unknown.length - 1] = 0x42;
    const frame = riffChunk("ANMF", join(animated.subarray(start + 8, end), unknown));
    expect(clean(riff(animated.subarray(12, start), frame, animated.subarray(end)), "webp").bytes).toEqual(animated);
    expect(clean(join(WEBP, text("secret")), "webp").bytes).toEqual(WEBP);
  });

  it("removes GIF comments and arbitrary applications without changing loop or frame data", () => {
    const extensions = join(
      Uint8Array.of(0x21, 0xfe, 6), text("secret"), Uint8Array.of(0),
      Uint8Array.of(0x21, 0xff, 11), text("PRIVATE1234"), Uint8Array.of(6), text("secret"), Uint8Array.of(0),
    );
    expect(clean(join(GIF.subarray(0, 25), extensions, GIF.subarray(25), text("secret")), "gif").bytes).toEqual(GIF);
  });

  it("rejects malformed container boundaries and conflicting or invalid orientations", () => {
    for (const [bytes, mime] of [[JPEG, "jpeg"], [PNG, "png"], [WEBP, "webp"], [GIF, "gif"]] as const) {
      invalid(bytes.subarray(0, bytes.length - 1), mime);
    }
    invalid(privateJpeg(9), "jpeg");
    const conflicting = join(
      JPEG.subarray(0, 2),
      jpegSegment(0xe1, join(text("Exif\0\0"), exif(6))),
      jpegSegment(0xe1, join(text("Exif\0\0"), exif(8))),
      JPEG.subarray(2),
    );
    invalid(conflicting, "jpeg");
    const badOffset = exif(6);
    new DataView(badOffset.buffer).setUint32(4, 0xffffffff, true);
    invalid(join(PNG.subarray(0, 33), pngChunk("eXIf", badOffset), PNG.subarray(33)), "png");
    const badCrc = PNG.slice();
    badCrc[badCrc.length - 1] ^= 1;
    invalid(badCrc, "png");
  });

  it("sanitises a genuine exact-25-MiB PNG with bounded buffers", () => {
    const input = maxSizePng();
    const result = clean(input, "png");
    expect(input.length).toBe(25 * 1024 * 1024);
    expect(result.size).toEqual({ width: 4096, height: 2132 });
    expect(result.bytes.length).toBeLessThan(input.length);
    expect(result.bytes.length).toBeGreaterThan(24 * 1024 * 1024);
  }, 60_000);
});
