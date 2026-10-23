import { describe, expect, it } from "vitest";
import vectors from "./fixtures/client-intake-test-vectors.json";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { intakeResponseSchema } from "../src/domain/contract";
import { signIntakeRequest } from "../src/domain/signature";
import { createBrowserErrorHandlers, createCronHandlers, createDrainHandlers, createIntakeHandlers } from "../src/routes";
import { createOnRequestError } from "../src/instrumentation";
import { TEST_SECRETS, makeRuntime } from "./helpers/fake-runtime";

const ORIGIN = "https://shop.example";

function signedGet(path: string, nowMs: number, secret = TEST_SECRETS.current, timestampOffset = 0): Request {
  const timestamp = Math.floor(nowMs / 1000) + timestampOffset;
  return new Request(`${ORIGIN}${path}`, {
    headers: {
      "x-dennieos-timestamp": String(timestamp),
      "x-dennieos-signature": signIntakeRequest({ secret, timestamp, method: "GET", pathAndQuery: path }),
      "x-dennieos-source": "src-1",
    },
  });
}

async function seed(ctx: ReturnType<typeof makeRuntime>, count: number) {
  const onRequestError = createOnRequestError({ runtime: () => ctx.runtime });
  for (let index = 0; index < count; index += 1) {
    await onRequestError(
      new Error(`boom ${index}`),
      { path: "/betalen/123?x=1", method: "POST", headers: {} },
      { routePath: "/betalen/[id]" },
    );
  }
  ctx.clock.ms += 60_000; // past the settle window
}

describe("onRequestError", () => {
  it("stores a scrubbed server event", async () => {
    const ctx = makeRuntime();
    const onRequestError = createOnRequestError({ runtime: () => ctx.runtime, getUserId: () => "user-1" });
    await onRequestError(
      new Error("fail for jan@example.com"),
      { path: "/betalen/123?email=a@b.nl", method: "POST", headers: {} },
      { routePath: "/betalen/[id]" },
    );
    const [row] = ctx.store.rows;
    expect(row?.origin).toBe("server");
    expect(JSON.stringify(row?.event)).not.toContain("jan@example.com");
    expect(row?.event.context).toMatchObject({ route: "/betalen/[id]", url_path: "/betalen/:id", status: 500, release: "2026.10.23-1" });
    expect(row?.event.context.user_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("ignores Next control-flow errors and never throws when storage is down", async () => {
    const ctx = makeRuntime();
    const onRequestError = createOnRequestError({ runtime: () => ctx.runtime });
    const redirect = Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT;replace;/x;307" });
    await onRequestError(redirect, { path: "/", method: "GET", headers: {} }, {});
    expect(ctx.store.rows).toHaveLength(0);

    ctx.store.failInserts = true;
    await expect(
      onRequestError(new Error("x"), { path: "/", method: "GET", headers: {} }, {}),
    ).resolves.toBeUndefined();
    expect(ctx.store.state.dropped).toBe(1);
    expect(ctx.warnings).toContain("next_signals.write_failed");
  });
});

describe("intake route", () => {
  it("serves contract v1 pages with a heartbeat", async () => {
    const ctx = makeRuntime();
    await seed(ctx, 3);
    const { GET } = createIntakeHandlers({ runtime: () => ctx.runtime });

    const first = await GET(signedGet("/dennieos/intake/v1/events?limit=2", ctx.clock.ms));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = intakeResponseSchema.parse(await first.json());
    expect(page.events).toHaveLength(2);
    expect(page.next_cursor).toBe("2");
    expect(page.heartbeat.contract_version).toBe("1");

    const second = intakeResponseSchema.parse(
      await (await GET(signedGet(`/dennieos/intake/v1/events?cursor=${page.next_cursor}&limit=2`, ctx.clock.ms))).json(),
    );
    expect(second.events).toHaveLength(1);
    const empty = intakeResponseSchema.parse(
      await (await GET(signedGet(`/dennieos/intake/v1/events?cursor=${second.next_cursor}`, ctx.clock.ms))).json(),
    );
    expect(empty.events).toHaveLength(0);
    expect(empty.next_cursor).toBe(second.next_cursor);
  });

  it("holds back events that are younger than the settle window", async () => {
    const ctx = makeRuntime();
    await seed(ctx, 1);
    const onRequestError = createOnRequestError({ runtime: () => ctx.runtime });
    await onRequestError(new Error("just now"), { path: "/", method: "GET", headers: {} }, {});
    const { GET } = createIntakeHandlers({ runtime: () => ctx.runtime });
    const page = intakeResponseSchema.parse(await (await GET(signedGet("/dennieos/intake/v1/events", ctx.clock.ms))).json());
    expect(page.events).toHaveLength(1);
    ctx.clock.ms += 11_000;
    const later = intakeResponseSchema.parse(await (await GET(signedGet("/dennieos/intake/v1/events", ctx.clock.ms))).json());
    expect(later.events).toHaveLength(2);
  });

  it("accepts the previous secret and refuses wrong, tampered, expired and unsigned requests", async () => {
    const ctx = makeRuntime();
    const { GET } = createIntakeHandlers({ runtime: () => ctx.runtime });
    const path = "/dennieos/intake/v1/events?limit=5";
    expect((await GET(signedGet(path, ctx.clock.ms, TEST_SECRETS.previous))).status).toBe(200);
    expect((await GET(signedGet(path, ctx.clock.ms, "z".repeat(64)))).status).toBe(401);
    expect((await GET(signedGet(path, ctx.clock.ms, TEST_SECRETS.current, -301))).status).toBe(401);
    const tampered = signedGet(path, ctx.clock.ms);
    const response = await GET(new Request(`${ORIGIN}/dennieos/intake/v1/events?limit=6`, { headers: tampered.headers }));
    expect(response.status).toBe(401);
    expect((await GET(new Request(`${ORIGIN}${path}`))).status).toBe(401);
  });

  it("answers 400 for a bad cursor or limit and 410 for a pruned cursor", async () => {
    const ctx = makeRuntime();
    const { GET } = createIntakeHandlers({ runtime: () => ctx.runtime });
    expect((await GET(signedGet("/dennieos/intake/v1/events?cursor=abc", ctx.clock.ms))).status).toBe(400);
    expect((await GET(signedGet("/dennieos/intake/v1/events?limit=501", ctx.clock.ms))).status).toBe(400);
    ctx.store.state = { ...ctx.store.state, prunedThroughSeq: 10 };
    expect((await GET(signedGet("/dennieos/intake/v1/events?cursor=3", ctx.clock.ms))).status).toBe(410);
    expect((await GET(signedGet("/dennieos/intake/v1/events?cursor=10", ctx.clock.ms))).status).toBe(200);
  });

  it("rate limits at 60 requests per minute", async () => {
    const ctx = makeRuntime();
    const { GET } = createIntakeHandlers({ runtime: () => ctx.runtime });
    let last = 200;
    for (let index = 0; index < 61; index += 1) {
      last = (await GET(signedGet("/dennieos/intake/v1/events", ctx.clock.ms))).status;
    }
    expect(last).toBe(429);
  });

  it("verifies the shared log_filter vector as sent", async () => {
    const ctx = makeRuntime({ nowMs: 1792742410 * 1000 });
    const { GET } = createIntakeHandlers({ runtime: () => ctx.runtime });
    const vector = vectors.signed_requests.find((request) => request.name === "with_log_filter")!;
    const response = await GET(
      new Request(`${ORIGIN}${vector.path_and_query}`, {
        headers: {
          "x-dennieos-timestamp": String(vector.timestamp),
          "x-dennieos-signature": vector.expected_signature,
        },
      }),
    );
    // The signature is valid; our numeric cursors do not know the vector's ULID cursor.
    expect(response.status).toBe(400);
  });
});

describe("browser error route", () => {
  const body = JSON.stringify({ type: "error", name: "TypeError", message: "x is undefined for jan@example.com", pageUrl: "https://shop.example/betalen/123?t=1" });
  const post = (headers: Record<string, string>, payload = body) =>
    new Request(`${ORIGIN}/dennieos/browser-errors`, {
      method: "POST",
      headers: { host: "shop.example", "user-agent": "Mozilla/5.0 Chrome/118.0.1 Safari/537.36", "x-forwarded-for": "198.51.100.9", ...headers },
      body: payload,
    });

  it("stores a same-origin report, scrubbed", async () => {
    const ctx = makeRuntime();
    const { POST } = createBrowserErrorHandlers({ runtime: () => ctx.runtime });
    expect((await POST(post({ origin: ORIGIN }))).status).toBe(204);
    const event = ctx.store.rows[0]?.event;
    expect(event?.context).toMatchObject({ browser: "Chrome 118", url_path: "/betalen/:id" });
    expect(JSON.stringify(event)).not.toContain("jan@example.com");
    expect(JSON.stringify(event)).not.toContain("198.51.100.9");
  });

  it("refuses cross-origin and origin-less requests", async () => {
    const ctx = makeRuntime();
    const { POST } = createBrowserErrorHandlers({ runtime: () => ctx.runtime });
    expect((await POST(post({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(post({}))).status).toBe(403);
    expect((await POST(post({ "sec-fetch-site": "same-origin" }))).status).toBe(204);
    expect(ctx.store.rows).toHaveLength(1);
  });

  it("limits size, shape and rate", async () => {
    const ctx = makeRuntime();
    const { POST } = createBrowserErrorHandlers({ runtime: () => ctx.runtime });
    const big = JSON.stringify({ type: "error", message: "x".repeat(20_000) });
    expect((await POST(post({ origin: ORIGIN }, big))).status).toBe(413);
    expect((await POST(post({ origin: ORIGIN }, "{not json"))).status).toBe(400);
    expect((await POST(post({ origin: ORIGIN }, JSON.stringify({ type: "error", message: "m", extra: 1 })))).status).toBe(400);
    let last = 204;
    for (let index = 0; index < 40; index += 1) {
      last = (await POST(post({ origin: ORIGIN }))).status;
    }
    expect(last).toBe(429);
  });

  it("samples: a sampled-out report is accepted but not stored", async () => {
    const ctx = makeRuntime({ config: { browserSampleRate: 0 } });
    const { POST } = createBrowserErrorHandlers({ runtime: () => ctx.runtime });
    expect((await POST(post({ origin: ORIGIN }))).status).toBe(204);
    expect(ctx.store.rows).toHaveLength(0);
  });
});

describe("drain route", () => {
  const ndjson = readFileSync(new URL("./fixtures/log-drain-batch.ndjson", import.meta.url));
  const sign = (secret: string, data: Buffer) => createHmac("sha1", secret).update(data).digest("hex");
  const post = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/dennieos/drain/vercel`, { method: "POST", headers, body: ndjson });

  it("stores kept records once, even when Vercel delivers them twice", async () => {
    const ctx = makeRuntime();
    const { POST } = createDrainHandlers({ runtime: () => ctx.runtime });
    const headers = { "x-vercel-signature": sign("test-drain-secret-not-real", ndjson) };
    expect((await POST(post(headers))).status).toBe(200);
    expect((await POST(post(headers))).status).toBe(200);
    expect(ctx.store.rows).toHaveLength(4);
    expect(ctx.store.rows.every((row) => row.origin === "vercel_drain")).toBe(true);
  });

  it("answers 403 for a bad signature, a missing signature or a missing second secret", async () => {
    const ctx = makeRuntime({ config: { drainHeaderSecret: "second-secret" } });
    const { POST } = createDrainHandlers({ runtime: () => ctx.runtime });
    const good = sign("test-drain-secret-not-real", ndjson);
    expect((await POST(post({ "x-vercel-signature": "0".repeat(40), "x-dennieos-drain": "second-secret" }))).status).toBe(403);
    expect((await POST(post({ "x-dennieos-drain": "second-secret" }))).status).toBe(403);
    expect((await POST(post({ "x-vercel-signature": good }))).status).toBe(403);
    expect((await POST(post({ "x-vercel-signature": good, "x-dennieos-drain": "second-secret" }))).status).toBe(200);
    expect(ctx.store.rows).toHaveLength(4);
  });

  it("still answers 200 when storage is down", async () => {
    const ctx = makeRuntime();
    ctx.store.failInserts = true;
    const { POST } = createDrainHandlers({ runtime: () => ctx.runtime });
    const response = await POST(post({ "x-vercel-signature": sign("test-drain-secret-not-real", ndjson) }));
    expect(response.status).toBe(200);
    expect(ctx.store.state.dropped).toBe(4);
  });
});

describe("cron route", () => {
  it("needs the cron bearer secret and writes the heartbeat", async () => {
    const ctx = makeRuntime();
    const { GET } = createCronHandlers({ runtime: () => ctx.runtime });
    expect((await GET(new Request(`${ORIGIN}/dennieos/cron/heartbeat`))).status).toBe(401);
    expect((await GET(new Request(`${ORIGIN}/dennieos/cron/heartbeat`, { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const ok = await GET(new Request(`${ORIGIN}/dennieos/cron/heartbeat`, { headers: { authorization: "Bearer cron-secret-test" } }));
    expect(ok.status).toBe(200);
    expect(ctx.store.state.schedulerLastRunAt).not.toBeNull();
  });
});
