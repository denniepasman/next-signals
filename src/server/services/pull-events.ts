import {
  CONTRACT_VERSION,
  MAX_PAGE_LIMIT,
  MAX_RESPONSE_BYTES,
  type IntakeResponse,
} from "../../domain/contract";
import { PACKAGE_VERSION } from "../../version";
import type { Runtime } from "../runtime";

/** Events become visible to a pull after this long, so late commits cannot be skipped. */
const SETTLE_SECONDS = 10;
const FIRST_CURSOR = "0";

export type PullResult =
  | { readonly ok: true; readonly response: IntakeResponse }
  | { readonly ok: false; readonly code: "intake.cursor_unknown" | "intake.cursor_pruned" };

export interface PullInput {
  readonly cursor: string | null;
  readonly limit: number;
}

export async function pullEvents(runtime: Runtime, input: PullInput): Promise<PullResult> {
  const limit = Math.min(input.limit, MAX_PAGE_LIMIT);
  const cursor = input.cursor ?? FIRST_CURSOR;
  if (!/^\d{1,15}$/u.test(cursor)) {
    return { ok: false, code: "intake.cursor_unknown" };
  }
  const afterSeq = Number(cursor);
  const state = await runtime.store.readState();
  if (afterSeq < state.prunedThroughSeq) {
    return { ok: false, code: "intake.cursor_pruned" };
  }
  const settledBefore = new Date(runtime.now().getTime() - SETTLE_SECONDS * 1000);
  const stored = await runtime.store.listEvents(afterSeq, limit, settledBefore);

  // Stay under the contract's 5 MB: cut the page and let the cursor follow what was returned.
  let bytes = 0;
  const page = [];
  for (const item of stored) {
    bytes += JSON.stringify(item.event).length;
    if (bytes > MAX_RESPONSE_BYTES && page.length > 0) {
      break;
    }
    page.push(item);
  }
  const last = page[page.length - 1];
  return {
    ok: true,
    response: {
      events: page.map((item) => item.event),
      next_cursor: last === undefined ? cursor : String(last.seq),
      heartbeat: {
        scheduler_last_run_at: state.schedulerLastRunAt,
        writer_last_ok_at: state.writerLastOkAt,
        buffered: 0,
        dropped: state.dropped + runtime.counters.dropped,
        package_version: PACKAGE_VERSION,
        contract_version: CONTRACT_VERSION,
      },
    },
  };
}
