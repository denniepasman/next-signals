import type { Runtime } from "../runtime";

export async function runHeartbeat(runtime: Runtime): Promise<{ pruned: number }> {
  const pruned = await runtime.store.runHeartbeat(runtime.config.retentionDays);
  return { pruned };
}
