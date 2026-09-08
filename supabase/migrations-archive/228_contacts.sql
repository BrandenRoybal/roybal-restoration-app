-- ============================================================
-- 228_contacts — the person spine. CRM Phase 1 (docs/CRM_Design.md §3).
--
-- Two tables, three functions, and a one-shot backfill:
--   contacts                  — one row per person/company we deal with
--   contact_merge_suggestions — the review queue decision 9 demands
--   contact_canonical(id)     — follows the merged_into chain
--   contact_resolve(...)      — find-or-create, advisory-lock serialized
--   contact_merge(...)        — office-only merge with tombstone
--
-- ⚠️ PRECONDITION — ✅ SATISFIED 2026-08-13 (owner disabled public
-- sign-ups in the dashboard before this migration merged). 216 forces
-- every new signup to role 'tech', and this migration trusts 'tech' as
-- a class — an open signup page plus the anon key in git would let a
-- stranger enroll themselves as trusted crew. 216's rollout step 0
-- recommended this; contacts make it overdue.
--
-- DESIGN RULES (docs/CRM_Design.md §2–§3, adversarially reviewed):
--   * Auto-link on exact 10-digit phone. A TRUSTED caller may also
--     link on exact email + exact name (same address-book entry —
--     decision 9 amendment, 2026-08-13). Untrusted lanes never link
--     on anything weaker than phone: self-reported name+email on a
--     public lane is attacker-controlled, so it creates + suggests.
--   * Fills never overwrite. Trusted callers fill BLANK fields only;
--     a DIFFERING non-blank value queues a 'conflict' suggestion for
--     the office (new phone numbers and changed emails surface instead
--     of silently rotting or silently overwriting).
--   * Every weaker match (email w/ different name, name+street, bare
--     name) creates a contact AND queues a pair suggestion — silent
--     duplicates never bypass the queue.
--   * Machine accounts are fenced at the TABLE, not just the RPC:
--     restrictive policies deny phone-agent@/office-brief@ direct
--     writes (the 204/205 precedent — a hijacked agent must not be
--     able to repoint a customer's email over PostgREST).
--   * merged_into / qbo_customer_id / review_asked_at move only
--     through definer RPCs or service role (216's column-privilege
--     technique) — tombstoning is not a tablet operation.
--   * All caller input is length-capped before it can reach an index
--     (the 227 discipline).
--
-- SAFE & additive. No existing table or blob field is touched.
-- Rollback: drop function contact_merge, contact_resolve,
-- contact_canonical; drop table contact_merge_suggestions, contacts.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. contacts
-- ------------------------------------------------------------
create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'person' check (kind in ('person','company')),
  role        text not null default 'customer',  -- customer | adjuster | agent | property_manager | sub | other
  name        text not null,
  company     text not null default '',
  phone       text not null default '',          -- as entered
  phone_norm  text generated always as (right(regexp_replace(phone, '\D', '', 'g'), 10)) stored,
  email       text not null default '',
  email_norm  text generated always as (lower(btrim(email))) stored,
  address     text not null default '',          -- mailing address (properties come in migration 230)
  qbo_customer_id text,                          -- persisted on first invoice push — ends the DisplayName fork
  source      text not null default '',          -- lane that produced this person (backfilled rows: richest lane)
  notes       text not null default '',
  marketing_opt_in boolean not null default false,  -- job traffic rides Work Auth; outreach needs its own yes
  review_asked_at  timestamptz,                     -- "tracks who was asked" (AI roadmap Phase 5)
  merged_into uuid references public.contacts (id), -- merge tombstone; resolvers FOLLOW the chain to the winner
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists contacts_phone_idx on public.contacts (phone_norm) where phone_norm <> '';
create index if not exists contacts_email_idx on public.contacts (email_norm) where email_norm <> '';
create index if not exists contacts_merged_idx on public.contacts (merged_into) where merged_into is not null;

drop trigger if exists trg_contacts_touch on public.contacts;
create trigger trg_contacts_touch
  before insert or update on public.contacts
  for each row execute function public.coordination_touch();

-- RLS: the 106/208 precedent, not the blob tables' blanket `for all`.
alter table public.contacts enable row level security;
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated using (true);
drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to authenticated with check (true);
drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update to authenticated using (true) with check (true);
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete to authenticated using (true);
drop policy if exists contacts_admin_only_delete on public.contacts;
create policy contacts_admin_only_delete on public.contacts
  as restrictive for delete to authenticated
  using (public.is_admin());

-- The 204/205 machine fence, carried forward: the AI service accounts
-- read contacts (the phone agent greets by name through its RPC lane)
-- but can never write the address book over PostgREST. Without this, a
-- prompt-injected agent could repoint any customer's email — the exact
-- attack the p_trusted gate below exists to stop.
drop policy if exists contacts_no_machine_insert on public.contacts;
create policy contacts_no_machine_insert on public.contacts
  as restrictive for insert to authenticated
  with check (coalesce(auth.email(), '') not in
    ('phone-agent@roybalconstruction.com', 'office-brief@roybalconstruction.com'));
drop policy if exists contacts_no_machine_update on public.contacts;
create policy contacts_no_machine_update on public.contacts
  as restrictive for update to authenticated
  using (coalesce(auth.email(), '') not in
    ('phone-agent@roybalconstruction.com', 'office-brief@roybalconstruction.com'));

-- 216's column-privilege technique: merged_into, qbo_customer_id and
-- review_asked_at move only through the definer RPCs / service role.
-- A tablet can correct a phone number; it cannot tombstone the
-- address book or rewire QuickBooks identity.
revoke insert, update on public.contacts from authenticated;
grant insert (name, kind, role, company, phone, email, address, notes, marketing_opt_in, source)
  on public.contacts to authenticated;
grant update (name, kind, role, company, phone, email, address, notes, marketing_opt_in)
  on public.contacts to authenticated;

comment on table public.contacts is
  'The person spine (CRM Phase 1). One row per person/company; jobs, messages, and leads link here. Merged rows carry merged_into; resolvers follow the chain to the winner.';

-- ------------------------------------------------------------
-- 2. contact_merge_suggestions — the review queue
--    A row is a possible-duplicate pair (contact_b set) or a proposed
--    field change (contact_b null: 'untrusted-fill' from a public
--    lane, or 'conflict' when a value differs from what is on file).
-- ------------------------------------------------------------
create table if not exists public.contact_merge_suggestions (
  id          uuid primary key default gen_random_uuid(),
  contact_a   uuid not null references public.contacts (id) on delete cascade,
  contact_b   uuid references public.contacts (id) on delete cascade,
  reason      text not null check (reason in ('email','name-address','name','untrusted-fill','conflict')),
  detail      jsonb not null default '{}'::jsonb,   -- the payload only; provenance lives in source
  source      text not null default '',
  status      text not null default 'open' check (status in ('open','merged','dismissed')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

-- One open suggestion per unordered pair+reason; field proposals
-- dedupe on a digest of the payload (a raw jsonb btree would carry a
-- ~2.7 KB index-row ceiling an attacker-sized email could trip).
create unique index if not exists contact_suggest_pair_idx
  on public.contact_merge_suggestions (least(contact_a, contact_b), greatest(contact_a, contact_b), reason)
  where contact_b is not null and status = 'open';
create unique index if not exists contact_suggest_fill_idx
  on public.contact_merge_suggestions (contact_a, reason, md5(detail::text))
  where contact_b is null and status = 'open';

-- The office reads and resolves; nobody else touches the queue. Rows
-- are written only by the definer RPCs, and resolving (dismiss/apply)
-- is admin-gated — the queue is the control decision 9 leans on, so a
-- tech or a hijacked machine account must not be able to launder it.
alter table public.contact_merge_suggestions enable row level security;
drop policy if exists contact_suggest_select on public.contact_merge_suggestions;
create policy contact_suggest_select on public.contact_merge_suggestions
  for select to authenticated using (true);
drop policy if exists contact_suggest_update on public.contact_merge_suggestions;
create policy contact_suggest_update on public.contact_merge_suggestions
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 3. contact_canonical — follow the merge chain to the live row.
--    Internal helper for the RPCs; not a client endpoint.
-- ------------------------------------------------------------
create or replace function public.contact_canonical(p_id uuid)
returns uuid
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_id   uuid := p_id;
  v_next uuid;
  i      int  := 0;
begin
  loop
    select merged_into into v_next from public.contacts where id = v_id;
    exit when v_next is null or i >= 10;   -- chains are flattened at merge; 10 is a paranoia bound
    v_id := v_next;
    i := i + 1;
  end loop;
  return v_id;
end;
$$;

revoke execute on function public.contact_canonical(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. contact_resolve — find-or-create, or refuse
--
-- Returns the contact id, or NULL when the caller is refused or the
-- input is empty. NULL is not an error (the 227 convention).
--
-- Ladder:
--   0. exact identity (name+phone+email+address) → return it
--      (this is what makes re-runs and backfills idempotent)
--   1. exact 10-digit phone → link. Trusted: fill blanks. Untrusted:
--      blank-fill proposals queue as 'untrusted-fill'. Both: differing
--      non-blank values queue as 'conflict'. Never overwrite.
--   2. exact email → trusted + same name: link (+ fills/conflicts);
--      blank input name: link, no fill; otherwise create + 'email'
--      pair suggestion (decision 9).
--   3. same name + same street number → create + 'name-address' pair
--   4. bare exact-name match → create + 'name' pair (fragments must
--      not bypass the queue)
--   5. create (name falls back to email/phone — no nameless shells)
--
-- Caller gate (inside the function, because SECURITY DEFINER ignores
-- the caller's RLS fencing): service-role calls (auth.uid() null)
-- pass as called; admin/office/tech pass as called; the phone-agent
-- machine user is admitted UNTRUSTED ONLY; everyone else is refused.
-- Fail-closed: an unknown or missing role refuses.
-- ------------------------------------------------------------
create or replace function public.contact_resolve(
  p_name    text,
  p_phone   text,
  p_email   text,
  p_address text,
  p_source  text default '',
  p_trusted boolean default false,
  p_role    text default 'customer'
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_caller_role  text;
  v_caller_email text;
  v_trusted boolean := coalesce(p_trusted, false);
  -- every input is capped before it can reach an index (227 discipline)
  v_name    text := left(btrim(coalesce(p_name, '')), 200);
  v_phone   text := left(btrim(coalesce(p_phone, '')), 40);
  v_email   text := left(btrim(coalesce(p_email, '')), 320);
  v_addr    text := left(btrim(coalesce(p_address, '')), 500);
  v_source  text := left(btrim(coalesce(p_source, '')), 80);
  v_role    text := left(btrim(coalesce(nullif(p_role, ''), 'customer')), 40);
  v_name_n  text;
  v_phone_n text;
  v_email_n text;
  v_street  text;
  v_id      uuid;
  v_new     uuid;
  v_row     public.contacts%rowtype;
  v_diff    jsonb;
begin
  v_name_n  := lower(v_name);
  v_phone_n := right(regexp_replace(v_phone, '\D', '', 'g'), 10);
  v_email_n := lower(v_email);

  -- caller gate (fail closed)
  if v_uid is not null then
    select p.role::text, u.email into v_caller_role, v_caller_email
      from public.profiles p join auth.users u on u.id = p.id
     where p.id = v_uid;
    if v_caller_role in ('admin', 'office', 'tech') then
      null;  -- pass, trusted as called
    elsif v_caller_role = 'viewer' and v_caller_email = 'phone-agent@roybalconstruction.com' then
      v_trusted := false;  -- admitted untrusted only
    else
      return null;  -- refused: office-brief@, missing profile, unknown/future roles
    end if;
  end if;

  -- nothing to key on
  if v_name = '' and v_phone_n = '' and v_email_n = '' then
    return null;
  end if;

  -- serialize resolve AND merge on one key: a resolve racing a merge
  -- must not fill fields on a row tombstoned in the same instant
  perform pg_advisory_xact_lock(hashtext('roybal.contact_resolve'));

  -- 0. exact identity — idempotent re-entry (merged rows canonicalize)
  select id into v_id from public.contacts
   where lower(btrim(name)) = v_name_n
     and phone_norm = v_phone_n
     and email_norm = v_email_n
     and lower(btrim(address)) = lower(v_addr)
   order by (merged_into is null) desc, created_at
   limit 1;
  if v_id is not null then
    return public.contact_canonical(v_id);
  end if;

  -- 1. exact 10-digit phone
  if length(v_phone_n) = 10 then
    select id into v_id from public.contacts
     where phone_norm = v_phone_n
     order by (merged_into is null) desc, created_at
     limit 1;
    if v_id is not null then
      v_id := public.contact_canonical(v_id);
      select * into v_row from public.contacts where id = v_id;

      -- differing non-blank values are a signal, never an overwrite
      v_diff := jsonb_strip_nulls(jsonb_build_object(
        'name',    case when v_name_n  <> '' and lower(btrim(v_row.name))  <> v_name_n  then jsonb_build_object('have', v_row.name,    'got', v_name)  end,
        'email',   case when v_email_n <> '' and v_row.email <> '' and lower(btrim(v_row.email)) <> v_email_n then jsonb_build_object('have', v_row.email, 'got', v_email) end,
        'address', case when v_addr    <> '' and v_row.address <> '' and lower(btrim(v_row.address)) <> lower(v_addr) then jsonb_build_object('have', v_row.address, 'got', v_addr) end));
      if v_diff <> '{}'::jsonb then
        insert into public.contact_merge_suggestions (contact_a, reason, detail, source)
        values (v_id, 'conflict', v_diff, v_source)
        on conflict do nothing;
      end if;

      if v_trusted then
        update public.contacts set
          email   = case when email   = '' and v_email_n <> '' then v_email else email end,
          address = case when address = '' and v_addr    <> '' then v_addr  else address end
        where id = v_id;
      elsif (v_row.email = '' and v_email_n <> '') or (v_row.address = '' and v_addr <> '') then
        insert into public.contact_merge_suggestions (contact_a, reason, detail, source)
        values (v_id, 'untrusted-fill', jsonb_strip_nulls(jsonb_build_object(
                  'email',   case when v_row.email   = '' and v_email_n <> '' then v_email end,
                  'address', case when v_row.address = '' and v_addr    <> '' then v_addr end)),
                v_source)
        on conflict do nothing;
      end if;
      return v_id;
    end if;
  end if;

  -- 2. exact email
  if v_email_n <> '' then
    select id into v_id from public.contacts
     where email_norm = v_email_n
     order by (merged_into is null) desc, created_at
     limit 1;
    if v_id is not null then
      v_id := public.contact_canonical(v_id);
      select * into v_row from public.contacts where id = v_id;

      if v_name_n = '' then
        -- email-only input asserting nothing: return the match, change nothing
        return v_id;
      end if;

      if v_trusted and lower(btrim(v_row.name)) = v_name_n then
        -- decision 9 amendment: TRUSTED email + exact name = the same
        -- address-book entry. Untrusted lanes never take this branch —
        -- name and email are both self-reported there.
        v_diff := jsonb_strip_nulls(jsonb_build_object(
          'phone',   case when v_phone_n <> '' and v_row.phone <> '' and right(regexp_replace(v_row.phone,'\D','','g'),10) <> v_phone_n then jsonb_build_object('have', v_row.phone, 'got', v_phone) end,
          'address', case when v_addr <> '' and v_row.address <> '' and lower(btrim(v_row.address)) <> lower(v_addr) then jsonb_build_object('have', v_row.address, 'got', v_addr) end));
        if v_diff <> '{}'::jsonb then
          insert into public.contact_merge_suggestions (contact_a, reason, detail, source)
          values (v_id, 'conflict', v_diff, v_source)
          on conflict do nothing;
        end if;
        update public.contacts set
          phone   = case when phone   = '' and v_phone_n <> '' then v_phone else phone end,
          address = case when address = '' and v_addr    <> '' then v_addr  else address end
        where id = v_id;
        return v_id;
      end if;

      -- untrusted, or a different name on a shared email: create + suggest
      insert into public.contacts (name, phone, email, address, source, role)
      values (v_name, v_phone, v_email, v_addr, v_source, v_role)
      returning id into v_new;
      insert into public.contact_merge_suggestions (contact_a, contact_b, reason, detail, source)
      values (v_id, v_new, 'email', jsonb_build_object('email', v_email_n), v_source)
      on conflict do nothing;
      return v_new;
    end if;
  end if;

  -- 3. same name + same street number → create + suggestion
  v_street := (regexp_match(v_addr, '^\s*(\d+)'))[1];
  if v_name_n <> '' and v_street is not null then
    select id into v_id from public.contacts
     where merged_into is null
       and lower(btrim(name)) = v_name_n
       and (regexp_match(btrim(address), '^\s*(\d+)'))[1] = v_street
     order by created_at limit 1;
    if v_id is not null then
      insert into public.contacts (name, phone, email, address, source, role)
      values (v_name, v_phone, v_email, v_addr, v_source, v_role)
      returning id into v_new;
      insert into public.contact_merge_suggestions (contact_a, contact_b, reason, detail, source)
      values (v_id, v_new, 'name-address', jsonb_build_object('name', v_name, 'street', v_street), v_source)
      on conflict do nothing;
      return v_new;
    end if;
  end if;

  -- 4. bare exact-name match — the weakest rung. Phone-less, email-less
  -- fragments (7 of the 11 live adjusters) must still reach the queue
  -- instead of silently duplicating.
  if v_name_n <> '' then
    select id into v_id from public.contacts
     where merged_into is null and lower(btrim(name)) = v_name_n
     order by created_at limit 1;
    if v_id is not null then
      insert into public.contacts (name, phone, email, address, source, role)
      values (v_name, v_phone, v_email, v_addr, v_source, v_role)
      returning id into v_new;
      insert into public.contact_merge_suggestions (contact_a, contact_b, reason, detail, source)
      values (v_id, v_new, 'name', jsonb_build_object('name', v_name), v_source)
      on conflict do nothing;
      return v_new;
    end if;
  end if;

  -- 5. a new person (never a nameless shell)
  insert into public.contacts (name, phone, email, address, source, role)
  values (coalesce(nullif(v_name, ''), nullif(v_email, ''), v_phone_n), v_phone, v_email, v_addr, v_source, v_role)
  returning id into v_id;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. contact_merge — office-only merge
--    Unions blank fields into the winner, tombstones the loser,
--    flattens chains, closes ONLY the pair's own suggestions, and
--    repoints the loser's other open suggestions at the winner.
--    Migration 229 extends this to repoint the lane link columns.
-- ------------------------------------------------------------
create or replace function public.contact_merge(
  p_winner uuid,
  p_loser  uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_l    public.contacts%rowtype;
  r      record;
  v_a    uuid;
  v_b    uuid;
begin
  -- fail closed: a missing profiles row must refuse, not fall through
  if v_uid is not null then
    select p.role::text into v_role from public.profiles p where p.id = v_uid;
    if v_role is null or v_role not in ('admin', 'office') then
      return false;  -- merging people is an office decision, not a tablet tap
    end if;
  end if;

  if p_winner is null or p_loser is null or p_winner = p_loser then return false; end if;

  -- same key as contact_resolve: merge and resolve serialize together
  perform pg_advisory_xact_lock(hashtext('roybal.contact_resolve'));

  select * into v_l from public.contacts where id = p_loser  and merged_into is null;
  if v_l.id is null then return false; end if;
  perform 1 from public.contacts where id = p_winner and merged_into is null;
  if not found then return false; end if;

  update public.contacts w set
    phone   = case when w.phone   = '' then v_l.phone   else w.phone   end,
    email   = case when w.email   = '' then v_l.email   else w.email   end,
    address = case when w.address = '' then v_l.address else w.address end,
    company = case when w.company = '' then v_l.company else w.company end,
    notes   = case when v_l.notes = '' then w.notes
                   when w.notes  = ''  then v_l.notes
                   else w.notes || E'\n' || v_l.notes end,
    qbo_customer_id  = coalesce(w.qbo_customer_id, v_l.qbo_customer_id),
    marketing_opt_in = w.marketing_opt_in or v_l.marketing_opt_in,
    review_asked_at  = greatest(w.review_asked_at, v_l.review_asked_at)
  where w.id = p_winner;

  update public.contacts set merged_into = p_winner where id = p_loser;
  update public.contacts set merged_into = p_winner where merged_into = p_loser;

  -- close ONLY this pair's own suggestions...
  update public.contact_merge_suggestions
     set status = 'merged', resolved_at = now()
   where status = 'open' and contact_b is not null
     and contact_a in (p_winner, p_loser) and contact_b in (p_winner, p_loser);

  -- ...and repoint the loser's remaining open rows at the winner,
  -- dropping any that would duplicate an existing open suggestion.
  for r in select * from public.contact_merge_suggestions
            where status = 'open' and (contact_a = p_loser or contact_b = p_loser)
  loop
    v_a := case when r.contact_a = p_loser then p_winner else r.contact_a end;
    v_b := case when r.contact_b = p_loser then p_winner else r.contact_b end;
    if v_a = v_b then
      delete from public.contact_merge_suggestions where id = r.id;
    else
      begin
        update public.contact_merge_suggestions
           set contact_a = v_a, contact_b = v_b where id = r.id;
      exception when unique_violation then
        delete from public.contact_merge_suggestions where id = r.id;
      end;
    end if;
  end loop;

  return true;
end;
$$;

-- ------------------------------------------------------------
-- Grants — MANDATORY (the 227 lesson): SECURITY DEFINER functions
-- default EXECUTE to PUBLIC, and the anon key is published in git.
-- ------------------------------------------------------------
revoke execute on function public.contact_resolve(text, text, text, text, text, boolean, text) from public, anon;
revoke execute on function public.contact_merge(uuid, uuid) from public, anon;
grant  execute on function public.contact_resolve(text, text, text, text, text, boolean, text) to authenticated, service_role;
grant  execute on function public.contact_merge(uuid, uuid) to authenticated, service_role;

comment on function public.contact_resolve is
  'Find-or-create a contact. NULL = refused caller or empty input, not an error. Auto-links on exact phone (any trusted lane) or email+name (trusted only); weaker evidence creates + queues a suggestion; differing values queue conflicts, never overwrite.';
comment on function public.contact_merge is
  'Office-only merge: unions blanks into the winner, tombstones the loser via merged_into, closes the pair''s suggestions, repoints the rest. Extended by migration 229 to repoint lane link columns.';

-- ------------------------------------------------------------
-- 6. Backfill — seed the spine from the three stores that hold
--    customer identity today. Runs as the migration role (trusted).
--    Idempotent: identical rows re-enter through ladder step 0.
--    Note on source: loops run field → legacy → board, so a customer
--    seen in several stores keeps the FIRST loop's source; live lanes
--    will record true first-touch going forward.
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  -- a. field jobs via the spine (richest, already typed)
  for r in select owner_name, owner_phone, owner_email, property_address
             from public.unified_jobs
            where coalesce(owner_name,'') <> '' or coalesce(owner_phone,'') <> '' or coalesce(owner_email,'') <> ''
            order by created_at
  loop
    perform public.contact_resolve(r.owner_name, r.owner_phone, r.owner_email, r.property_address, 'field', true, 'customer');
  end loop;

  -- b. their adjusters (address book, role-tagged)
  for r in select distinct adjuster_name, adjuster_phone, adjuster_email
             from public.unified_jobs
            where coalesce(adjuster_name,'') <> ''
  loop
    perform public.contact_resolve(r.adjuster_name, r.adjuster_phone, r.adjuster_email, '', 'field', true, 'adjuster');
  end loop;

  -- c. the legacy typed jobs table (old React app; still applied on remote)
  if to_regclass('public.jobs') is not null then
    for r in execute 'select owner_name, owner_phone, owner_email, property_address,
                             adjuster_name, adjuster_phone, adjuster_email
                        from public.jobs'
    loop
      if coalesce(r.owner_name,'') <> '' or coalesce(r.owner_phone,'') <> '' then
        perform public.contact_resolve(r.owner_name, r.owner_phone, r.owner_email, r.property_address, 'backfill', true, 'customer');
      end if;
      if coalesce(r.adjuster_name,'') <> '' then
        perform public.contact_resolve(r.adjuster_name, r.adjuster_phone, r.adjuster_email, '', 'backfill', true, 'adjuster');
      end if;
    end loop;
  end if;

  -- d. board jobs and leads (blobs; channel becomes source when present)
  for r in select data->>'customer' as customer, data->>'phone' as phone,
                  data->>'email' as email, data->>'address' as address,
                  coalesce(nullif(data->>'channel',''), 'backfill') as source
             from public.coordination_jobs
            where deleted = false
              and (coalesce(data->>'customer','') <> '' or coalesce(data->>'phone','') <> '')
            order by created_at
  loop
    perform public.contact_resolve(r.customer, r.phone, r.email, r.address, r.source, true, 'customer');
  end loop;
end;
$$;
