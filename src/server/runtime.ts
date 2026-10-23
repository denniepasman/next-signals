import { createRateLimiter, type RateLimiter } from "../domain/rate-limit";
import { loadConfig, type SignalsConfig } from "./config";
import { createSupabaseStore, type ErrorStore } from "./store";

const INTAKE_REQUESTS_PER_MINUTE = 60;
const BROWSER_REPORTS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

export interface Runtime {
  readonly config: SignalsConfig;
  readonly store: ErrorStore;
  readonly intakeLimiter: RateLimiter;
  readonly browserLimiter: RateLimiter;
  readonly now: () => Date;
  readonly random: () => number;
  /** Events this instance could not store; added to the heartbeat's `dropped`. */
  readonly counters: { dropped: number; lastWriterOkAt: number };
  readonly warn: (code: string) => void;
}

export type RuntimeOverrides = Partial<Omit<Runtime, "config" | "store">> & {
  config: SignalsConfig;
  store: ErrorStore;
};

export function createRuntime(overrides: RuntimeOverrides): Runtime {
  return {
    intakeLimiter: createRateLimiter({ limit: INTAKE_REQUESTS_PER_MINUTE, windowMs: MINUTE_MS }),
    browserLimiter: createRateLimiter({ limit: BROWSER_REPORTS_PER_MINUTE, windowMs: MINUTE_MS }),
    now: () => new Date(),
    random: Math.random,
    counters: { dropped: 0, lastWriterOkAt: 0 },
    // A stable code only: never a payload, a secret or personal data.
    warn: (code) => console.warn(`[dennieos] ${code}`),
    ...overrides,
  };
}

let shared: Runtime | undefined;

/** The runtime from the environment, built on first use. */
export function getRuntime(): Runtime {
  if (shared === undefined) {
    const config = loadConfig();
    shared = createRuntime({ config, store: createSupabaseStore(config) });
  }
  return shared;
}
