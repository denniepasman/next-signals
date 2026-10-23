import { randomUUID } from "node:crypto";
import { buildContractEvent } from "../../domain/event";
import { normalizeUrlPath } from "../../domain/paths";
import type { Runtime } from "../runtime";
import { recordEvents } from "./record-events";

export interface ServerErrorInput {
  readonly error: unknown;
  readonly path: string;
  readonly method: string;
  readonly routePath: string | null;
  readonly userId: string | null;
}

// Control-flow errors Next throws on purpose; they are not failures.
const EXPECTED_DIGESTS = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/u;

interface ErrorParts {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly isExpected: boolean;
}

function describeError(error: unknown): ErrorParts {
  if (error instanceof Error) {
    const digest = (error as Error & { digest?: unknown }).digest;
    return {
      name: error.name || "Error",
      message: error.message,
      stack: error.stack ?? null,
      isExpected: typeof digest === "string" && EXPECTED_DIGESTS.test(digest),
    };
  }
  return {
    name: "NonErrorThrown",
    message: typeof error === "string" ? error : "A non-Error value was thrown",
    stack: null,
    isExpected: false,
  };
}

export async function ingestServerError(runtime: Runtime, input: ServerErrorInput): Promise<void> {
  const parts = describeError(input.error);
  if (parts.isExpected) {
    return;
  }
  const event = buildContractEvent(
    {
      id: randomUUID(),
      occurredAt: runtime.now(),
      level: "error",
      className: parts.name,
      message: parts.message,
      stack: parts.stack,
      route: input.routePath,
      method: input.method,
      status: 500,
      release: runtime.config.release,
      userId: input.userId,
      browser: null,
      urlPath: normalizeUrlPath(input.path),
    },
    { projectRoot: runtime.config.projectRoot, userHashSalt: runtime.config.userHashSalt },
  );
  await recordEvents(runtime, [event], "server");
}
