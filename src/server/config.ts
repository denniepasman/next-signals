import { z } from "zod";

export interface SignalsConfig {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  /** Current intake secret, then the previous one during a rotation. */
  readonly intakeSecrets: readonly string[];
  readonly userHashSalt: string | null;
  readonly drainSignatureSecret: string | null;
  readonly drainHeaderSecret: string | null;
  readonly cronSecret: string | null;
  readonly release: string | null;
  readonly retentionDays: number;
  /** 0..1: the share of browser error reports that is stored. */
  readonly browserSampleRate: number;
  readonly projectRoot: string | null;
  /** Extra origins (besides the request's own host) allowed to post browser errors. */
  readonly allowedBrowserOrigins: readonly string[];
}

const envSchema = z.object({
  DENNIEOS_INTAKE_SECRET: z.string().min(32),
  DENNIEOS_INTAKE_SECRET_PREVIOUS: z.string().min(32).optional(),
  DENNIEOS_USER_HASH_SALT: z.string().min(1).optional(),
  DENNIEOS_DRAIN_SECRET: z.string().min(1).optional(),
  DENNIEOS_DRAIN_HEADER_SECRET: z.string().min(1).optional(),
  DENNIEOS_RELEASE: z.string().min(1).optional(),
  DENNIEOS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  DENNIEOS_BROWSER_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  DENNIEOS_ALLOWED_ORIGINS: z.string().optional(),
  DENNIEOS_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(1).optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().min(1).optional(),
});

/** Reads and validates the environment once; throws a readable error naming the variables. */
export function loadConfig(env: Record<string, string | undefined> = process.env): SignalsConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`@dennieos/next-signals: invalid environment (${names})`);
  }
  const values = parsed.data;
  const supabaseUrl =
    values.DENNIEOS_SUPABASE_URL ?? values.NEXT_PUBLIC_SUPABASE_URL ?? values.SUPABASE_URL;
  if (supabaseUrl === undefined) {
    throw new Error(
      "@dennieos/next-signals: set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL / DENNIEOS_SUPABASE_URL)",
    );
  }
  return {
    supabaseUrl,
    supabaseServiceRoleKey: values.SUPABASE_SERVICE_ROLE_KEY,
    intakeSecrets: [values.DENNIEOS_INTAKE_SECRET, values.DENNIEOS_INTAKE_SECRET_PREVIOUS].filter(
      (secret): secret is string => secret !== undefined,
    ),
    userHashSalt: values.DENNIEOS_USER_HASH_SALT ?? null,
    drainSignatureSecret: values.DENNIEOS_DRAIN_SECRET ?? null,
    drainHeaderSecret: values.DENNIEOS_DRAIN_HEADER_SECRET ?? null,
    cronSecret: values.CRON_SECRET ?? null,
    release: values.DENNIEOS_RELEASE ?? values.VERCEL_GIT_COMMIT_SHA ?? null,
    retentionDays: values.DENNIEOS_RETENTION_DAYS,
    browserSampleRate: values.DENNIEOS_BROWSER_SAMPLE_RATE,
    projectRoot: process.cwd(),
    allowedBrowserOrigins: (values.DENNIEOS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
  };
}
