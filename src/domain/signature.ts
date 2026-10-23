import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Contract v1 signing (docs/integrations/client-intake-contract.md in the DennieOS repo):
//   string_to_sign = timestamp + "\n" + method + "\n" + path_and_query
//   signature      = "sha256=" + lowercase hex HMAC-SHA256(secret, string_to_sign)

export const MAX_CLOCK_SKEW_SECONDS = 300;
export const SIGNATURE_PREFIX = "sha256=";

export type Verification = "valid" | "expired" | "invalid";

/** Compares two strings in constant time, whatever their lengths. */
export function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

export interface SignInput {
  readonly secret: string;
  readonly timestamp: number | string;
  readonly method: string;
  readonly pathAndQuery: string;
}

export function signIntakeRequest(input: SignInput): string {
  const stringToSign = `${input.timestamp}\n${input.method}\n${input.pathAndQuery}`;
  return `${SIGNATURE_PREFIX}${createHmac("sha256", input.secret).update(stringToSign).digest("hex")}`;
}

export interface VerifyInput {
  /** Current secret first, then the previous one while a rotation is running. */
  readonly secrets: readonly string[];
  readonly nowSeconds: number;
  readonly timestampHeader: string | null;
  readonly signatureHeader: string | null;
  readonly method: string;
  readonly pathAndQuery: string;
}

export function verifyIntakeRequest(input: VerifyInput): Verification {
  const { timestampHeader, signatureHeader } = input;
  if (timestampHeader === null || signatureHeader === null || !/^\d{1,12}$/u.test(timestampHeader)) {
    return "invalid";
  }
  const timestamp = Number(timestampHeader);
  if (Math.abs(input.nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    return "expired";
  }
  // Every secret is checked, without stopping early, so timing does not reveal which matched.
  let isMatch = false;
  for (const secret of input.secrets) {
    const expected = signIntakeRequest({
      secret,
      timestamp: timestampHeader,
      method: input.method,
      pathAndQuery: input.pathAndQuery,
    });
    if (safeEqual(expected, signatureHeader)) {
      isMatch = true;
    }
  }
  return isMatch ? "valid" : "invalid";
}

/** Vercel log drain: `x-vercel-signature` is the hex HMAC-SHA1 of the raw body (ADR 0039). */
export function verifyDrainSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (signatureHeader === null || secret === "") {
    return false;
  }
  const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signatureHeader.trim().toLowerCase());
}
