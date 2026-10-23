import { describe, expect, it } from "vitest";
import vectors from "./fixtures/client-intake-test-vectors.json";
import { signIntakeRequest, verifyIntakeRequest } from "../src/domain/signature";

type SecretName = keyof typeof vectors.secrets;

describe("intake signature (shared vectors)", () => {
  for (const request of vectors.signed_requests) {
    it(`signs ${request.name}`, () => {
      const signature = signIntakeRequest({
        secret: vectors.secrets[request.secret as SecretName],
        timestamp: request.timestamp,
        method: request.method,
        pathAndQuery: request.path_and_query,
      });
      expect(signature).toBe(request.expected_signature);
    });
  }

  for (const testCase of vectors.verification_cases) {
    it(`verifies ${testCase.name}`, () => {
      const request = vectors.signed_requests.find((candidate) => candidate.name === testCase.request);
      expect(request).toBeDefined();
      const overrides = testCase as { path_and_query?: string; method?: string };
      const result = verifyIntakeRequest({
        secrets: [vectors.secrets.current, vectors.secrets.previous],
        nowSeconds: testCase.now,
        timestampHeader: testCase.timestamp_header,
        signatureHeader: request!.expected_signature,
        method: overrides.method ?? request!.method,
        pathAndQuery: overrides.path_and_query ?? request!.path_and_query,
      });
      expect(result).toBe(testCase.expected);
    });
  }

  it("refuses a missing or malformed header", () => {
    const base = {
      secrets: [vectors.secrets.current],
      nowSeconds: 1792742400,
      method: "GET",
      pathAndQuery: "/dennieos/intake/v1/events?limit=500",
    };
    expect(verifyIntakeRequest({ ...base, timestampHeader: null, signatureHeader: "x" })).toBe("invalid");
    expect(verifyIntakeRequest({ ...base, timestampHeader: "abc", signatureHeader: "x" })).toBe("invalid");
    expect(verifyIntakeRequest({ ...base, timestampHeader: "1792742400", signatureHeader: null })).toBe("invalid");
  });

  it("refuses the previous secret once it is no longer configured", () => {
    const request = vectors.signed_requests.find((candidate) => candidate.name === "signed_with_previous_secret")!;
    const result = verifyIntakeRequest({
      secrets: [vectors.secrets.current],
      nowSeconds: request.timestamp,
      timestampHeader: String(request.timestamp),
      signatureHeader: request.expected_signature,
      method: request.method,
      pathAndQuery: request.path_and_query,
    });
    expect(result).toBe("invalid");
  });
});
