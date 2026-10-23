import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { contractEventSchema, type ContractEvent } from "../domain/contract";
import type { SignalsConfig } from "./config";

export type EventOrigin = "server" | "browser" | "vercel_drain";

export interface StoredEvent {
  readonly seq: number;
  readonly event: ContractEvent;
}

export interface IntakeState {
  readonly schedulerLastRunAt: string | null;
  readonly writerLastOkAt: string | null;
  readonly dropped: number;
  readonly prunedThroughSeq: number;
}

/** Everything the services need from storage; the Supabase implementation is below. */
export interface ErrorStore {
  insertEvents(events: readonly ContractEvent[], origin: EventOrigin): Promise<void>;
  /** Events with seq > afterSeq that were inserted before `insertedBefore`, ascending. */
  listEvents(afterSeq: number, limit: number, insertedBefore: Date): Promise<StoredEvent[]>;
  readState(): Promise<IntakeState>;
  recordWriterOk(): Promise<void>;
  recordDropped(count: number): Promise<void>;
  /** Writes the scheduler heartbeat and prunes; returns the number of pruned events. */
  runHeartbeat(retentionDays: number): Promise<number>;
}

const rowSchema = z.object({
  seq: z.coerce.number().int(),
  id: z.string(),
  occurred_at: z.string(),
  level: z.string(),
  class: z.string(),
  message: z.string(),
  stack: z.string().nullable(),
  fingerprint_hint: z.string().nullable(),
  context: z.unknown(),
});

const stateSchema = z.object({
  scheduler_last_run_at: z.string().nullable(),
  writer_last_ok_at: z.string().nullable(),
  dropped: z.coerce.number().int(),
  pruned_through_seq: z.coerce.number().int(),
});

const SCHEMA = "dennieos";
const EVENTS_TABLE = "error_events";
const STATE_TABLE = "intake_state";

export function createSupabaseStore(config: SignalsConfig): ErrorStore {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    db: { schema: SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function fail(operation: string, error: { code?: string } | null): never {
    // Only the operation and the PostgREST code: never the payload.
    throw new Error(`dennieos.store.${operation}_failed${error?.code ? ` (${error.code})` : ""}`);
  }

  return {
    async insertEvents(events, origin) {
      if (events.length === 0) {
        return;
      }
      const rows = events.map((event) => ({ ...event, origin }));
      const { error } = await client
        .from(EVENTS_TABLE)
        .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (error) {
        fail("insert", error);
      }
    },

    async listEvents(afterSeq, limit, insertedBefore) {
      const { data, error } = await client
        .from(EVENTS_TABLE)
        .select("seq,id,occurred_at,level,class,message,stack,fingerprint_hint,context")
        .gt("seq", afterSeq)
        .lt("created_at", insertedBefore.toISOString())
        .order("seq", { ascending: true })
        .limit(limit);
      if (error) {
        fail("list", error);
      }
      return (data ?? []).map((row) => {
        const parsed = rowSchema.parse(row);
        return {
          seq: parsed.seq,
          event: contractEventSchema.parse({
            id: parsed.id,
            occurred_at: parsed.occurred_at,
            level: parsed.level,
            class: parsed.class,
            message: parsed.message,
            stack: parsed.stack,
            fingerprint_hint: parsed.fingerprint_hint,
            context: parsed.context,
          }),
        };
      });
    },

    async readState() {
      const { data, error } = await client.from(STATE_TABLE).select("*").eq("id", 1).maybeSingle();
      if (error) {
        fail("read_state", error);
      }
      if (data === null) {
        return { schedulerLastRunAt: null, writerLastOkAt: null, dropped: 0, prunedThroughSeq: 0 };
      }
      const state = stateSchema.parse(data);
      return {
        schedulerLastRunAt: state.scheduler_last_run_at,
        writerLastOkAt: state.writer_last_ok_at,
        dropped: state.dropped,
        prunedThroughSeq: state.pruned_through_seq,
      };
    },

    async recordWriterOk() {
      const { error } = await client.rpc("record_writer_ok");
      if (error) {
        fail("record_writer_ok", error);
      }
    },

    async recordDropped(count) {
      const { error } = await client.rpc("record_dropped", { p_count: count });
      if (error) {
        fail("record_dropped", error);
      }
    },

    async runHeartbeat(retentionDays) {
      const { data, error } = await client.rpc("run_heartbeat", { p_retention_days: retentionDays });
      if (error) {
        fail("run_heartbeat", error);
      }
      return z.coerce.number().int().catch(0).parse(data);
    },
  };
}
