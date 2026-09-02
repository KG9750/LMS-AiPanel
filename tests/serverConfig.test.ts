import { describe, expect, it } from "vitest";
import { resolveServerHost } from "../src/server/config";

describe("server host boundary", () => {
  it("accepts loopback hosts", () => {
    expect(resolveServerHost(undefined)).toBe("127.0.0.1");
    expect(resolveServerHost("::1")).toBe("::1");
  });

  it("rejects non-loopback hosts unless explicitly enabled", () => {
    expect(() => resolveServerHost("0.0.0.0")).toThrow(/loopback/i);
    expect(resolveServerHost("0.0.0.0", "1")).toBe("0.0.0.0");
  });
});
