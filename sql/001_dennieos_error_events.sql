-- @dennieos/next-signals 1.0.0: storage for the client's own errors.
-- Apply once in the client's Supabase project (SQL editor or `supabase db push`).
-- After applying: Project Settings -> API -> Exposed schemas -> add `dennieos`.
-- Only the service role (server side) can read or write; RLS denies everyone else.

create schema if not exists dennieos;

create table if not exists dennieos.error_events (
  seq bigint generated always as identity unique,
  id text primary key check (char_length(id) <= 64),
  occurred_at timestamptz not null,
  level text not null check (level in ('warning', 'error', 'critical')),
  class text not null check (char_length(class) <= 255),
  message text not null check (char_length(message) <= 2000),
  stack text check (char_length(stack) <= 8000),
  fingerprint_hint text check (char_length(fingerprint_hint) <= 128),
  context jsonb not null default '{}'::jsonb,
  origin text not null check (origin in ('server', 'browser', 'vercel_drain')),
  created_at timestamptz not null default now()
);

create index if not exists error_events_created_at_idx on dennieos.error_events (created_at);

-- One row: heartbeat and counters for the contract's `heartbeat` object.
create table if not exists dennieos.intake_state (
  id smallint primary key default 1 check (id = 1),
  scheduler_last_run_at timestamptz,
  writer_last_ok_at timestamptz,
  dropped bigint not null default 0,
  -- Highest seq removed by pruning; a pull cursor below it gets 410 (a gap).
  pruned_through_seq bigint not null default 0
);

insert into dennieos.intake_state (id) values (1) on conflict (id) do nothing;

alter table dennieos.error_events enable row level security;
alter table dennieos.intake_state enable row level security;
-- No policies on purpose: deny all for anon and authenticated; the service role bypasses RLS.

revoke all on schema dennieos from public, anon, authenticated;
revoke all on all tables in schema dennieos from public, anon, authenticated;
grant usage on schema dennieos to service_role;
grant select, insert, update, delete on dennieos.error_events, dennieos.intake_state to service_role;

create or replace function dennieos.record_writer_ok()
returns void language sql as $$
  update dennieos.intake_state set writer_last_ok_at = now() where id = 1;
$$;

create or replace function dennieos.record_dropped(p_count integer)
returns void language sql as $$
  update dennieos.intake_state set dropped = dropped + greatest(p_count, 0) where id = 1;
$$;

-- Called by the Vercel cron: heartbeat plus pruning by retention. Returns the pruned count.
create or replace function dennieos.run_heartbeat(p_retention_days integer)
returns integer language plpgsql as $$
declare
  v_pruned integer;
  v_max_seq bigint;
begin
  update dennieos.intake_state set scheduler_last_run_at = now() where id = 1;

  with removed as (
    delete from dennieos.error_events
    where created_at < now() - make_interval(days => greatest(p_retention_days, 1))
    returning seq
  )
  select count(*), max(seq) into v_pruned, v_max_seq from removed;

  if v_max_seq is not null then
    update dennieos.intake_state
    set pruned_through_seq = greatest(pruned_through_seq, v_max_seq)
    where id = 1;
  end if;
  return v_pruned;
end;
$$;

revoke all on function dennieos.record_writer_ok(), dennieos.record_dropped(integer),
  dennieos.run_heartbeat(integer) from public, anon, authenticated;
grant execute on function dennieos.record_writer_ok(), dennieos.record_dropped(integer),
  dennieos.run_heartbeat(integer) to service_role;
