import { describe, expect, it } from "vitest";
import { buildContractEvent, buildFingerprintHint } from "../src/domain/event";
import { contractEventSchema } from "../src/domain/contract";
import { firstAppFrame, normalizeUrlPath, parseBrowser, relativizeStack } from "../src/domain/paths";

describe("normalizeUrlPath", () => {
  it("replaces ids and drops query and hash", () => {
    expect(normalizeUrlPath("https://x.nl/betalen/123?email=a@b.nl#top")).toBe("/betalen/:id");
    expect(normalizeUrlPath("/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301/edit")).toBe("/u/:id/edit");
    expect(normalizeUrlPath("/klant/jan%40example.com")).toBe("/klant/:id");
    expect(normalizeUrlPath("")).toBeNull();
  });
});

describe("parseBrowser", () => {
  it("returns family and major version only", () => {
    expect(
      parseBrowser("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.88 Safari/537.36"),
    ).toBe("Chrome 118");
    expect(parseBrowser("Mozilla/5.0 (Macintosh; rv:119.0) Gecko/20100101 Firefox/119.0")).toBe("Firefox 119");
    expect(parseBrowser("Mozilla/5.0 (iPhone) AppleWebKit/605 Version/17.1 Mobile/15E148 Safari/604.1")).toBe("Safari 17");
    expect(parseBrowser(null)).toBeNull();
  });
});

describe("stacks", () => {
  const stack = [
    "Error: boom",
    "    at handler (/var/task/.next/server/app/api/pay/route.js:1:420)",
    "    at node_modules/next/dist/server.js:5:1",
  ].join("\n");

  it("relativizes paths and finds the first app frame", () => {
    const relative = relativizeStack(stack, "/var/task");
    expect(relative).toContain("(.next/server/app/api/pay/route.js:1:420)");
    expect(firstAppFrame(relative)).toBe("handler@.next/server/app/api/pay/route.js");
  });

  it("gives the same fingerprint when only the line number changes", () => {
    const moved = stack.replace(":1:420", ":9:7");
    expect(buildFingerprintHint("Error", stack)).toBe(buildFingerprintHint("Error", moved));
  });
});

describe("buildContractEvent", () => {
  it("scrubs every free-text field and hashes the user", () => {
    const event = buildContractEvent(
      {
        id: "e1",
        occurredAt: new Date("2026-10-23T08:00:00Z"),
        level: "error",
        className: "Error",
        message: "failed for jan@example.com from 203.0.113.7",
        stack: "Error\n    at f (/var/task/a.js:1:1)\n    at g (https://shop.nl/_next/x.js?token=abc:1:2)",
        route: "/betalen/[id]",
        method: "POST",
        status: 500,
        release: "r1",
        userId: "user-42",
        browser: "Chrome 118",
        urlPath: "/betalen/:id",
      },
      { projectRoot: "/var/task", userHashSalt: "salt" },
    );
    expect(contractEventSchema.safeParse(event).success).toBe(true);
    const text = JSON.stringify(event);
    expect(text).not.toContain("jan@example.com");
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain("user-42");
    expect(text).not.toContain("token=abc");
    expect(event.context.user_hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
