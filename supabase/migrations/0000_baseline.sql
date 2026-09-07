


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."billing_type" AS ENUM (
    'tm',
    'scope'
);


ALTER TYPE "public"."billing_type" OWNER TO "postgres";


CREATE TYPE "public"."equipment_type" AS ENUM (
    'lgr_dehumidifier',
    'refrigerant_dehumidifier',
    'air_mover',
    'hepa_scrubber',
    'hepa_vac',
    'axial_fan',
    'other'
);


ALTER TYPE "public"."equipment_type" OWNER TO "postgres";


CREATE TYPE "public"."job_status" AS ENUM (
    'new',
    'active',
    'drying',
    'final_inspection',
    'invoicing',
    'closed',
    'lead',
    'inspection_scheduled',
    'inspection_complete',
    'emergency_services',
    'mitigation_active',
    'mitigation_complete',
    'estimate_pending',
    'estimate_approved',
    'reconstruction_active',
    'punch_list',
    'invoice_submitted',
    'payment_pending'
);


ALTER TYPE "public"."job_status" OWNER TO "postgres";


CREATE TYPE "public"."loss_category" AS ENUM (
    'cat1',
    'cat2',
    'cat3'
);


ALTER TYPE "public"."loss_category" OWNER TO "postgres";


CREATE TYPE "public"."loss_type" AS ENUM (
    'water',
    'fire',
    'mold',
    'freeze',
    'other'
);


ALTER TYPE "public"."loss_type" OWNER TO "postgres";


CREATE TYPE "public"."photo_category" AS ENUM (
    'before',
    'during',
    'after',
    'moisture',
    'equipment',
    'general'
);


ALTER TYPE "public"."photo_category" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'admin',
    'tech',
    'viewer',
    'office'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_blob_emptyish"("v" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select v is null
      or jsonb_typeof(v) = 'null'
      or (jsonb_typeof(v) = 'string' and (v #>> '{}') = '')
      or (jsonb_typeof(v) = 'array'  and jsonb_array_length(v) = 0)
      or (jsonb_typeof(v) = 'object' and v = '{}'::jsonb);
$$;


ALTER FUNCTION "public"."_blob_emptyish"("v" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_all_ids"("arr" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select jsonb_typeof(arr) = 'array' and not exists (
    select 1 from jsonb_array_elements(arr) e
    where jsonb_typeof(e) <> 'object' or coalesce(e->>'id','') = ''
  );
$$;


ALTER FUNCTION "public"."_mf_all_ids"("arr" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_emptyish"("v" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select v is null
      or jsonb_typeof(v) = 'null'
      or (jsonb_typeof(v) = 'string' and v #>> '{}' = '')
      or (jsonb_typeof(v) = 'array'  and jsonb_array_length(v) = 0)
      or (jsonb_typeof(v) = 'object' and not exists (select 1 from jsonb_object_keys(v)));
$$;


ALTER FUNCTION "public"."_mf_emptyish"("v" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_form"("nv" "jsonb", "ov" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  out jsonb; k text; missing jsonb; v jsonb;
begin
  if ov is null then return nv; end if;
  if public._mf_emptyish(nv) and not public._mf_emptyish(ov) then
    return ov;
  end if;

  if jsonb_typeof(nv) = 'array' and jsonb_typeof(ov) = 'array' then
    if public._mf_all_ids(nv) and public._mf_all_ids(ov) then
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into missing
      from jsonb_array_elements(ov) with ordinality as t(e, ord)
      where not exists (select 1 from jsonb_array_elements(nv) x where x -> 'id' = e -> 'id');
      if jsonb_array_length(missing) > 0 then return nv || missing; end if;
      return nv;
    end if;
    return nv;
  end if;

  if public._mf_is_obj(nv) and public._mf_is_obj(ov) then
    out := nv;
    for k in select jsonb_object_keys(ov) loop
      v := public._mf_form(nv -> k, ov -> k);
      if v is not null then out := jsonb_set(out, array[k], v, true);
      else out := out - k; end if;
    end loop;
    return out;
  end if;

  return nv;
end;
$$;


ALTER FUNCTION "public"."_mf_form"("nv" "jsonb", "ov" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_is_obj"("v" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select v is not null and jsonb_typeof(v) = 'object';
$$;


ALTER FUNCTION "public"."_mf_is_obj"("v" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs'];
  marks jsonb; k text; arr jsonb; kept jsonb;
begin
  marks := blob -> 'deletedIds';
  if marks is null or jsonb_typeof(marks) <> 'object' or marks = '{}'::jsonb then return blob; end if;
  foreach k in array id_cols loop
    arr := blob -> k;
    if jsonb_typeof(arr) <> 'array' or jsonb_array_length(arr) = 0 then continue; end if;
    select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into kept
    from jsonb_array_elements(arr) with ordinality as t(e, ord)
    where not (jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> '' and marks ? (e->>'id'));
    if jsonb_array_length(kept) <> jsonb_array_length(arr) then
      blob := jsonb_set(blob, array[k], kept, true);
    end if;
  end loop;
  return blob;
end;
$$;


ALTER FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_sync_guard"("p_build" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."_sync_guard"("p_build" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ai_usage_set_month"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.billing_month := to_char(coalesce(new.created_at, now()) at time zone 'UTC', 'YYYY-MM');
  return new;
end;
$$;


ALTER FUNCTION "public"."ai_usage_set_month"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."capture_blob_history"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  regression     boolean := false;
  last_reg       timestamptz;
  rolling_id     bigint;
  rolling_anchor timestamptz;
begin
  if tg_op = 'UPDATE' then
    if old.data is not distinct from new.data
       and old.deleted is not distinct from new.deleted then
      return new;
    end if;

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
      select max(replaced_at) into last_reg
        from public.blob_history
       where table_name = tg_table_name and id = old.id and was_regression;
      if last_reg is not null and last_reg > now() - interval '1 minute' then
        return new;
      end if;
      insert into public.blob_history
        (table_name, id, data, deleted, row_updated_at, op, was_regression, updated_by)
      values
        (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'update', true, old.updated_by);
      return new;
    end if;

    select hist_id, first_captured_at into rolling_id, rolling_anchor
      from public.blob_history
     where table_name = tg_table_name and id = old.id
       and op = 'update' and not was_regression
     order by replaced_at desc
     limit 1;

    if rolling_id is not null and rolling_anchor > now() - interval '60 minutes' then
      update public.blob_history
         set data = old.data, deleted = old.deleted,
             row_updated_at = old.updated_at, replaced_at = now(),
             updated_by = old.updated_by
       where hist_id = rolling_id;
    else
      insert into public.blob_history
        (table_name, id, data, deleted, row_updated_at, op, was_regression, updated_by)
      values
        (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'update', false, old.updated_by);
    end if;
    return new;

  elsif tg_op = 'DELETE' then
    insert into public.blob_history
      (table_name, id, data, deleted, row_updated_at, op, was_regression, updated_by)
    values
      (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'delete', false, old.updated_by);
    return old;
  end if;
  return null;
exception when others then
  raise warning 'blob_history capture failed for %.%: %', tg_table_name, old.id, sqlerrm;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."capture_blob_history"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_is_dry"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.is_dry := case
    when lower(new.material_type) in ('drywall','gypsum','sheetrock')               then new.moisture_pct <= 1.0
    when lower(new.material_type) in ('wood','hardwood','subfloor','osb','plywood') then new.moisture_pct <= 19.0
    when lower(new.material_type) in ('concrete','slab','block')                    then new.moisture_pct <= 4.0
    else new.moisture_pct <= 16.0
  end;
  return new;
end;
$$;


ALTER FUNCTION "public"."compute_is_dry"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."contact_canonical"("p_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id   uuid := p_id;
  v_next uuid;
  i      int  := 0;
begin
  loop
    select merged_into into v_next from public.contacts where id = v_id;
    exit when v_next is null or i >= 10;
    v_id := v_next;
    i := i + 1;
  end loop;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."contact_canonical"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."contact_mark_review_asked"("p_contact" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  rc     int;
begin
  if v_uid is not null then
    select p.role::text into v_role from public.profiles p where p.id = v_uid;
    if v_role is null or v_role not in ('admin', 'office', 'tech') then
      return false;
    end if;
  end if;
  update public.contacts
     set review_asked_at = now()
   where id = p_contact and merged_into is null and review_asked_at is null;
  get diagnostics rc = row_count;
  return rc = 1;
end;
$$;


ALTER FUNCTION "public"."contact_mark_review_asked"("p_contact" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."contact_mark_review_asked"("p_contact" "uuid") IS 'CF-4: the never-ask-twice review stamp. Office roles only (in-function gate); true = this call stamped it.';



CREATE OR REPLACE FUNCTION "public"."contact_merge"("p_winner" "uuid", "p_loser" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_l    public.contacts%rowtype;
  r      record;
  v_a    uuid;
  v_b    uuid;
begin
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

  update public.unified_jobs   set contact_id = p_winner where contact_id = p_loser;
  update public.sms_messages   set contact_id = p_winner where contact_id = p_loser;
  update public.email_messages set contact_id = p_winner where contact_id = p_loser;
  update public.portal_jobs    set contact_id = p_winner where contact_id = p_loser;
  update public.capture_events set contact_id = p_winner where contact_id = p_loser;

  for r in select id from public.coordination_jobs
            where deleted = false and data->>'contactId' = p_loser::text
  loop
    perform public.coordination_job_patch(r.id, jsonb_build_object('contactId', p_winner::text));
  end loop;

  update public.contact_merge_suggestions
     set status = 'merged', resolved_at = now()
   where status = 'open' and contact_b is not null
     and contact_a in (p_winner, p_loser) and contact_b in (p_winner, p_loser);

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


ALTER FUNCTION "public"."contact_merge"("p_winner" "uuid", "p_loser" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."contact_merge"("p_winner" "uuid", "p_loser" "uuid") IS 'Office-only merge: unions blanks into the winner, tombstones the loser, repoints the five link columns AND the board blob contactId (230, via coordination_job_patch), closes the pair''s suggestions, repoints the rest.';



CREATE OR REPLACE FUNCTION "public"."contact_resolve"("p_name" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_source" "text" DEFAULT ''::"text", "p_trusted" boolean DEFAULT false, "p_role" "text" DEFAULT 'customer'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
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
        return v_id;
      end if;

      if v_trusted and lower(btrim(v_row.name)) = v_name_n then
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


ALTER FUNCTION "public"."contact_resolve"("p_name" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_source" "text", "p_trusted" boolean, "p_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."contact_resolve"("p_name" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_source" "text", "p_trusted" boolean, "p_role" "text") IS 'Find-or-create a contact. NULL = refused caller or empty input, not an error. Auto-links on exact phone (any trusted lane) or email+name (trusted only); weaker evidence creates + queues a suggestion; differing values queue conflicts, never overwrite.';



CREATE OR REPLACE FUNCTION "public"."coordination_job_patch"("p_id" "uuid", "p_patch" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_data jsonb;
  v_rev  int;
  v_prev timestamptz;
  v_ts   text;
begin
  -- 246: a JWT caller must be a verified office user (the contact_merge
  -- gate). Refusal is a null no-op, same as a missing row — this function
  -- must not become an existence oracle for job ids.
  if v_uid is not null then
    select p.role::text into v_role from public.profiles p where p.id = v_uid;
    if v_role is null or v_role not in ('admin', 'office') then
      return null;
    end if;
  end if;

  select data into v_data from public.coordination_jobs
    where id = p_id and deleted = false
    for update;                                  -- serialize against a concurrent board save
  if v_data is null then return null; end if;    -- gone or tombstoned → no-op, not an error

  v_rev := coalesce((v_data->>'rev')::int, 0) + 1;
  -- prior timestamp, tolerant of a missing OR malformed updatedAt (the 218/225
  -- precedent: a bare ('')::timestamptz raises 22007 and coalesce can't catch it)
  begin v_prev := (v_data->>'updatedAt')::timestamptz; exception when others then v_prev := null; end;
  -- strictly newer than what's on file and not behind the clock (the 218 rule)
  v_ts := to_char(greatest(now(), coalesce(v_prev, to_timestamp(0)) + interval '1 ms')
            at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- shallow merge (patch keys win), then OVERLAY rev+updatedAt so the caller
  -- can never set them — they are function-controlled
  v_data := (v_data || p_patch) || jsonb_build_object('rev', v_rev, 'updatedAt', v_ts);
  update public.coordination_jobs set data = v_data where id = p_id;   -- coordination_touch() stamps the updated_at COLUMN
  return v_data;
end;
$$;


ALTER FUNCTION "public"."coordination_job_patch"("p_id" "uuid", "p_patch" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."coordination_job_patch"("p_id" "uuid", "p_patch" "jsonb") IS 'Board Tier 1 + CRM §13.3: rev-bumping shallow patch of a coordination_jobs blob so the board adopts (not clobbers) the change. service_role, or a JWT whose profiles.role is admin|office (others: null no-op).';



CREATE OR REPLACE FUNCTION "public"."coordination_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."coordination_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."field_projects_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."field_projects_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."field_projects_trash_capture"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.deleted and not coalesce(old.deleted, false) then
    insert into public.field_projects_trash (id, data) values (old.id, old.data);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."field_projects_trash_capture"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_job_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.job_number := 'RC-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('job_number_seq')::text, 3, '0');
  return new;
end;
$$;


ALTER FUNCTION "public"."generate_job_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_portal_data"("p_token" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_job         jobs%rowtype;
  v_checkins    json;
  v_moisture    json;
  v_equipment   json;
begin
  select * into v_job from jobs where portal_token = p_token;
  if not found then return null; end if;

  select json_agg(
    json_build_object(
      'id',             tc.id,
      'tech_name',      split_part(p.full_name, ' ', 1),
      'checked_in_at',  tc.checked_in_at,
      'checked_out_at', tc.checked_out_at
    ) order by tc.checked_in_at desc
  ) into v_checkins
  from tech_checkins tc
  join profiles p on p.id = tc.tech_id
  where tc.job_id = v_job.id;

  select json_agg(
    json_build_object(
      'room',         r.name,
      'is_dry',       mr.is_dry,
      'reading_date', mr.reading_date,
      'moisture_pct', mr.moisture_pct,
      'material',     mr.material_type
    )
  ) into v_moisture
  from (
    select distinct on (room_id) *
    from moisture_readings
    where job_id = v_job.id
    order by room_id, reading_date desc
  ) mr
  join rooms r on r.id = mr.room_id;

  select json_agg(
    json_build_object(
      'equipment_name', equipment_name,
      'equipment_type', equipment_type,
      'date_placed',    date_placed
    )
  ) into v_equipment
  from equipment_logs
  where job_id = v_job.id and date_removed is null;

  return json_build_object(
    'job_number',       v_job.job_number,
    'property_address', v_job.property_address,
    'owner_name',       v_job.owner_name,
    'status',           v_job.status,
    'loss_type',        v_job.loss_type,
    'date_of_loss',     v_job.date_of_loss,
    'updated_at',       v_job.updated_at,
    'checkins',         coalesce(v_checkins, '[]'::json),
    'moisture',         coalesce(v_moisture, '[]'::json),
    'equipment',        coalesce(v_equipment, '[]'::json)
  );
end;
$$;


ALTER FUNCTION "public"."get_portal_data"("p_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'tech'
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_assigned_to_job"("job_uuid" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  select exists (
    select 1 from jobs
    where id = job_uuid
      and (auth.uid() = any(assigned_tech_ids) or created_by = auth.uid())
  );
$$;


ALTER FUNCTION "public"."is_assigned_to_job"("job_uuid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs'];
  form_slots text[] := array[
    'workAuth','certDrying','laborLog','scopeOfWork','preConChecklist',
    'selections','subSchedule','punchList','drawSchedule','certCompletion',
    'portalShare','floorPlan'];
  max_tombstones int := 2000;      -- keep in step with MAX_TOMBSTONES in merge.js
  newer jsonb; older jsonb; merged jsonb;
  k text; ol jsonb; nl jsonb; missing jsonb; kept jsonb;
  o_rooms jsonb; n_rooms jsonb; r jsonb; m jsonb; ov jsonb;
  marks jsonb; any_gone boolean;
  skip_keys text[];
begin
  -- NOTE ON PARITY: proven byte-equal to apps/field/js/merge.js over 2033
  -- randomized cases. Two divergences remain, both UNREACHABLE with real data
  -- (every id is a non-empty UUID string; updatedAt is always an ISO string):
  --   • id truthiness: JS excludes falsy ids (0, false); the SQL id-present
  --     gate is `->>'id' <> ''`, which keeps '0'/'false'.
  --   • updatedAt newer-pick: JS coerces falsy non-strings (0, false) to '';
  --     `->>` here yields their literal text.
  if coalesce(a->>'updatedAt','') collate "C" >= coalesce(b->>'updatedAt','') collate "C"
    then newer := a; older := b;
    else newer := b; older := a;
  end if;
  merged := newer;

  -- ---------- deletes are decided FIRST, and bind BOTH sides ----------
  -- union of both copies' marks; for an id both sides deleted, the EARLIER
  -- stamp is kept (it is the truthful one). Capped to the newest N marks.
  with all_marks as (
    select key, value from jsonb_each(
      case when jsonb_typeof(older -> 'deletedIds') = 'object' then older -> 'deletedIds' else '{}'::jsonb end)
    union all
    select key, value from jsonb_each(
      case when jsonb_typeof(newer -> 'deletedIds') = 'object' then newer -> 'deletedIds' else '{}'::jsonb end)
  ), picked as (
    select key, min((value #>> '{}') collate "C") as ts from all_marks group by key
  ), capped as (
    select key, ts from picked order by ts desc, key desc limit max_tombstones
  )
  select coalesce(jsonb_object_agg(key, to_jsonb(ts)), '{}'::jsonb) into marks from capped;

  any_gone := marks <> '{}'::jsonb;
  -- an empty map is never written: it would be noise in every row, and the
  -- client's self-echo check (sync.js sameContent) compares content exactly
  if any_gone then merged := jsonb_set(merged, array['deletedIds'], marks, true); end if;

  -- id-keyed collections union by id (newer's element wins an id clash),
  -- set-based + order-preserving; id membership compared by jsonb VALUE.
  -- A tombstoned id is neither carried over from the older copy nor kept in
  -- the newer one — the mark outranks both.
  foreach k in array id_cols loop
    ol := older -> k;
    if ol is null or jsonb_typeof(ol) <> 'array' then ol := '[]'::jsonb; end if;
    if jsonb_typeof(merged -> k) = 'array' then
      nl := merged -> k;
    elsif jsonb_array_length(ol) > 0 then
      nl := '[]'::jsonb;                                         -- older had rows → key becomes an array
    else
      continue;                                                  -- neither side has this collection
    end if;

    if jsonb_array_length(ol) > 0 then
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into missing
      from jsonb_array_elements(ol) with ordinality as t(e, ord)
      where jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> ''
        and not (marks ? (e->>'id'))                             -- blocked resurrection
        and not exists (
          select 1 from jsonb_array_elements(nl) x
          where jsonb_typeof(x) = 'object' and x -> 'id' = e -> 'id');
      nl := nl || missing;
    end if;

    if any_gone then
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into kept
      from jsonb_array_elements(nl) with ordinality as t(e, ord)
      where not (jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> '' and marks ? (e->>'id'));
      nl := kept;
    end if;

    merged := jsonb_set(merged, array[k], nl, true);
  end loop;

  -- rooms: shared string list, union by value
  o_rooms := older -> 'rooms';
  if jsonb_typeof(o_rooms) = 'array' and jsonb_array_length(o_rooms) > 0 then
    n_rooms := case when jsonb_typeof(merged -> 'rooms') = 'array' then merged -> 'rooms' else '[]'::jsonb end;
    for r in select e from jsonb_array_elements(o_rooms) e loop
      if not exists (select 1 from jsonb_array_elements(n_rooms) x where x = r) then
        n_rooms := n_rooms || jsonb_build_array(r);
      end if;
    end loop;
    merged := jsonb_set(merged, array['rooms'], n_rooms, true);
  end if;

  -- loss-type chips (field loss classification): union by value like rooms —
  -- two devices classifying concurrently are BOTH right (one taps Fire, one
  -- taps Storm). Scalars inside each block stay newer-wins like every other
  -- header scalar. Mirrors apps/field/js/merge.js.
  o_rooms := older -> 'lossTypes';
  if jsonb_typeof(o_rooms) = 'array' and jsonb_array_length(o_rooms) > 0 then
    n_rooms := case when jsonb_typeof(merged -> 'lossTypes') = 'array' then merged -> 'lossTypes' else '[]'::jsonb end;
    for r in select e from jsonb_array_elements(o_rooms) e loop
      if not exists (select 1 from jsonb_array_elements(n_rooms) x where x = r) then
        n_rooms := n_rooms || jsonb_build_array(r);
      end if;
    end loop;
    merged := jsonb_set(merged, array['lossTypes'], n_rooms, true);
  end if;

  -- single-form slots: filled beats empty; two filled merge field-wise
  foreach k in array form_slots loop
    m := merged -> k;
    ov := older -> k;
    if m is null or jsonb_typeof(m) = 'null' then
      if ov is not null and jsonb_typeof(ov) <> 'null' then
        merged := jsonb_set(merged, array[k], ov, true);
      end if;
    elsif ov is null or jsonb_typeof(ov) = 'null' then
      null;                                                      -- newer holds it, older empty → keep
    else
      merged := jsonb_set(merged, array[k], public._mf_form(m, ov), true);
    end if;
  end loop;

  -- ---------- top-level scalars: filled beats empty ----------
  -- The twin of the loop at the end of mergeProjects() in apps/field/js/merge.js.
  -- `merged := newer` above hands every scalar to whichever blob carries the
  -- larger updatedAt — and THIS function fabricates that stamp a few lines down
  -- in push_project (greatest(both inputs)+1ms, then floored at now()). A tablet
  -- whose clock trails the server therefore lost text it genuinely typed later.
  -- Only a BLANK ever loses here: a real edit on the newer side still wins, so a
  -- concurrent rename from another device is never reverted.
  skip_keys := id_cols || form_slots
             || array['rooms','lossTypes','id','rev','updatedAt','deleted','deletedIds'];
  for k, ov in select key, value from jsonb_each(older) loop
    if k = any(skip_keys) then continue; end if;
    if public._blob_emptyish(merged -> k) and not public._blob_emptyish(ov) then
      merged := jsonb_set(merged, array[k], ov, true);
    end if;
  end loop;

  return merged;
end;
$$;


ALTER FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."photo_shares_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."photo_shares_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_access_begin"("p_contact" "uuid", "p_channel" "text", "p_dest" "text", "p_code_hash" "text", "p_hourly" integer DEFAULT 3, "p_daily" integer DEFAULT 20) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."portal_access_begin"("p_contact" "uuid", "p_channel" "text", "p_dest" "text", "p_code_hash" "text", "p_hourly" integer, "p_daily" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."portal_access_begin"("p_contact" "uuid", "p_channel" "text", "p_dest" "text", "p_code_hash" "text", "p_hourly" integer, "p_daily" integer) IS 'CF-1: atomically reserve a pending portal-access code under per-contact and daily caps. NULL = capped, degrade politely.';



CREATE OR REPLACE FUNCTION "public"."portal_access_verify"("p_contact" "uuid", "p_code_hash" "text", "p_token_hash" "text", "p_ttl_days" integer DEFAULT 180, "p_max_attempts" integer DEFAULT 5) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."portal_access_verify"("p_contact" "uuid", "p_code_hash" "text", "p_token_hash" "text", "p_ttl_days" integer, "p_max_attempts" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."portal_access_verify"("p_contact" "uuid", "p_code_hash" "text", "p_token_hash" "text", "p_ttl_days" integer, "p_max_attempts" integer) IS 'CF-1: spend one attempt on a pending code; activate the contact session on a match. Five wrong guesses kill the code.';



CREATE OR REPLACE FUNCTION "public"."portal_jobs_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."portal_jobs_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_selections_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."portal_selections_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."project_field_photos"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare arr jsonb := new.data -> 'photos';
begin
  if new.deleted or arr is null or jsonb_typeof(arr) <> 'array' then return null; end if;
  if tg_op = 'UPDATE' and (old.data -> 'photos') is not distinct from arr then return null; end if;

  perform public.reconcile_job_photos(new.id, arr);
  return null;
exception when others then
  raise warning 'project_field_photos failed for job %: %', new.id, sqlerrm;
  return null;
end;
$$;


ALTER FUNCTION "public"."project_field_photos"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."push_project"("p_id" "uuid", "p_base_rev" integer, "p_data" "jsonb", "p_build" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    AS $$
declare
  cur_rev int; cur_data jsonb; cur_deleted boolean; found_row boolean;
  new_rev int; merged jsonb; rc int;
  ts_in timestamptz; ts_cur timestamptz; ts_new timestamptz; now_iso text;
  clean jsonb;
begin
  if p_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'push_project: id and a JSON-object data are required';
  end if;
  perform public._sync_guard(p_build);

  clean := public._mf_sweep_tombstones(p_data - 'rev');

  select (data->>'rev')::int, data, deleted
    into cur_rev, cur_data, cur_deleted
    from public.field_projects where id = p_id
    for update;
  found_row := found;

  if not found_row then
    begin
      insert into public.field_projects (id, data, deleted)
      values (p_id, jsonb_set(clean, '{rev}', to_jsonb(1)), false);
      return jsonb_build_object('status','insert','rev',1);
    exception when unique_violation then
      select (data->>'rev')::int, data, deleted
        into cur_rev, cur_data, cur_deleted
        from public.field_projects where id = p_id for update;
      if not found then
        raise exception 'push_project: row vanished mid-insert, retry';
      end if;
    end;
  end if;

  cur_rev := coalesce(cur_rev, 0);

  if cur_deleted then
    return jsonb_build_object('status','deleted','rev',cur_rev,'data',cur_data);
  end if;

  if cur_rev = coalesce(p_base_rev, 0) then
    new_rev := cur_rev + 1;
    update public.field_projects
       set data = jsonb_set(clean, '{rev}', to_jsonb(new_rev)), deleted = false
     where id = p_id;
    get diagnostics rc = row_count;
    if rc = 0 then raise exception 'push_project: row vanished mid-apply, retry'; end if;
    return jsonb_build_object('status','applied','rev',new_rev);
  end if;

  merged := public.merge_project_blobs(clean, cur_data);

  if (merged - 'rev' - 'updatedAt') = (cur_data - 'rev' - 'updatedAt') then
    return jsonb_build_object('status','current','rev',cur_rev,'data',cur_data);
  end if;

  new_rev := cur_rev + 1;
  merged := jsonb_set(merged, '{rev}', to_jsonb(new_rev));
  begin ts_in  := (p_data   ->> 'updatedAt')::timestamptz; exception when others then ts_in  := null; end;
  begin ts_cur := (cur_data ->> 'updatedAt')::timestamptz; exception when others then ts_cur := null; end;
  ts_new := greatest(coalesce(ts_in, to_timestamp(0)), coalesce(ts_cur, to_timestamp(0)))
            + interval '1 millisecond';
  if ts_new < now() then ts_new := now(); end if;
  now_iso := to_char(ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  merged := jsonb_set(merged, '{updatedAt}', to_jsonb(now_iso));
  update public.field_projects set data = merged, deleted = false where id = p_id;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'push_project: row vanished mid-merge, retry'; end if;
  return jsonb_build_object('status','merged','rev',new_rev,'data',merged);
end;
$$;


ALTER FUNCTION "public"."push_project"("p_id" "uuid", "p_base_rev" integer, "p_data" "jsonb", "p_build" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_job_photos"("p_job" "uuid", "p_arr" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare touched int := 0; swept int := 0; skipped int := 0;
begin
  if p_job is null or p_arr is null or jsonb_typeof(p_arr) <> 'array' then
    return 0;
  end if;

  perform set_config('app.projection', 'on', true);

  select count(*) into skipped
    from jsonb_array_elements(p_arr) p
   where jsonb_typeof(p) <> 'object'
      or coalesce(p->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if skipped > 0 then
    raise warning 'reconcile_job_photos: job % has % photo(s) with no usable id — not represented as rows', p_job, skipped;
  end if;

  with parsed as (
    select
      (p->>'id')::uuid                                   as id,
      ord,
      nullif(p->>'src','')                               as src,
      nullif(p->>'cloud','')                             as cloud,
      coalesce(p->>'room','')                            as room,
      coalesce(nullif(p->>'stage',''),'during')          as stage,
      coalesce(p->>'caption','')                         as caption,
      case when jsonb_typeof(p->'ai') in ('object','array') then p->'ai' end as ai,
      case when (p->>'ts') ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'ts')::timestamptz end as taken_at,
      (select u.id from auth.users u
        where lower(u.email) = lower(nullif(p->>'by','')) limit 1)          as by_uid
    from jsonb_array_elements(p_arr) with ordinality as t(p, ord)
    where jsonb_typeof(p) = 'object'
      and (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  incoming as (
    select distinct on (id) id, src, cloud, room, stage, caption, ai, taken_at, by_uid
    from parsed order by id, ord desc
  ),
  upserted as (
    insert into public.field_photos
      (id, job_id, src, cloud, room, stage, caption, ai, taken_at, created_by, created_at, updated_at)
    select i.id, p_job, i.src, i.cloud, i.room, i.stage, i.caption, i.ai, i.taken_at,
           i.by_uid, coalesce(i.taken_at, now()), now()
    from incoming i
    on conflict (job_id, id) do update
      set src        = excluded.src,
          cloud      = excluded.cloud,
          room       = excluded.room,
          stage      = excluded.stage,
          caption    = excluded.caption,
          ai         = excluded.ai,
          taken_at   = excluded.taken_at,
          deleted_at = null,
          deleted_by = null
      where field_photos.purged_at is null
        and (field_photos.src, field_photos.cloud, field_photos.room, field_photos.stage,
             field_photos.caption, field_photos.ai, field_photos.taken_at, field_photos.deleted_at)
        is distinct from
            (excluded.src, excluded.cloud, excluded.room, excluded.stage,
             excluded.caption, excluded.ai, excluded.taken_at, null::timestamptz)
    returning 1
  )
  select count(*) into touched from upserted;

  update public.field_photos f
     set deleted_at = now()
   where f.job_id = p_job
     and f.deleted_at is null
     and f.purged_at is null
     and not exists (
       select 1 from jsonb_array_elements(p_arr) p
        where (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and (p->>'id')::uuid = f.id);
  get diagnostics swept = row_count;

  perform set_config('app.projection', '', true);
  return touched + swept;
end;
$_$;


ALTER FUNCTION "public"."reconcile_job_photos"("p_job" "uuid", "p_arr" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."repair_field_photos"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare fixed int := 0; r record;
begin
  for r in select id, data->'photos' as arr from public.field_projects
            where not deleted and jsonb_typeof(data->'photos') = 'array'
  loop
    fixed := fixed + public.reconcile_job_photos(r.id, r.arr);
  end loop;
  return fixed;
end;
$$;


ALTER FUNCTION "public"."repair_field_photos"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_photo"("p_job" "uuid", "p_photo" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    AS $$
declare
  r public.field_photos%rowtype;
  cur_data jsonb; cur_rev int; cur_deleted boolean;
  entry jsonb; by_email text; ts_cur timestamptz; ts_new timestamptz; rc int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'restore_photo: only an admin may restore a deleted photo';
  end if;

  select * into r from public.field_photos where job_id = p_job and id = p_photo;
  if not found then
    return jsonb_build_object('status','not_found');
  end if;
  if r.src is null and r.cloud is null then
    return jsonb_build_object('status','no_image');
  end if;

  select data, (data->>'rev')::int, deleted
    into cur_data, cur_rev, cur_deleted
    from public.field_projects where id = p_job for update;
  if not found then
    return jsonb_build_object('status','job_missing');
  end if;
  if cur_deleted then
    return jsonb_build_object('status','job_deleted',
      'hint','revive the job first — its photos come back with it');
  end if;

  -- already listed? nothing to put back — but the tombstone may still stand,
  -- which is the contradiction 241 sweeps out on the next write. Lift it, and
  -- bump the row so devices actually learn about it.
  if exists (
    select 1 from jsonb_array_elements(coalesce(cur_data->'photos','[]'::jsonb)) p
     where (p->>'id') = p_photo::text
  ) then
    update public.field_photos
       set deleted_at = null, deleted_by = null, purged_at = null
     where job_id = p_job and id = p_photo;
    if cur_data #> array['deletedIds', p_photo::text] is not null then
      begin ts_cur := (cur_data->>'updatedAt')::timestamptz; exception when others then ts_cur := null; end;
      ts_new := greatest(coalesce(ts_cur, to_timestamp(0)), now()) + interval '1 millisecond';
      update public.field_projects
         set data = jsonb_set(
                      jsonb_set(cur_data #- array['deletedIds', p_photo::text],
                        '{rev}', to_jsonb(coalesce(cur_rev,0) + 1)),
                      '{updatedAt}',
                      to_jsonb(to_char(ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       where id = p_job;
      return jsonb_build_object('status','already_present','rev', coalesce(cur_rev,0) + 1,'tombstone','cleared');
    end if;
    return jsonb_build_object('status','already_present');
  end if;

  select email into by_email from auth.users where id = r.created_by;

  entry := jsonb_strip_nulls(jsonb_build_object(
    'id',      r.id,
    'src',     r.src,
    'cloud',   r.cloud,
    'room',    nullif(r.room,''),
    'stage',   r.stage,
    'caption', nullif(r.caption,''),
    'ai',      r.ai,
    'ts',      to_char(coalesce(r.taken_at, r.created_at) at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'by',      by_email));

  begin ts_cur := (cur_data->>'updatedAt')::timestamptz; exception when others then ts_cur := null; end;
  ts_new := greatest(coalesce(ts_cur, to_timestamp(0)), now()) + interval '1 millisecond';

  update public.field_projects
     set data = jsonb_set(
                  jsonb_set(
                    jsonb_set(cur_data #- array['deletedIds', p_photo::text],
                      '{photos}',
                      coalesce(case when jsonb_typeof(cur_data->'photos') = 'array'
                                    then cur_data->'photos' end, '[]'::jsonb) || jsonb_build_array(entry)),
                    '{rev}', to_jsonb(coalesce(cur_rev,0) + 1)),
                  '{updatedAt}',
                  to_jsonb(to_char(ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where id = p_job;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'restore_photo: job vanished, retry'; end if;

  update public.field_photos
     set purged_at = null
   where job_id = p_job and id = p_photo and purged_at is not null;

  return jsonb_build_object('status','restored','rev', coalesce(cur_rev,0) + 1);
end;
$$;


ALTER FUNCTION "public"."restore_photo"("p_job" "uuid", "p_photo" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revive_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    AS $$
declare cur_rev int; cur_data jsonb; cur_deleted boolean; new_rev int; rc int;
begin
  if p_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'revive_project: id and a JSON-object data are required';
  end if;
  perform public._sync_guard(p_build);

  select (data->>'rev')::int, data, deleted
    into cur_rev, cur_data, cur_deleted
    from public.field_projects where id = p_id for update;

  if not found then
    return jsonb_build_object('status','missing');
  end if;
  if not cur_deleted then
    return jsonb_build_object('status','conflict','rev',coalesce(cur_rev,0),'data',cur_data);
  end if;

  new_rev := coalesce(cur_rev, 0) + 1;
  update public.field_projects
     set data = jsonb_set(p_data - 'rev', '{rev}', to_jsonb(new_rev)), deleted = false
   where id = p_id and deleted;
  get diagnostics rc = row_count;
  if rc = 0 then
    select (data->>'rev')::int, data into cur_rev, cur_data
      from public.field_projects where id = p_id;
    return jsonb_build_object('status','conflict','rev',coalesce(cur_rev,0),'data',cur_data);
  end if;
  return jsonb_build_object('status','revived','rev',new_rev);
end;
$$;


ALTER FUNCTION "public"."revive_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_invoice_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  yr  text := to_char(now(), 'YYYY');
  seq int;
BEGIN
  SELECT COUNT(*) + 1 INTO seq FROM invoices WHERE to_char(created_at, 'YYYY') = yr;
  NEW.invoice_number := 'INV-' || yr || '-' || LPAD(seq::text, 3, '0');
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_invoice_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stamp_field_photo"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare projecting boolean := coalesce(current_setting('app.projection', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    new.created_by := case when projecting then new.created_by
                           else coalesce(new.created_by, auth.uid()) end;
    new.updated_by := auth.uid();
    new.updated_at := now();
  else
    if new.* is not distinct from old.* then return new; end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_by := auth.uid();
    elsif new.deleted_at is null then
      new.deleted_by := null;
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."stamp_field_photo"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stamp_updated_by"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'UPDATE'
     and new.data is not distinct from old.data
     and new.deleted is not distinct from old.deleted then
    return new;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;


ALTER FUNCTION "public"."stamp_updated_by"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tombstone_project"("p_id" "uuid", "p_data" "jsonb" DEFAULT NULL::"jsonb", "p_build" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    AS $$
declare cur_data jsonb; cur_deleted boolean; body jsonb; hw int; rc int;
begin
  if p_id is null then raise exception 'tombstone_project: id is required'; end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'tombstone_project: data must be a JSON object';
  end if;
  perform public._sync_guard(p_build);

  select data, deleted into cur_data, cur_deleted
    from public.field_projects where id = p_id for update;

  if not found then
    insert into public.field_projects (id, data, deleted)
    values (p_id, coalesce(p_data - 'rev', jsonb_build_object('id', p_id)), true);
    return jsonb_build_object('status','tombstoned','created',true);
  end if;

  if cur_deleted then
    return jsonb_build_object('status','already_deleted');
  end if;

  body := case
            when p_data is null then cur_data
            when length(p_data::text) >= length(coalesce(cur_data,'{}'::jsonb)::text) then p_data - 'rev'
            else cur_data
          end;

  hw := greatest(
          coalesce((cur_data ->> 'rev')::int, 0),
          coalesce((p_data   ->> 'rev')::int, 0),
          coalesce((body     ->> 'rev')::int, 0));
  body := jsonb_set(coalesce(body, jsonb_build_object('id', p_id)), '{rev}', to_jsonb(hw));

  update public.field_projects set data = body, deleted = true where id = p_id;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'tombstone_project: row vanished, retry'; end if;
  return jsonb_build_object('status','tombstoned','rev',hw);
end;
$$;


ALTER FUNCTION "public"."tombstone_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_work_auth_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_work_auth_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."web_alert_claim"("p_session_id" "uuid", "p_session_max" integer, "p_daily_max" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_sent  int;
  v_today int;
begin
  perform pg_advisory_xact_lock(hashtext('roybal.web_alert_claim'));

  select coalesce((result->>'alerts')::int, 0) into v_sent
    from public.capture_events
   where id = p_session_id and form_key = 'webReceptionist';

  if v_sent is null then return false; end if;
  if v_sent >= p_session_max then return false; end if;

  select coalesce(sum(coalesce((result->>'alerts')::int, 0)), 0) into v_today
    from public.capture_events
   where form_key = 'webReceptionist'
     and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  if v_today >= p_daily_max then return false; end if;

  update public.capture_events
     set result = jsonb_set(coalesce(result, '{}'::jsonb), '{alerts}', to_jsonb(v_sent + 1))
   where id = p_session_id;

  return true;
end;
$$;


ALTER FUNCTION "public"."web_alert_claim"("p_session_id" "uuid", "p_session_max" integer, "p_daily_max" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."web_alert_claim"("p_session_id" "uuid", "p_session_max" integer, "p_daily_max" integer) IS 'Public web receptionist: atomically buy the right to send one owner text.';



CREATE OR REPLACE FUNCTION "public"."web_lead_insert"("p_session_id" "uuid", "p_lead" "jsonb", "p_daily_max" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('roybal.web_lead_insert'));

  if (select coalesce((result->>'lead')::boolean, false)
        from public.capture_events
       where id = p_session_id and form_key = 'webReceptionist') is distinct from false then
    return null;
  end if;

  if (select count(*) from public.coordination_jobs
       where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
         and data->>'channel' = 'ai-chat') >= p_daily_max then
    return null;
  end if;

  v_id := (p_lead->>'id')::uuid;
  insert into public.coordination_jobs (id, data, deleted)
  values (v_id, p_lead, false);

  update public.capture_events
     set result = jsonb_set(coalesce(result, '{}'::jsonb), '{lead}', 'true'::jsonb),
         status = 'confirmed',
         processed_at = now()
   where id = p_session_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."web_lead_insert"("p_session_id" "uuid", "p_lead" "jsonb", "p_daily_max" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."web_lead_insert"("p_session_id" "uuid", "p_lead" "jsonb", "p_daily_max" integer) IS 'Public web receptionist: insert one lead per session, capped per day.';



CREATE OR REPLACE FUNCTION "public"."web_session_begin"("p_ip_hash" "text", "p_subnet_hash" "text", "p_origin" "text", "p_path" "text", "p_ua" "text", "p_service" "text", "p_ip_max" integer, "p_subnet_max" integer, "p_hourly_max" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('roybal.web_session_begin'));

  if (select count(*) from public.capture_events
       where form_key = 'webReceptionist'
         and created_at > now() - interval '1 hour'
         and raw_payload->>'ipHash' = p_ip_hash) >= p_ip_max then
    return null;
  end if;

  if (select count(*) from public.capture_events
       where form_key = 'webReceptionist'
         and created_at > now() - interval '1 hour'
         and raw_payload->>'subnetHash' = p_subnet_hash) >= p_subnet_max then
    return null;
  end if;

  if (select count(*) from public.capture_events
       where form_key = 'webReceptionist'
         and created_at > now() - interval '1 hour') >= p_hourly_max then
    return null;
  end if;

  insert into public.capture_events
    (source_type, form_key, captured_by, status, raw_payload, result)
  values
    ('web_chat', 'webReceptionist', 'web-agent', 'pending',
     jsonb_build_object(
       'ipHash',     p_ip_hash,
       'subnetHash', p_subnet_hash,
       'origin',     p_origin,
       'path',       left(coalesce(p_path, ''), 200),
       'ua',         left(coalesce(p_ua, ''), 200),
       'service',    left(coalesce(p_service, ''), 80)),
     jsonb_build_object('turns', 0, 'calls', 0, 'lead', false))
  returning id into v_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."web_session_begin"("p_ip_hash" "text", "p_subnet_hash" "text", "p_origin" "text", "p_path" "text", "p_ua" "text", "p_service" "text", "p_ip_max" integer, "p_subnet_max" integer, "p_hourly_max" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."web_session_begin"("p_ip_hash" "text", "p_subnet_hash" "text", "p_origin" "text", "p_path" "text", "p_ua" "text", "p_service" "text", "p_ip_max" integer, "p_subnet_max" integer, "p_hourly_max" integer) IS 'Public web receptionist: atomically mint a session or refuse. NULL = degrade to the form.';



CREATE OR REPLACE FUNCTION "public"."web_turn_begin"("p_session_id" "uuid", "p_est_usd" numeric, "p_model" "text", "p_daily_cap" numeric, "p_lane_cap" numeric, "p_shared_cap" numeric, "p_max_calls" integer, "p_session_ttl_minutes" integer DEFAULT 20) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_calls   int;
  v_created timestamptz;
  v_month   text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_id      uuid;
begin
  perform pg_advisory_xact_lock(hashtext('roybal.web_turn_begin'));

  select (result->>'calls')::int, created_at
    into v_calls, v_created
    from public.capture_events
   where id = p_session_id and form_key = 'webReceptionist';

  if v_created is null then return null; end if;
  if v_created < now() - make_interval(mins => p_session_ttl_minutes) then
    return null;
  end if;
  if coalesce(v_calls, 0) >= p_max_calls then return null; end if;

  if (select coalesce(sum(cost_usd), 0) from public.ai_usage
       where form_key = 'webReceptionist'
         and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') >= p_daily_cap then
    return null;
  end if;

  if (select coalesce(sum(cost_usd), 0) from public.ai_usage
       where form_key = 'webReceptionist'
         and billing_month = v_month) >= p_lane_cap then
    return null;
  end if;

  if (select coalesce(sum(cost_usd), 0) from public.ai_usage
       where billing_month = v_month) >= p_shared_cap then
    return null;
  end if;

  insert into public.ai_usage
    (capture_event_id, captured_by, form_key, provider, llm_model,
     input_tokens, output_tokens, llm_cost_usd, cost_usd, note)
  values
    (p_session_id, 'web-agent', 'webReceptionist', 'anthropic', p_model,
     0, 0, p_est_usd, p_est_usd, 'reserved')
  returning id into v_id;

  update public.capture_events
     set result = jsonb_set(
                    jsonb_set(coalesce(result, '{}'::jsonb),
                              '{calls}', to_jsonb(coalesce(v_calls, 0) + 2)),
                    '{turns}', to_jsonb(coalesce((result->>'turns')::int, 0) + 1))
   where id = p_session_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."web_turn_begin"("p_session_id" "uuid", "p_est_usd" numeric, "p_model" "text", "p_daily_cap" numeric, "p_lane_cap" numeric, "p_shared_cap" numeric, "p_max_calls" integer, "p_session_ttl_minutes" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."web_turn_begin"("p_session_id" "uuid", "p_est_usd" numeric, "p_model" "text", "p_daily_cap" numeric, "p_lane_cap" numeric, "p_shared_cap" numeric, "p_max_calls" integer, "p_session_ttl_minutes" integer) IS 'Public web receptionist: reserve worst-case spend BEFORE the model call. NULL = a cap is met.';



CREATE OR REPLACE FUNCTION "public"."web_turn_end"("p_usage_id" "uuid", "p_in_tokens" integer, "p_out_tokens" integer, "p_actual_usd" numeric) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  update public.ai_usage
     set input_tokens  = greatest(p_in_tokens, 0),
         output_tokens = greatest(p_out_tokens, 0),
         llm_cost_usd  = greatest(p_actual_usd, 0),
         cost_usd      = greatest(p_actual_usd, 0),
         note          = 'settled'
   where id = p_usage_id
     and note = 'reserved';
$$;


ALTER FUNCTION "public"."web_turn_end"("p_usage_id" "uuid", "p_in_tokens" integer, "p_out_tokens" integer, "p_actual_usd" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."web_turn_end"("p_usage_id" "uuid", "p_in_tokens" integer, "p_out_tokens" integer, "p_actual_usd" numeric) IS 'Public web receptionist: reconcile a reservation down to measured usage.';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."ai_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "capture_event_id" "uuid",
    "unified_job_id" "uuid",
    "captured_by" "text",
    "form_key" "text",
    "provider" "text",
    "stt_model" "text",
    "llm_model" "text",
    "audio_seconds" numeric DEFAULT 0 NOT NULL,
    "input_tokens" integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL,
    "stt_cost_usd" numeric DEFAULT 0 NOT NULL,
    "llm_cost_usd" numeric DEFAULT 0 NOT NULL,
    "cost_usd" numeric DEFAULT 0 NOT NULL,
    "capped" boolean DEFAULT false NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "billing_month" "text",
    "tts_chars" integer DEFAULT 0 NOT NULL,
    "tts_cost_usd" numeric DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."ai_usage" OWNER TO "postgres";


COMMENT ON TABLE "public"."ai_usage" IS 'AI cost ledger (201). Append-only to clients since 247: authenticated may SELECT (the cap sum) and INSERT (the ledger row); UPDATE/DELETE are revoked. service_role bypasses RLS and retains full access.';



CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."app_settings" IS 'Server-side operational settings (migration 218). RLS intentionally has no policies: only postgres/service_role may read or write. The sync RPCs read it as SECURITY DEFINER.';



CREATE TABLE IF NOT EXISTS "public"."blob_history" (
    "hist_id" bigint NOT NULL,
    "table_name" "text" NOT NULL,
    "id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL,
    "row_updated_at" timestamp with time zone,
    "first_captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "replaced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "op" "text" DEFAULT 'update'::"text" NOT NULL,
    "was_regression" boolean DEFAULT false NOT NULL,
    "updated_by" "uuid"
);
ALTER TABLE ONLY "public"."blob_history" ALTER COLUMN "data" SET COMPRESSION lz4;


ALTER TABLE "public"."blob_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."blob_history" IS 'Server-side blob version history (migration 215). RLS intentionally has no policies: only postgres/service_role may read or restore. Do not add policies or grants for app roles; the rls_enabled_no_policy lint is expected and accepted.';



ALTER TABLE "public"."blob_history" ALTER COLUMN "hist_id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."blob_history_hist_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."canvas_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Floor Plan'::"text" NOT NULL,
    "level_name" "text" DEFAULT 'Main Floor'::"text" NOT NULL,
    "scale" double precision DEFAULT 20 NOT NULL,
    "unit_system" "text" DEFAULT 'imperial'::"text" NOT NULL,
    "canvas_width" double precision DEFAULT 60 NOT NULL,
    "canvas_height" double precision DEFAULT 60 NOT NULL,
    "background_image_url" "text",
    "background_opacity" double precision DEFAULT 0.3 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "canvas_plans_unit_system_check" CHECK (("unit_system" = ANY (ARRAY['imperial'::"text", 'metric'::"text"])))
);


ALTER TABLE "public"."canvas_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."capture_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "unified_job_id" "uuid",
    "phase_instance_id" "uuid",
    "source_type" "text" NOT NULL,
    "form_key" "text",
    "raw_payload" "jsonb",
    "transcript" "text",
    "result" "jsonb",
    "captured_by" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error" "text",
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "contact_id" "uuid"
);


ALTER TABLE "public"."capture_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."capture_events" IS 'AI audit trail (200). Since 247: authenticated may SELECT/INSERT and UPDATE only (status, processed_at, result, transcript, raw_payload, error, contact_id) — the result-stamp path. DELETE revoked. The narrow UPDATE is P1 debt: it goes when execution moves server-side.';



CREATE TABLE IF NOT EXISTS "public"."communications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "comm_type" "text" NOT NULL,
    "direction" "text",
    "contact_name" "text",
    "contact_role" "text",
    "subject" "text",
    "body" "text" NOT NULL,
    "is_internal" boolean DEFAULT false NOT NULL,
    "follow_up_needed" boolean DEFAULT false NOT NULL,
    "follow_up_date" "date",
    CONSTRAINT "communications_comm_type_check" CHECK (("comm_type" = ANY (ARRAY['call'::"text", 'email'::"text", 'text'::"text", 'site_visit'::"text", 'internal_note'::"text", 'verbal_approval'::"text", 'other'::"text"]))),
    CONSTRAINT "communications_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text", 'internal'::"text"])))
);


ALTER TABLE "public"."communications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."completeness_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "unified_job_id" "uuid" NOT NULL,
    "phase_instance_id" "uuid",
    "required_count" integer DEFAULT 0 NOT NULL,
    "present_count" integer DEFAULT 0 NOT NULL,
    "hard_gaps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "soft_gaps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_billable" boolean DEFAULT false NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."completeness_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_merge_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_a" "uuid" NOT NULL,
    "contact_b" "uuid",
    "reason" "text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "contact_merge_suggestions_reason_check" CHECK (("reason" = ANY (ARRAY['email'::"text", 'name-address'::"text", 'name'::"text", 'untrusted-fill'::"text", 'conflict'::"text"]))),
    CONSTRAINT "contact_merge_suggestions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'merged'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."contact_merge_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "channel" "text" DEFAULT 'sms'::"text" NOT NULL,
    "destination" "text" DEFAULT ''::"text" NOT NULL,
    "code_hash" "text",
    "code_expires_at" timestamp with time zone,
    "attempts" integer DEFAULT 0 NOT NULL,
    "token_hash" "text",
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contact_sessions_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text"])))
);


ALTER TABLE "public"."contact_sessions" OWNER TO "postgres";


COMMENT ON TABLE "public"."contact_sessions" IS 'CF-1 portal accounts: pending codes and active contact sessions. Bearer tokens hashed at rest; never a DB credential (deliberately not Supabase Auth until Phase-3 RLS).';



CREATE TABLE IF NOT EXISTS "public"."email_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gmail_id" "text" NOT NULL,
    "thread_id" "text" DEFAULT ''::"text" NOT NULL,
    "direction" "text" NOT NULL,
    "from_addr" "text" DEFAULT ''::"text" NOT NULL,
    "from_name" "text" DEFAULT ''::"text" NOT NULL,
    "to_addr" "text" DEFAULT ''::"text" NOT NULL,
    "subject" "text" DEFAULT ''::"text" NOT NULL,
    "body_text" "text" DEFAULT ''::"text" NOT NULL,
    "message_id_header" "text" DEFAULT ''::"text" NOT NULL,
    "job_id" "text",
    "matched_by" "text" DEFAULT ''::"text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_by_office" boolean DEFAULT false NOT NULL,
    "sent_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "contact_id" "uuid",
    CONSTRAINT "email_messages_direction_check" CHECK (("direction" = ANY (ARRAY['in'::"text", 'out'::"text"])))
);


ALTER TABLE "public"."email_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."portal_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "field_project_id" "uuid",
    "unified_job_id" "uuid",
    "share_token" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "customer_name" "text" DEFAULT ''::"text" NOT NULL,
    "property_address" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT ''::"text" NOT NULL,
    "milestones" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "photos" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "documents" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "selections_source" "jsonb",
    "selections_published_at" timestamp with time zone,
    "selections_submitted_at" timestamp with time zone,
    "contact_id" "uuid",
    "drying" "jsonb",
    "notify_crew" boolean DEFAULT true NOT NULL,
    "crew_line_date" "date",
    "closeout" "jsonb",
    "approvals" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "billing" "jsonb",
    "crew_intro_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."portal_jobs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."portal_jobs"."drying" IS 'Customer-safe drying summary — readings only (asOf, per-area current vs dry standard, equipment count). Never a trend or ETA; dates and commitments stay human-only.';



COMMENT ON COLUMN "public"."portal_jobs"."notify_crew" IS 'Office toggle: post the who''s-on-the-job-today line to this job''s thread on the crew''s first QB Time clock-in of the day (migration 236).';



COMMENT ON COLUMN "public"."portal_jobs"."crew_line_date" IS 'Last Alaska date a crew line was posted — one per job per day.';



COMMENT ON COLUMN "public"."portal_jobs"."closeout" IS 'CF-4 closeout record: {completedAt, warrantyMonths, homeFile:[{label,value}]}. Office-curated in the Client Portal form; served through the gateway allow-list only when status=complete.';



COMMENT ON COLUMN "public"."portal_jobs"."approvals" IS 'CF-3 change-order approvals: office-published, customer-answered (e-sign via the gateway). Never written by publishPortal.';



COMMENT ON COLUMN "public"."portal_jobs"."billing" IS 'CF-3 shared balance: {invoiced, paid, balance, payUrl, asOf} from fincalc.billingSummary. Null = not shared.';



COMMENT ON COLUMN "public"."portal_jobs"."crew_intro_ids" IS 'crew_members ids already introduced on this job''s crew line (crew-bios phase 2) — stamped with the day claim the first time the line names them';



CREATE TABLE IF NOT EXISTS "public"."portal_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "portal_job_id" "uuid" NOT NULL,
    "direction" "text" NOT NULL,
    "channel" "text" DEFAULT 'portal'::"text" NOT NULL,
    "author" "text" DEFAULT 'office'::"text" NOT NULL,
    "body" "text" NOT NULL,
    "read_by_office" boolean DEFAULT false NOT NULL,
    "read_by_customer" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "portal_messages_author_check" CHECK (("author" = ANY (ARRAY['customer'::"text", 'office'::"text", 'ai'::"text"]))),
    CONSTRAINT "portal_messages_channel_check" CHECK (("channel" = ANY (ARRAY['portal'::"text", 'sms'::"text"]))),
    CONSTRAINT "portal_messages_direction_check" CHECK (("direction" = ANY (ARRAY['in'::"text", 'out'::"text"])))
);


ALTER TABLE "public"."portal_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sms_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "unified_job_id" "uuid",
    "direction" "text" DEFAULT 'outbound'::"text" NOT NULL,
    "to_number" "text" NOT NULL,
    "from_number" "text" DEFAULT ''::"text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "kind" "text" DEFAULT 'text'::"text" NOT NULL,
    "sent_by" "text",
    "twilio_sid" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "contact_id" "uuid",
    CONSTRAINT "sms_messages_direction_check" CHECK (("direction" = ANY (ARRAY['outbound'::"text", 'inbound'::"text"])))
);


ALTER TABLE "public"."sms_messages" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."contact_timeline" WITH ("security_invoker"='true') AS
 SELECT "sms_messages"."contact_id",
    'sms'::"text" AS "lane",
    "sms_messages"."created_at" AS "at",
        CASE "sms_messages"."direction"
            WHEN 'inbound'::"text" THEN 'in'::"text"
            WHEN 'outbound'::"text" THEN 'out'::"text"
            ELSE "sms_messages"."direction"
        END AS "direction",
    "sms_messages"."body",
    ("sms_messages"."unified_job_id")::"text" AS "ref"
   FROM "public"."sms_messages"
  WHERE ("sms_messages"."contact_id" IS NOT NULL)
UNION ALL
 SELECT "email_messages"."contact_id",
    'email'::"text" AS "lane",
    "email_messages"."received_at" AS "at",
    "email_messages"."direction",
    COALESCE("email_messages"."subject", ''::"text") AS "body",
    "email_messages"."job_id" AS "ref"
   FROM "public"."email_messages"
  WHERE ("email_messages"."contact_id" IS NOT NULL)
UNION ALL
 SELECT "pj"."contact_id",
    'portal'::"text" AS "lane",
    "pm"."created_at" AS "at",
    "pm"."direction",
    "pm"."body",
    ("pj"."id")::"text" AS "ref"
   FROM ("public"."portal_messages" "pm"
     JOIN "public"."portal_jobs" "pj" ON (("pj"."id" = "pm"."portal_job_id")))
  WHERE ("pj"."contact_id" IS NOT NULL)
UNION ALL
 SELECT "capture_events"."contact_id",
    'call'::"text" AS "lane",
    "capture_events"."captured_at" AS "at",
    'in'::"text" AS "direction",
    COALESCE("capture_events"."transcript", '(call)'::"text") AS "body",
    ("capture_events"."id")::"text" AS "ref"
   FROM "public"."capture_events"
  WHERE (("capture_events"."contact_id" IS NOT NULL) AND ("capture_events"."source_type" = 'phone_call'::"text"));


ALTER VIEW "public"."contact_timeline" OWNER TO "postgres";


COMMENT ON VIEW "public"."contact_timeline" IS 'Every conversation with a contact across SMS, email, portal, and phone calls — a security_invoker union over the lane tables, keyed by contact_id. Not a store; the lanes stay authoritative.';



CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" DEFAULT 'person'::"text" NOT NULL,
    "role" "text" DEFAULT 'customer'::"text" NOT NULL,
    "name" "text" NOT NULL,
    "company" "text" DEFAULT ''::"text" NOT NULL,
    "phone" "text" DEFAULT ''::"text" NOT NULL,
    "phone_norm" "text" GENERATED ALWAYS AS ("right"("regexp_replace"("phone", '\D'::"text", ''::"text", 'g'::"text"), 10)) STORED,
    "email" "text" DEFAULT ''::"text" NOT NULL,
    "email_norm" "text" GENERATED ALWAYS AS ("lower"("btrim"("email"))) STORED,
    "address" "text" DEFAULT ''::"text" NOT NULL,
    "qbo_customer_id" "text",
    "source" "text" DEFAULT ''::"text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "marketing_opt_in" boolean DEFAULT false NOT NULL,
    "review_asked_at" timestamp with time zone,
    "merged_into" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "marketing_opt_in_at" timestamp with time zone,
    CONSTRAINT "contacts_kind_check" CHECK (("kind" = ANY (ARRAY['person'::"text", 'company'::"text"])))
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."contacts" IS 'The person spine (CRM Phase 1). One row per person/company; jobs, messages, and leads link here. Merged rows carry merged_into; resolvers follow the chain to the winner.';



COMMENT ON COLUMN "public"."contacts"."marketing_opt_in_at" IS 'when marketing consent was last given (null when off) — CF-5 consent record';



CREATE TABLE IF NOT EXISTS "public"."coordination_jobs" (
    "id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid"
);


ALTER TABLE "public"."coordination_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."crew_members" (
    "id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."crew_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "doc_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "storage_path" "text",
    "file_url" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "notes" "text",
    "signed_at" timestamp with time zone,
    "signed_by_name" "text",
    CONSTRAINT "documents_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['work_authorization'::"text", 'direction_to_pay'::"text", 'responsibility_acknowledgment'::"text", 'change_order'::"text", 'estimate'::"text", 'invoice'::"text", 'carrier_correspondence'::"text", 'permit'::"text", 'vendor_invoice'::"text", 'closeout'::"text", 'other'::"text"]))),
    CONSTRAINT "documents_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'signed'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."equipment_logs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "room_id" "uuid",
    "equipment_type" "public"."equipment_type" NOT NULL,
    "equipment_name" "text" NOT NULL,
    "asset_number" "text",
    "serial_number" "text",
    "date_placed" "date" DEFAULT CURRENT_DATE NOT NULL,
    "date_removed" "date",
    "placed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."equipment_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."field_photos" (
    "id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "src" "text",
    "cloud" "text",
    "room" "text" DEFAULT ''::"text" NOT NULL,
    "stage" "text" DEFAULT 'during'::"text" NOT NULL,
    "caption" "text" DEFAULT ''::"text" NOT NULL,
    "ai" "jsonb",
    "taken_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "purged_at" timestamp with time zone
);
ALTER TABLE ONLY "public"."field_photos" ALTER COLUMN "src" SET COMPRESSION lz4;


ALTER TABLE "public"."field_photos" OWNER TO "postgres";


COMMENT ON TABLE "public"."field_photos" IS 'One row per job photo (migration 221, Phase 3). Replaces the photos[] array inside field_projects.data so adding a photo is one small insert instead of a multi-megabyte blob rewrite. Soft delete only: deleted_at is a flag, rows are purged by an operator, never by the app.';



COMMENT ON COLUMN "public"."field_photos"."purged_at" IS 'Deliberate, durable removal. The blob-to-row projection re-creates anything the blob still lists, so an ordinary delete cannot stick; a row marked here is skipped by the projection and stays gone.';



CREATE TABLE IF NOT EXISTS "public"."field_projects" (
    "id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid"
);


ALTER TABLE "public"."field_projects" OWNER TO "postgres";


COMMENT ON TABLE "public"."field_projects" IS 'Job blobs. WRITES GO THROUGH THE RPCs ONLY (push_project / tombstone_project / revive_project, migrations 217/218): they merge server-side so a stale client cannot clobber another device. Direct INSERT/UPDATE/DELETE was revoked from app roles in migration 219 - do not grant it back without also reverting the client (SYNC_VIA_RPC).';



CREATE OR REPLACE VIEW "public"."field_photos_deleted" AS
 SELECT "f"."job_id",
    ("fp"."data" ->> 'customer'::"text") AS "customer",
    "f"."id" AS "photo_id",
    "f"."room",
    "f"."stage",
    "f"."caption",
    "f"."deleted_at",
    "du"."email" AS "deleted_by",
    "cu"."email" AS "taken_by",
    "f"."taken_at",
    ("f"."purged_at" IS NOT NULL) AS "purged",
    (("f"."cloud" IS NOT NULL) OR ("f"."src" IS NOT NULL)) AS "recoverable"
   FROM ((("public"."field_photos" "f"
     LEFT JOIN "public"."field_projects" "fp" ON (("fp"."id" = "f"."job_id")))
     LEFT JOIN "auth"."users" "du" ON (("du"."id" = "f"."deleted_by")))
     LEFT JOIN "auth"."users" "cu" ON (("cu"."id" = "f"."created_by")))
  WHERE ("f"."deleted_at" IS NOT NULL)
  ORDER BY "f"."deleted_at" DESC;


ALTER VIEW "public"."field_photos_deleted" OWNER TO "postgres";


COMMENT ON VIEW "public"."field_photos_deleted" IS 'Photos removed from a job (migration 225). The row keeps the image and who removed it; restore_photo(job_id, photo_id) puts one back. Operator-only.';



CREATE OR REPLACE VIEW "public"."field_photos_drift" AS
 WITH "blob_photos" AS (
         SELECT "fp"."id" AS "job_id",
            (("p"."value" ->> 'id'::"text"))::"uuid" AS "photo_id"
           FROM "public"."field_projects" "fp",
            LATERAL "jsonb_array_elements"(("fp"."data" -> 'photos'::"text")) "p"("value")
          WHERE ((NOT "fp"."deleted") AND ("jsonb_typeof"(("fp"."data" -> 'photos'::"text")) = 'array'::"text") AND ("jsonb_typeof"("p"."value") = 'object'::"text") AND (("p"."value" ->> 'id'::"text") ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::"text"))
        )
 SELECT "b"."job_id",
    "b"."photo_id",
    'missing row'::"text" AS "problem"
   FROM "blob_photos" "b"
  WHERE ((NOT (EXISTS ( SELECT 1
           FROM "public"."field_photos" "f"
          WHERE (("f"."id" = "b"."photo_id") AND ("f"."job_id" = "b"."job_id") AND ("f"."deleted_at" IS NULL))))) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."field_photos" "f"
          WHERE (("f"."id" = "b"."photo_id") AND ("f"."job_id" = "b"."job_id") AND ("f"."purged_at" IS NOT NULL))))))
UNION ALL
 SELECT "f"."job_id",
    "f"."id" AS "photo_id",
    'row not in blob'::"text" AS "problem"
   FROM ("public"."field_photos" "f"
     JOIN "public"."field_projects" "fp" ON ((("fp"."id" = "f"."job_id") AND (NOT "fp"."deleted"))))
  WHERE (("f"."deleted_at" IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM "blob_photos" "b"
          WHERE (("b"."photo_id" = "f"."id") AND ("b"."job_id" = "f"."job_id"))))));


ALTER VIEW "public"."field_photos_drift" OWNER TO "postgres";


COMMENT ON VIEW "public"."field_photos_drift" IS 'Operator check that field_photos mirrors the job blobs (223, fixed in 224). Expect zero rows. The projection swallows its own errors so a field save is never blocked, and the nightly repair-field-photos job re-reconciles; this is how anything left over is noticed. Run it before Phase 3 flips reads onto these rows.';



CREATE TABLE IF NOT EXISTS "public"."field_projects_trash" (
    "id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "deleted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."field_projects_trash" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."field_requirements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "required_form_id" "uuid" NOT NULL,
    "field_path" "text" NOT NULL,
    "label" "text" NOT NULL,
    "gate" "text" DEFAULT 'hard'::"text" NOT NULL,
    "requirement" "text" DEFAULT 'always'::"text" NOT NULL,
    "condition_key" "text",
    "note" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."field_requirements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."floor_plan_openings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "wall_index" integer NOT NULL,
    "type" "text" NOT NULL,
    "width" numeric NOT NULL,
    "height" numeric NOT NULL,
    "offset_from_start" numeric DEFAULT 0 NOT NULL,
    "swing" "text",
    "label" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "floor_plan_openings_type_check" CHECK (("type" = ANY (ARRAY['door'::"text", 'window'::"text", 'opening'::"text"])))
);


ALTER TABLE "public"."floor_plan_openings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."floor_plan_rooms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Room'::"text" NOT NULL,
    "points" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "height" numeric DEFAULT 8 NOT NULL,
    "color" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."floor_plan_rooms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."floor_plans" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "magicplan_project_id" "text",
    "file_url" "text",
    "storage_path" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'magicplan'::"text" NOT NULL,
    "file_name" "text",
    "file_type" "text"
);


ALTER TABLE "public"."floor_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gmail_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "account" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "last_pull_epoch" bigint,
    "connected_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."gmail_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."integration_runs" (
    "id" bigint NOT NULL,
    "connection" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "ok" boolean,
    "error" "text",
    "rows_affected" integer,
    "external_ref" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "integration_runs_kind_check" CHECK (("kind" = ANY (ARRAY['pull'::"text", 'push'::"text", 'refresh'::"text", 'webhook'::"text"])))
);


ALTER TABLE "public"."integration_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."integration_runs" IS 'One row per integration adapter call (247, F-005). Written by the service role only; authenticated may read. P1 replaces `connection` text with connection_id -> connections(id) (roadmap §2.6).';



CREATE TABLE IF NOT EXISTS "public"."qb_time_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "realm_id" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "connected_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qb_time_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "realm_id" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "connected_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qbo_tokens" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."integration_health" AS
 WITH "tok" AS (
         SELECT DISTINCT ON ("t_1"."connection") "t_1"."connection",
            "t_1"."account",
            "t_1"."token_expires_at"
           FROM ( SELECT 'gmail'::"text" AS "connection",
                    "g"."account",
                    "g"."expires_at" AS "token_expires_at",
                    "g"."updated_at"
                   FROM "public"."gmail_tokens" "g"
                UNION ALL
                 SELECT 'qb_time'::"text",
                    "q"."realm_id",
                    "q"."expires_at",
                    "q"."updated_at"
                   FROM "public"."qb_time_tokens" "q"
                UNION ALL
                 SELECT 'qbo'::"text",
                    "o"."realm_id",
                    "o"."expires_at",
                    "o"."updated_at"
                   FROM "public"."qbo_tokens" "o") "t_1"
          ORDER BY "t_1"."connection", "t_1"."updated_at" DESC
        ), "lanes" AS (
         SELECT "tok"."connection"
           FROM "tok"
        UNION
         SELECT "integration_runs"."connection"
           FROM "public"."integration_runs"
        UNION
         SELECT "v"."connection"
           FROM ( VALUES ('gmail'::"text"), ('qb_time'::"text"), ('qbo'::"text")) "v"("connection")
        ), "done" AS (
         SELECT "r"."connection",
            COALESCE("r"."finished_at", "r"."started_at") AS "at",
            "r"."ok",
            "r"."error"
           FROM "public"."integration_runs" "r"
          WHERE ("r"."ok" IS NOT NULL)
        ), "last_ok" AS (
         SELECT "d"."connection",
            "max"("d"."at") AS "at"
           FROM "done" "d"
          WHERE "d"."ok"
          GROUP BY "d"."connection"
        ), "fails" AS (
         SELECT "d"."connection",
            "count"(*) AS "n",
            ("array_agg"("d"."error" ORDER BY "d"."at" DESC))[1] AS "last_error"
           FROM ("done" "d"
             LEFT JOIN "last_ok" "k_1" ON (("k_1"."connection" = "d"."connection")))
          WHERE ((NOT "d"."ok") AND ("d"."at" > COALESCE("k_1"."at", '-infinity'::timestamp with time zone)))
          GROUP BY "d"."connection"
        )
 SELECT "l"."connection",
    "t"."account",
    "t"."token_expires_at",
    "k"."at" AS "last_ok_at",
    "f"."last_error",
    (COALESCE("f"."n", (0)::bigint))::integer AS "consecutive_failures",
        CASE
            WHEN ("t"."token_expires_at" IS NULL) THEN 'not_connected'::"text"
            WHEN ("t"."token_expires_at" < ("now"() - '25:00:00'::interval)) THEN 'token_stale'::"text"
            WHEN (COALESCE("f"."n", (0)::bigint) >= 3) THEN 'failing'::"text"
            WHEN ("k"."at" IS NULL) THEN 'no_runs_yet'::"text"
            ELSE 'ok'::"text"
        END AS "status"
   FROM ((("lanes" "l"
     LEFT JOIN "tok" "t" ON (("t"."connection" = "l"."connection")))
     LEFT JOIN "last_ok" "k" ON (("k"."connection" = "l"."connection")))
     LEFT JOIN "fails" "f" ON (("f"."connection" = "l"."connection")));


ALTER VIEW "public"."integration_health" OWNER TO "postgres";


COMMENT ON VIEW "public"."integration_health" IS 'Per-lane automation health (247, F-005): last_ok_at, last_error, consecutive_failures and token expiry. status token_stale = the refresh loop stopped advancing expires_at for 25h+ (how Gmail 09-01 and QB Time 09-04 actually failed). Owner-run on purpose so it can read the token tables; it exposes expiry and account only, never a token.';



ALTER TABLE "public"."integration_runs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."integration_runs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "invoice_number" "text" DEFAULT ''::"text" NOT NULL,
    "invoice_type" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "amount_cents" integer DEFAULT 0 NOT NULL,
    "paid_cents" integer DEFAULT 0 NOT NULL,
    "due_date" "date",
    "submitted_date" "date",
    "paid_date" "date",
    "notes" "text",
    "xactimate_ref" "text",
    CONSTRAINT "invoices_invoice_type_check" CHECK (("invoice_type" = ANY (ARRAY['mitigation'::"text", 'reconstruction'::"text", 'tm'::"text", 'vendor_passthrough'::"text", 'supplement'::"text"]))),
    CONSTRAINT "invoices_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'partially_paid'::"text", 'paid'::"text", 'disputed'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."job_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."job_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_number" "text" DEFAULT ''::"text" NOT NULL,
    "status" "public"."job_status" DEFAULT 'new'::"public"."job_status" NOT NULL,
    "loss_type" "public"."loss_type",
    "loss_category" "public"."loss_category",
    "date_of_loss" "date",
    "property_address" "text" DEFAULT ''::"text" NOT NULL,
    "owner_name" "text",
    "owner_phone" "text",
    "owner_email" "text",
    "insurance_carrier" "text",
    "claim_number" "text",
    "adjuster_name" "text",
    "adjuster_phone" "text",
    "adjuster_email" "text",
    "assigned_tech_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "magicplan_project_id" "text",
    "notes" "text",
    "created_by" "uuid",
    "portal_token" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "date_received" "date",
    "cause_of_loss" "text",
    "is_emergency" boolean DEFAULT false NOT NULL,
    "billing_party" "text",
    "property_manager_name" "text",
    "property_manager_phone" "text",
    "property_manager_email" "text",
    "assigned_pm_id" "uuid",
    "xactimate_file_number" "text",
    "deductible_amount" integer DEFAULT 0,
    "policy_number" "text",
    "loss_location" "text",
    "lead_source" "text"
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."line_items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "room_id" "uuid",
    "category" "text" DEFAULT 'General'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" double precision DEFAULT 1 NOT NULL,
    "unit" "text" DEFAULT 'EA'::"text" NOT NULL,
    "unit_price" integer DEFAULT 0 NOT NULL,
    "total_cents" integer GENERATED ALWAYS AS (("round"(("quantity" * ("unit_price")::double precision)))::integer) STORED,
    "notes" "text",
    "billing_type" "public"."billing_type" DEFAULT 'scope'::"public"."billing_type" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."manual_floor_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Floor Plan'::"text" NOT NULL,
    "scale" numeric DEFAULT 50 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."manual_floor_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."moisture_readings" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "room_id" "uuid" NOT NULL,
    "reading_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "location_description" "text" NOT NULL,
    "material_type" "text" NOT NULL,
    "moisture_pct" double precision NOT NULL,
    "is_dry" boolean DEFAULT false NOT NULL,
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."moisture_readings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pending_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" integer NOT NULL,
    "kind" "text" NOT NULL,
    "label" "text" DEFAULT ''::"text" NOT NULL,
    "params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "job_id" "text",
    "proposed_by" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "result" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval) NOT NULL,
    "executed_at" timestamp with time zone,
    CONSTRAINT "pending_actions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'executed'::"text", 'failed'::"text", 'declined'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."pending_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."phase_instances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "unified_job_id" "uuid" NOT NULL,
    "template_id" "uuid",
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "conditions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."phase_instances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."phase_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "loss_type" "text" DEFAULT 'water'::"text" NOT NULL,
    "description" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."phase_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."photo_shares" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "field_project_id" "uuid",
    "share_token" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "kind" "text" DEFAULT 'photos'::"text" NOT NULL,
    "customer_name" "text" DEFAULT ''::"text" NOT NULL,
    "property_address" "text" DEFAULT ''::"text" NOT NULL,
    "claim_no" "text" DEFAULT ''::"text" NOT NULL,
    "date_of_loss" "text" DEFAULT ''::"text" NOT NULL,
    "photos" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."photo_shares" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."photos" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "room_id" "uuid",
    "uploaded_by" "uuid",
    "storage_path" "text" NOT NULL,
    "caption" "text",
    "category" "public"."photo_category" DEFAULT 'general'::"public"."photo_category" NOT NULL,
    "taken_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "gps_lat" double precision,
    "gps_lng" double precision,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."portal_selections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "portal_job_id" "uuid" NOT NULL,
    "selection_id" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "type" "text" DEFAULT ''::"text" NOT NULL,
    "label" "text" DEFAULT ''::"text" NOT NULL,
    "scope" "text" DEFAULT 'room'::"text" NOT NULL,
    "room" "text" DEFAULT ''::"text" NOT NULL,
    "room_key" "text" DEFAULT ''::"text" NOT NULL,
    "rooms" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "descr" "text" DEFAULT ''::"text" NOT NULL,
    "cat" "text" DEFAULT ''::"text" NOT NULL,
    "sel" "text" DEFAULT ''::"text" NOT NULL,
    "qty" numeric(12,2),
    "unit" "text" DEFAULT ''::"text" NOT NULL,
    "lkq_unit_cost" numeric(12,2),
    "lkq_total" numeric(12,2),
    "waste_pct" numeric(5,2),
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "chosen_option_id" "text",
    "chosen_label" "text",
    "delta_cents" integer DEFAULT 0 NOT NULL,
    "chosen_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_choice" "text",
    "customer_note" "text",
    "responded_at" timestamp with time zone,
    CONSTRAINT "portal_selections_choice_chk" CHECK ((("customer_choice" IS NULL) OR ("customer_choice" = ANY (ARRAY['match'::"text", 'change'::"text"]))))
);


ALTER TABLE "public"."portal_selections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."price_list" (
    "id" bigint NOT NULL,
    "market" "text" DEFAULT 'FAIRBANK'::"text" NOT NULL,
    "category" "text" NOT NULL,
    "category_label" "text" NOT NULL,
    "code" "text" NOT NULL,
    "description" "text" NOT NULL,
    "unit" "text",
    "replace_price" numeric(10,2),
    "remove_price" numeric(10,2),
    "detach_reset_price" numeric(10,2),
    "source" "text" DEFAULT 'Fairbanks CONSOLIDATED 2026-07-13 (screenshot transcription)'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."price_list" OWNER TO "postgres";


COMMENT ON TABLE "public"."price_list" IS 'Fairbanks Xactimate market prices — reference basis for reconstruction estimates. replace_price is the quoted unit price.';



ALTER TABLE "public"."price_list" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."price_list_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text" DEFAULT ''::"text" NOT NULL,
    "role" "public"."user_role" DEFAULT 'tech'::"public"."user_role" NOT NULL,
    "phone" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qb_time_jobcodes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "qb_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "parent_id" "text",
    "jobcode_type" "text",
    "active" boolean DEFAULT true NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qb_time_jobcodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reconstruction_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "room_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "trade" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "completed_by" "uuid",
    "completed_at" timestamp with time zone,
    "sort_order" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "reconstruction_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_progress'::"text", 'complete'::"text", 'skipped'::"text"]))),
    CONSTRAINT "reconstruction_items_trade_check" CHECK (("trade" = ANY (ARRAY['drywall'::"text", 'insulation'::"text", 'paint'::"text", 'trim'::"text", 'flooring'::"text", 'cabinetry'::"text", 'plumbing'::"text", 'electrical'::"text", 'hvac'::"text", 'final_clean'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."reconstruction_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."required_forms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "template_id" "uuid" NOT NULL,
    "form_key" "text" NOT NULL,
    "form_label" "text" NOT NULL,
    "requirement" "text" DEFAULT 'always'::"text" NOT NULL,
    "condition_key" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."required_forms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_markers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "canvas_plan_id" "uuid" NOT NULL,
    "room_id" "uuid",
    "type" "text" DEFAULT 'label'::"text" NOT NULL,
    "x" double precision NOT NULL,
    "y" double precision NOT NULL,
    "label" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "room_markers_type_check" CHECK (("type" = ANY (ARRAY['label'::"text", 'equipment'::"text", 'moisture'::"text", 'fixture'::"text"])))
);


ALTER TABLE "public"."room_markers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_openings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "type" "text" DEFAULT 'door'::"text" NOT NULL,
    "wall_index" integer DEFAULT 0 NOT NULL,
    "position" double precision DEFAULT 0.5 NOT NULL,
    "width" double precision DEFAULT 3 NOT NULL,
    "height" double precision DEFAULT 6.8 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "room_openings_type_check" CHECK (("type" = ANY (ARRAY['door'::"text", 'window'::"text", 'opening'::"text"])))
);


ALTER TABLE "public"."room_openings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rooms" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "floor_level" "text" DEFAULT 'Main'::"text" NOT NULL,
    "affected" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "canvas_plan_id" "uuid",
    "polygon_points" "jsonb",
    "height" double precision DEFAULT 8 NOT NULL,
    "floor_area" double precision,
    "perimeter" double precision,
    "wall_area" double precision,
    "ceiling_area" double precision,
    "centroid_x" double precision,
    "centroid_y" double precision,
    "color" "text" DEFAULT '#1e3a5f'::"text" NOT NULL,
    "room_notes" "text",
    "category_of_water" "text",
    "class_of_loss" "text",
    "demo_status" "text" DEFAULT 'none'::"text",
    "drying_status" "text" DEFAULT 'not_started'::"text",
    "checkbox_flags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rooms_category_of_water_check" CHECK (("category_of_water" = ANY (ARRAY['cat1'::"text", 'cat2'::"text", 'cat3'::"text"]))),
    CONSTRAINT "rooms_class_of_loss_check" CHECK (("class_of_loss" = ANY (ARRAY['class1'::"text", 'class2'::"text", 'class3'::"text", 'class4'::"text"]))),
    CONSTRAINT "rooms_demo_status_check" CHECK (("demo_status" = ANY (ARRAY['none'::"text", 'partial'::"text", 'complete'::"text"]))),
    CONSTRAINT "rooms_drying_status_check" CHECK (("drying_status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'complete'::"text"])))
);


ALTER TABLE "public"."rooms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_clients" (
    "user_id" "uuid" NOT NULL,
    "build" "text",
    "last_seen" timestamp with time zone DEFAULT "now"() NOT NULL,
    "calls" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."sync_clients" OWNER TO "postgres";


COMMENT ON TABLE "public"."sync_clients" IS 'Which build each person last synced from (migration 226). Written by _sync_guard on every sync RPC. Used to confirm the fleet is off the pre-RPC builds before/after migration 219 revokes direct writes.';



CREATE OR REPLACE VIEW "public"."sync_fleet" AS
 SELECT "u"."email",
    ("p"."role")::"text" AS "role",
    "c"."build",
    "c"."last_seen",
    "c"."calls",
        CASE
            WHEN ("p"."role" = 'viewer'::"public"."user_role") THEN 'n/a (service account)'::"text"
            WHEN ("c"."user_id" IS NULL) THEN 'never synced through the RPC'::"text"
            WHEN ("c"."last_seen" < ("now"() - '3 days'::interval)) THEN 'quiet 3+ days'::"text"
            ELSE 'ok'::"text"
        END AS "status"
   FROM (("public"."profiles" "p"
     JOIN "auth"."users" "u" ON (("u"."id" = "p"."id")))
     LEFT JOIN "public"."sync_clients" "c" ON (("c"."user_id" = "p"."id")))
  ORDER BY ("c"."last_seen" IS NULL) DESC, "c"."last_seen" DESC NULLS LAST;


ALTER VIEW "public"."sync_fleet" OWNER TO "postgres";


COMMENT ON VIEW "public"."sync_fleet" IS 'Roster vs. reality: who has synced through the RPCs, from which build, and who has not appeared at all. After migration 219, anyone flagged here is a device still on a pre-RPC build whose saves are being refused.';



CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "assigned_to" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "due_date" "date",
    "title" "text" NOT NULL,
    "description" "text",
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "category" "text",
    CONSTRAINT "tasks_category_check" CHECK (("category" = ANY (ARRAY['photo'::"text", 'document'::"text", 'estimate'::"text", 'inspection'::"text", 'monitoring'::"text", 'invoice'::"text", 'communication'::"text", 'scheduling'::"text", 'other'::"text"]))),
    CONSTRAINT "tasks_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'done'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tech_checkins" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "tech_id" "uuid" NOT NULL,
    "checked_in_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "checked_out_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tech_checkins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."time_entries" (
    "id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."time_entries" OWNER TO "postgres";


COMMENT ON TABLE "public"."time_entries" IS 'Logged crew hours (102). Since 247 authenticated may SELECT/INSERT/UPDATE but not DELETE — the QB Time proxy soft-deletes with data.deleted on the service role, and hours are claim documentation.';



CREATE TABLE IF NOT EXISTS "public"."unified_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_number" "text",
    "insurance_carrier" "text",
    "adjuster_name" "text",
    "adjuster_phone" "text",
    "adjuster_email" "text",
    "property_address" "text",
    "owner_name" "text",
    "owner_phone" "text",
    "owner_email" "text",
    "date_of_loss" "date",
    "loss_type" "text",
    "water_category" "text",
    "water_class" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "current_phase_id" "uuid",
    "field_project_id" "uuid",
    "coordination_job_id" "uuid",
    "relational_job_id" "uuid",
    "qb_jobcode_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "contact_id" "uuid"
);


ALTER TABLE "public"."unified_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_authorizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "wa_date" "text",
    "work_order_number" "text",
    "owner_name" "text",
    "owner_phone" "text",
    "loss_cause" "text",
    "claim_number" "text",
    "ins_carrier" "text",
    "owner_sig_data_url" "text",
    "contractor_sig_data_url" "text",
    "owner_sig_date" "text",
    "contractor_sig_date" "text",
    "owner_signed_at" timestamp with time zone,
    "contractor_signed_at" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."work_authorizations" OWNER TO "postgres";


ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."blob_history"
    ADD CONSTRAINT "blob_history_pkey" PRIMARY KEY ("hist_id");



ALTER TABLE ONLY "public"."canvas_plans"
    ADD CONSTRAINT "canvas_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."capture_events"
    ADD CONSTRAINT "capture_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."communications"
    ADD CONSTRAINT "communications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."completeness_state"
    ADD CONSTRAINT "completeness_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."completeness_state"
    ADD CONSTRAINT "completeness_state_unified_job_id_phase_instance_id_key" UNIQUE ("unified_job_id", "phase_instance_id");



ALTER TABLE ONLY "public"."contact_merge_suggestions"
    ADD CONSTRAINT "contact_merge_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_sessions"
    ADD CONSTRAINT "contact_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_sessions"
    ADD CONSTRAINT "contact_sessions_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coordination_jobs"
    ADD CONSTRAINT "coordination_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."crew_members"
    ADD CONSTRAINT "crew_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_gmail_id_key" UNIQUE ("gmail_id");



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."equipment_logs"
    ADD CONSTRAINT "equipment_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."field_photos"
    ADD CONSTRAINT "field_photos_pkey" PRIMARY KEY ("job_id", "id");



ALTER TABLE ONLY "public"."field_projects"
    ADD CONSTRAINT "field_projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."field_projects_trash"
    ADD CONSTRAINT "field_projects_trash_pkey" PRIMARY KEY ("id", "deleted_at");



ALTER TABLE ONLY "public"."field_requirements"
    ADD CONSTRAINT "field_requirements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."field_requirements"
    ADD CONSTRAINT "field_requirements_uq" UNIQUE ("required_form_id", "field_path");



ALTER TABLE ONLY "public"."floor_plan_openings"
    ADD CONSTRAINT "floor_plan_openings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."floor_plan_rooms"
    ADD CONSTRAINT "floor_plan_rooms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."floor_plans"
    ADD CONSTRAINT "floor_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_tokens"
    ADD CONSTRAINT "gmail_tokens_account_key" UNIQUE ("account");



ALTER TABLE ONLY "public"."gmail_tokens"
    ADD CONSTRAINT "gmail_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integration_runs"
    ADD CONSTRAINT "integration_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_job_number_key" UNIQUE ("job_number");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_portal_token_key" UNIQUE ("portal_token");



ALTER TABLE ONLY "public"."line_items"
    ADD CONSTRAINT "line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manual_floor_plans"
    ADD CONSTRAINT "manual_floor_plans_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."manual_floor_plans"
    ADD CONSTRAINT "manual_floor_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."moisture_readings"
    ADD CONSTRAINT "moisture_readings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pending_actions"
    ADD CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."phase_instances"
    ADD CONSTRAINT "phase_instances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."phase_templates"
    ADD CONSTRAINT "phase_templates_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."phase_templates"
    ADD CONSTRAINT "phase_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."photo_shares"
    ADD CONSTRAINT "photo_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."photo_shares"
    ADD CONSTRAINT "photo_shares_share_token_key" UNIQUE ("share_token");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_jobs"
    ADD CONSTRAINT "portal_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_jobs"
    ADD CONSTRAINT "portal_jobs_share_token_key" UNIQUE ("share_token");



ALTER TABLE ONLY "public"."portal_messages"
    ADD CONSTRAINT "portal_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_selections"
    ADD CONSTRAINT "portal_selections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_selections"
    ADD CONSTRAINT "portal_selections_portal_job_id_selection_id_key" UNIQUE ("portal_job_id", "selection_id");



ALTER TABLE ONLY "public"."price_list"
    ADD CONSTRAINT "price_list_market_category_code_key" UNIQUE ("market", "category", "code");



ALTER TABLE ONLY "public"."price_list"
    ADD CONSTRAINT "price_list_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qb_time_jobcodes"
    ADD CONSTRAINT "qb_time_jobcodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qb_time_jobcodes"
    ADD CONSTRAINT "qb_time_jobcodes_qb_id_key" UNIQUE ("qb_id");



ALTER TABLE ONLY "public"."qb_time_tokens"
    ADD CONSTRAINT "qb_time_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qb_time_tokens"
    ADD CONSTRAINT "qb_time_tokens_realm_id_key" UNIQUE ("realm_id");



ALTER TABLE ONLY "public"."qbo_tokens"
    ADD CONSTRAINT "qbo_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_tokens"
    ADD CONSTRAINT "qbo_tokens_realm_id_key" UNIQUE ("realm_id");



ALTER TABLE ONLY "public"."reconstruction_items"
    ADD CONSTRAINT "reconstruction_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."required_forms"
    ADD CONSTRAINT "required_forms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."required_forms"
    ADD CONSTRAINT "required_forms_template_id_form_key_key" UNIQUE ("template_id", "form_key");



ALTER TABLE ONLY "public"."room_markers"
    ADD CONSTRAINT "room_markers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."room_openings"
    ADD CONSTRAINT "room_openings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sms_messages"
    ADD CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_clients"
    ADD CONSTRAINT "sync_clients_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tech_checkins"
    ADD CONSTRAINT "tech_checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."unified_jobs"
    ADD CONSTRAINT "unified_jobs_field_project_id_key" UNIQUE ("field_project_id");



ALTER TABLE ONLY "public"."unified_jobs"
    ADD CONSTRAINT "unified_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_authorizations"
    ADD CONSTRAINT "work_authorizations_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."work_authorizations"
    ADD CONSTRAINT "work_authorizations_pkey" PRIMARY KEY ("id");



CREATE INDEX "ai_usage_job_idx" ON "public"."ai_usage" USING "btree" ("unified_job_id");



CREATE INDEX "ai_usage_month_formkey_idx" ON "public"."ai_usage" USING "btree" ("billing_month", "form_key");



CREATE INDEX "ai_usage_month_idx" ON "public"."ai_usage" USING "btree" ("billing_month");



CREATE INDEX "blob_history_lookup" ON "public"."blob_history" USING "btree" ("table_name", "id", "replaced_at" DESC);



CREATE INDEX "canvas_plans_job_id_idx" ON "public"."canvas_plans" USING "btree" ("job_id");



CREATE INDEX "capture_events_contact_idx" ON "public"."capture_events" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "capture_events_job_idx" ON "public"."capture_events" USING "btree" ("unified_job_id");



CREATE INDEX "capture_events_status_idx" ON "public"."capture_events" USING "btree" ("status");



CREATE INDEX "capture_events_web_iphash_idx" ON "public"."capture_events" USING "btree" ((("raw_payload" ->> 'ipHash'::"text"))) WHERE ("form_key" = 'webReceptionist'::"text");



CREATE INDEX "capture_events_web_recent_idx" ON "public"."capture_events" USING "btree" ("created_at") WHERE ("form_key" = 'webReceptionist'::"text");



CREATE INDEX "capture_events_web_subnet_idx" ON "public"."capture_events" USING "btree" ((("raw_payload" ->> 'subnetHash'::"text"))) WHERE ("form_key" = 'webReceptionist'::"text");



CREATE INDEX "communications_created_at_idx" ON "public"."communications" USING "btree" ("created_at" DESC);



CREATE INDEX "communications_job_id_idx" ON "public"."communications" USING "btree" ("job_id");



CREATE INDEX "completeness_job_idx" ON "public"."completeness_state" USING "btree" ("unified_job_id");



CREATE INDEX "contact_sessions_contact_idx" ON "public"."contact_sessions" USING "btree" ("contact_id", "created_at");



CREATE INDEX "contact_sessions_token_idx" ON "public"."contact_sessions" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);



CREATE UNIQUE INDEX "contact_suggest_fill_idx" ON "public"."contact_merge_suggestions" USING "btree" ("contact_a", "reason", "md5"(("detail")::"text")) WHERE (("contact_b" IS NULL) AND ("status" = 'open'::"text"));



CREATE UNIQUE INDEX "contact_suggest_pair_idx" ON "public"."contact_merge_suggestions" USING "btree" (LEAST("contact_a", "contact_b"), GREATEST("contact_a", "contact_b"), "reason") WHERE (("contact_b" IS NOT NULL) AND ("status" = 'open'::"text"));



CREATE INDEX "contacts_email_idx" ON "public"."contacts" USING "btree" ("email_norm") WHERE ("email_norm" <> ''::"text");



CREATE INDEX "contacts_merged_idx" ON "public"."contacts" USING "btree" ("merged_into") WHERE ("merged_into" IS NOT NULL);



CREATE INDEX "contacts_phone_idx" ON "public"."contacts" USING "btree" ("phone_norm") WHERE ("phone_norm" <> ''::"text");



CREATE INDEX "coordination_jobs_channel_day_idx" ON "public"."coordination_jobs" USING "btree" ("created_at") WHERE (("data" ->> 'channel'::"text") = 'ai-chat'::"text");



CREATE INDEX "coordination_jobs_updated_idx" ON "public"."coordination_jobs" USING "btree" ("updated_at");



CREATE INDEX "crew_members_updated_idx" ON "public"."crew_members" USING "btree" ("updated_at");



CREATE INDEX "documents_job_id_idx" ON "public"."documents" USING "btree" ("job_id");



CREATE INDEX "email_messages_contact_idx" ON "public"."email_messages" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "email_messages_job_idx" ON "public"."email_messages" USING "btree" ("job_id", "received_at" DESC);



CREATE INDEX "email_messages_unread_idx" ON "public"."email_messages" USING "btree" ("read_by_office") WHERE ("direction" = 'in'::"text");



CREATE INDEX "equipment_job_id_idx" ON "public"."equipment_logs" USING "btree" ("job_id");



CREATE INDEX "field_photos_id" ON "public"."field_photos" USING "btree" ("id");



CREATE INDEX "field_photos_job" ON "public"."field_photos" USING "btree" ("job_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "field_photos_purged" ON "public"."field_photos" USING "btree" ("purged_at") WHERE ("purged_at" IS NOT NULL);



CREATE INDEX "field_photos_sync" ON "public"."field_photos" USING "btree" ("updated_at" DESC);



CREATE INDEX "field_photos_trash" ON "public"."field_photos" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "field_projects_updated_idx" ON "public"."field_projects" USING "btree" ("updated_at");



CREATE INDEX "integration_runs_conn_started_idx" ON "public"."integration_runs" USING "btree" ("connection", "started_at" DESC);



CREATE INDEX "invoices_job_id_idx" ON "public"."invoices" USING "btree" ("job_id");



CREATE INDEX "jobs_created_by_idx" ON "public"."jobs" USING "btree" ("created_by");



CREATE INDEX "jobs_portal_token_idx" ON "public"."jobs" USING "btree" ("portal_token");



CREATE INDEX "jobs_status_idx" ON "public"."jobs" USING "btree" ("status");



CREATE INDEX "jobs_tech_ids_idx" ON "public"."jobs" USING "gin" ("assigned_tech_ids");



CREATE INDEX "line_items_job_id_idx" ON "public"."line_items" USING "btree" ("job_id");



CREATE INDEX "moisture_job_id_idx" ON "public"."moisture_readings" USING "btree" ("job_id", "reading_date");



CREATE INDEX "pending_actions_live_idx" ON "public"."pending_actions" USING "btree" ("status", "expires_at" DESC, "created_at" DESC);



CREATE INDEX "phase_instances_job_idx" ON "public"."phase_instances" USING "btree" ("unified_job_id");



CREATE INDEX "photo_shares_project_idx" ON "public"."photo_shares" USING "btree" ("field_project_id");



CREATE INDEX "photo_shares_token_idx" ON "public"."photo_shares" USING "btree" ("share_token");



CREATE INDEX "photos_job_id_idx" ON "public"."photos" USING "btree" ("job_id");



CREATE INDEX "photos_room_id_idx" ON "public"."photos" USING "btree" ("room_id");



CREATE INDEX "portal_jobs_contact_idx" ON "public"."portal_jobs" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "portal_jobs_project_idx" ON "public"."portal_jobs" USING "btree" ("field_project_id");



CREATE INDEX "portal_jobs_token_idx" ON "public"."portal_jobs" USING "btree" ("share_token");



CREATE INDEX "portal_jobs_updated_idx" ON "public"."portal_jobs" USING "btree" ("updated_at");



CREATE INDEX "portal_messages_job_idx" ON "public"."portal_messages" USING "btree" ("portal_job_id", "created_at");



CREATE INDEX "portal_messages_unread_idx" ON "public"."portal_messages" USING "btree" ("portal_job_id") WHERE (("direction" = 'in'::"text") AND ("read_by_office" = false));



CREATE INDEX "portal_selections_job_idx" ON "public"."portal_selections" USING "btree" ("portal_job_id", "sort_order");



CREATE INDEX "portal_selections_pending_idx" ON "public"."portal_selections" USING "btree" ("portal_job_id") WHERE ("chosen_option_id" IS NULL);



CREATE INDEX "portal_selections_wants_change_idx" ON "public"."portal_selections" USING "btree" ("portal_job_id") WHERE ("customer_choice" = 'change'::"text");



CREATE INDEX "price_list_category_idx" ON "public"."price_list" USING "btree" ("category");



CREATE INDEX "price_list_code_trgm_idx" ON "public"."price_list" USING "gin" ("code" "public"."gin_trgm_ops");



CREATE INDEX "price_list_desc_trgm_idx" ON "public"."price_list" USING "gin" ("description" "public"."gin_trgm_ops");



CREATE INDEX "reconstruction_items_job_id_idx" ON "public"."reconstruction_items" USING "btree" ("job_id");



CREATE INDEX "reconstruction_items_room_id_idx" ON "public"."reconstruction_items" USING "btree" ("room_id");



CREATE INDEX "room_markers_canvas_plan_id_idx" ON "public"."room_markers" USING "btree" ("canvas_plan_id");



CREATE INDEX "room_openings_room_id_idx" ON "public"."room_openings" USING "btree" ("room_id");



CREATE INDEX "rooms_canvas_plan_id_idx" ON "public"."rooms" USING "btree" ("canvas_plan_id");



CREATE INDEX "sms_messages_contact_idx" ON "public"."sms_messages" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "sms_messages_job_idx" ON "public"."sms_messages" USING "btree" ("unified_job_id");



CREATE INDEX "sms_messages_sid_idx" ON "public"."sms_messages" USING "btree" ("twilio_sid");



CREATE INDEX "sms_messages_time_idx" ON "public"."sms_messages" USING "btree" ("created_at");



CREATE INDEX "tasks_assigned_to_idx" ON "public"."tasks" USING "btree" ("assigned_to");



CREATE INDEX "tasks_due_date_idx" ON "public"."tasks" USING "btree" ("due_date");



CREATE INDEX "tasks_job_id_idx" ON "public"."tasks" USING "btree" ("job_id");



CREATE INDEX "tech_checkins_job_id_idx" ON "public"."tech_checkins" USING "btree" ("job_id");



CREATE INDEX "tech_checkins_tech_id_idx" ON "public"."tech_checkins" USING "btree" ("tech_id", "checked_in_at" DESC);



CREATE INDEX "time_entries_updated_idx" ON "public"."time_entries" USING "btree" ("updated_at");



CREATE INDEX "unified_jobs_claim_idx" ON "public"."unified_jobs" USING "btree" ("claim_number");



CREATE INDEX "unified_jobs_contact_idx" ON "public"."unified_jobs" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "unified_jobs_coord_idx" ON "public"."unified_jobs" USING "btree" ("coordination_job_id");



CREATE INDEX "unified_jobs_field_idx" ON "public"."unified_jobs" USING "btree" ("field_project_id");



CREATE OR REPLACE TRIGGER "blob_history_capture" BEFORE DELETE OR UPDATE ON "public"."coordination_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."capture_blob_history"();



CREATE OR REPLACE TRIGGER "blob_history_capture" BEFORE DELETE OR UPDATE ON "public"."field_projects" FOR EACH ROW EXECUTE FUNCTION "public"."capture_blob_history"();



CREATE OR REPLACE TRIGGER "canvas_plans_updated_at" BEFORE UPDATE ON "public"."canvas_plans" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "equipment_logs_updated_at" BEFORE UPDATE ON "public"."equipment_logs" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "field_projects_trash_capture" BEFORE UPDATE ON "public"."field_projects" FOR EACH ROW EXECUTE FUNCTION "public"."field_projects_trash_capture"();



CREATE OR REPLACE TRIGGER "invoices_updated_at" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "jobs_updated_at" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "line_items_updated_at" BEFORE UPDATE ON "public"."line_items" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "moisture_compute_dry" BEFORE INSERT OR UPDATE ON "public"."moisture_readings" FOR EACH ROW EXECUTE FUNCTION "public"."compute_is_dry"();



CREATE OR REPLACE TRIGGER "project_field_photos" AFTER INSERT OR UPDATE ON "public"."field_projects" FOR EACH ROW EXECUTE FUNCTION "public"."project_field_photos"();



CREATE OR REPLACE TRIGGER "reconstruction_items_updated_at" BEFORE UPDATE ON "public"."reconstruction_items" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "room_openings_set_updated_at" BEFORE UPDATE ON "public"."room_openings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "rooms_updated_at" BEFORE UPDATE ON "public"."rooms" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "set_invoice_number" BEFORE INSERT ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."set_invoice_number"();



CREATE OR REPLACE TRIGGER "set_job_number" BEFORE INSERT ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."generate_job_number"();



CREATE OR REPLACE TRIGGER "stamp_field_photo" BEFORE INSERT OR UPDATE ON "public"."field_photos" FOR EACH ROW EXECUTE FUNCTION "public"."stamp_field_photo"();



CREATE OR REPLACE TRIGGER "stamp_updated_by" BEFORE INSERT OR UPDATE ON "public"."coordination_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."stamp_updated_by"();



CREATE OR REPLACE TRIGGER "stamp_updated_by" BEFORE INSERT OR UPDATE ON "public"."field_projects" FOR EACH ROW EXECUTE FUNCTION "public"."stamp_updated_by"();



CREATE OR REPLACE TRIGGER "tasks_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_ai_usage_set_month" BEFORE INSERT ON "public"."ai_usage" FOR EACH ROW EXECUTE FUNCTION "public"."ai_usage_set_month"();



CREATE OR REPLACE TRIGGER "trg_capture_events_touch" BEFORE INSERT OR UPDATE ON "public"."capture_events" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_completeness_touch" BEFORE INSERT OR UPDATE ON "public"."completeness_state" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_contacts_touch" BEFORE INSERT OR UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_coordination_jobs_touch" BEFORE INSERT OR UPDATE ON "public"."coordination_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_crew_members_touch" BEFORE INSERT OR UPDATE ON "public"."crew_members" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_field_projects_touch" BEFORE INSERT OR UPDATE ON "public"."field_projects" FOR EACH ROW EXECUTE FUNCTION "public"."field_projects_touch"();



CREATE OR REPLACE TRIGGER "trg_phase_instances_touch" BEFORE INSERT OR UPDATE ON "public"."phase_instances" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_photo_shares_touch" BEFORE INSERT OR UPDATE ON "public"."photo_shares" FOR EACH ROW EXECUTE FUNCTION "public"."photo_shares_touch"();



CREATE OR REPLACE TRIGGER "trg_portal_jobs_touch" BEFORE INSERT OR UPDATE ON "public"."portal_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."portal_jobs_touch"();



CREATE OR REPLACE TRIGGER "trg_portal_selections_touch" BEFORE INSERT OR UPDATE ON "public"."portal_selections" FOR EACH ROW EXECUTE FUNCTION "public"."portal_selections_touch"();



CREATE OR REPLACE TRIGGER "trg_time_entries_touch" BEFORE INSERT OR UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "trg_unified_jobs_touch" BEFORE INSERT OR UPDATE ON "public"."unified_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."coordination_touch"();



CREATE OR REPLACE TRIGGER "work_authorizations_updated_at" BEFORE UPDATE ON "public"."work_authorizations" FOR EACH ROW EXECUTE FUNCTION "public"."update_work_auth_updated_at"();



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_capture_event_id_fkey" FOREIGN KEY ("capture_event_id") REFERENCES "public"."capture_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_unified_job_id_fkey" FOREIGN KEY ("unified_job_id") REFERENCES "public"."unified_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."canvas_plans"
    ADD CONSTRAINT "canvas_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."canvas_plans"
    ADD CONSTRAINT "canvas_plans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."capture_events"
    ADD CONSTRAINT "capture_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."capture_events"
    ADD CONSTRAINT "capture_events_phase_instance_id_fkey" FOREIGN KEY ("phase_instance_id") REFERENCES "public"."phase_instances"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."capture_events"
    ADD CONSTRAINT "capture_events_unified_job_id_fkey" FOREIGN KEY ("unified_job_id") REFERENCES "public"."unified_jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."communications"
    ADD CONSTRAINT "communications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."communications"
    ADD CONSTRAINT "communications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."completeness_state"
    ADD CONSTRAINT "completeness_state_phase_instance_id_fkey" FOREIGN KEY ("phase_instance_id") REFERENCES "public"."phase_instances"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."completeness_state"
    ADD CONSTRAINT "completeness_state_unified_job_id_fkey" FOREIGN KEY ("unified_job_id") REFERENCES "public"."unified_jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_merge_suggestions"
    ADD CONSTRAINT "contact_merge_suggestions_contact_a_fkey" FOREIGN KEY ("contact_a") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_merge_suggestions"
    ADD CONSTRAINT "contact_merge_suggestions_contact_b_fkey" FOREIGN KEY ("contact_b") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_sessions"
    ADD CONSTRAINT "contact_sessions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_merged_into_fkey" FOREIGN KEY ("merged_into") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."equipment_logs"
    ADD CONSTRAINT "equipment_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."equipment_logs"
    ADD CONSTRAINT "equipment_logs_placed_by_fkey" FOREIGN KEY ("placed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."equipment_logs"
    ADD CONSTRAINT "equipment_logs_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."field_requirements"
    ADD CONSTRAINT "field_requirements_required_form_id_fkey" FOREIGN KEY ("required_form_id") REFERENCES "public"."required_forms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."floor_plan_openings"
    ADD CONSTRAINT "floor_plan_openings_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."manual_floor_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."floor_plan_openings"
    ADD CONSTRAINT "floor_plan_openings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."floor_plan_rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."floor_plan_rooms"
    ADD CONSTRAINT "floor_plan_rooms_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."manual_floor_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."floor_plans"
    ADD CONSTRAINT "floor_plans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_assigned_pm_id_fkey" FOREIGN KEY ("assigned_pm_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."line_items"
    ADD CONSTRAINT "line_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."line_items"
    ADD CONSTRAINT "line_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."manual_floor_plans"
    ADD CONSTRAINT "manual_floor_plans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moisture_readings"
    ADD CONSTRAINT "moisture_readings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moisture_readings"
    ADD CONSTRAINT "moisture_readings_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."moisture_readings"
    ADD CONSTRAINT "moisture_readings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."phase_instances"
    ADD CONSTRAINT "phase_instances_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."phase_templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."phase_instances"
    ADD CONSTRAINT "phase_instances_unified_job_id_fkey" FOREIGN KEY ("unified_job_id") REFERENCES "public"."unified_jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."portal_jobs"
    ADD CONSTRAINT "portal_jobs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."portal_messages"
    ADD CONSTRAINT "portal_messages_portal_job_id_fkey" FOREIGN KEY ("portal_job_id") REFERENCES "public"."portal_jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reconstruction_items"
    ADD CONSTRAINT "reconstruction_items_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."reconstruction_items"
    ADD CONSTRAINT "reconstruction_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reconstruction_items"
    ADD CONSTRAINT "reconstruction_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."required_forms"
    ADD CONSTRAINT "required_forms_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."phase_templates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_markers"
    ADD CONSTRAINT "room_markers_canvas_plan_id_fkey" FOREIGN KEY ("canvas_plan_id") REFERENCES "public"."canvas_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_markers"
    ADD CONSTRAINT "room_markers_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."room_openings"
    ADD CONSTRAINT "room_openings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_canvas_plan_id_fkey" FOREIGN KEY ("canvas_plan_id") REFERENCES "public"."canvas_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sms_messages"
    ADD CONSTRAINT "sms_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tech_checkins"
    ADD CONSTRAINT "tech_checkins_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tech_checkins"
    ADD CONSTRAINT "tech_checkins_tech_id_fkey" FOREIGN KEY ("tech_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."unified_jobs"
    ADD CONSTRAINT "unified_jobs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_authorizations"
    ADD CONSTRAINT "work_authorizations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



CREATE POLICY "Admin can do anything with canvas plans" ON "public"."canvas_plans" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with checkins" ON "public"."tech_checkins" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with equipment" ON "public"."equipment_logs" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with floor plans" ON "public"."floor_plans" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with jobs" ON "public"."jobs" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with line items" ON "public"."line_items" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with moisture" ON "public"."moisture_readings" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with photos" ON "public"."photos" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with room markers" ON "public"."room_markers" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with room openings" ON "public"."room_openings" USING ("public"."is_admin"());



CREATE POLICY "Admin can do anything with rooms" ON "public"."rooms" USING ("public"."is_admin"());



CREATE POLICY "Admin can read all profiles" ON "public"."profiles" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "Admin can update any profile" ON "public"."profiles" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "Authenticated users can manage communications" ON "public"."communications" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage documents" ON "public"."documents" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage invoices" ON "public"."invoices" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage reconstruction items" ON "public"."reconstruction_items" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage tasks" ON "public"."tasks" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage work authorizations" ON "public"."work_authorizations" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Tech can access canvas plans on assigned jobs" ON "public"."canvas_plans" USING ("public"."is_assigned_to_job"("job_id")) WITH CHECK ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can access equipment on assigned jobs" ON "public"."equipment_logs" USING ("public"."is_assigned_to_job"("job_id")) WITH CHECK ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can access line items on assigned jobs" ON "public"."line_items" USING ("public"."is_assigned_to_job"("job_id")) WITH CHECK ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can access moisture on assigned jobs" ON "public"."moisture_readings" USING ("public"."is_assigned_to_job"("job_id")) WITH CHECK ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can access photos on assigned jobs" ON "public"."photos" USING ("public"."is_assigned_to_job"("job_id")) WITH CHECK ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can access room markers" ON "public"."room_markers" USING ("public"."is_assigned_to_job"(( SELECT "canvas_plans"."job_id"
   FROM "public"."canvas_plans"
  WHERE ("canvas_plans"."id" = "room_markers"."canvas_plan_id")))) WITH CHECK ("public"."is_assigned_to_job"(( SELECT "canvas_plans"."job_id"
   FROM "public"."canvas_plans"
  WHERE ("canvas_plans"."id" = "room_markers"."canvas_plan_id"))));



CREATE POLICY "Tech can access room openings" ON "public"."room_openings" USING ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_openings"."room_id") AND "public"."is_assigned_to_job"("r"."job_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_openings"."room_id") AND "public"."is_assigned_to_job"("r"."job_id")))));



CREATE POLICY "Tech can access rooms on assigned jobs" ON "public"."rooms" USING ("public"."is_assigned_to_job"("job_id")) WITH CHECK ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can create jobs" ON "public"."jobs" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Tech can manage own checkins" ON "public"."tech_checkins" USING (("tech_id" = "auth"."uid"())) WITH CHECK (("tech_id" = "auth"."uid"()));



CREATE POLICY "Tech can read assigned jobs" ON "public"."jobs" FOR SELECT USING ((("auth"."uid"() = ANY ("assigned_tech_ids")) OR ("created_by" = "auth"."uid"())));



CREATE POLICY "Tech can read checkins on assigned jobs" ON "public"."tech_checkins" FOR SELECT USING ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can read floor plans on assigned jobs" ON "public"."floor_plans" FOR SELECT USING ("public"."is_assigned_to_job"("job_id"));



CREATE POLICY "Tech can update assigned jobs" ON "public"."jobs" FOR UPDATE USING ((("auth"."uid"() = ANY ("assigned_tech_ids")) OR ("created_by" = "auth"."uid"())));



CREATE POLICY "Users can read own profile" ON "public"."profiles" FOR SELECT USING (("id" = "auth"."uid"()));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"()));



CREATE POLICY "admin_all_floor_plan_openings" ON "public"."floor_plan_openings" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_all_floor_plan_rooms" ON "public"."floor_plan_rooms" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_all_manual_floor_plans" ON "public"."manual_floor_plans" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin_only_hard_delete" ON "public"."coordination_jobs" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "admin_only_hard_delete" ON "public"."field_projects" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."ai_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_usage_insert" ON "public"."ai_usage" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "ai_usage_read" ON "public"."ai_usage" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."blob_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brief agent cannot delete coordination_jobs" ON "public"."coordination_jobs" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot delete crew_members" ON "public"."crew_members" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot delete field_projects" ON "public"."field_projects" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot delete portal_messages" ON "public"."portal_messages" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot delete time_entries" ON "public"."time_entries" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot delete unified_jobs" ON "public"."unified_jobs" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot insert coordination_jobs" ON "public"."coordination_jobs" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot insert crew_members" ON "public"."crew_members" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot insert field_projects" ON "public"."field_projects" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot insert portal_messages" ON "public"."portal_messages" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot insert time_entries" ON "public"."time_entries" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot insert unified_jobs" ON "public"."unified_jobs" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot update coordination_jobs" ON "public"."coordination_jobs" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot update crew_members" ON "public"."crew_members" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot update field_projects" ON "public"."field_projects" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot update portal_messages" ON "public"."portal_messages" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot update time_entries" ON "public"."time_entries" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



CREATE POLICY "brief agent cannot update unified_jobs" ON "public"."unified_jobs" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'office-brief@roybalconstruction.com'::"text"));



ALTER TABLE "public"."canvas_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."capture_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "capture_events_insert" ON "public"."capture_events" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "capture_events_read" ON "public"."capture_events" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "capture_events_update" ON "public"."capture_events" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."communications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."completeness_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "completeness_state_all" ON "public"."completeness_state" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."contact_merge_suggestions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_suggest_select" ON "public"."contact_merge_suggestions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "contact_suggest_update" ON "public"."contact_merge_suggestions" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contacts_admin_only_delete" ON "public"."contacts" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "contacts_delete" ON "public"."contacts" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "contacts_insert" ON "public"."contacts" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "contacts_no_machine_insert" ON "public"."contacts" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> ALL (ARRAY['phone-agent@roybalconstruction.com'::"text", 'office-brief@roybalconstruction.com'::"text"])));



CREATE POLICY "contacts_no_machine_update" ON "public"."contacts" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> ALL (ARRAY['phone-agent@roybalconstruction.com'::"text", 'office-brief@roybalconstruction.com'::"text"])));



CREATE POLICY "contacts_select" ON "public"."contacts" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "contacts_update" ON "public"."contacts" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."coordination_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coordination_jobs_all" ON "public"."coordination_jobs" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."crew_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "crew_members_all" ON "public"."crew_members" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_messages_machine_deny_upd" ON "public"."email_messages" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") !~~ 'office-brief@%'::"text")) WITH CHECK ((COALESCE("auth"."email"(), ''::"text") !~~ 'office-brief@%'::"text"));



CREATE POLICY "email_messages_mark" ON "public"."email_messages" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "email_messages_read" ON "public"."email_messages" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."equipment_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."field_photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "field_photos_admin_delete" ON "public"."field_photos" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "field_photos_crew_read" ON "public"."field_photos" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['tech'::"public"."user_role", 'admin'::"public"."user_role", 'office'::"public"."user_role", 'viewer'::"public"."user_role"]))))));



CREATE POLICY "field_photos_crew_update" ON "public"."field_photos" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['tech'::"public"."user_role", 'admin'::"public"."user_role", 'office'::"public"."user_role"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['tech'::"public"."user_role", 'admin'::"public"."user_role", 'office'::"public"."user_role"]))))));



CREATE POLICY "field_photos_crew_write" ON "public"."field_photos" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['tech'::"public"."user_role", 'admin'::"public"."user_role", 'office'::"public"."user_role"]))))));



ALTER TABLE "public"."field_projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "field_projects_all" ON "public"."field_projects" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."field_projects_trash" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."field_requirements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "field_requirements_read" ON "public"."field_requirements" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."floor_plan_openings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."floor_plan_rooms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."floor_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gmail_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gmail_tokens_none" ON "public"."gmail_tokens" TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."integration_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "integration_runs_read" ON "public"."integration_runs" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."manual_floor_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."moisture_readings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pending_actions_propose" ON "public"."pending_actions" FOR INSERT TO "authenticated" WITH CHECK ((("status" = 'pending'::"text") AND ("executed_at" IS NULL)));



CREATE POLICY "pending_actions_read" ON "public"."pending_actions" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."phase_instances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "phase_instances_all" ON "public"."phase_instances" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."phase_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "phase_templates_read" ON "public"."phase_templates" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "phone agent cannot delete board jobs" ON "public"."coordination_jobs" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'phone-agent@roybalconstruction.com'::"text"));



CREATE POLICY "phone agent cannot delete field projects" ON "public"."field_projects" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'phone-agent@roybalconstruction.com'::"text"));



CREATE POLICY "phone agent cannot insert field projects" ON "public"."field_projects" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((COALESCE("auth"."email"(), ''::"text") <> 'phone-agent@roybalconstruction.com'::"text"));



CREATE POLICY "phone agent cannot update board jobs" ON "public"."coordination_jobs" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'phone-agent@roybalconstruction.com'::"text"));



CREATE POLICY "phone agent cannot update field projects" ON "public"."field_projects" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((COALESCE("auth"."email"(), ''::"text") <> 'phone-agent@roybalconstruction.com'::"text"));



ALTER TABLE "public"."photo_shares" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "photo_shares_all" ON "public"."photo_shares" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."photos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."portal_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal_jobs_all" ON "public"."portal_jobs" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."portal_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal_messages_all" ON "public"."portal_messages" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."portal_selections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal_selections_all" ON "public"."portal_selections" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."price_list" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "price_list_read" ON "public"."price_list" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qb_time_jobcodes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qb_time_jobcodes_read" ON "public"."qb_time_jobcodes" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."qb_time_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qb_time_tokens_none" ON "public"."qb_time_tokens" TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."qbo_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "qbo_tokens_none" ON "public"."qbo_tokens" TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."reconstruction_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."required_forms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "required_forms_read" ON "public"."required_forms" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."room_markers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."room_openings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rooms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sms_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sms_messages_insert" ON "public"."sms_messages" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "sms_messages_select" ON "public"."sms_messages" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "sms_messages_update" ON "public"."sms_messages" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."sync_clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tech_checkins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tech_read_floor_plan_openings" ON "public"."floor_plan_openings" FOR SELECT TO "authenticated" USING (("plan_id" IN ( SELECT "manual_floor_plans"."id"
   FROM "public"."manual_floor_plans"
  WHERE "public"."is_assigned_to_job"("manual_floor_plans"."job_id"))));



CREATE POLICY "tech_read_floor_plan_rooms" ON "public"."floor_plan_rooms" FOR SELECT TO "authenticated" USING (("plan_id" IN ( SELECT "manual_floor_plans"."id"
   FROM "public"."manual_floor_plans"
  WHERE "public"."is_assigned_to_job"("manual_floor_plans"."job_id"))));



CREATE POLICY "tech_read_manual_floor_plans" ON "public"."manual_floor_plans" FOR SELECT TO "authenticated" USING ("public"."is_assigned_to_job"("job_id"));



ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "time_entries_insert" ON "public"."time_entries" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "time_entries_read" ON "public"."time_entries" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "time_entries_update" ON "public"."time_entries" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."unified_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "unified_jobs_all" ON "public"."unified_jobs" TO "authenticated" USING (true) WITH CHECK (true);



ALTER TABLE "public"."work_authorizations" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";














































































































































































GRANT ALL ON FUNCTION "public"."_blob_emptyish"("v" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."_blob_emptyish"("v" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."_blob_emptyish"("v" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."_mf_all_ids"("arr" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_mf_all_ids"("arr" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."_mf_emptyish"("v" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_mf_emptyish"("v" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."_mf_form"("nv" "jsonb", "ov" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_mf_form"("nv" "jsonb", "ov" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."_mf_is_obj"("v" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_mf_is_obj"("v" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."_sync_guard"("p_build" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_sync_guard"("p_build" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."ai_usage_set_month"() TO "anon";
GRANT ALL ON FUNCTION "public"."ai_usage_set_month"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ai_usage_set_month"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."capture_blob_history"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."capture_blob_history"() TO "service_role";



GRANT ALL ON FUNCTION "public"."compute_is_dry"() TO "anon";
GRANT ALL ON FUNCTION "public"."compute_is_dry"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_is_dry"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."contact_canonical"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."contact_canonical"("p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."contact_mark_review_asked"("p_contact" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."contact_mark_review_asked"("p_contact" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."contact_mark_review_asked"("p_contact" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."contact_merge"("p_winner" "uuid", "p_loser" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."contact_merge"("p_winner" "uuid", "p_loser" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."contact_merge"("p_winner" "uuid", "p_loser" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."contact_resolve"("p_name" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_source" "text", "p_trusted" boolean, "p_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."contact_resolve"("p_name" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_source" "text", "p_trusted" boolean, "p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."contact_resolve"("p_name" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_source" "text", "p_trusted" boolean, "p_role" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."coordination_job_patch"("p_id" "uuid", "p_patch" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."coordination_job_patch"("p_id" "uuid", "p_patch" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."coordination_job_patch"("p_id" "uuid", "p_patch" "jsonb") TO "authenticated";



GRANT ALL ON FUNCTION "public"."coordination_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."coordination_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."coordination_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."field_projects_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."field_projects_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."field_projects_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."field_projects_trash_capture"() TO "anon";
GRANT ALL ON FUNCTION "public"."field_projects_trash_capture"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."field_projects_trash_capture"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_job_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_job_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_job_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_portal_data"("p_token" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_portal_data"("p_token" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_portal_data"("p_token" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_assigned_to_job"("job_uuid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_assigned_to_job"("job_uuid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_assigned_to_job"("job_uuid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."photo_shares_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."photo_shares_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."photo_shares_touch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_access_begin"("p_contact" "uuid", "p_channel" "text", "p_dest" "text", "p_code_hash" "text", "p_hourly" integer, "p_daily" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_access_begin"("p_contact" "uuid", "p_channel" "text", "p_dest" "text", "p_code_hash" "text", "p_hourly" integer, "p_daily" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_access_verify"("p_contact" "uuid", "p_code_hash" "text", "p_token_hash" "text", "p_ttl_days" integer, "p_max_attempts" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_access_verify"("p_contact" "uuid", "p_code_hash" "text", "p_token_hash" "text", "p_ttl_days" integer, "p_max_attempts" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."portal_jobs_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."portal_jobs_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_jobs_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."portal_selections_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."portal_selections_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_selections_touch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."project_field_photos"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."project_field_photos"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."push_project"("p_id" "uuid", "p_base_rev" integer, "p_data" "jsonb", "p_build" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."push_project"("p_id" "uuid", "p_base_rev" integer, "p_data" "jsonb", "p_build" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."push_project"("p_id" "uuid", "p_base_rev" integer, "p_data" "jsonb", "p_build" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_job_photos"("p_job" "uuid", "p_arr" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_job_photos"("p_job" "uuid", "p_arr" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."repair_field_photos"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."repair_field_photos"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."restore_photo"("p_job" "uuid", "p_photo" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."restore_photo"("p_job" "uuid", "p_photo" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."restore_photo"("p_job" "uuid", "p_photo" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."revive_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revive_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revive_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_invoice_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_invoice_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_invoice_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."stamp_field_photo"() TO "anon";
GRANT ALL ON FUNCTION "public"."stamp_field_photo"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."stamp_field_photo"() TO "service_role";



GRANT ALL ON FUNCTION "public"."stamp_updated_by"() TO "anon";
GRANT ALL ON FUNCTION "public"."stamp_updated_by"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."stamp_updated_by"() TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."tombstone_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tombstone_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."tombstone_project"("p_id" "uuid", "p_data" "jsonb", "p_build" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_work_auth_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_work_auth_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_work_auth_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."web_alert_claim"("p_session_id" "uuid", "p_session_max" integer, "p_daily_max" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."web_alert_claim"("p_session_id" "uuid", "p_session_max" integer, "p_daily_max" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."web_lead_insert"("p_session_id" "uuid", "p_lead" "jsonb", "p_daily_max" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."web_lead_insert"("p_session_id" "uuid", "p_lead" "jsonb", "p_daily_max" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."web_session_begin"("p_ip_hash" "text", "p_subnet_hash" "text", "p_origin" "text", "p_path" "text", "p_ua" "text", "p_service" "text", "p_ip_max" integer, "p_subnet_max" integer, "p_hourly_max" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."web_session_begin"("p_ip_hash" "text", "p_subnet_hash" "text", "p_origin" "text", "p_path" "text", "p_ua" "text", "p_service" "text", "p_ip_max" integer, "p_subnet_max" integer, "p_hourly_max" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."web_turn_begin"("p_session_id" "uuid", "p_est_usd" numeric, "p_model" "text", "p_daily_cap" numeric, "p_lane_cap" numeric, "p_shared_cap" numeric, "p_max_calls" integer, "p_session_ttl_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."web_turn_begin"("p_session_id" "uuid", "p_est_usd" numeric, "p_model" "text", "p_daily_cap" numeric, "p_lane_cap" numeric, "p_shared_cap" numeric, "p_max_calls" integer, "p_session_ttl_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."web_turn_end"("p_usage_id" "uuid", "p_in_tokens" integer, "p_out_tokens" integer, "p_actual_usd" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."web_turn_end"("p_usage_id" "uuid", "p_in_tokens" integer, "p_out_tokens" integer, "p_actual_usd" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";
























GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."ai_usage" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."ai_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage" TO "service_role";



GRANT ALL ON TABLE "public"."app_settings" TO "service_role";



GRANT ALL ON TABLE "public"."blob_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."blob_history_hist_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."canvas_plans" TO "anon";
GRANT ALL ON TABLE "public"."canvas_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."canvas_plans" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."capture_events" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."capture_events" TO "authenticated";
GRANT ALL ON TABLE "public"."capture_events" TO "service_role";



GRANT UPDATE("raw_payload") ON TABLE "public"."capture_events" TO "authenticated";



GRANT UPDATE("transcript") ON TABLE "public"."capture_events" TO "authenticated";



GRANT UPDATE("result") ON TABLE "public"."capture_events" TO "authenticated";



GRANT UPDATE("status") ON TABLE "public"."capture_events" TO "authenticated";



GRANT UPDATE("error") ON TABLE "public"."capture_events" TO "authenticated";



GRANT UPDATE("processed_at") ON TABLE "public"."capture_events" TO "authenticated";



GRANT UPDATE("contact_id") ON TABLE "public"."capture_events" TO "authenticated";



GRANT ALL ON TABLE "public"."communications" TO "anon";
GRANT ALL ON TABLE "public"."communications" TO "authenticated";
GRANT ALL ON TABLE "public"."communications" TO "service_role";



GRANT ALL ON TABLE "public"."completeness_state" TO "anon";
GRANT ALL ON TABLE "public"."completeness_state" TO "authenticated";
GRANT ALL ON TABLE "public"."completeness_state" TO "service_role";



GRANT ALL ON TABLE "public"."contact_merge_suggestions" TO "anon";
GRANT ALL ON TABLE "public"."contact_merge_suggestions" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_merge_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."contact_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."email_messages" TO "anon";
GRANT ALL ON TABLE "public"."email_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."email_messages" TO "service_role";



GRANT ALL ON TABLE "public"."portal_jobs" TO "anon";
GRANT ALL ON TABLE "public"."portal_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."portal_messages" TO "anon";
GRANT ALL ON TABLE "public"."portal_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_messages" TO "service_role";



GRANT ALL ON TABLE "public"."sms_messages" TO "anon";
GRANT ALL ON TABLE "public"."sms_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."sms_messages" TO "service_role";



GRANT ALL ON TABLE "public"."contact_timeline" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_timeline" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT INSERT("kind"),UPDATE("kind") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("role"),UPDATE("role") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("name"),UPDATE("name") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("company"),UPDATE("company") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("phone"),UPDATE("phone") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("email"),UPDATE("email") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("address"),UPDATE("address") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("source") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("notes"),UPDATE("notes") ON TABLE "public"."contacts" TO "authenticated";



GRANT INSERT("marketing_opt_in"),UPDATE("marketing_opt_in") ON TABLE "public"."contacts" TO "authenticated";



GRANT ALL ON TABLE "public"."coordination_jobs" TO "anon";
GRANT ALL ON TABLE "public"."coordination_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."coordination_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."crew_members" TO "anon";
GRANT ALL ON TABLE "public"."crew_members" TO "authenticated";
GRANT ALL ON TABLE "public"."crew_members" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."equipment_logs" TO "anon";
GRANT ALL ON TABLE "public"."equipment_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."equipment_logs" TO "service_role";



GRANT ALL ON TABLE "public"."field_photos" TO "anon";
GRANT ALL ON TABLE "public"."field_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."field_photos" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."field_projects" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."field_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."field_projects" TO "service_role";



GRANT ALL ON TABLE "public"."field_photos_deleted" TO "service_role";



GRANT ALL ON TABLE "public"."field_photos_drift" TO "service_role";



GRANT ALL ON TABLE "public"."field_projects_trash" TO "anon";
GRANT ALL ON TABLE "public"."field_projects_trash" TO "authenticated";
GRANT ALL ON TABLE "public"."field_projects_trash" TO "service_role";



GRANT ALL ON TABLE "public"."field_requirements" TO "anon";
GRANT ALL ON TABLE "public"."field_requirements" TO "authenticated";
GRANT ALL ON TABLE "public"."field_requirements" TO "service_role";



GRANT ALL ON TABLE "public"."floor_plan_openings" TO "anon";
GRANT ALL ON TABLE "public"."floor_plan_openings" TO "authenticated";
GRANT ALL ON TABLE "public"."floor_plan_openings" TO "service_role";



GRANT ALL ON TABLE "public"."floor_plan_rooms" TO "anon";
GRANT ALL ON TABLE "public"."floor_plan_rooms" TO "authenticated";
GRANT ALL ON TABLE "public"."floor_plan_rooms" TO "service_role";



GRANT ALL ON TABLE "public"."floor_plans" TO "anon";
GRANT ALL ON TABLE "public"."floor_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."floor_plans" TO "service_role";



GRANT ALL ON TABLE "public"."gmail_tokens" TO "anon";
GRANT ALL ON TABLE "public"."gmail_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."gmail_tokens" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."integration_runs" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."integration_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."integration_runs" TO "service_role";



GRANT ALL ON TABLE "public"."qb_time_tokens" TO "anon";
GRANT ALL ON TABLE "public"."qb_time_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."qb_time_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_tokens" TO "anon";
GRANT ALL ON TABLE "public"."qbo_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."qbo_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."integration_health" TO "authenticated";
GRANT ALL ON TABLE "public"."integration_health" TO "service_role";



GRANT ALL ON SEQUENCE "public"."integration_runs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON SEQUENCE "public"."job_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."job_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."job_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."line_items" TO "anon";
GRANT ALL ON TABLE "public"."line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."line_items" TO "service_role";



GRANT ALL ON TABLE "public"."manual_floor_plans" TO "anon";
GRANT ALL ON TABLE "public"."manual_floor_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."manual_floor_plans" TO "service_role";



GRANT ALL ON TABLE "public"."moisture_readings" TO "anon";
GRANT ALL ON TABLE "public"."moisture_readings" TO "authenticated";
GRANT ALL ON TABLE "public"."moisture_readings" TO "service_role";



GRANT ALL ON TABLE "public"."pending_actions" TO "anon";
GRANT ALL ON TABLE "public"."pending_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_actions" TO "service_role";



GRANT ALL ON TABLE "public"."phase_instances" TO "anon";
GRANT ALL ON TABLE "public"."phase_instances" TO "authenticated";
GRANT ALL ON TABLE "public"."phase_instances" TO "service_role";



GRANT ALL ON TABLE "public"."phase_templates" TO "anon";
GRANT ALL ON TABLE "public"."phase_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."phase_templates" TO "service_role";



GRANT ALL ON TABLE "public"."photo_shares" TO "anon";
GRANT ALL ON TABLE "public"."photo_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."photo_shares" TO "service_role";



GRANT ALL ON TABLE "public"."photos" TO "anon";
GRANT ALL ON TABLE "public"."photos" TO "authenticated";
GRANT ALL ON TABLE "public"."photos" TO "service_role";



GRANT ALL ON TABLE "public"."portal_selections" TO "anon";
GRANT ALL ON TABLE "public"."portal_selections" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_selections" TO "service_role";



GRANT ALL ON TABLE "public"."price_list" TO "anon";
GRANT ALL ON TABLE "public"."price_list" TO "authenticated";
GRANT ALL ON TABLE "public"."price_list" TO "service_role";



GRANT ALL ON SEQUENCE "public"."price_list_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."price_list_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."price_list_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."profiles" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT UPDATE("full_name") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("phone") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("avatar_url") ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."qb_time_jobcodes" TO "anon";
GRANT ALL ON TABLE "public"."qb_time_jobcodes" TO "authenticated";
GRANT ALL ON TABLE "public"."qb_time_jobcodes" TO "service_role";



GRANT ALL ON TABLE "public"."reconstruction_items" TO "anon";
GRANT ALL ON TABLE "public"."reconstruction_items" TO "authenticated";
GRANT ALL ON TABLE "public"."reconstruction_items" TO "service_role";



GRANT ALL ON TABLE "public"."required_forms" TO "anon";
GRANT ALL ON TABLE "public"."required_forms" TO "authenticated";
GRANT ALL ON TABLE "public"."required_forms" TO "service_role";



GRANT ALL ON TABLE "public"."room_markers" TO "anon";
GRANT ALL ON TABLE "public"."room_markers" TO "authenticated";
GRANT ALL ON TABLE "public"."room_markers" TO "service_role";



GRANT ALL ON TABLE "public"."room_openings" TO "anon";
GRANT ALL ON TABLE "public"."room_openings" TO "authenticated";
GRANT ALL ON TABLE "public"."room_openings" TO "service_role";



GRANT ALL ON TABLE "public"."rooms" TO "anon";
GRANT ALL ON TABLE "public"."rooms" TO "authenticated";
GRANT ALL ON TABLE "public"."rooms" TO "service_role";



GRANT ALL ON TABLE "public"."sync_clients" TO "service_role";



GRANT ALL ON TABLE "public"."sync_fleet" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."tech_checkins" TO "anon";
GRANT ALL ON TABLE "public"."tech_checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."tech_checkins" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."time_entries" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."time_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."time_entries" TO "service_role";



GRANT ALL ON TABLE "public"."unified_jobs" TO "anon";
GRANT ALL ON TABLE "public"."unified_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."unified_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."work_authorizations" TO "anon";
GRANT ALL ON TABLE "public"."work_authorizations" TO "authenticated";
GRANT ALL ON TABLE "public"."work_authorizations" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";



































