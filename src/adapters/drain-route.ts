import { safeEqual, verifyDrainSignature } from "../domain/signature";
import { getRuntime, type Runtime } from "../server/runtime";
import { ingestDrainBody } from "../server/services/ingest-drain";
import { errorResponse, jsonResponse } from "./http";

/** Vercel caps a payload at 1 MB; anything much larger is not from Vercel. */
const MAX_DRAIN_BODY_BYTES = 2 * 1024 * 1024;
export const DRAIN_HEADER = "x-dennieos-drain";

export interface DrainRouteOptions {
  readonly runtime?: () => Runtime;
}

/** `POST /dennieos/drain/vercel` (ADR 0039): verify, parse, keep errors, store, answer 200. */
export function createDrainHandlers(options: DrainRouteOptions = {}): {
  POST: (request: Request) => Promise<Response>;
} {
  const resolveRuntime = options.runtime ?? getRuntime;
  return {
    async POST(request) {
      const runtime = resolveRuntime();
      const { drainSignatureSecret, drainHeaderSecret } = runtime.config;
      if (drainSignatureSecret === null) {
        return errorResponse("vercel_drain.not_configured", 403);
      }
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength > MAX_DRAIN_BODY_BYTES) {
        return errorResponse("vercel_drain.too_large", 413);
      }
      const isSignatureValid = verifyDrainSignature(
        raw,
        request.headers.get("x-vercel-signature"),
        drainSignatureSecret,
      );
      const isHeaderValid =
        drainHeaderSecret === null ||
        safeEqual(request.headers.get(DRAIN_HEADER) ?? "", drainHeaderSecret);
      if (!isSignatureValid || !isHeaderValid) {
        return errorResponse("vercel_drain.signature_refused", 403);
      }
      try {
        const { kept } = await ingestDrainBody(runtime, new TextDecoder().decode(raw));
        return jsonResponse({ kept }, 200);
      } catch {
        // Vercel only needs a 200; a storage problem is already counted as dropped.
        runtime.warn("next_signals.drain_failed");
        return jsonResponse({ kept: 0 }, 200);
      }
    },
  };
}
