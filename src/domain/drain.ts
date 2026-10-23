import { createHash } from "node:crypto";
import { z } from "zod";
import type { RawEvent } from "./event";
import { normalizeUrlPath } from "./paths";

// Vercel log drain records (ADR 0039 in the DennieOS repo). Unknown keys are dropped; the
// personal parts of a record (proxy.clientIp, proxy.userAgent, query strings) are never read.

const proxySchema = z.object({
  method: z.string().optional(),
  path: z.string().optional(),
  statusCode: z.number().optional(),
});

export const drainRecordSchema = z.object({
  id: z.string().min(1).max(200),
  deploymentId: z.string().optional(),
  source: z.string().optional(),
  timestamp: z.number(),
  level: z.string().optional(),
  message: z.string().optional(),
  path: z.string().optional(),
  type: z.string().optional(),
  statusCode: z.number().optional(),
  proxy: proxySchema.optional(),
});
export type DrainRecord = z.infer<typeof drainRecordSchema>;

export interface ParsedDrainBody {
  readonly records: DrainRecord[];
  /** Lines or array items that were not a usable record. */
  readonly malformed: number;
}

const CRASH_STATUS = -1;
const SERVER_ERROR_STATUS = 500;
const TIMEOUT_STATUS = 504;

/** Accepts NDJSON and a JSON array, so a mis-set drain format does not break the route. */
export function parseDrainBody(rawBody: string): ParsedDrainBody {
  const trimmed = rawBody.trim();
  if (trimmed === "") {
    return { records: [], malformed: 0 };
  }
  const items = trimmed.startsWith("[") ? parseJsonArray(trimmed) : parseNdjson(trimmed);
  const records: DrainRecord[] = [];
  let malformed = items.malformed;
  for (const item of items.values) {
    const parsed = drainRecordSchema.safeParse(item);
    if (parsed.success) {
      records.push(parsed.data);
    } else {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function parseJsonArray(text: string): { values: unknown[]; malformed: number } {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? { values: value, malformed: 0 } : { values: [], malformed: 1 };
  } catch {
    return { values: [], malformed: 1 };
  }
}

function parseNdjson(text: string): { values: unknown[]; malformed: number } {
  const values: unknown[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { values, malformed };
}

/** Status, not message text: the exact timeout wording is undocumented (ADR 0039). */
export function shouldKeepDrainRecord(record: DrainRecord): boolean {
  const statuses = [record.statusCode, record.proxy?.statusCode];
  return (
    record.level === "error" ||
    record.level === "fatal" ||
    statuses.some(
      (status) => status !== undefined && (status >= SERVER_ERROR_STATUS || status === CRASH_STATUS),
    )
  );
}

function classifyDrainRecord(record: DrainRecord): string {
  const status = record.statusCode ?? record.proxy?.statusCode;
  if (record.statusCode === CRASH_STATUS) {
    return "vercel.function_crash";
  }
  if (status === TIMEOUT_STATUS && record.source !== "edge") {
    return "vercel.function_timeout";
  }
  if (record.source === "edge") {
    return "vercel.edge_error";
  }
  return "vercel.function_error";
}

/** Splits "Error: text\n    at fn (file:1:2)" into message and stack. */
function splitMessage(message: string): { message: string; stack: string | null } {
  const index = message.search(/\n\s+at\s/u);
  if (index === -1) {
    return { message, stack: null };
  }
  return { message: message.slice(0, index), stack: message.slice(index + 1) };
}

const MAX_EVENT_ID_LENGTH = 64;

function buildEventId(recordId: string): string {
  const id = `vercel_${recordId}`;
  return id.length <= MAX_EVENT_ID_LENGTH
    ? id
    : `vercel_${createHash("sha256").update(recordId).digest("hex").slice(0, 40)}`;
}

export function mapDrainRecord(record: DrainRecord): RawEvent {
  const { message, stack } = splitMessage(record.message ?? "");
  const proxyStatus = record.proxy?.statusCode;
  const httpStatus =
    record.statusCode !== undefined && record.statusCode > 0 ? record.statusCode : proxyStatus;
  const isCritical = record.level === "fatal" || record.statusCode === CRASH_STATUS;
  return {
    id: buildEventId(record.id),
    occurredAt: new Date(record.timestamp),
    level: isCritical ? "critical" : "error",
    className: classifyDrainRecord(record),
    message: message === "" ? `Vercel ${record.type ?? "log"} (status ${httpStatus ?? "unknown"})` : message,
    stack,
    route: normalizeUrlPath(record.path ?? record.proxy?.path ?? ""),
    method: record.proxy?.method ?? null,
    status: httpStatus ?? null,
    release: record.deploymentId ?? null,
    userId: null,
    browser: null,
    urlPath: normalizeUrlPath(record.proxy?.path ?? record.path ?? ""),
  };
}
