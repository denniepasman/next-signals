import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import signatureVectors from "./fixtures/signature-vectors.json";
import { mapDrainRecord, parseDrainBody, shouldKeepDrainRecord } from "../src/domain/drain";
import { buildContractEvent } from "../src/domain/event";
import { contractEventSchema } from "../src/domain/contract";
import { verifyDrainSignature } from "../src/domain/signature";

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url));

describe("drain signature (fixtures from ADR 0039)", () => {
  for (const vector of signatureVectors.vectors) {
    it(vector.name, () => {
      expect(
        verifyDrainSignature(new Uint8Array(read(vector.bodyFile)), vector.header, signatureVectors.secret),
      ).toBe(vector.isValid);
    });
  }

  it("refuses an empty secret", () => {
    expect(verifyDrainSignature(new Uint8Array(read("log-drain-batch.ndjson")), "abc", "")).toBe(false);
  });
});

describe("drain records", () => {
  const records = parseDrainBody(read("log-drain-batch.ndjson").toString("utf8")).records;

  it("parses the NDJSON and the JSON array to the same records", () => {
    const fromJson = parseDrainBody(read("log-drain-batch.json").toString("utf8")).records;
    expect(fromJson.map((record) => record.id)).toEqual(records.map((record) => record.id));
  });

  it("keeps and drops the records the fixtures name", () => {
    const keptIds = records.filter(shouldKeepDrainRecord).map((record) => record.id);
    const droppedIds = records.filter((record) => !shouldKeepDrainRecord(record)).map((record) => record.id);
    expect(keptIds.map((id) => id.slice(-4))).toEqual(signatureVectors.expectedKeptIdSuffixes);
    expect(droppedIds.map((id) => id.slice(-4))).toEqual(signatureVectors.expectedDroppedIdSuffixes);
  });

  it("maps to valid contract events per ADR 0039", () => {
    const events = records
      .filter(shouldKeepDrainRecord)
      .map((record) => buildContractEvent(mapDrainRecord(record), { projectRoot: "/var/task", userHashSalt: null }));
    for (const event of events) {
      expect(contractEventSchema.safeParse(event).success).toBe(true);
    }
    expect(events.map((event) => event.class)).toEqual([
      "vercel.function_error",
      "vercel.function_timeout",
      "vercel.function_crash",
      expect.stringMatching(/^vercel\./),
    ]);
    expect(events[2]?.level).toBe("critical");
    expect(events[0]?.level).toBe("error");
    expect(events[0]?.context.release).toBe("dpl_233NRGRjVZX1caZrXWtz5g1TAksD");
    expect(events[0]?.context.url_path).toBe("/api/pay");
  });

  it("never stores the client ip, user agent or query values", () => {
    const serialised = JSON.stringify(
      records
        .filter(shouldKeepDrainRecord)
        .map((record) => buildContractEvent(mapDrainRecord(record), { projectRoot: "/var/task", userHashSalt: null })),
    );
    expect(serialised).not.toContain("203.0.113.7");
    expect(serialised).not.toContain("Mozilla");
    expect(serialised).not.toContain("token=");
  });

  it("counts malformed lines and skips them", () => {
    const parsed = parseDrainBody('{"id":"a","timestamp":1,"level":"error"}\nnot json\n{"nope":true}\n');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.malformed).toBe(2);
  });
});
