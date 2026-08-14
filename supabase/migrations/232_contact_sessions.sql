-- ============================================================
-- 232_contact_sessions — CF-1 accounts (docs/CRM_Design.md §8 CF-1).
--
-- The portal outlives the job: a customer verifies possession of the
-- phone number ALREADY ON FILE and receives a long-lived contact
-- session — "My projects" across every job, past and future.
--
-- DELIBERATELY NOT SUPABASE AUTH. Any JWT in the `authenticated` role
-- passes every legacy USING(true) policy in this database (migration
-- 216's own warning), so a customer login must not be an auth.users
-- row until Sync Plan Phase 3 fences a customer role. Instead this
-- extends the portal's existing bearer-credential model one level up:
-- job share_token (Phase A) → contact session (CF-1), both served by
-- the single roybal-portal gateway, both revocable, neither ever a DB
-- credential.
--
-- Flow (v1 is SMS-only; codes go ONLY to the phone already on file —
-- decision 5's identity bar: we verify channel possession, we never
-- trust a self-report):
--   1. customer taps "save this" on a job link → portal_access_begin
--      reserves a pending session ATOMICALLY under rate caps, and the
--      gateway texts a 6-digit code (kind portalCode)
--   2. customer types the code → portal_access_verify checks it with
--      an atomic attempt counter and, on match, activates the session
--   3. the gateway thereafter accepts {session, jobId} anywhere it
--      accepts a job token — resolved server-side, tokens never leave
--
-- The RPCs are the 227 pattern: SECURITY DEFINER, advisory-lock
-- serialized (code sends spend Twilio money; code checks are a
-- brute-force surface), service_role only.
--
-- SAFE & additive. Rollback: drop the two functions and the table.
-- ============================================================

create table if not exists public.contact_sessions (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references public.contacts (id) on delete cascade,
  channel         text not null default 'sms' check (channel in ('sms', 'email')),
  destination     text not null default '',       -- masked audit trail, e.g. '•••-0142'
  code_hash       text,                           -- sha-256 of the 6-digit code while pending
  code_expires_at timestamptz,                    -- ~10 minutes
  attempts        int  not null default 0,        -- wrong guesses so far
  token_hash      text unique,                    -- sha-256 of the session token once verified
  expires_at      timestamptz,                    -- session lifetime (~180 days)
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists contact_sessions_contact_idx on public.contact_sessions (contact_id, created_at);
create index if not exists contact_sessions_token_idx on public.contact_sessions (token_hash) where token_hash is not null;

-- Guard-table posture (227): RLS on, NO policies, nothing granted.
-- Only the service-role gateway and the definer RPCs touch this table.
alter table public.contact_sessions enable row level security;
revoke all on public.contact_sessions from anon, authenticated;

comment on table public.contact_sessions is
  'CF-1 portal accounts: pending codes and active contact sessions. Bearer tokens hashed at rest; never a DB credential (deliberately not Supabase Auth until Phase-3 RLS).';

-- ------------------------------------------------------------
-- portal_access_begin — reserve a pending session, or refuse.
-- Returns the session id, or NULL when a cap is met (the caller
-- degrades to "try again later" — NULL is not an error, 227 style).
-- Caps are checked and the row written under one advisory lock, so
-- 2,000 simultaneous requests cannot each pass a read-then-write.
-- ------------------------------------------------------------
create or replace function public.portal_access_begin(
  p_contact   uuid,
  p_channel   text,
  p_dest      text,
  p_code_hash text,
  p_hourly    int default 3,     -- code sends per contact per hour
  p_daily     int default 20     -- code sends across ALL contacts per day
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_contact is null or coalesce(p_code_hash, '') = '' then return null; end if;
  perform pg_advisory_xact_lock(hashtext('roybal.portal_access'));

  if (select count(*) from public.contact_sessions
       where contact_id = p_contact and created_at > now() - interval '1 hour') >= p_hourly then
    return null;
  end if;
  if (select count(*) from public.contact_sessions
       where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') >= p_daily then
    return null;
  end if;

  insert into public.contact_sessions (contact_id, channel, destination, code_hash, code_expires_at)
  values (p_contact, coalesce(nullif(p_channel, ''), 'sms'), left(coalesce(p_dest, ''), 40),
          p_code_hash, now() + interval '10 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- portal_access_verify — spend one attempt, activate on a match.
-- Attempts are counted BEFORE the comparison inside the same lock, so
-- a guess always costs an attempt even when the caller races itself;
-- five wrong guesses kill the code.
-- ------------------------------------------------------------
create or replace function public.portal_access_verify(
  p_contact      uuid,
  p_code_hash    text,
  p_token_hash   text,
  p_ttl_days     int default 180,
  p_max_attempts int default 5
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if p_contact is null or coalesce(p_code_hash, '') = '' or coalesce(p_token_hash, '') = '' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('roybal.portal_access'));

  select * into r from public.contact_sessions
   where contact_id = p_contact
     and token_hash is null
     and revoked_at is null
     and code_hash is not null
     and code_expires_at > now()
   order by created_at desc
   limit 1;
  if r.id is null then return false; end if;

  update public.contact_sessions set attempts = attempts + 1 where id = r.id;
  if r.attempts + 1 > p_max_attempts then return false; end if;
  if r.code_hash is distinct from p_code_hash then return false; end if;

  update public.contact_sessions
     set token_hash = p_token_hash,
         expires_at = now() + make_interval(days => greatest(p_ttl_days, 1)),
         code_hash = null, code_expires_at = null
   where id = r.id;
  return true;
end;
$$;

-- Grants — the 227 lesson: definer functions default EXECUTE to PUBLIC
-- and the anon key is in git. Gateway (service role) only.
revoke execute on function public.portal_access_begin(uuid, text, text, text, int, int) from public, anon, authenticated;
revoke execute on function public.portal_access_verify(uuid, text, text, int, int)      from public, anon, authenticated;
grant  execute on function public.portal_access_begin(uuid, text, text, text, int, int) to service_role;
grant  execute on function public.portal_access_verify(uuid, text, text, int, int)      to service_role;

comment on function public.portal_access_begin is
  'CF-1: atomically reserve a pending portal-access code under per-contact and daily caps. NULL = capped, degrade politely.';
comment on function public.portal_access_verify is
  'CF-1: spend one attempt on a pending code; activate the contact session on a match. Five wrong guesses kill the code.';
