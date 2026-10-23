import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildContractEvent } from "../../domain/event";
import { normalizeUrlPath, parseBrowser } from "../../domain/paths";
import type { Runtime } from "../runtime";
import { recordEvents } from "./record-events";

export const MAX_BROWSER_BODY_BYTES = 16 * 1024;

/** Unknown keys are rejected: the reporter sends exactly these. */
export const browserReportSchema = z
  .object({
    type: z.enum(["error", "unhandledrejection"]),
    name: z.string().max(200).optional(),
    message: z.string().min(1).max(2000),
    stack: z.string().max(12_000).optional(),
    pageUrl: z.string().max(2048).optional(),
  })
  .strict();
export type BrowserReport = z.infer<typeof browserReportSchema>;

export async function ingestBrowserError(
  runtime: Runtime,
  report: BrowserReport,
  userAgent: string | null,
): Promise<void> {
  const urlPath = report.pageUrl === undefined ? null : normalizeUrlPath(report.pageUrl);
  const event = buildContractEvent(
    {
      id: randomUUID(),
      occurredAt: runtime.now(),
      level: "error",
      className: report.name ?? (report.type === "unhandledrejection" ? "UnhandledRejection" : "Error"),
      message: report.message,
      stack: report.stack ?? null,
      route: urlPath,
      method: null,
      status: null,
      release: runtime.config.release,
      userId: null,
      browser: parseBrowser(userAgent),
      urlPath,
    },
    { projectRoot: null, userHashSalt: null },
  );
  await recordEvents(runtime, [event], "browser");
}
