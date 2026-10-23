import { createHmac } from "node:crypto";
import {
  ASSIGNMENT,
  BEARER,
  EMAIL,
  JSON_PAIR,
  JWT,
  PERSONAL_REDACTED,
  REDACTED,
  SUPABASE_KEY,
  UUID,
  isSensitiveKey,
  wordsOf,
} from "./redaction-rules";

// Privacy scrubber for error text and context. A port of DennieOS's
// apps/web/src/domain/signals/scrub.ts: the same rules run here (at the source) and again at
// DennieOS intake. Pure and idempotent: scrub(scrub(x)) === scrub(x).

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A message is a sentence; a stack carries its causes. DennieOS applies the same limits. */
export const MAX_CLIENT_MESSAGE_LENGTH = 1000;
export const MAX_CLIENT_STACK_LENGTH = 8000;
export const TRUNCATED_MARKER = "…[truncated]";

const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_ENTRIES = 50;
/** Applying the rules a few times settles the rare case where one replacement exposes another. */
const SETTLE_PASSES = 3;

export interface ScrubTextOptions {
  /** Longest result, marker included. */
  readonly maxLength: number;
}

export interface ScrubContextOptions {
  /** Top-level keys the contract allows; other keys are dropped. Omitted: every key is kept. */
  readonly allowedKeys?: ReadonlySet<string>;
  readonly maxStringLength?: number;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

// Headers whose whole value is a credential. Quoted (JSON) values keep their quotes.
const HEADER =
  /\b((?:set-)?cookie|(?:proxy-)?authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)(["']?)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|(?!\s|\[redacted\])[^\r\n]*)/giu;
/** `?token=abc&page=2` -> keys stay, values go. */
const QUERY_VALUE = /([?&][\w[\].%-]+)=([^&\s#"'<>]*)/gu;
/** Hex strings of 32+ characters; exactly 40 is a git commit and stays readable. */
const LONG_HEX = /(?<![\w/.\\-])[0-9a-f]{32,}(?![\w/\\]|\.\w)/giu;
const GIT_SHA_LENGTH = 40;
const LONG_BASE64 = /(?<![\w/.\\-])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/\\]|\.\w)/gu;

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`(?<![\\w.-])(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![\\w-]|\\.\\d)`, "gu");
const VERSION_BEFORE_IP = /(?:\bv|\bversion\s|\bver\.?\s?)$/iu;
const VERSION_LOOKBEHIND = 9;
const HEXTET = "[0-9a-f]{1,4}";
const IPV6 = new RegExp(
  `(?<![\\w:.])(?:(?:${HEXTET}:){7}${HEXTET}|(?:${HEXTET}:){1,7}:(?:${HEXTET}(?::${HEXTET}){0,6})?|::(?:${HEXTET}(?::${HEXTET}){0,6})?)(?![\\w:.]*\\w)`,
  "giu",
);
const IBAN = /(?<![\w-])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\w-])/gu;
const BSN = /(?<![\w.-])\d{9}(?![\w-]|\.\d)/gu;
const PHONE_CANDIDATE = /(?<![\w.:/+-])(?:\+|00)?\(?\d[\d\s().-]{7,17}\d(?![\w-])/gu;
const DATE_LIKE = /^\d{1,4}[-.]\d{1,2}[-.]\d{1,4}/u;

const IBAN_MIN_LENGTH = 15;
const IBAN_MAX_LENGTH = 34;
const IBAN_MODULUS = 97;
const BSN_MODULUS = 11;
const DUTCH_PHONE_DIGITS = 10;
const INTERNATIONAL_PHONE_MIN_DIGITS = 9;
const INTERNATIONAL_PHONE_MAX_DIGITS = 15;
const CHAR_CODE_A = 65;
const IBAN_LETTER_OFFSET = 10;

function isValidIban(candidate: string): boolean {
  const compact = candidate.replace(/\s/gu, "");
  if (compact.length < IBAN_MIN_LENGTH || compact.length > IBAN_MAX_LENGTH) {
    return false;
  }
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/u.test(char)
      ? char
      : String(char.charCodeAt(0) - CHAR_CODE_A + IBAN_LETTER_OFFSET);
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % IBAN_MODULUS;
    }
  }
  return remainder === 1;
}

/** The Dutch 11-proof: 9a + 8b + ... + 2h - i is a multiple of 11 (and not all zeros). */
function isValidBsn(candidate: string): boolean {
  const digits = candidate.split("").map(Number);
  const weighted = digits.reduce((sum, digit, index) => {
    const weight = index === digits.length - 1 ? -1 : digits.length - index;
    return sum + digit * weight;
  }, 0);
  return weighted % BSN_MODULUS === 0 && digits.some((digit) => digit !== 0);
}

function isPhoneNumber(candidate: string): boolean {
  const digits = candidate.replace(/\D/gu, "");
  const isInternational = candidate.startsWith("+") || candidate.startsWith("00");
  if (isInternational) {
    return (
      digits.length >= INTERNATIONAL_PHONE_MIN_DIGITS &&
      digits.length <= INTERNATIONAL_PHONE_MAX_DIGITS
    );
  }
  // Dutch numbers: 10 digits behind a leading 0, separated by spaces or hyphens only (dots and
  // dates such as 01-02-2026 10:00 look the same otherwise).
  return (
    digits.length === DUTCH_PHONE_DIGITS &&
    digits.startsWith("0") &&
    !candidate.includes(".") &&
    !DATE_LIKE.test(candidate)
  );
}

function redactHeader(
  _match: string,
  name: string,
  quote: string,
  separator: string,
  value: string,
): string {
  const normalisedSeparator = separator.includes("=") ? ": " : separator;
  const [firstChar = ""] = value;
  const isQuoted = firstChar === '"' || firstChar === "'";
  return `${name}${quote}${normalisedSeparator}${
    isQuoted ? `${firstChar}${REDACTED}${firstChar}` : REDACTED
  }`;
}

function isSecretLookingBase64(candidate: string): boolean {
  return /\d/u.test(candidate) && /[a-z]/u.test(candidate) && /[A-Z]/u.test(candidate);
}

function removeCredentials(text: string): string {
  return text
    .replace(HEADER, redactHeader)
    .replace(ASSIGNMENT, `$1=${REDACTED}`)
    .replace(JSON_PAIR, `"$1":"${REDACTED}"`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(SUPABASE_KEY, REDACTED)
    .replace(QUERY_VALUE, `$1=${REDACTED}`)
    .replace(LONG_HEX, (match) => (match.length === GIT_SHA_LENGTH ? match : REDACTED))
    .replace(LONG_BASE64, (match) => (isSecretLookingBase64(match) ? REDACTED : match));
}

function removePersonalData(text: string): string {
  return text
    .replace(EMAIL, PERSONAL_REDACTED)
    .replace(IBAN, (match) => (isValidIban(match) ? PERSONAL_REDACTED : match))
    .replace(IPV4, (match, offset: number, whole: string) =>
      VERSION_BEFORE_IP.test(whole.slice(Math.max(0, offset - VERSION_LOOKBEHIND), offset))
        ? match
        : PERSONAL_REDACTED,
    )
    .replace(IPV6, PERSONAL_REDACTED)
    .replace(PHONE_CANDIDATE, (match) => (isPhoneNumber(match) ? PERSONAL_REDACTED : match))
    .replace(BSN, (match) => (isValidBsn(match) ? PERSONAL_REDACTED : match));
}

function scrubOnce(text: string, maxLength: number): string {
  // A marker from an earlier pass is taken off and put back, so a second pass changes nothing.
  const wasTruncated = text.endsWith(TRUNCATED_MARKER);
  const body = wasTruncated ? text.slice(0, -TRUNCATED_MARKER.length) : text;
  // Ids stay readable, and their digits must not look like a phone number or a BSN.
  const scrubbed = removeCredentials(body)
    .split(UUID)
    .map((part, index) => (index % 2 === 1 ? part : removePersonalData(part)))
    .join("");
  if (!wasTruncated && scrubbed.length <= maxLength) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, Math.max(0, maxLength - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`;
}

/** `text` without credentials and personal data, cut to `options.maxLength`. */
export function scrubClientText(text: string, options: ScrubTextOptions): string {
  return Array.from({ length: SETTLE_PASSES }).reduce<string>(
    (current) => scrubOnce(current, options.maxLength),
    text,
  );
}

/** Key words that name a person or an address of a person; their values never leave the source. */
const PERSONAL_WORDS: ReadonlySet<string> = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "ip",
  "iban",
  "bsn",
  "username",
  "firstname",
  "lastname",
]);
const PERSONAL_WORD_PAIRS: ReadonlySet<string> = new Set(["user id", "user name"]);

function isPersonalKey(key: string): boolean {
  const words = wordsOf(key);
  return words.some((word) => PERSONAL_WORDS.has(word)) || PERSONAL_WORD_PAIRS.has(words.join(" "));
}

interface ContextLimits {
  readonly maxStringLength: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
}

type JsonRecord = Record<string, Json | undefined>;

function scrubValue(
  value: unknown,
  depth: number,
  limits: ContextLimits,
  seen: WeakSet<object>,
): Json | undefined {
  if (typeof value === "string") {
    return scrubClientText(value, { maxLength: limits.maxStringLength });
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value !== "object") {
    // undefined, functions and symbols are not stored.
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  if (depth >= limits.maxDepth) {
    return "[truncated]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const items: Json[] = value
      .slice(0, limits.maxEntries)
      .map((item: unknown) => scrubValue(item, depth + 1, limits, seen) ?? null);
    return value.length > limits.maxEntries ? [...items, "[truncated]"] : items;
  }
  return scrubEntries(value, depth, limits, seen) as Json;
}

function scrubEntries(
  record: object,
  depth: number,
  limits: ContextLimits,
  seen: WeakSet<object>,
): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, entry] of Object.entries(record).slice(0, limits.maxEntries)) {
    const scrubbed = scrubEntry(key, entry, depth, limits, seen);
    if (scrubbed !== undefined) {
      result[key] = scrubbed;
    }
  }
  return result;
}

function scrubEntry(
  key: string,
  entry: unknown,
  depth: number,
  limits: ContextLimits,
  seen: WeakSet<object>,
): Json | undefined {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  if (isPersonalKey(key)) {
    return PERSONAL_REDACTED;
  }
  return scrubValue(entry, depth + 1, limits, seen);
}

/** A JSON-safe, bounded copy of `context` with credentials and personal data removed. */
export function scrubClientContext(
  context: Readonly<Record<string, unknown>>,
  options: ScrubContextOptions = {},
): JsonRecord {
  const limits: ContextLimits = {
    maxStringLength: options.maxStringLength ?? MAX_CLIENT_MESSAGE_LENGTH,
    maxDepth: options.maxDepth ?? MAX_CONTEXT_DEPTH,
    maxEntries: options.maxEntries ?? MAX_CONTEXT_ENTRIES,
  };
  const { allowedKeys } = options;
  const kept =
    allowedKeys === undefined
      ? context
      : Object.fromEntries(Object.entries(context).filter(([key]) => allowedKeys.has(key)));
  return scrubEntries(kept, 0, limits, new WeakSet());
}

/**
 * The only form in which a user id is stored: HMAC-SHA256 with the source's salt
 * (DENNIEOS_USER_HASH_SALT), so the same user groups per source and nothing links users across
 * sources. A missing salt is a bug, never a silent unsalted hash.
 */
export function hashClientUserId(rawId: string, salt: string): string {
  if (salt === "") {
    throw new Error("hashClientUserId needs a non-empty salt");
  }
  return createHmac("sha256", salt).update(rawId).digest("hex");
}
