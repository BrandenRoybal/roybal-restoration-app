-- ============================================================
-- 229_contact_links — CRM steps 2–3 (docs/CRM_Design.md §5).
--
-- One nullable contact_id on each lane, the contact_timeline view,
-- the contact_merge extension 228 promised, and a conservative
-- backfill of the links.
--
--   unified_jobs.contact_id    — stamped by the field app's spine sync
--   sms_messages.contact_id    — stamped by roybal-notify's inbound webhook
--   email_messages.contact_id  — stamped by gmail-proxy when it files mail
--   portal_jobs.contact_id     — stamped by publishPortal() (which also
--                                stops writing unified_job_id: null)
--   capture_events.contact_id  — stamped by the phone lane
--
-- Backfill rules are deliberately conservative: a link is stamped only
-- when it is unambiguous — the spine re-resolves through the same
-- idempotent ladder that seeded it (migration 228 step 0), and the
-- message lanes stamp only when EXACTLY ONE live contact matches the
-- customer-side number/address. Ambiguity stays unlinked; the office
-- can link by hand later. coordination_jobs lead blobs are NOT
-- back-stamped here — post-hoc blob writes need the rev-bumping RPC
-- that lands with the board's own RPC cutover (doc §5).
--
-- SAFE & additive. Rollback: drop view contact_timeline; drop the five
-- contact_id columns; re-run 228's contact_merge definition.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Link columns
-- ------------------------------------------------------------
alter table public.unified_jobs   add column if not exists contact_id uuid references public.contacts (id) on delete set null;
alter table public.sms_messages   add column if not exists contact_id uuid references public.contacts (id) on delete set null;
alter table public.email_messages add column if not exists contact_id uuid references public.contacts (id) on delete set null;
alter table public.portal_jobs    add column if not exists contact_id uuid references public.contacts (id) on delete set null;
alter table public.capture_events add column if not exists contact_id uuid references public.contacts (id) on delete set null;

create index if not exists unified_jobs_contact_idx   on public.unified_jobs   (contact_id) where contact_id is not null;
create index if not exists sms_messages_contact_idx   on public.sms_messages   (contact_id) where contact_id is not null;
create index if not exists email_messages_contact_idx on public.email_messages (contact_id) where contact_id is not null;
create index if not exists portal_jobs_contact_idx    on public.portal_jobs    (contact_id) where contact_id is not null;
create index if not exists capture_events_contact_idx on public.capture_events (contact_id) where contact_id is not null;

-- ------------------------------------------------------------
-- 2. contact_timeline — AI Roadmap Phase 6's "one conversation thread
--    per customer", as a union over the lanes instead of a new store.
--    security_invoker: the caller's RLS applies, not the owner's; and
--    the 225/226 precedent — never a free PostgREST endpoint for anon.
-- ------------------------------------------------------------
create or replace view public.contact_timeline
  with (security_invoker = true) as
  select contact_id, 'sms' as lane, created_at as at,
         case direction when 'inbound' then 'in' when 'outbound' then 'out' else direction end as direction,
         body, unified_job_id::text as ref
    from public.sms_messages where contact_id is not null
  union all
  select contact_id, 'email', received_at,
         direction, coalesce(subject, ''), job_id::text
    from public.email_messages where contact_id is not null
  union all
  select pj.contact_id, 'portal', pm.created_at,
         pm.direction, pm.body, pj.id::text
    from public.portal_messages pm
    join public.portal_jobs pj on pj.id = pm.portal_job_id
   where pj.contact_id is not null
  union all
  select contact_id, 'call', captured_at,
         'in', coalesce(transcript, '(call)'), id::text
    from public.capture_events
   where contact_id is not null and source_type = 'phone_call';

revoke all on public.contact_timeline from anon;

comment on view public.contact_timeline is
  'Every conversation with a contact across SMS, email, portal, and phone calls — a security_invoker union over the lane tables, keyed by contact_id. Not a store; the lanes stay authoritative.';

-- ------------------------------------------------------------
-- 3. contact_merge, extended — the link-column repoint 228 promised.
--    Full replacement; body identical to 228 plus the repoint block.
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
      return false;
    end if;
  end if;

  if p_winner is null or p_loser is null or p_winner = p_loser then return false; end if;

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

  -- NEW in 229: the loser's lane links follow the person
  update public.unified_jobs   set contact_id = p_winner where contact_id = p_loser;
  update public.sms_messages   set contact_id = p_winner where contact_id = p_loser;
  update public.email_messages set contact_id = p_winner where contact_id = p_loser;
  update public.portal_jobs    set contact_id = p_winner where contact_id = p_loser;
  update public.capture_events set contact_id = p_winner where contact_id = p_loser;

  -- close ONLY this pair's own suggestions
  update public.contact_merge_suggestions
     set status = 'merged', resolved_at = now()
   where status = 'open' and contact_b is not null
     and contact_a in (p_winner, p_loser) and contact_b in (p_winner, p_loser);

  -- repoint the loser's remaining open rows at the winner
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

comment on function public.contact_merge is
  'Office-only merge: unions blanks into the winner, tombstones the loser, repoints every lane link column (229), closes the pair''s suggestions, repoints the rest.';

-- ------------------------------------------------------------
-- 4. Backfill the links
-- ------------------------------------------------------------

-- a. the spine: re-resolve through the idempotent ladder (step 0 / phone
--    match returns the 228-seeded contact; no duplicates are minted)
do $$
declare
  r record;
  v uuid;
begin
  for r in select id, owner_name, owner_phone, owner_email, property_address
             from public.unified_jobs
            where contact_id is null
              and (coalesce(owner_name,'') <> '' or coalesce(owner_phone,'') <> '' or coalesce(owner_email,'') <> '')
  loop
    v := public.contact_resolve(r.owner_name, r.owner_phone, r.owner_email, r.property_address, 'field', true, 'customer');
    if v is not null then
      update public.unified_jobs set contact_id = v where id = r.id;
    end if;
  end loop;
end;
$$;

-- b. portal shares ride the spine crosswalk — carry the person...
update public.portal_jobs pj
   set contact_id     = uj.contact_id,
       unified_job_id = coalesce(pj.unified_job_id, uj.id)
  from public.unified_jobs uj
 where pj.field_project_id = uj.field_project_id
   and uj.contact_id is not null
   and pj.contact_id is null;

-- ...and, independent of whether a contact resolved, pick up the
--    unified_job_id that publishPortal() used to write as null
update public.portal_jobs pj
   set unified_job_id = uj.id
  from public.unified_jobs uj
 where pj.field_project_id = uj.field_project_id
   and pj.unified_job_id is null;

-- c. SMS: customer-side number (inbound = from, outbound = to), single live
--    match only. Owner/crew-directed OUTBOUND kinds (brief, phoneOwner,
--    webOwner, webLead, forward, assistCrew, approval) are excluded — their
--    to_number is the owner, not a customer, so they must never land on a
--    customer's timeline. Inbound replies are always from a customer.
update public.sms_messages m
   set contact_id = x.cid
  from (
    select m2.id as mid, min(c.id::text)::uuid as cid
      from public.sms_messages m2
      join public.contacts c
        on c.merged_into is null and c.phone_norm <> ''
       and c.phone_norm = right(regexp_replace(
             case when m2.direction = 'inbound' then m2.from_number else m2.to_number end,
             '\D', '', 'g'), 10)
     where m2.contact_id is null
       and not (m2.direction = 'outbound'
                and m2.kind in ('brief','phoneOwner','webOwner','webLead','forward','assistCrew','approval'))
     group by m2.id
    having count(distinct c.id) = 1
  ) x
 where m.id = x.mid;

-- d. email: exact address first (customer side by direction)...
update public.email_messages m
   set contact_id = x.cid
  from (
    select m2.id as mid, min(c.id::text)::uuid as cid
      from public.email_messages m2
      join public.contacts c
        on c.merged_into is null and c.email_norm <> ''
       and c.email_norm = lower(btrim(
             case when m2.direction = 'in' then m2.from_addr else m2.to_addr end))
     where m2.contact_id is null
     group by m2.id
    having count(distinct c.id) = 1
  ) x
 where m.id = x.mid;

--    ...then the job crosswalk for the rest (job_id is a field_projects id
--    stored as TEXT in 208 — compare as text, never cast the free-form side)
update public.email_messages m
   set contact_id = uj.contact_id
  from public.unified_jobs uj
 where m.contact_id is null
   and uj.field_project_id::text = m.job_id
   and uj.contact_id is not null;

-- e. phone calls: caller number, single live match only
update public.capture_events e
   set contact_id = x.cid
  from (
    select e2.id as eid, min(c.id::text)::uuid as cid
      from public.capture_events e2
      join public.contacts c
        on c.merged_into is null and c.phone_norm <> ''
       and c.phone_norm = right(regexp_replace(coalesce(e2.raw_payload->>'from',''), '\D', '', 'g'), 10)
     where e2.contact_id is null and e2.source_type = 'phone_call'
     group by e2.id
    having count(distinct c.id) = 1
  ) x
 where e.id = x.eid;
