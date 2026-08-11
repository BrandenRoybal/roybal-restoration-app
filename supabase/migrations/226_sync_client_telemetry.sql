-- ============================================================
-- 226: see which build each device is actually running
-- ------------------------------------------------------------
-- Prerequisite for 219 (revoking direct writes). 219's own header says to
-- confirm every device is on the RPC build first — but there has been no way
-- to see that. A device on a pre-RPC build does not call these functions at
-- all, so it is invisible: the only thing that reveals it is 219 breaking its
-- sync.
--
-- This records who is calling the sync RPCs and from which build, so the
-- fleet can be checked against the roster. After 219 the reasoning is:
--   • a person who appears here is syncing fine;
--   • a person on the roster who NEVER appears is the straggler to chase.
--
-- Deliberately cheap and non-blocking: one upsert per sync call on a table
-- with one row per user, and any failure is swallowed — telemetry must never
-- cost the crew a save.
-- ============================================================

set lock_timeout = '5s';

create table if not exists public.sync_clients (
  user_id    uuid primary key,
  build      text,
  last_seen  timestamptz not null default now(),
  calls      bigint      not null default 0
);

alter table public.sync_clients enable row level security;
revoke all on public.sync_clients from anon, authenticated;

comment on table public.sync_clients is
  'Which build each person last synced from (migration 226). Written by '
  '_sync_guard on every sync RPC. Used to confirm the fleet is off the '
  'pre-RPC builds before/after migration 219 revokes direct writes.';

-- _sync_guard gains the recording step; role + build checks are unchanged
create or replace function public._sync_guard(p_build text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare min_build int; caller_build int;
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tech','admin','office')
  ) then
    raise exception 'sync: this account may not write field_projects';
  end if;

  select coalesce((value)::text::int, 0) into min_build
    from public.app_settings where key = 'min_field_build';
  min_build := coalesce(min_build, 0);
  if min_build > 0 and p_build is not null then
    begin
      caller_build := regexp_replace(p_build, '\D', '', 'g')::int;
    exception when others then
      caller_build := null;
    end;
    if caller_build is not null and caller_build < min_build then
      raise exception 'sync: app build % is older than the required build % — update the app',
        caller_build, min_build
        using errcode = 'P0002';
    end if;
  end if;

  -- fleet visibility; never allowed to cost a save
  begin
    if auth.uid() is not null then
      insert into public.sync_clients (user_id, build, last_seen, calls)
      values (auth.uid(), p_build, now(), 1)
      on conflict (user_id) do update
        set build = excluded.build, last_seen = now(), calls = sync_clients.calls + 1;
    end if;
  exception when others then
    null;
  end;
end;
$$;

revoke execute on function public._sync_guard(text) from public, anon, authenticated;

-- roster vs. reality: who is syncing, on what, and who has gone quiet
create or replace view public.sync_fleet as
select
  u.email,
  p.role::text                                    as role,
  c.build,
  c.last_seen,
  c.calls,
  case
    when p.role = 'viewer'          then 'n/a (service account)'
    when c.user_id is null          then '⚠️ never synced through the RPC'
    when c.last_seen < now() - interval '3 days' then '⚠️ quiet 3+ days'
    else 'ok'
  end                                             as status
from public.profiles p
join auth.users u on u.id = p.id
left join public.sync_clients c on c.user_id = p.id
order by (c.last_seen is null) desc, c.last_seen desc nulls last;

revoke all on public.sync_fleet from anon, authenticated;

comment on view public.sync_fleet is
  'Roster vs. reality: who has synced through the RPCs, from which build, and '
  'who has not appeared at all. After migration 219, anyone flagged here is a '
  'device still on a pre-RPC build whose saves are being refused.';
