import type { ContractEvent } from "../../domain/contract";
import type { Runtime } from "../runtime";
import type { EventOrigin } from "../store";

const WRITER_OK_INTERVAL_MS = 60_000;

/**
 * Stores scrubbed events. Never throws: a failing write is counted as dropped and shows up in
 * the heartbeat, so an error reporter cannot break the app it watches.
 */
export async function recordEvents(
  runtime: Runtime,
  events: readonly ContractEvent[],
  origin: EventOrigin,
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  try {
    await runtime.store.insertEvents(events, origin);
  } catch {
    runtime.counters.dropped += events.length;
    runtime.warn("next_signals.write_failed");
    await flushDropped(runtime);
    return;
  }
  await markWriterOk(runtime);
  await flushDropped(runtime);
}

async function markWriterOk(runtime: Runtime): Promise<void> {
  const nowMs = runtime.now().getTime();
  if (nowMs - runtime.counters.lastWriterOkAt < WRITER_OK_INTERVAL_MS) {
    return;
  }
  runtime.counters.lastWriterOkAt = nowMs;
  try {
    await runtime.store.recordWriterOk();
  } catch {
    runtime.warn("next_signals.heartbeat_failed");
  }
}

/** Moves the in-memory dropped count to the database once it can be written again. */
async function flushDropped(runtime: Runtime): Promise<void> {
  const pending = runtime.counters.dropped;
  if (pending === 0) {
    return;
  }
  try {
    await runtime.store.recordDropped(pending);
    runtime.counters.dropped -= pending;
  } catch {
    // Still unreachable: the count stays in memory and is reported by the next heartbeat.
  }
}

/** Counts events that were refused before storage (malformed drain lines, for instance). */
export async function recordDroppedCount(runtime: Runtime, count: number): Promise<void> {
  if (count <= 0) {
    return;
  }
  runtime.counters.dropped += count;
  await flushDropped(runtime);
}
