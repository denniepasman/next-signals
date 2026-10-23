// Small helpers shared by the route adapters.

export function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(code: string, status: number, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: code }, status, headers);
}

/** First address of x-forwarded-for; used only as an in-memory rate limit key, never stored. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ?? request.headers.get("x-real-ip") ?? "unknown";
}

export type RequestLike = Request;
