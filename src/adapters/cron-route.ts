import { safeEqual } from "../domain/signature";
import { getRuntime, type Runtime } from "../server/runtime";
import { runHeartbeat } from "../server/services/run-heartbeat";
import { errorResponse, jsonResponse } from "./http";

export interface CronRouteOptions {
  readonly runtime?: () => Runtime;
}

/** `GET /dennieos/cron/heartbeat`: called by a Vercel cron with `Authorization: Bearer $CRON_SECRET`. */
export function createCronHandlers(options: CronRouteOptions = {}): {
  GET: (request: Request) => Promise<Response>;
} {
  const resolveRuntime = options.runtime ?? getRuntime;
  return {
    async GET(request) {
      const runtime = resolveRuntime();
      const { cronSecret } = runtime.config;
      const authorization = request.headers.get("authorization") ?? "";
      if (cronSecret === null || !safeEqual(authorization, `Bearer ${cronSecret}`)) {
        return errorResponse("heartbeat.unauthorized", 401);
      }
      try {
        const { pruned } = await runHeartbeat(runtime);
        return jsonResponse({ ok: true, pruned }, 200);
      } catch {
        runtime.warn("next_signals.heartbeat_run_failed");
        return errorResponse("heartbeat.unavailable", 503);
      }
    },
  };
}
