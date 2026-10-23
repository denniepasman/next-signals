import { createRuntime, type Runtime } from "../../src/server/runtime";
import type { SignalsConfig } from "../../src/server/config";
import type { ContractEvent } from "../../src/domain/contract";
import type { ErrorStore, EventOrigin, IntakeState, StoredEvent } from "../../src/server/store";

export const TEST_SECRETS = {
  current: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  previous: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
};

export class FakeStore implements ErrorStore {
  rows: { seq: number; event: ContractEvent; origin: EventOrigin; createdAt: Date }[] = [];
  state: IntakeState = { schedulerLastRunAt: null, writerLastOkAt: null, dropped: 0, prunedThroughSeq: 0 };
  failInserts = false;
  private nextSeq = 1;

  constructor(private readonly now: () => Date) {}

  async insertEvents(events: readonly ContractEvent[], origin: EventOrigin): Promise<void> {
    if (this.failInserts) {
      throw new Error("down");
    }
    for (const event of events) {
      if (this.rows.some((row) => row.event.id === event.id)) {
        continue;
      }
      this.rows.push({ seq: this.nextSeq++, event, origin, createdAt: this.now() });
    }
  }
  async listEvents(afterSeq: number, limit: number, insertedBefore: Date): Promise<StoredEvent[]> {
    return this.rows
      .filter((row) => row.seq > afterSeq && row.createdAt < insertedBefore)
      .slice(0, limit)
      .map((row) => ({ seq: row.seq, event: row.event }));
  }
  async readState(): Promise<IntakeState> {
    return this.state;
  }
  async recordWriterOk(): Promise<void> {
    this.state = { ...this.state, writerLastOkAt: this.now().toISOString() };
  }
  async recordDropped(count: number): Promise<void> {
    this.state = { ...this.state, dropped: this.state.dropped + count };
  }
  async runHeartbeat(): Promise<number> {
    this.state = { ...this.state, schedulerLastRunAt: this.now().toISOString() };
    return 0;
  }
}

export function makeRuntime(options: { nowMs?: number; config?: Partial<SignalsConfig> } = {}) {
  const clock = { ms: options.nowMs ?? Date.UTC(2026, 9, 23, 8, 0, 0) };
  const now = () => new Date(clock.ms);
  const store = new FakeStore(now);
  const config: SignalsConfig = {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-test",
    intakeSecrets: [TEST_SECRETS.current, TEST_SECRETS.previous],
    userHashSalt: "salt-for-tests",
    drainSignatureSecret: "test-drain-secret-not-real",
    drainHeaderSecret: null,
    cronSecret: "cron-secret-test",
    release: "2026.10.23-1",
    retentionDays: 30,
    browserSampleRate: 1,
    projectRoot: "/var/task",
    allowedBrowserOrigins: [],
    ...options.config,
  };
  const warnings: string[] = [];
  const runtime: Runtime = createRuntime({ config, store, now, warn: (code) => warnings.push(code), random: () => 0 });
  return { runtime, store, clock, warnings };
}
