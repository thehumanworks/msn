import { describe, expect, it } from "vitest";
import {
  fileNameOf,
  hex,
  hmacSha256,
  imageSize,
  previewValid,
  readCapped,
  readMultipart,
  sha256Bytes,
  signPreview,
  sniffedType,
  stripMetadata,
} from "../src/attachment-bytes";
import { HttpError } from "../src/http";

const text = (value: string) => new TextEncoder().encode(value);

describe("attachment bytes", () => {
  it("hashes the empty string the way SHA-256 defines", () => {
    expect(hex(sha256Bytes(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("signs with HMAC-SHA256", () => {
    const mac = hmacSha256(text("key"), text("The quick brown fox jumps over the lazy dog"));
    expect(hex(mac)).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("sniffs bytes instead of a name", () => {
    expect(sniffedType(text("<script>alert(1)</script>"))).toBe("text/html");
    expect(sniffedType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
    expect(sniffedType(text("plain words"))).toBe("text/plain");
    expect(sniffedType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffedType(new Uint8Array([0, 1, 2, 255]))).toBe("application/octet-stream");
  });

  it("reads a jpeg frame and drops the exif segment", () => {
    const exif = text("Exif\0\0GPSDATA");
    const sof = new Uint8Array([
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00,
    ]);
    const bytes = new Uint8Array(2 + 4 + exif.length + sof.length + 2);
    bytes.set([0xff, 0xd8, 0xff, 0xe1, 0x00, exif.length + 2], 0);
    bytes.set(exif, 6);
    bytes.set(sof, 6 + exif.length);
    bytes.set([0xff, 0xd9], 6 + exif.length + sof.length);
    expect(imageSize(bytes, "image/jpeg")).toEqual({ width: 3, height: 2 });
    const stripped = stripMetadata(bytes, "image/jpeg");
    expect(new TextDecoder().decode(stripped)).not.toContain("Exif");
    expect(new TextDecoder().decode(stripped)).not.toContain("GPSDATA");
    expect(imageSize(stripped, "image/jpeg")).toEqual({ width: 3, height: 2 });
  });

  it("rejects a preview signature that was changed or has expired", () => {
    const secret = text("workspace-key");
    const exp = Date.now() + 60_000;
    const sig = signPreview(secret, `tenant/general/4/0/${exp}`);
    expect(previewValid(secret, "tenant", "general", 4, 0, String(exp), sig)).toBe(true);
    expect(previewValid(secret, "tenant", "general", 4, 0, String(exp), sig.replace("a", "b"))).toBe(false);
    expect(previewValid(secret, "tenant", "general", 4, 1, String(exp), sig)).toBe(false);
    expect(previewValid(secret, "tenant", "general", 4, 0, String(exp - 120_000), sig, Date.now())).toBe(
      false,
    );
  });

  it("stops reading a body once it passes the cap", async () => {
    const request = new Request("https://msn.test/up", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    await expect(readCapped(request, 4)).rejects.toMatchObject({ status: 413, code: "attachment_too_large" });
    const empty = new Request("https://msn.test/up", { method: "POST", body: "" });
    await expect(readCapped(empty, 4)).rejects.toBeInstanceOf(HttpError);
  });

  it("reads a multipart body one file at a time and stops at the file cap", async () => {
    const body = [
      "--bound",
      'Content-Disposition: form-data; name="username"',
      "",
      "ada",
      "--bound",
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      "Content-Type: image/png",
      "",
      "hello",
      "--bound",
      'Content-Disposition: form-data; name="file"; filename="b.txt"',
      "",
      "second",
      "--bound--",
      "",
    ].join("\r\n");
    const seen: string[] = [];
    const fields = await readMultipart(
      new Request("https://msn.test/up", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=bound" },
        body,
      }),
      async (file) => {
        seen.push(`${file.name}:${new TextDecoder().decode(file.bytes)}`);
      },
      { maxBytes: 10, maxFiles: 2 },
    );
    expect(fields.username).toBe("ada");
    expect(seen).toEqual(["note.txt:hello", "b.txt:second"]);
    expect(fileNameOf("form-data; name=\"file\"; filename*=UTF-8''caf%C3%A9.txt")).toBe("café.txt");

    const overflow = [
      "--bound",
      'Content-Disposition: form-data; name="file"; filename="big.bin"',
      "",
      "0123456789X",
      "--bound--",
      "",
    ].join("\r\n");
    await expect(
      readMultipart(
        new Request("https://msn.test/up", {
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=bound" },
          body: overflow,
        }),
        async () => {},
        { maxBytes: 4, maxFiles: 2 },
      ),
    ).rejects.toMatchObject({ status: 413, code: "attachment_too_large" });

    const many = ["one", "two", "three"]
      .map(
        (name) =>
          `--bound\r\nContent-Disposition: form-data; name="file"; filename="${name}.txt"\r\n\r\n${name}\r\n`,
      )
      .join("");
    await expect(
      readMultipart(
        new Request("https://msn.test/up", {
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=bound" },
          body: `${many}--bound--\r\n`,
        }),
        async () => {},
        { maxBytes: 10, maxFiles: 2 },
      ),
    ).rejects.toMatchObject({ status: 413, code: "too_many_attachments" });
  });
});
