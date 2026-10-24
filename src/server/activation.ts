/**
 * The package is inert until the owner sets DENNIEOS_INTAKE_SECRET (non-empty). Without it every
 * route answers 404 and `onRequestError` does nothing: no environment is validated, no Supabase
 * client is created and nothing is written.
 */
export function isSignalsActive(env: Record<string, string | undefined> = process.env): boolean {
  const secret = env.DENNIEOS_INTAKE_SECRET;
  return secret !== undefined && secret.trim() !== "";
}

/** Same body-less 404 an unrouted path gives, so an inactive install reveals nothing. */
export function inactiveResponse(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

/**
 * With an injected runtime (tests, custom wiring) the caller has already decided the package is
 * active; only the default environment-based runtime is gated on the secret.
 */
export function resolveIsActive(options: { runtime?: unknown; isActive?: () => boolean }): () => boolean {
  return options.isActive ?? (options.runtime === undefined ? () => isSignalsActive() : () => true);
}
