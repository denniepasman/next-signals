import { mapDrainRecord, parseDrainBody, shouldKeepDrainRecord } from "../../domain/drain";
import { buildContractEvent } from "../../domain/event";
import type { Runtime } from "../runtime";
import { recordDroppedCount, recordEvents } from "./record-events";

export async function ingestDrainBody(runtime: Runtime, rawBody: string): Promise<{ kept: number }> {
  const { records, malformed } = parseDrainBody(rawBody);
  const events = records
    .filter(shouldKeepDrainRecord)
    .map((record) =>
      buildContractEvent(mapDrainRecord(record), {
        projectRoot: runtime.config.projectRoot,
        userHashSalt: null,
      }),
    );
  await recordEvents(runtime, events, "vercel_drain");
  await recordDroppedCount(runtime, malformed);
  return { kept: events.length };
}
