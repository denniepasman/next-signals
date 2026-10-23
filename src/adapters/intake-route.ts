import { z } from "zod";
import { verifyIntakeRequest } from "../domain/signature";
import { getRuntime, type Runtime } from "../server/runtime";
import { pullEvents } from "../server/services/pull-events";
import { errorResponse, jsonResponse } from "./http";

const DEFAULT_LIMIT = 500;

const querySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMIT),
});

export interface IntakeRouteOptions {
  readonly runtime?: () => Runtime;
  /**
   * The path DennieOS signs, when it differs from the URL this app sees (a rewrite or proxy that
   * strips a prefix). Receives the path and query as this app sees them.
   */
  readonly signedPathAndQuery?: (seen: string) => string;
}

/** `GET /dennieos/intake/v1/events`: the signed pull of contract v1. */
export function createIntakeHandlers(options: IntakeRouteOptions = {}): {
  GET: (request: Request) => Promise<Response>;
} {
  const resolveRuntime = options.runtime ?? getRuntime;
  return {
    async GET(request) {
      const runtime = resolveRuntime();
      const url = new URL(request.url);
      const seen = `${url.pathname}${url.search}`;
      const pathAndQuery = options.signedPathAndQuery?.(seen) ?? seen;

      const verification = verifyIntakeRequest({
        secrets: runtime.config.intakeSecrets,
        nowSeconds: Math.floor(runtime.now().getTime() / 1000),
        timestampHeader: request.headers.get("x-dennieos-timestamp"),
        signatureHeader: request.headers.get("x-dennieos-signature"),
        method: request.method,
        pathAndQuery,
      });
      if (verification !== "valid") {
        return errorResponse(`client_intake.signature_${verification}`, 401);
      }

      const limited = runtime.intakeLimiter.check(request.headers.get("x-dennieos-source") ?? "source");
      if (!limited.allowed) {
        return errorResponse("client_intake.rate_limited", 429, {
          "retry-after": String(limited.retryAfterSeconds),
        });
      }

      const query = querySchema.safeParse({
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      });
      if (!query.success) {
        return errorResponse("client_intake.bad_request", 400);
      }
      // `log_filter` is for the Laravel log scanner; it is signed but has no meaning here.

      try {
        const result = await pullEvents(runtime, {
          cursor: query.data.cursor ?? null,
          limit: query.data.limit,
        });
        if (!result.ok) {
          return result.code === "intake.cursor_pruned"
            ? errorResponse("client_intake.cursor_pruned", 410)
            : errorResponse("client_intake.cursor_unknown", 400);
        }
        return jsonResponse(result.response, 200);
      } catch {
        runtime.warn("next_signals.pull_failed");
        return errorResponse("client_intake.unavailable", 503);
      }
    },
  };
}
