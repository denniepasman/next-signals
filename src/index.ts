export { PACKAGE_VERSION } from "./version";
export { CONTRACT_VERSION, INTAKE_PATH, intakeResponseSchema, contractEventSchema } from "./domain/contract";
export type { ContractEvent, IntakeResponse } from "./domain/contract";
export { scrubClientText, scrubClientContext, hashClientUserId } from "./domain/scrub";
export { signIntakeRequest, verifyIntakeRequest } from "./domain/signature";
export { isSignalsActive } from "./server/activation";
export { loadConfig } from "./server/config";
export type { SignalsConfig } from "./server/config";
export { createOnRequestError } from "./instrumentation";
