import {
  MAX_BROWSER_BODY_BYTES,
  browserReportSchema,
  ingestBrowserError,
} from "../server/services/ingest-browser-error";
import { getRuntime, type Runtime } from "../server/runtime";
import { clientKey, errorResponse } from "./http";

export interface BrowserErrorRouteOptions {
  readonly runtime?: () => Runtime;
}

function isSameOrigin(request: Request, runtime: Runtime): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }
  if (runtime.config.allowedBrowserOrigins.includes(origin)) {
    return true;
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** `POST /dennieos/browser-errors`: same-origin, size-limited, rate-limited, sampled. */
export function createBrowserErrorHandlers(options: BrowserErrorRouteOptions = {}): {
  POST: (request: Request) => Promise<Response>;
} {
  const resolveRuntime = options.runtime ?? getRuntime;
  return {
    async POST(request) {
      const runtime = resolveRuntime();
      if (!isSameOrigin(request, runtime)) {
        return errorResponse("browser_errors.origin_refused", 403);
      }
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_BROWSER_BODY_BYTES) {
        return errorResponse("browser_errors.too_large", 413);
      }
      const limited = runtime.browserLimiter.check(clientKey(request));
      if (!limited.allowed) {
        return errorResponse("browser_errors.rate_limited", 429, {
          "retry-after": String(limited.retryAfterSeconds),
        });
      }
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BROWSER_BODY_BYTES) {
        return errorResponse("browser_errors.too_large", 413);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return errorResponse("browser_errors.bad_request", 400);
      }
      const parsed = browserReportSchema.safeParse(json);
      if (!parsed.success) {
        return errorResponse("browser_errors.bad_request", 400);
      }
      // A sampled-out report looks like an accepted one.
      if (runtime.random() < runtime.config.browserSampleRate) {
        await ingestBrowserError(runtime, parsed.data, request.headers.get("user-agent"));
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    },
  };
}
