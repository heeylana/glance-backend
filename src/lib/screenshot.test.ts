import { describe, expect, it } from "vitest";
import { parseImageDataUrl, sha256Hex } from "./screenshot.js";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("parseImageDataUrl", () => {
  it("accepts the capture format and returns bytes plus media type", () => {
    const r = parseImageDataUrl(`data:image/png;base64,${PNG_1PX}`);
    expect(r.mediaType).toBe("image/png");
    expect(r.bytes.length).toBeGreaterThan(50);
    expect(r.base64).toBe(PNG_1PX);
  });
  it("rejects anything that is not an image data url", () => {
    expect(() => parseImageDataUrl("https://example.com/a.jpg")).toThrow();
    expect(() => parseImageDataUrl("data:text/html;base64,PGh0bWw+")).toThrow();
    expect(() => parseImageDataUrl("data:image/jpeg;base64,")).toThrow();
  });
});

describe("sha256Hex", () => {
  it("is stable and hex", () => {
    const h = sha256Hex(Buffer.from("glance"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha256Hex(Buffer.from("glance")));
  });
});
