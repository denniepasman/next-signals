// The patterns and key rules behind every redaction. Ported from DennieOS
// (apps/web/src/domain/logging/redaction-rules.ts) so a value removed in DennieOS is removed
// at the source too. Keep the two in step.

export const REDACTED = "[redacted]";
export const PERSONAL_REDACTED = "[personal]";

/** Words that make a key sensitive wherever they appear: `accessToken`, `client_secret`, ... */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "authorisation",
  "cookie",
  "signature",
  "credential",
  "credentials",
  "payload",
]);
/** Word pairs that are sensitive together but not apart: `apiKey`, `private_key`, `sessionId`. */
const SENSITIVE_PAIRS: ReadonlySet<string> = new Set(["api key", "private key", "session id"]);
/** Whole keys that hold content rather than metadata (webhook and email bodies). */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "session",
  "body",
  "html",
  "text",
  "emailbody",
]);

/** "accessToken" / "access_token" / "Access-Token" -> ["access", "token"]. */
export function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
}

export function isSensitiveKey(key: string): boolean {
  const words = wordsOf(key);
  return (
    SENSITIVE_KEYS.has(words.join("")) ||
    words.some((word) => SENSITIVE_WORDS.has(word)) ||
    words.some((_word, index) => SENSITIVE_PAIRS.has(words.slice(index, index + 2).join(" ")))
  );
}

export const BEARER = /\bBearer\s+[\w.~+/-]+=*/giu;
export const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu;
export const SUPABASE_KEY = /\bsb_(secret|publishable)_[\w-]+/gu;
/** `access_token=...`, `password=...` in URLs and messages; OAuth `code=` too. */
export const ASSIGNMENT =
  /\b((?:access|refresh|id)?[-_]?token|secret|client[-_]?secret|password|passwd|api[-_]?key|apikey|signature|code)=([^&\s"']+)/giu;
/** `"password": "..."` in serialised JSON inside a message. */
export const JSON_PAIR =
  /"(password|passwd|secret|token|access_token|refresh_token|api_?key|signature)"\s*:\s*"[^"]*"/giu;

export const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/giu;
/** Ids are no personal data and their digits are no phone number. */
export const UUID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/iu;
