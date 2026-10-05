import { describe, expect, it } from "vitest";
import ip from "ip";

describe("the WebTorrent tracker IP replacement", () => {
  it("preserves the documented IPv4 and IPv6 buffer formatting API", () => {
    expect(ip.toString(Buffer.from([8, 8, 4, 4]))).toBe("8.8.4.4");
    expect(ip.toString(Buffer.from([
      0x20, 0x01, 0x48, 0x60, 0x48, 0x60, 0, 0,
      0, 0, 0, 0, 0, 0, 0x88, 0x88,
    ]))).toBe("2001:4860:4860::8888");
  });

  it("classifies ordinary public and reserved IPv4 and IPv6 addresses", () => {
    expect(ip.isPublic("8.8.8.8")).toBe(true);
    expect(ip.isPrivate("192.168.1.1")).toBe(true);
    expect(ip.isPublic("2001:4860:4860::8888")).toBe(true);
    expect(ip.isPrivate("fd00::1")).toBe(true);
    expect(ip.isLoopback("000:0:0000::01")).toBe(true);
  });

  it("fails closed for the non-canonical addresses in the upstream SSRF advisory", () => {
    for (const address of ["127.1", "012.1.2.3", "01200034567", "0x7f.1"]) {
      expect(() => ip.isPublic(address)).toThrow();
    }
    expect(ip.isPrivate("::fFFf:127.0.0.1")).toBe(true);
  });
});
