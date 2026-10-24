// Tiny browser reporter (no dependencies). Call `startBrowserReporter()` once from a client
// component. It posts to the same-origin route and never throws into the page.

export interface BrowserReporterOptions {
  /** Default: /dennieos/browser-errors */
  readonly endpoint?: string;
  /** Reports per page load; the rest is dropped. Default 5. */
  readonly maxReports?: number;
}

interface Report {
  type: "error" | "unhandledrejection";
  name?: string;
  message: string;
  stack?: string;
  pageUrl?: string;
}

export interface ReporterEnvironment {
  addEventListener(type: string, listener: (event: never) => void): void;
  location: { href: string };
  fetch(input: string, init: RequestInit): Promise<unknown>;
}

const DEFAULT_ENDPOINT = "/dennieos/browser-errors";
const DEFAULT_MAX_REPORTS = 5;
const MAX_MESSAGE = 2000;
const MAX_STACK = 12_000;

function describe(value: unknown): { name?: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return { name: value.name, message: value.message || value.name, stack: value.stack };
  }
  return { message: typeof value === "string" ? value : "Non-error value" };
}

/** Returns a function that stops the reporter. Safe to call on the server (does nothing). */
export function startBrowserReporter(
  options: BrowserReporterOptions = {},
  environment: ReporterEnvironment | null = typeof window === "undefined"
    ? null
    : (window as unknown as ReporterEnvironment),
): () => void {
  if (environment === null) {
    return () => undefined;
  }
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const maxReports = options.maxReports ?? DEFAULT_MAX_REPORTS;
  const sent = new Set<string>();
  let isActive = true;

  function send(report: Report): void {
    const key = `${report.name ?? ""}|${report.message}|${(report.stack ?? "").split("\n")[1] ?? ""}`;
    if (!isActive || sent.size >= maxReports || sent.has(key)) {
      return;
    }
    sent.add(key);
    try {
      void Promise.resolve(
        environment!.fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...report, pageUrl: environment!.location.href }),
          keepalive: true,
          credentials: "same-origin",
        }),
      )
        .then((response) => {
          // A 404 means the app has no DENNIEOS_INTAKE_SECRET (inert): stop for this page load.
          if (typeof response === "object" && response !== null && (response as { status?: unknown }).status === 404) {
            isActive = false;
          }
        })
        .catch(() => undefined);
    } catch {
      // Reporting must never break the page.
    }
  }

  environment.addEventListener("error", ((event: { error?: unknown; message?: string }) => {
    const parts = event.error === undefined ? { message: event.message ?? "Script error" } : describe(event.error);
    send({
      type: "error",
      name: parts.name,
      message: parts.message.slice(0, MAX_MESSAGE),
      stack: parts.stack?.slice(0, MAX_STACK),
    } as Report);
  }) as (event: never) => void);

  environment.addEventListener("unhandledrejection", ((event: { reason?: unknown }) => {
    const parts = describe(event.reason);
    send({
      type: "unhandledrejection",
      name: parts.name,
      message: parts.message.slice(0, MAX_MESSAGE),
      stack: parts.stack?.slice(0, MAX_STACK),
    } as Report);
  }) as (event: never) => void);

  return () => {
    isActive = false;
  };
}
