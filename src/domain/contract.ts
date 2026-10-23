import { z } from "zod";

// Contract v1 response shapes (docs/integrations/client-intake-contract.md in the DennieOS repo).

export const CONTRACT_VERSION = "1";
export const INTAKE_PATH = "/dennieos/intake/v1/events";
export const MAX_PAGE_LIMIT = 500;
export const MAX_RESPONSE_BYTES = 4_500_000; // contract allows 5 MB; stay below it.

export const eventLevelSchema = z.enum(["warning", "error", "critical"]);
export type EventLevel = z.infer<typeof eventLevelSchema>;

export const eventContextSchema = z.object({
  route: z.string().nullable(),
  method: z.string().nullable(),
  status: z.number().int().nullable(),
  release: z.string().nullable(),
  user_hash: z.string().nullable(),
  browser: z.string().nullable(),
  url_path: z.string().nullable(),
});

export const contractEventSchema = z.object({
  id: z.string().min(1).max(64),
  occurred_at: z.string().datetime({ offset: true }),
  level: eventLevelSchema,
  class: z.string().max(255),
  message: z.string().max(2000),
  stack: z.string().max(8000).nullable(),
  fingerprint_hint: z.string().max(128).nullable(),
  context: eventContextSchema,
});
export type ContractEvent = z.infer<typeof contractEventSchema>;

export const heartbeatSchema = z.object({
  scheduler_last_run_at: z.string().nullable(),
  writer_last_ok_at: z.string().nullable(),
  buffered: z.number().int().min(0),
  dropped: z.number().int().min(0),
  package_version: z.string(),
  contract_version: z.literal(CONTRACT_VERSION),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const intakeResponseSchema = z.object({
  events: z.array(contractEventSchema),
  next_cursor: z.string(),
  heartbeat: heartbeatSchema,
});
export type IntakeResponse = z.infer<typeof intakeResponseSchema>;
