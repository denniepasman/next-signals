import { createHash } from "node:crypto";
import type { ContractEvent, EventLevel } from "./contract";
import { firstAppFrame, relativizeStack } from "./paths";
import {
  MAX_CLIENT_MESSAGE_LENGTH,
  MAX_CLIENT_STACK_LENGTH,
  hashClientUserId,
  scrubClientText,
} from "./scrub";

const MAX_CLASS_LENGTH = 255;
const MAX_SHORT_FIELD_LENGTH = 200;
const FINGERPRINT_LENGTH = 32;

export interface RawEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly level: EventLevel;
  readonly className: string;
  readonly message: string;
  readonly stack: string | null;
  readonly route: string | null;
  readonly method: string | null;
  readonly status: number | null;
  readonly release: string | null;
  readonly userId: string | null;
  readonly browser: string | null;
  readonly urlPath: string | null;
}

export interface BuildEventOptions {
  readonly projectRoot: string | null;
  readonly userHashSalt: string | null;
}

function scrubShort(value: string | null): string | null {
  return value === null ? null : scrubClientText(value, { maxLength: MAX_SHORT_FIELD_LENGTH });
}

/** The source's own grouping key: class plus the first application frame (no line number). */
export function buildFingerprintHint(className: string, stack: string | null): string {
  const basis = `${className}|${firstAppFrame(stack) ?? ""}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

/** Raw event -> contract v1 event. Everything free-text is scrubbed here, at the source. */
export function buildContractEvent(raw: RawEvent, options: BuildEventOptions): ContractEvent {
  const relativeStack =
    raw.stack === null ? null : relativizeStack(raw.stack, options.projectRoot);
  const stack =
    relativeStack === null
      ? null
      : scrubClientText(relativeStack, { maxLength: MAX_CLIENT_STACK_LENGTH });
  const userHash =
    raw.userId !== null && options.userHashSalt !== null && options.userHashSalt !== ""
      ? hashClientUserId(raw.userId, options.userHashSalt)
      : null;
  const className = scrubClientText(raw.className, { maxLength: MAX_CLASS_LENGTH });
  return {
    id: raw.id,
    occurred_at: raw.occurredAt.toISOString(),
    level: raw.level,
    class: className,
    message: scrubClientText(raw.message, { maxLength: MAX_CLIENT_MESSAGE_LENGTH }),
    stack,
    fingerprint_hint: buildFingerprintHint(className, stack),
    context: {
      route: scrubShort(raw.route),
      method: scrubShort(raw.method),
      status: raw.status,
      release: scrubShort(raw.release),
      user_hash: userHash,
      browser: scrubShort(raw.browser),
      url_path: scrubShort(raw.urlPath),
    },
  };
}
