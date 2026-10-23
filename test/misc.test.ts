import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { intakeResponseSchema } from "../src/domain/contract";
import { createRateLimiter } from "../src/domain/rate-limit";
import { loadConfig } from "../src/server/config";
import { startBrowserReporter, type ReporterEnvironment } from "../src/client";
import { PACKAGE_VERSION } from "../src/version";
import vectors from "./fixtures/client-intake-test-vectors.json";

describe("package", () => {
  it("keeps PACKAGE_VERSION equal to package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("parses the shared sample responses with the contract schema", () => {
    for (const sample of Object.values(vectors.sample_responses)) {
      expect(intakeResponseSchema.safeParse(sample).success).toBe(true);
    }
  });
});

describe("loadConfig", () => {
  const base = {
    DENNIEOS_INTAKE_SECRET: "a".repeat(64),
    SUPABASE_SERVICE_ROLE_KEY: "key",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  };

  it("reads defaults and the previous secret", () => {
    const config = loadConfig({ ...base, DENNIEOS_INTAKE_SECRET_PREVIOUS: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "abc" });
    expect(config.intakeSecrets).toHaveLength(2);
    expect(config.retentionDays).toBe(30);
    expect(config.browserSampleRate).toBe(1);
    expect(config.release).toBe("abc");
  });

  it("names the missing variables without printing values", () => {
    expect(() => loadConfig({ SUPABASE_SERVICE_ROLE_KEY: "key" })).toThrow(/DENNIEOS_INTAKE_SECRET/u);
    expect(() => loadConfig({ ...base, DENNIEOS_INTAKE_SECRET: "short" })).toThrow(/DENNIEOS_INTAKE_SECRET/u);
  });
});

describe("rate limiter", () => {
  it("allows the limit, then waits for the window", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.check("b").allowed).toBe(true);
    now = 1000;
    expect(limiter.check("a").allowed).toBe(true);
  });
});

describe("browser reporter", () => {
  function fakeEnvironment() {
    const listeners = new Map<string, (event: never) => void>();
    const requests: { url: string; body: string }[] = [];
    const environment: ReporterEnvironment = {
      addEventListener: (type, listener) => void listeners.set(type, listener),
      location: { href: "https://shop.example/betalen/1?x=1" },
      fetch: async (url, init) => void requests.push({ url, body: String(init.body) }),
    };
    return { environment, listeners, requests };
  }

  it("posts errors once, caps reports and can be stopped", async () => {
    const { environment, listeners, requests } = fakeEnvironment();
    const stop = startBrowserReporter({ maxReports: 2 }, environment);
    const fire = (type: string, event: object) => (listeners.get(type) as unknown as (e: object) => void)(event);
    fire("error", { error: new TypeError("a") });
    fire("error", { error: new TypeError("a") });
    fire("unhandledrejection", { reason: new Error("b") });
    fire("error", { error: new Error("c") });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("/dennieos/browser-errors");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ type: "error", name: "TypeError", message: "a" });
    stop();
  });

  it("does nothing without a window", () => {
    expect(() => startBrowserReporter({}, null)()).not.toThrow();
  });
});
