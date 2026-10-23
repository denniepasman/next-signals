import { getRuntime, type Runtime } from "./server/runtime";
import { ingestServerError } from "./server/services/ingest-server-error";

// Structural types so the package compiles against Next 14, 15 and 15.x without importing next.
export interface RequestErrorRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}
export interface RequestErrorContext {
  readonly routePath?: string;
  readonly routeType?: string;
  readonly routerKind?: string;
}

export interface OnRequestErrorOptions {
  readonly runtime?: () => Runtime;
  /** Your own user id for this request (session lookup); stored only as an HMAC. */
  readonly getUserId?: (request: RequestErrorRequest) => string | null | Promise<string | null>;
}

export function createOnRequestError(options: OnRequestErrorOptions = {}) {
  const resolveRuntime = options.runtime ?? getRuntime;
  return async function onRequestError(
    error: unknown,
    request: RequestErrorRequest,
    context: RequestErrorContext,
  ): Promise<void> {
    // The reporter must never break the request it reports on.
    try {
      const runtime = resolveRuntime();
      const userId = options.getUserId === undefined ? null : await options.getUserId(request);
      await ingestServerError(runtime, {
        error,
        path: request.path,
        method: request.method,
        routePath: context.routePath ?? null,
        userId,
      });
    } catch {
      console.warn("[dennieos] next_signals.on_request_error_failed");
    }
  };
}

/** `export { onRequestError } from "@dennieos/next-signals/instrumentation"` in instrumentation.ts. */
export const onRequestError = createOnRequestError();
