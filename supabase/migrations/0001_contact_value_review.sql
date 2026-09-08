-- ============================================================================
-- 0001 — a value review has two answers, and stops asking about formatting
--
-- contact_merge_suggestions carries two different questions under one name:
--
--   * a PAIR (contact_b set) asks "are these two records the same person?"
--   * a FIELD proposal (contact_b null, reason 'conflict'/'untrusted-fill')
--     asks "the person is known — which spelling of this one value is right?"
--
-- The queue only ever offered "Not a match", which answers the first question.
-- On a field proposal it answers nothing, so the only way to clear one was to
-- dismiss it. The office UI now offers both sides per field (apps/admin);
-- this migration is the other half: stop raising the ones that were never a
-- disagreement in the first place.
--
-- Of the five open on 2026-09-08, four were formatting:
--   "2400 Maria St. Fairbanks,  AK 99709" vs the same with one space
--   "3018 Nate Circle"          vs "3018 Nate Circle North Pole, AK 99705"
--   "1911 Central Ave, fairbanks, ak 99701" vs "1911 Central Ave. Fairbanks…"
--   phone 9073475457            vs a typo'd stored 907-34-5457, fixed since
-- Only "3011 Nate Cir" vs "3018 Nate Circle" (a different house) and
-- "Danny tilley" vs "Danny Tilly" (a different spelling) deserved a human.
--
-- SCOPE: this changes what gets RECORDED as a conflict, never what gets
-- MATCHED. contact_resolve's lookups are untouched — who links to whom is a
-- much larger blast radius than which review rows appear, and nothing here
-- should move it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One comparison, used by the resolver and mirrored in apps/admin/js/contacts.js
-- so the queue never asks about a difference the resolver would no longer make.
-- ---------------------------------------------------------------------------
create or replace function public.contact_same_value(p_kind text, p_a text, p_b text)
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  a    text := lower(btrim(coalesce(p_a, '')));
  b    text := lower(btrim(coalesce(p_b, '')));
  pats text[] := array['(street|str|st)', '(avenue|ave|av)', '(circle|cir)', '(road|rd)',
                       '(drive|drv|dr)', '(lane|ln)', '(boulevard|blvd)', '(court|ct)',
                       '(place|pl)', '(highway|hwy)', '(suite|ste)', '(apartment|apt)'];
  reps text[] := array['st', 'av', 'cir', 'rd', 'dr', 'ln', 'blvd', 'ct', 'pl', 'hwy', 'ste', 'apt'];
  sh   text;
  lo   text;
  i    int;
begin
  if p_kind = 'phone' then
    a := right(regexp_replace(a, '\D', '', 'g'), 10);
    b := right(regexp_replace(b, '\D', '', 'g'), 10);
    return a <> '' and a = b;
  end if;

  -- case, punctuation and runs of whitespace are formatting, not disagreement
  a := btrim(regexp_replace(regexp_replace(a, '[.,#]', ' ', 'g'), '\s+', ' ', 'g'));
  b := btrim(regexp_replace(regexp_replace(b, '[.,#]', ' ', 'g'), '\s+', ' ', 'g'));

  if p_kind <> 'address' then
    return a = b;
  end if;

  -- "Ave." and "Avenue" are one street; so are "Cir" and "Circle"
  for i in 1 .. array_length(pats, 1) loop
    a := regexp_replace(a, '\m' || pats[i] || '\M', reps[i], 'g');
    b := regexp_replace(b, '\m' || pats[i] || '\M', reps[i], 'g');
  end loop;
  if a = b then
    return true;
  end if;

  -- one address written short and one written long is still one address, as
  -- long as the short one is a whole leading run of tokens of the long one:
  -- "3018 nate cir" inside "3018 nate cir north pole ak 99705". A different
  -- street number ("3011 nate cir") fails on the very first token, which is
  -- the case that has to keep reaching a human.
  if length(a) <= length(b) then sh := a; lo := b; else sh := b; lo := a; end if;
  return length(sh) >= 8 and left(lo, length(sh) + 1) = sh || ' ';
end;
$$;

alter function public.contact_same_value(text, text, text) owner to postgres;
comment on function public.contact_same_value(text, text, text) is
  'True when two values differ only in formatting. Used to decide whether a difference is worth a review row, never to decide whether two contacts match.';
revoke all on function public.contact_same_value(text, text, text) from public;
grant execute on function public.contact_same_value(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- contact_resolve, unchanged except for the four comparisons that decide
-- whether a difference is worth recording.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contact_resolve(p_name text, p_phone text, p_email text, p_address text, p_source text DEFAULT ''::text, p_trusted boolean DEFAULT false, p_role text DEFAULT 'customer'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid     uuid := auth.uid();
  v_caller_role  text;
  v_caller_email text;
  v_trusted boolean := coalesce(p_trusted, false);
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
      null;
    elsif v_caller_role = 'viewer' and v_caller_email = 'phone-agent@roybalconstruction.com' then
      v_trusted := false;
    else
      return null;
    end if;
  end if;

  if v_name = '' and v_phone_n = '' and v_email_n = '' then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('roybal.contact_resolve'));

  -- 0. exact identity — idempotent re-entry
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

      v_diff := jsonb_strip_nulls(jsonb_build_object(
        'name',    case when v_name_n  <> '' and not public.contact_same_value('name', v_row.name, v_name) then jsonb_build_object('have', v_row.name, 'got', v_name) end,
        'email',   case when v_email_n <> '' and v_row.email <> '' and not public.contact_same_value('email', v_row.email, v_email) then jsonb_build_object('have', v_row.email, 'got', v_email) end,
        'address', case when v_addr    <> '' and v_row.address <> '' and not public.contact_same_value('address', v_row.address, v_addr) then jsonb_build_object('have', v_row.address, 'got', v_addr) end));
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
        return v_id;
      end if;

      if v_trusted and lower(btrim(v_row.name)) = v_name_n then
        v_diff := jsonb_strip_nulls(jsonb_build_object(
          'phone',   case when v_phone_n <> '' and v_row.phone <> '' and not public.contact_same_value('phone', v_row.phone, v_phone) then jsonb_build_object('have', v_row.phone, 'got', v_phone) end,
          'address', case when v_addr <> '' and v_row.address <> '' and not public.contact_same_value('address', v_row.address, v_addr) then jsonb_build_object('have', v_row.address, 'got', v_addr) end));
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

  -- 4. bare exact-name match — fragments must not bypass the queue
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

-- ---------------------------------------------------------------------------
-- The rows already sitting in the queue. Each open field proposal is re-tested
-- against what the contact holds NOW — several were settled by hand months ago
-- and nothing ever closed them — and against the comparison above. What is
-- left is written back; a proposal with nothing left is closed.
-- ---------------------------------------------------------------------------
do $cleanup$
declare
  r    record;
  c    public.contacts%rowtype;
  live jsonb;
  fld  text;
  have text;
  got  text;
begin
  for r in
    select * from public.contact_merge_suggestions
     where status = 'open' and contact_b is null and reason in ('conflict', 'untrusted-fill')
  loop
    select * into c from public.contacts where id = r.contact_a;
    if not found then
      update public.contact_merge_suggestions
         set status = 'dismissed', resolved_at = now() where id = r.id;
      continue;
    end if;

    live := '{}'::jsonb;
    for fld in select jsonb_object_keys(r.detail) loop
      continue when fld not in ('name', 'company', 'phone', 'email', 'address');
      got := btrim(coalesce(case when jsonb_typeof(r.detail -> fld) = 'object'
                                 then r.detail -> fld ->> 'got'
                                 else r.detail ->> fld end, ''));
      continue when got = '';
      have := btrim(case fld when 'name'    then c.name
                             when 'company' then c.company
                             when 'phone'   then c.phone
                             when 'email'   then c.email
                             else c.address end);
      continue when public.contact_same_value(fld, have, got);
      live := live || jsonb_build_object(fld, r.detail -> fld);
    end loop;

    if live = '{}'::jsonb then
      update public.contact_merge_suggestions
         set status = 'dismissed', resolved_at = now() where id = r.id;
    elsif live <> r.detail then
      -- contact_suggest_fill_idx is unique on md5(detail::text); if trimming
      -- makes this row a twin of another open one, close it rather than fail
      if exists (select 1 from public.contact_merge_suggestions
                  where contact_a = r.contact_a and reason = r.reason
                    and contact_b is null and status = 'open' and id <> r.id
                    and md5(detail::text) = md5(live::text)) then
        update public.contact_merge_suggestions
           set status = 'dismissed', resolved_at = now() where id = r.id;
      else
        update public.contact_merge_suggestions set detail = live where id = r.id;
      end if;
    end if;
  end loop;
end
$cleanup$;
