# @dennieos/next-signals

Error capture for Next.js apps (App Router, Next 14 to 16) that report to DennieOS through the
**client intake contract v1**. Errors are written into the client's **own Supabase** first;
DennieOS **pulls** them with a signed `GET`. DennieOS never gets database credentials, and the
app exposes no endpoint anyone can post server errors to.

## Inert unless configured

The package is **active only when `DENNIEOS_INTAKE_SECRET` is set** (non-empty). Without it:
`onRequestError` does nothing, and the intake, browser error, drain and heartbeat routes answer
`404` with an empty body. No environment variable is validated, no Supabase client is created and
nothing is written. The browser reporter stops after the first `404`. So the same code can ship to
every environment; set the secret only where it should report.

| Piece | What it does |
| --- | --- |
| `onRequestError` (`@dennieos/next-signals/instrumentation`) | Server render, route handler and server action errors. Needs Next 15 or newer (Next 14 has no `onRequestError`; the other pieces work). |
| Browser error route + `startBrowserReporter` | `window.onerror` and unhandled rejections: same-origin only, 16 KB body limit, 30 reports per minute per address (per instance), sampled. |
| Vercel log drain route | Timeouts, crashes and edge errors that never reach `onRequestError` (Vercel Pro). Verifies `x-vercel-signature` (HMAC-SHA1 over the raw body, constant time) per ADR 0039. |
| Intake route | `GET /dennieos/intake/v1/events`: HMAC-SHA256 verified in constant time over the raw path and query, 5 minute clock window, current and previous secret. |
| Heartbeat cron | Writes `scheduler_last_run_at` and prunes events older than 30 days. |

Everything is scrubbed **before** it is stored: e-mail addresses, IP addresses, IBAN, BSN, phone
numbers, query values, cookies, authorization headers, tokens and long secrets. Users are stored
only as `HMAC-SHA256(salt, user_id)`. The scrub rules are a port of DennieOS's own
(`apps/web/src/domain/signals/scrub.ts`).

## Install

1. **Package.** While the package is private, install it from GitHub (it builds on install):

   ```bash
   npm install github:denniepasman/next-signals#v1.0.0 @supabase/supabase-js
   ```

   (Once published to a private npm scope: `npm install @dennieos/next-signals`.)

2. **Database.** Apply `sql/001_dennieos_error_events.sql` to the client's Supabase project (SQL
   editor or a Supabase migration; the file ships in the package at
   `node_modules/@dennieos/next-signals/sql/`). Then add `dennieos` under *Project Settings, API,
   Exposed schemas*. The table has RLS on and **no policies**: only the service role (server side)
   reads or writes it. The SQL file is applied by the owner and is harmless while the package is inactive.

3. **Environment variables** (Vercel project settings, **Production only**; for a staging or preview environment do not set `DENNIEOS_INTAKE_SECRET`, the package then stays inert and needs no other switch):

   | Variable | Meaning |
   | --- | --- |
   | `DENNIEOS_INTAKE_SECRET` | Shown once in the DennieOS connect wizard (32 random bytes, hex). **Without it the package is inactive.** |
   | `DENNIEOS_INTAKE_SECRET_PREVIOUS` | Only during a rotation (24 hours). |
   | `DENNIEOS_USER_HASH_SALT` | Per-source salt from DennieOS; only needed with `getUserId`. |
   | `NEXT_PUBLIC_SUPABASE_URL` | Already present in most apps (or `SUPABASE_URL`). |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never expose it to the browser. |
   | `CRON_SECRET` | Vercel sends it to cron routes as `Authorization: Bearer ...`. |
   | `DENNIEOS_DRAIN_SECRET` | The log drain's signature secret (see below). Optional without a drain. |
   | `DENNIEOS_DRAIN_HEADER_SECRET` | Second secret for the `x-dennieos-drain` header. Optional. |
   | `DENNIEOS_RELEASE` | Optional; defaults to `VERCEL_GIT_COMMIT_SHA`. |
   | `DENNIEOS_RETENTION_DAYS` | Optional, default 30. |
   | `DENNIEOS_BROWSER_SAMPLE_RATE` | Optional, 0 to 1, default 1. |
   | `DENNIEOS_ALLOWED_ORIGINS` | Optional, comma separated, extra origins for browser reports. |

4. **`instrumentation.ts`** (project root or `src/`). The dynamic import keeps Node-only code
   out of the edge bundle:

   ```ts
   import type { onRequestError as DennieOsOnRequestError } from "@dennieos/next-signals/instrumentation";

   export async function onRequestError(...args: Parameters<typeof DennieOsOnRequestError>) {
     if (process.env.NEXT_RUNTIME === "nodejs") {
       const { onRequestError } = await import("@dennieos/next-signals/instrumentation");
       await onRequestError(...args);
     }
   }
   ```

   To tie errors to users, use `createOnRequestError({ getUserId })` instead; the id is only ever
   stored as a salted HMAC.

5. **Routes.** Each file also gets `export const dynamic = "force-dynamic"; export const runtime = "nodejs";`.

   `app/dennieos/intake/v1/events/route.ts`
   ```ts
   import { createIntakeHandlers } from "@dennieos/next-signals/routes";
   export const { GET } = createIntakeHandlers();
   export const dynamic = "force-dynamic";
   export const runtime = "nodejs";
   ```

   `app/dennieos/browser-errors/route.ts` (`createBrowserErrorHandlers`, exports `POST`),
   `app/dennieos/drain/vercel/route.ts` (`createDrainHandlers`, exports `POST`) and
   `app/dennieos/cron/heartbeat/route.ts` (`createCronHandlers`, exports `GET`) work the same way.

   These four paths must be **excluded from your own middleware and authentication**, and not sit
   behind Vercel Deployment Protection. If a rewrite changes the path the app sees, pass
   `createIntakeHandlers({ signedPathAndQuery })` so the signature is checked over the path DennieOS signed.

6. **Browser reporter.** In a client component rendered by the root layout:

   ```tsx
   "use client";
   import { useEffect } from "react";
   import { startBrowserReporter } from "@dennieos/next-signals/client";

   export function ErrorReporter() {
     useEffect(() => startBrowserReporter(), []);
     return null;
   }
   ```

7. **Heartbeat cron.** `vercel.json`:

   ```json
   { "crons": [{ "path": "/dennieos/cron/heartbeat", "schedule": "*/5 * * * *" }] }
   ```

   (Vercel Hobby only allows daily crons; use Pro.)

8. **Log drain (Vercel Pro, optional).** Team Settings, Drains: type Logs, schema `log` v1, format
   NDJSON, sources `lambda` and `edge`, environment production, 100% sampling, URL
   `https://<domain>/dennieos/drain/vercel`. Put the drain's signature secret in
   `DENNIEOS_DRAIN_SECRET`; add a custom header `x-dennieos-drain` with a second random secret in
   `DENNIEOS_DRAIN_HEADER_SECRET`. Switch on *hide IP addresses* team-wide. Drained data costs
   $0.50 per GB on Pro and needs the owner's consent. Records are kept when `level` is
   `error` or `fatal`, or the status is 500 or higher or -1.

9. **Connect in DennieOS.** Add the source with implementation `next_package`, base URL
   `https://<domain>`, and the intake secret from step 3.

## Contract notes

- Events are ordered by an insertion sequence; the cursor is that number as a string. Events become
  visible to a pull 10 seconds after insertion so a late commit is never skipped. A cursor that is
  not a number gets `400`; a cursor older than the last prune gets `410` (DennieOS restarts and
  records a gap).
- Responses are cut under 4.5 MB (the contract allows 5 MB) and sent with `Cache-Control: no-store`.
  Pulls are limited to 60 per minute per process.
- `log_filter` is signed like any query parameter and ignored (Laravel only).
- Messages are cut at 1,000 characters (stricter than the contract's 2,000, matching DennieOS's
  own scrubber); stacks at 8,000.
- The heartbeat reports `dropped`: events this app could not store (storage down, malformed drain
  lines). A growing number makes DennieOS flag the source.
- Rate limits are per process: on serverless each instance counts for itself, so they are a brake
  against floods, not an exact quota.

## Development

```bash
npm ci
npm run check   # typecheck, vitest, build
```

`test/fixtures/` holds copies of DennieOS's shared test vectors (`client-intake-test-vectors.json`)
and the synthetic Vercel drain fixtures (`signature-vectors.json`, `log-drain-batch.*`). The
DennieOS repo is the single source; refresh the copies when it changes. No real secrets or client
data live in this repository.
