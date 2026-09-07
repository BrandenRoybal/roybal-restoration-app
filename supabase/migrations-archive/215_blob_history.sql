-- ============================================================
-- 215: blob history — Phase 0 tourniquet under job overwrites
-- ------------------------------------------------------------
-- Aug 6 2026: a device that hadn't synced since Jul 31 pushed its whole
-- copy of the Awthentis job and erased the contents inventory. The rev
-- guard + merge added in #97 prevent that on CURRENT clients, but the
-- enforcement is client-side: a stale cached build bypasses all of it.
-- This trigger keeps the PRIOR version of a job blob server-side whenever
-- one is overwritten or deleted, so any future clobber — from any client,
-- any build, or manual SQL — is a one-query restore.
--
-- Capture rules (adversarially reviewed 2026-08-10):
--   • no-op writes (data + deleted unchanged) are ignored
--   • ORDINARY saves use a ROLLING capture: within a 60-minute bucket the
--     newest ordinary history row is UPDATED in place to hold the current
--     pre-image, so the immediate pre-image of ANY write always survives
--     regardless of how the write is classified; a new anchor row is
--     inserted when the bucket ages out. Bounded rows, zero lost pre-images.
--   • REGRESSIONS insert unconditionally — an incoming write whose rev or
--     internal updatedAt is OLDER than what it replaces (the stale-device
--     signature), or whose payload is malformed — but with a 1-minute
--     floor so a two-device ping-pong loop cannot write unbounded history
--     (the first capture of a clobber is the one that holds the good copy).
--   • hard DELETEs always capture (soft deletes are ordinary updates and
--     also land in field_projects_trash via 214)
--   • a failed capture must never block a field save: the trigger swallows
--     its own errors with a warning. Known hole: QUERY_CANCELED
--     (statement_timeout) cannot be caught — mitigated by lz4 compression
--     and verified timing headroom, see notes at bottom.
--
-- Retention (nightly pg_cron purge):
--   • ordinary rows: newest 48 per job kept regardless of age (ceiling),
--     30-day window otherwise, and the newest 3 per job survive any age
--   • regression rows (the pre-clobber copies): kept 90 days
--
-- Recovery (operator action, SQL editor / service role):
--   -- list versions:
--   select hist_id, first_captured_at, replaced_at, op, was_regression,
--          jsonb_array_length(coalesce(data->'photos','[]'::jsonb)) photos,
--          jsonb_array_length(coalesce(data->'contents','[]'::jsonb)) contents
--     from blob_history where id = '<job-id>' order by replaced_at desc;
--   -- restore one (bump rev so guarded clients accept the pull):
--   update field_projects fp
--      set data = jsonb_set(h.data, '{rev}',
--                   to_jsonb(coalesce((fp.data->>'rev')::numeric, 0) + 1)),
--          deleted = false
--     from (select data from blob_history where hist_id = <hist-id>) h
--    where fp.id = '<job-id>';
-- ============================================================

set lock_timeout = '5s';

create table if not exists public.blob_history (
  hist_id           bigint generated always as identity primary key,
  table_name        text        not null,
  id                uuid        not null,
  data              jsonb       not null,
  deleted           boolean     not null default false,
  row_updated_at    timestamptz,                        -- updated_at of the preserved version
  first_captured_at timestamptz not null default now(), -- anchor time (rolling rows keep it)
  replaced_at       timestamptz not null default now(), -- when this pre-image was current
  op                text        not null default 'update',  -- 'update' | 'delete'
  was_regression    boolean     not null default false      -- stale-looking write detected
);

-- lz4 is several times cheaper to compress than default pglz — this runs
-- synchronously inside every save, so it directly buys timeout headroom
alter table public.blob_history alter column data set compression lz4;

create index if not exists blob_history_lookup
  on public.blob_history (table_name, id, replaced_at desc);

-- clients have no business in history: RLS on, deliberately NO policies,
-- and grants revoked on table, sequence, and function — only the service
-- role / SQL editor can read or restore.
alter table public.blob_history enable row level security;
revoke all on public.blob_history from anon, authenticated;
revoke all on sequence public.blob_history_hist_id_seq from anon, authenticated;

comment on table public.blob_history is
  'Server-side blob version history (migration 215). RLS intentionally has '
  'no policies: only postgres/service_role may read or restore. Do not add '
  'policies or grants for app roles; the rls_enabled_no_policy lint is '
  'expected and accepted.';

create or replace function public.capture_blob_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  regression     boolean := false;
  last_reg       timestamptz;
  rolling_id     bigint;
  rolling_anchor timestamptz;
begin
  if tg_op = 'UPDATE' then
    if old.data is not distinct from new.data
       and old.deleted is not distinct from new.deleted then
      return new;                                   -- no-op write
    end if;

    -- stale-device signature: incoming write is OLDER than what it replaces.
    -- Key absence is neutral (writers that omit rev/updatedAt are not
    -- thereby stale); genuinely malformed values classify as regression.
    begin
      regression :=
           ((new.data ? 'rev') and (old.data ? 'rev')
             and (new.data->>'rev')::numeric < (old.data->>'rev')::numeric)
        or ((new.data ? 'updatedAt') and (old.data ? 'updatedAt')
             and (new.data->>'updatedAt')::timestamptz
               < (old.data->>'updatedAt')::timestamptz);
    exception when others then
      regression := true;
      raise warning 'blob_history: malformed rev/updatedAt on %.% (%) — treating as regression',
        tg_table_name, old.id, sqlerrm;
    end;

    if regression then
      -- 1-minute floor: a runaway conflict loop must not flood history.
      -- The FIRST capture of a clobber holds the good pre-image; repeats
      -- within the floor add nothing worth their cost.
      select max(replaced_at) into last_reg
        from public.blob_history
       where table_name = tg_table_name and id = old.id and was_regression;
      if last_reg is not null and last_reg > now() - interval '1 minute' then
        return new;
      end if;
      insert into public.blob_history
        (table_name, id, data, deleted, row_updated_at, op, was_regression)
      values
        (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'update', true);
      return new;
    end if;

    -- ordinary save: rolling capture. The newest ordinary row inside its
    -- 60-minute bucket is refreshed to hold the immediate pre-image; a new
    -- anchor row starts when the bucket ages out.
    select hist_id, first_captured_at into rolling_id, rolling_anchor
      from public.blob_history
     where table_name = tg_table_name and id = old.id
       and op = 'update' and not was_regression
     order by replaced_at desc
     limit 1;

    if rolling_id is not null and rolling_anchor > now() - interval '60 minutes' then
      update public.blob_history
         set data = old.data, deleted = old.deleted,
             row_updated_at = old.updated_at, replaced_at = now()
       where hist_id = rolling_id;
    else
      insert into public.blob_history
        (table_name, id, data, deleted, row_updated_at, op, was_regression)
      values
        (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'update', false);
    end if;
    return new;

  elsif tg_op = 'DELETE' then
    insert into public.blob_history
      (table_name, id, data, deleted, row_updated_at, op, was_regression)
    values
      (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'delete', false);
    return old;
  end if;
  return null;
exception when others then
  -- a failed capture must NEVER block a field save
  raise warning 'blob_history capture failed for %.%: %', tg_table_name, old.id, sqlerrm;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function public.capture_blob_history() from public, anon, authenticated;

drop trigger if exists blob_history_capture on public.field_projects;
create trigger blob_history_capture
  before update or delete on public.field_projects
  for each row execute function public.capture_blob_history();

drop trigger if exists blob_history_capture on public.coordination_jobs;
create trigger blob_history_capture
  before update or delete on public.coordination_jobs
  for each row execute function public.capture_blob_history();

-- nightly purge, 09:17 UTC ≈ 1:17 AM Alaska. Gated on pg_cron so branch /
-- local replays (where the extension isn't enabled) skip scheduling
-- instead of breaking the migration chain.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('purge-blob-history');
    exception when others then
      null;  -- job didn't exist yet
    end;
    perform cron.schedule(
      'purge-blob-history',
      '17 9 * * *',
      $purge$
      delete from public.blob_history
       where hist_id in (
         select hist_id from (
           select hist_id, was_regression, replaced_at,
                  row_number() over (partition by table_name, id, was_regression
                                     order by replaced_at desc) as rn
             from public.blob_history
            where op <> 'delete'
         ) ranked
         where (not was_regression and rn > 48)
            or (not was_regression and rn > 3
                and replaced_at < now() - interval '30 days')
            or (was_regression and replaced_at < now() - interval '90 days')
       );
      $purge$
    );
  end if;
end;
$$;

-- Notes for operators:
--  • delete-captures (op='delete') are never purged by the cron job; they
--    are rare and are the last copy of a hard-deleted job.
--  • The one uncatchable failure class is statement_timeout firing inside
--    the synchronous history write (PL/pgSQL cannot trap QUERY_CANCELED).
--    Timing was verified at apply time with a 3 MB blob; lz4 keeps the
--    added cost well inside the authenticated role's timeout budget.
