import { describe, expect, it } from "vitest";
import { hashClientUserId, scrubClientContext, scrubClientText } from "../src/domain/scrub";

const scrub = (text: string) => scrubClientText(text, { maxLength: 1000 });

describe("scrubClientText", () => {
  it.each([
    ["jan@example.com failed", "jan@example.com"],
    ["from 203.0.113.7 today", "203.0.113.7"],
    ["iban NL91 ABNA 0417 1643 00 bad", "0417 1643"],
    ["call 06-12345678 now", "12345678"],
    ["bsn 111222333 given", "111222333"],
    ["GET /x?token=abc123&page=2", "abc123"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["cookie: session=abcdef", "abcdef"],
    ['{"password":"hunter2"}', "hunter2"],
  ])("removes personal data or credentials in %s", (input, secret) => {
    expect(scrub(input)).not.toContain(secret);
  });

  it("keeps ids, versions and commits readable", () => {
    const text = "user 3f2504e0-4f89-11d3-9a0c-0305e82c3301 on v1.2.3.4 at 9fceb02d0ae598e95dc970b74767f19372d61af0";
    expect(scrub(text)).toBe(text);
  });

  it("is idempotent and bounded", () => {
    const long = `a@b.nl ${"x ".repeat(2000)}`;
    const once = scrub(long);
    expect(once.length).toBeLessThanOrEqual(1000);
    expect(scrub(once)).toBe(once);
  });
});

describe("scrubClientContext", () => {
  it("redacts sensitive and personal keys, drops disallowed keys", () => {
    const result = scrubClientContext(
      { route: "/x", email: "a@b.nl", apiKey: "k", extra: "no" },
      { allowedKeys: new Set(["route", "email", "apiKey"]) },
    );
    expect(result).toEqual({ route: "/x", email: "[personal]", apiKey: "[redacted]" });
  });

  it("handles circular structures", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(scrubClientContext({ loop })).toEqual({ loop: { self: "[circular]" } });
  });
});

describe("hashClientUserId", () => {
  it("is salted and stable", () => {
    expect(hashClientUserId("42", "salt")).toBe(hashClientUserId("42", "salt"));
    expect(hashClientUserId("42", "salt")).not.toBe(hashClientUserId("42", "other"));
    expect(() => hashClientUserId("42", "")).toThrow();
  });
});
