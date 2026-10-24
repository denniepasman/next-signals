import { afterEach, describe, expect, it, vi } from "vitest";
import { signIntakeRequest } from "../src/domain/signature";
import { isSignalsActive } from "../src/server/activation";
import { startBrowserReporter } from "../src/client";
import { createOnRequestError, onRequestError } from "../src/instrumentation";
import { createBrowserErrorHandlers, createCronHandlers, createDrainHandlers, createIntakeHandlers } from "../src/routes";
import { TEST_SECRETS } from "./helpers/fake-runtime";

const ORIGIN = "https://shop.example";
const PATH = "/dennieos/intake/v1/events";

function throwingRuntime(): never {
  throw new Error("the runtime must not be built while inactive");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inactive without DENNIEOS_INTAKE_SECRET", () => {
  it("treats a missing, empty or blank secret as inactive", () => {
    expect(isSignalsActive({})).toBe(false);
    expect(isSignalsActive({ DENNIEOS_INTAKE_SECRET: "" })).toBe(false);
    expect(isSignalsActive({ DENNIEOS_INTAKE_SECRET: "   " })).toBe(false);
    expect(isSignalsActive({ DENNIEOS_INTAKE_SECRET: TEST_SECRETS.current })).toBe(true);
  });

  it("answers 404 on every route and never builds the runtime", async () => {
    vi.stubEnv("DENNIEOS_INTAKE_SECRET", "");
    const options = { isActive: () => false, runtime: throwingRuntime };
    const responses = await Promise.all([
      createIntakeHandlers(options).GET(new Request(`${ORIGIN}${PATH}`)),
      createCronHandlers(options).GET(new Request(`${ORIGIN}/dennieos/cron/heartbeat`)),
      createDrainHandlers(options).POST(new Request(`${ORIGIN}/dennieos/drain/vercel`, { method: "POST", body: "{}" })),
      createBrowserErrorHandlers(options).POST(new Request(`${ORIGIN}/dennieos/browser-errors`, { method: "POST", body: "{}" })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
  });

  it("answers 404 with the default wiring when the environment has no secret", async () => {
    vi.stubEnv("DENNIEOS_INTAKE_SECRET", "");
    const response = await createIntakeHandlers().GET(new Request(`${ORIGIN}${PATH}`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("onRequestError does nothing and does not even warn", async () => {
    vi.stubEnv("DENNIEOS_INTAKE_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await onRequestError(new Error("boom"), { path: "/", method: "GET", headers: {} }, {});
    await createOnRequestError({ isActive: () => false, runtime: throwingRuntime })(
      new Error("boom"),
      { path: "/", method: "GET", headers: {} },
      {},
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the browser reporter stops after the first 404", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 404 });
    const listeners: Record<string, (event: never) => void> = {};
    startBrowserReporter({}, {
      addEventListener: (type, listener) => {
        listeners[type] = listener;
      },
      location: { href: "https://shop.example/" },
      fetch,
    });
    (listeners.error as (event: { error: Error }) => void)({ error: new Error("one") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    (listeners.error as (event: { error: Error }) => void)({ error: new Error("two") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("active with DENNIEOS_INTAKE_SECRET", () => {
  it("serves the routes (a bad signature is a 401, not a 404)", async () => {
    vi.stubEnv("DENNIEOS_INTAKE_SECRET", TEST_SECRETS.current);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    const response = await createIntakeHandlers().GET(new Request(`${ORIGIN}${PATH}`));
    expect(response.status).toBe(401);
  });

  it("verifies a valid signature before touching storage", async () => {
    vi.stubEnv("DENNIEOS_INTAKE_SECRET", TEST_SECRETS.current);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signIntakeRequest({ secret: TEST_SECRETS.current, timestamp, method: "GET", pathAndQuery: `${PATH}?limit=0` });
    const response = await createIntakeHandlers().GET(
      new Request(`${ORIGIN}${PATH}?limit=0`, {
        headers: { "x-dennieos-timestamp": String(timestamp), "x-dennieos-signature": signature, "x-dennieos-source": "inactive-test" },
      }),
    );
    expect(response.status).toBe(400); // past the signature check, rejected by query validation
  });
});
