-- ============================================================================
-- 0022 — equipment scan in and out: the office's fleet list, and a server
--        copy of every equipment scan the crew makes, stamped when the server
--        first saw it.
--
-- WHAT IT IS FOR: each drying machine carries a QR label with its asset tag
-- (AM-014). On a job's Drying Log the crew taps 📷 Scan equipment and points
-- the phone at labels; every read is an append-only event in the job blob,
-- field_projects.data->'equipmentScans' (apps/field/js/scans.js), and the
-- drying log's equipment rows are derived from those events, so every reader
-- of the rows keeps working unchanged. This file is the database half:
--
--   equipment_units            the fleet list: one row per labelled machine
--                              (tag, type, make/model, rating, owned/rented,
--                              status). The scanner reads it to name what it
--                              just read; the office's Equipment tab edits it
--   equipment_tag_key          the field app's tagKey() in SQL: AM-14, AM-014
--                              and "am 014" are one machine (AM-14); a plain
--                              number loses its leading zeros (007 → 7).
--                              Internal
--   equipment_unit_save        door: add one unit, or change one by id
--   equipment_units_add_range  door: add AM-001 … AM-040 in one go, skipping
--                              tags already on the list
--   equipment_scans            the audit copy: one row per scan event, insert
--                              only, with received_at = when the server first
--                              saw it. Read by owner/office/crew lead
--   record_equipment_scans     copies a job's new events into equipment_scans.
--                              Internal, shared by the trigger and the backfill
--   project_equipment_scans    the trigger on field_projects (0015's shape)
--   merge_project_blobs,       the server merge and the push-time tombstone
--   _mf_sweep_tombstones       sweep learn 'equipmentScans' as an id
--                              collection, as merge.js ID_COLLECTIONS does
--
-- WHAT THIS CHANGES TODAY: nothing a crew sees until a field build with the
-- scanner (v208) is on the phone: the Drying Log keeps its scan button
-- switched off until equipment_units has answered once on that device
-- (fleet.js fleetReady), so applying this file is what switches scanning on.
-- The office's Equipment tab gets its fleet list and label printing; its "Out
-- now" view reads job data and works with or without this file. No existing
-- row changes. The backfill copies whatever scan events job blobs already
-- hold (none, on a database no scanner build has written to).
--
-- WHY THE BLOB AND NOT A TABLE THE PHONE WRITES: a crew works offline for
-- days and the field app has no outbox (doc 03), so the job blob is the only
-- write path that survives a basement with no signal. An event is never
-- edited (an undo is a new "void" event), which is the one shape the id-union
-- merge keeps whole on every device (the 0021 lesson: a new element with a
-- new id survives every merge; an edit in place does not).
--
-- WHY A SERVER COPY: an event's `at` is the phone's clock. equipment_scans
-- adds the server's own clock: received_at is when the row first reached the
-- server, and the row is never updated or deleted afterwards. An edited copy
-- of an event (same id) keeps its first-seen row, and a scan a stale device
-- drops from the blob, or that a tombstone removes, keeps its row. The trigger
-- can never fail a sync push (exception-guarded, as 0015's is).
--
-- THE PHONE CHECK: a build older than the scanner build treats
-- 'equipmentScans' as a plain value (newer copy wins whole), so it can push a
-- copy missing another phone's newer scans. The scans are not lost (every
-- scanner phone still holds them and unions them back, and equipment_scans
-- already has them), but raise app_settings min_field_build to the scanner
-- build at rollout, the way 0018 did for v202. That is the owner's call, not
-- this file's: nothing here changes the floor.
--
-- THE TAG FORMAT is the owner's open choice (AM-014, AM-14 or plain numbers);
-- the rules here accept all three. A tag is stored as printed (upper-cased),
-- unique by its key within the org.
--
-- WHO: owner, office and crew lead read both tables and change the fleet list
-- through the two doors, which refuse anyone else with 42501 and stamp
-- created_by/updated_by. A crew member reads equipment_units (the scanner
-- names what it read) and nothing else here. Nobody writes equipment_scans:
-- not authenticated, not the service role; only the trigger, which runs as
-- postgres. The key helper and the projection helper are callable by nobody.
-- Owner postgres throughout.
--
-- Census: +2 tables, +2 policies, +1 trigger, +5 functions (equipment_tag_key,
-- equipment_unit_save, equipment_units_add_range, record_equipment_scans and
-- the project_equipment_scans trigger function), +3 primary keys and unique
-- constraints (two primary keys and equipment_units' (org_id, tag_key));
-- views and enums unchanged. merge_project_blobs and _mf_sweep_tombstones are
-- replaced, not added.
-- Roles: owner, office and crew_lead gain reading both tables and the two
-- doors; crew gains reading equipment_units; viewer, agent and anon read and
-- write exactly what they did before. The service role gains all on
-- equipment_units and SELECT only on equipment_scans.
--
-- KILL SWITCH AND ROLLBACK: to stop the server copy, drop the
-- project_equipment_scans trigger; the blob keeps every scan, and running
-- this file's backfill block later copies them with that later received_at.
-- To switch scanning off on phones, drop equipment_units: fleet.js turns the
-- scan button off when the table answers 404, at the next online page open.
-- Additive: dropping the trigger, the five functions and the two tables
-- restores the schema as it was, apart from the two merge functions; put
-- those back (0002's merge_project_blobs, 0000_baseline's
-- _mf_sweep_tombstones) only once no phone writes scans, or the server merge
-- goes back to treating the scan log as one plain value.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The tables.
-- ---------------------------------------------------------------------------
create table if not exists public.equipment_units (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb',
  tag         text        not null check (tag ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),  -- as printed: AM-014, 101
  tag_key     text        not null check (tag_key <> ''),                     -- equipment_tag_key(tag), set by the doors
  type        text        not null
              check (type in ('air_mover', 'dehumidifier', 'dehu_lgr', 'dehu_desiccant', 'air_scrubber', 'heater', 'other')),
  make        text        check (char_length(make) <= 120),
  model       text        check (char_length(model) <= 120),
  serial      text        check (char_length(serial) <= 120),
  rating      text        check (char_length(rating) <= 120),                 -- "1/3 hp", "130 ppd": as the plate says
  owned       text        not null default 'owned' check (owned in ('owned', 'rented')),
  status      text        not null default 'active' check (status in ('active', 'repair', 'retired')),
  notes       text        check (char_length(notes) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,                                                           -- auth.uid() of who added it
  updated_by  uuid,                                                           -- auth.uid() of who last changed it
  constraint equipment_units_tag_key_unique unique (org_id, tag_key)
);

comment on table public.equipment_units is
  'The fleet list: one row per labelled drying machine. tag is as printed on the label (AM-014, or a plain number); tag_key is the field app''s tagKey() of it (AM-14), unique per org, so AM-14 and AM-014 are one machine. type is a scans.js TYPE_LABELS code. Read by owner/office/crew lead/crew; written only through equipment_unit_save() and equipment_units_add_range().';
comment on column public.equipment_units.tag_key is
  'equipment_tag_key(tag): PREFIX-<integer> for a two-letter tag (AM-014 → AM-14), the digits without leading zeros for a plain number (007 → 7), else the tag. The same rule as apps/field/js/scans.js tagKey().';

create table if not exists public.equipment_scans (
  id           text        primary key check (char_length(id) between 1 and 128),  -- the event's id inside the job blob
  job_id       uuid        not null,                                     -- field_projects.id
  tag          text        not null,                                     -- as the event carries it
  tag_key      text        not null,                                     -- equipment_tag_key(tag)
  act          text        not null check (act in ('place', 'remove', 'move', 'void')),
  room         text,
  type         text,                                                     -- place: the type label at scan time
  model        text,                                                     -- place: the fleet list's make/model text at scan time
  voids        text,                                                     -- void: the id of the event it cancels
  how          text,                                                     -- camera | photo | typed
  by_email     text,                                                     -- the login (blob `by`)
  tech         text,                                                     -- the device's tech name, self-chosen
  build        text,                                                     -- the field app build that wrote it
  scanned_at   timestamptz,                                              -- the phone's clock (blob `at`); null if unreadable
  received_at  timestamptz not null default now(),                       -- the server's clock, the first time it saw the event
  elsewhere    jsonb,                                                    -- place: {jobId, label, since} when the unit was open on another job
  raw          jsonb       not null                                      -- the element exactly as first seen
);

comment on table public.equipment_scans is
  'Every equipment scan event (field_projects.data->''equipmentScans''), copied by the project_equipment_scans trigger the first time the server sees it. Insert only: an edited copy of an event or one dropped from the blob keeps its first row. scanned_at is the phone''s clock, received_at the server''s. Read by owner/office/crew lead; written by nothing but the trigger.';
comment on column public.equipment_scans.received_at is
  'When the server first received the event (the sync push''s transaction time). Never updated.';

create index if not exists equipment_scans_tag_key_idx on public.equipment_scans (tag_key, scanned_at);
create index if not exists equipment_scans_job_idx on public.equipment_scans (job_id);

alter table public.equipment_units owner to postgres;
alter table public.equipment_scans owner to postgres;
alter table public.equipment_units enable row level security;
alter table public.equipment_scans enable row level security;

-- The baseline's default privileges grant ALL on every new table to anon and
-- authenticated (0000_baseline.sql; 0008). Take it all back: anon holds
-- nothing, authenticated may SELECT (RLS narrows it), and every write goes
-- through the doors or the trigger. The service role may not edit the audit
-- copy either: it reads it.
revoke all on public.equipment_units, public.equipment_scans from public, anon, authenticated;
grant select on public.equipment_units, public.equipment_scans to authenticated;
grant all on public.equipment_units to service_role;
revoke all on public.equipment_scans from service_role;
grant select on public.equipment_scans to service_role;

-- Read, with role_is() for the reason 0010 gives. The fleet list is read by
-- every field login (the scanner names a plain-number tag from it); the scan
-- copy by the people who answer for where the machines are.
drop policy if exists equipment_units_read_field on public.equipment_units;
create policy equipment_units_read_field on public.equipment_units
  for select to authenticated
  using ((select public.role_is('owner', 'office', 'crew_lead', 'crew')));

drop policy if exists equipment_scans_read_leads on public.equipment_scans;
create policy equipment_scans_read_leads on public.equipment_scans
  for select to authenticated
  using ((select public.role_is('owner', 'office', 'crew_lead')));


-- ---------------------------------------------------------------------------
-- 2. equipment_tag_key(tag): apps/field/js/scans.js tagKey(), rule for rule.
--    Collapse whitespace runs (JavaScript's \s, spelled out so the answer
--    does not depend on the database locale) and trim; upper-case; then
--      two letters, any of space . _ - or a dash a phone keyboard swaps in,
--      digits                          → PREFIX-<digits without leading zeros>
--      digits only                     → the digits without leading zeros
--      anything else                   → as it is
--    "" for null or blank. Keep it in step with tagKey(): supabase/test/
--    equipment_scan.test.sql holds the shared cases, and apps/field/test/
--    merge-sql-parity.test.mjs runs the same cases through tagKey().
-- ---------------------------------------------------------------------------
create or replace function public.equipment_tag_key(p_tag text) returns text
  language sql
  immutable
  set search_path to 'public', 'pg_temp'
as $$
  select case
           when s ~ '^[A-Z]{2}[ ._‐-―−-]*[0-9]+$'
             then substr(s, 1, 2) || '-' || regexp_replace(substring(s from '([0-9]+)$'), '^0+(?=[0-9])', '')
           when s ~ '^[0-9]+$'
             then regexp_replace(s, '^0+(?=[0-9])', '')
           else s
         end
    from (select upper(btrim(regexp_replace(coalesce(p_tag, ''),
                   '[\t\n\v\f\r    -     　﻿]+', ' ', 'g'), ' ')) as s) t;
$$;

alter function public.equipment_tag_key(text) owner to postgres;
comment on function public.equipment_tag_key(text) is
  'The comparison key of an equipment tag, the same rule as the field app''s scans.js tagKey(): AM-014 / AM-14 / am 014 → AM-14, 007 → 7, else the tag upper-cased and trimmed; '''' for none. Internal: the doors and record_equipment_scans call it (0022).';
revoke all on function public.equipment_tag_key(text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. equipment_unit_save(unit): add one unit, or change the unit with that
--    id. A key the JSON leaves out keeps its value (a status change sends
--    {id, status}); a blank text clears it. The type defaults from the tag's
--    prefix (AM air mover, DH dehumidifier, AF air scrubber, HT heater, as
--    scans.js TAG_PREFIXES); a plain-number tag needs one. A tag whose key is
--    already on the list is refused with 23505 and says which tag holds it.
--    Returns the row as saved.
-- ---------------------------------------------------------------------------
create or replace function public.equipment_unit_save(p_unit jsonb) returns public.equipment_units
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_id    uuid;
  v_cur   public.equipment_units;
  v_row   public.equipment_units;
  v_tag   text;
  v_key   text;
  v_type  text;
  v_owned text;
  v_stat  text;
  v_dup   text;
begin
  if not public.role_is('owner', 'office', 'crew_lead') then
    raise exception 'only the office or a crew lead can change the equipment list' using errcode = 'insufficient_privilege';
  end if;
  if p_unit is null or jsonb_typeof(p_unit) <> 'object' then
    raise exception 'equipment_unit_save takes one unit as a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  if btrim(coalesce(p_unit ->> 'id', '')) <> '' then
    v_id := btrim(p_unit ->> 'id')::uuid;
    select * into v_cur from public.equipment_units where id = v_id for update;
  end if;

  -- the tag as printed: upper-cased and trimmed, letters, digits and dashes
  v_tag := case when v_cur.id is null or jsonb_exists(p_unit, 'tag')
                then upper(btrim(coalesce(p_unit ->> 'tag', ''))) else v_cur.tag end;
  if v_tag !~ '^[A-Z0-9][A-Z0-9-]{0,15}$' then
    raise exception '"%" is not a tag: use letters, digits and dashes, up to 16 (example AM-014)', v_tag
      using errcode = 'check_violation';
  end if;
  v_key := public.equipment_tag_key(v_tag);

  v_type := case when v_cur.id is null or jsonb_exists(p_unit, 'type')
                 then nullif(lower(btrim(coalesce(p_unit ->> 'type', ''))), '') else v_cur.type end;
  if v_type is null then
    v_type := case substring(v_key from '^([A-Z]{2})-[0-9]+$')
                when 'AM' then 'air_mover' when 'DH' then 'dehumidifier'
                when 'AF' then 'air_scrubber' when 'HT' then 'heater' end;
  end if;
  if v_type is null or v_type not in ('air_mover', 'dehumidifier', 'dehu_lgr', 'dehu_desiccant', 'air_scrubber', 'heater', 'other') then
    raise exception 'pick a type for %: air mover, dehumidifier, LGR or desiccant dehumidifier, air scrubber, heater or other', v_tag
      using errcode = 'check_violation';
  end if;

  v_owned := case when jsonb_exists(p_unit, 'owned') then nullif(lower(btrim(coalesce(p_unit ->> 'owned', ''))), '') end;
  v_owned := coalesce(v_owned, v_cur.owned, 'owned');
  v_stat  := case when jsonb_exists(p_unit, 'status') then nullif(lower(btrim(coalesce(p_unit ->> 'status', ''))), '') end;
  v_stat  := coalesce(v_stat, v_cur.status, 'active');
  if v_owned not in ('owned', 'rented') then
    raise exception 'owned is "owned" or "rented", not "%"', v_owned using errcode = 'check_violation';
  end if;
  if v_stat not in ('active', 'repair', 'retired') then
    raise exception 'status is "active", "repair" or "retired", not "%"', v_stat using errcode = 'check_violation';
  end if;

  begin
    if v_cur.id is null then
      insert into public.equipment_units
        (id, tag, tag_key, type, make, model, serial, rating, owned, status, notes, created_by, updated_by)
      values
        (coalesce(v_id, gen_random_uuid()), v_tag, v_key, v_type,
         nullif(btrim(p_unit ->> 'make'), ''), nullif(btrim(p_unit ->> 'model'), ''),
         nullif(btrim(p_unit ->> 'serial'), ''), nullif(btrim(p_unit ->> 'rating'), ''),
         v_owned, v_stat, nullif(btrim(p_unit ->> 'notes'), ''), auth.uid(), auth.uid())
      returning * into v_row;
    else
      update public.equipment_units u
         set tag        = v_tag,
             tag_key    = v_key,
             type       = v_type,
             make       = case when jsonb_exists(p_unit, 'make')   then nullif(btrim(p_unit ->> 'make'), '')   else u.make end,
             model      = case when jsonb_exists(p_unit, 'model')  then nullif(btrim(p_unit ->> 'model'), '')  else u.model end,
             serial     = case when jsonb_exists(p_unit, 'serial') then nullif(btrim(p_unit ->> 'serial'), '') else u.serial end,
             rating     = case when jsonb_exists(p_unit, 'rating') then nullif(btrim(p_unit ->> 'rating'), '') else u.rating end,
             owned      = v_owned,
             status     = v_stat,
             notes      = case when jsonb_exists(p_unit, 'notes')  then nullif(btrim(p_unit ->> 'notes'), '')  else u.notes end,
             updated_at = now(),
             updated_by = auth.uid()
       where u.id = v_cur.id
      returning * into v_row;
    end if;
  exception when unique_violation then
    select u.tag into v_dup from public.equipment_units u
     where u.tag_key = v_key and u.id is distinct from coalesce(v_cur.id, v_id)
     limit 1;
    raise exception '% is already on the equipment list%', v_tag,
      case when v_dup is not null and v_dup <> v_tag then format(' as %s', v_dup) else '' end
      using errcode = 'unique_violation',
            hint = 'Edit that unit instead, or give this one another number.';
  end;
  return v_row;
end;
$$;

alter function public.equipment_unit_save(jsonb) owner to postgres;
comment on function public.equipment_unit_save(jsonb) is
  'Door for equipment_units: insert a unit, or update the unit with p_unit.id (keys left out keep their values). Normalises the tag (upper, trim), sets tag_key, defaults the type from the tag prefix, stamps created_by/updated_by. 23505 for a tag already on the list, 23514 for a bad tag or type, 42501 for anyone but owner/office/crew lead.';
revoke all on function public.equipment_unit_save(jsonb) from public, anon, authenticated;
grant execute on function public.equipment_unit_save(jsonb) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. equipment_units_add_range(prefix, from, to, pad, type, make, model,
--    rating, owned): add PREFIX-<n> for every n from..to, the number padded
--    to `pad` digits and never cut (AM-001 … AM-040; 1000 stays AM-1000). A
--    blank prefix adds plain numbers. A tag whose key is already on the list
--    is skipped. At most 200 per call. Returns the units added.
-- ---------------------------------------------------------------------------
create or replace function public.equipment_units_add_range(
  p_prefix text, p_from integer, p_to integer, p_pad integer default 3, p_type text default null,
  p_make text default null, p_model text default null, p_rating text default null, p_owned text default 'owned'
) returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_prefix text := upper(btrim(coalesce(p_prefix, '')));
  v_pad    int  := coalesce(p_pad, 3);
  v_type   text := nullif(lower(btrim(coalesce(p_type, ''))), '');
  v_owned  text := coalesce(nullif(lower(btrim(coalesce(p_owned, ''))), ''), 'owned');
  n        int;
begin
  if not public.role_is('owner', 'office', 'crew_lead') then
    raise exception 'only the office or a crew lead can change the equipment list' using errcode = 'insufficient_privilege';
  end if;
  if v_prefix !~ '^([A-Z]{2})?$' then
    raise exception 'a prefix is two letters (AM, DH, AF, HT), or blank for plain numbers' using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or p_to is null or p_from < 0 or p_to < p_from or p_to > 999999 then
    raise exception 'number the units from 0 to 999999, the first no higher than the last' using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from + 1 > 200 then
    raise exception 'at most 200 units per call' using errcode = 'invalid_parameter_value';
  end if;
  if v_pad < 1 or v_pad > 6 then
    raise exception 'digits is 1 to 6' using errcode = 'invalid_parameter_value';
  end if;
  if v_type is null then
    v_type := case v_prefix when 'AM' then 'air_mover' when 'DH' then 'dehumidifier'
                            when 'AF' then 'air_scrubber' when 'HT' then 'heater' end;
  end if;
  if v_type is null or v_type not in ('air_mover', 'dehumidifier', 'dehu_lgr', 'dehu_desiccant', 'air_scrubber', 'heater', 'other') then
    raise exception 'pick a type for these units' using errcode = 'check_violation';
  end if;
  if v_owned not in ('owned', 'rented') then
    raise exception 'owned is "owned" or "rented", not "%"', v_owned using errcode = 'check_violation';
  end if;

  with wanted as (
    select t.tag, public.equipment_tag_key(t.tag) as tag_key
      from (select case when v_prefix = '' then '' else v_prefix || '-' end
                   || case when char_length(g::text) >= v_pad then g::text else lpad(g::text, v_pad, '0') end as tag
              from generate_series(p_from, p_to) as g) t
  ), added as (
    insert into public.equipment_units
      (tag, tag_key, type, make, model, rating, owned, created_by, updated_by)
    select w.tag, w.tag_key, v_type,
           nullif(btrim(p_make), ''), nullif(btrim(p_model), ''), nullif(btrim(p_rating), ''),
           v_owned, auth.uid(), auth.uid()
      from wanted w
    on conflict (org_id, tag_key) do nothing
    returning 1
  )
  select count(*) into n from added;
  return n;
end;
$$;

alter function public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text) owner to postgres;
comment on function public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text) is
  'Door for equipment_units: add PREFIX-<n> for n in from..to (n padded to pad digits, never cut; blank prefix = plain numbers), skipping tags whose key is already listed. Type defaults from the prefix. At most 200 per call; returns the units added. 42501 for anyone but owner/office/crew lead.';
revoke all on function public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. record_equipment_scans(job, array): insert every event of the blob's
--    equipmentScans array the table has not seen yet. An element needs a
--    non-empty string id (up to 128 characters) and a known act; anything
--    else is not an event and is passed over. Never updates, never deletes.
--    `at` is read only as an ISO time with a zone (what toISOString()
--    writes); a time the calendar doesn't have is kept as null rather than
--    losing the event. Returns the rows added. Shared by the trigger and the
--    backfill.
-- ---------------------------------------------------------------------------
create or replace function public.record_equipment_scans(p_job uuid, p_arr jsonb) returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  e    jsonb;
  v_at timestamptz;
  n    int := 0;
  k    int;
begin
  if p_job is null or p_arr is null or jsonb_typeof(p_arr) <> 'array' then
    return 0;
  end if;

  for e in
    select x.e
      from jsonb_array_elements(p_arr) with ordinality as x(e, ord)
     where jsonb_typeof(x.e) = 'object'
       and jsonb_typeof(x.e -> 'id') = 'string'
       and char_length(x.e ->> 'id') between 1 and 128
       and (x.e ->> 'act') in ('place', 'remove', 'move', 'void')
       and not exists (select 1 from public.equipment_scans s where s.id = x.e ->> 'id')
     order by x.ord
  loop
    v_at := null;
    if (e ->> 'at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
      begin
        v_at := (e ->> 'at')::timestamptz;
      exception when others then
        v_at := null;
      end;
    end if;

    -- a second copy of the same id in one array: the first one is the row
    insert into public.equipment_scans
      (id, job_id, tag, tag_key, act, room, type, model, voids, how, by_email, tech, build,
       scanned_at, elsewhere, raw)
    values
      (e ->> 'id', p_job,
       left(coalesce(e ->> 'tag', ''), 64), public.equipment_tag_key(left(coalesce(e ->> 'tag', ''), 64)),
       e ->> 'act',
       left(e ->> 'room', 200), left(e ->> 'type', 120), left(e ->> 'model', 200), left(e ->> 'voids', 128),
       left(e ->> 'how', 20), left(e ->> 'by', 200), left(e ->> 'tech', 120), left(e ->> 'build', 40),
       v_at,
       case when jsonb_typeof(e -> 'elsewhere') = 'object' then e -> 'elsewhere' end,
       e)
    on conflict (id) do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;

  return n;
end;
$$;

alter function public.record_equipment_scans(uuid, jsonb) owner to postgres;
comment on function public.record_equipment_scans(uuid, jsonb) is
  'Copies the equipment scan events of one job''s blob array (field_projects.data->''equipmentScans'') into equipment_scans: insert by event id, first copy wins, never updates or deletes. Called by the project_equipment_scans trigger and the 0022 backfill.';
-- Default privileges hand EXECUTE on every new function to anon and
-- authenticated directly (0008). Nobody but the trigger calls this.
revoke all on function public.record_equipment_scans(uuid, jsonb) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. project_equipment_scans(): the trigger. 0015's shape: fires after every
--    insert/update of a job row, skips an unchanged array, and can never fail
--    the write that fired it. A trashed job's scans are still facts: recorded
--    like any other.
-- ---------------------------------------------------------------------------
create or replace function public.project_equipment_scans() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare arr jsonb := new.data -> 'equipmentScans';
begin
  if arr is null or jsonb_typeof(arr) <> 'array' or jsonb_array_length(arr) = 0 then return null; end if;
  -- unchanged array: nothing new to record
  if tg_op = 'UPDATE' and (old.data -> 'equipmentScans') is not distinct from arr then return null; end if;

  perform public.record_equipment_scans(new.id, arr);
  return null;
exception when others then
  raise warning 'project_equipment_scans failed for job %: %', new.id, sqlerrm;
  return null;
end;
$$;

alter function public.project_equipment_scans() owner to postgres;
comment on function public.project_equipment_scans() is
  'AFTER INSERT OR UPDATE on field_projects: copies new equipment scan events into equipment_scans. Exception-guarded: a sync push never fails because of it.';
revoke all on function public.project_equipment_scans() from public, anon, authenticated, service_role;

drop trigger if exists project_equipment_scans on public.field_projects;
create trigger project_equipment_scans
  after insert or update on public.field_projects
  for each row execute function public.project_equipment_scans();


-- ---------------------------------------------------------------------------
-- 7. Backfill: scan events already in job blobs become rows now, received_at
--    = now (the first time this server holds them as rows).
-- ---------------------------------------------------------------------------
do $$
declare r record; jobs int := 0; n int := 0;
begin
  for r in
    select id, data
      from public.field_projects
     where jsonb_typeof(data -> 'equipmentScans') = 'array'
       and jsonb_array_length(data -> 'equipmentScans') > 0
  loop
    begin
      n := n + public.record_equipment_scans(r.id, r.data -> 'equipmentScans');
      jobs := jobs + 1;
    exception when others then
      raise warning '0022 backfill: job % skipped: %', r.id, sqlerrm;
    end;
  end loop;
  raise notice '0022: % scan event(s) recorded from % job(s)', n, jobs;
end
$$;


-- ---------------------------------------------------------------------------
-- 8. The server merge learns the scan log. merge_project_blobs is 0002's
--    definition and _mf_sweep_tombstones the baseline's, VERBATIM, with
--    'equipmentScans' added to id_cols: the only change. Without it the
--    server merge treats the array as one plain value (the newer copy wins
--    whole) and a phone's scans could be dropped by another phone's push.
--    apps/field/test/merge-sql-parity.test.mjs holds both lists to merge.js
--    ID_COLLECTIONS. Grants survive CREATE OR REPLACE; none are restated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs','equipmentScans'];
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

  -- ---------- a preview is never the photograph ----------
  -- Twin of the preview block in apps/field/js/merge.js. A photos[] entry
  -- carrying `previewOf` holds a ~320px stand-in plus the hash of the real
  -- bytes (apps/field/js/thumbs.js), not the photograph itself. When both
  -- copies carry the same photo id and one of them holds the real thing, the
  -- real thing wins -- regardless of which copy is newer, because "newer" says
  -- when a device last touched the job, not which copy of a photo is better.
  --
  -- Field-granular like the JS: the newer entry keeps its caption, room and
  -- stage edits and takes only `src` from the older one. `cloud` travels with
  -- `src` because they describe the same bytes.
  --
  -- THIS PATH SHOULD BE UNREACHABLE. The client restores every marker before
  -- it deflates anything (deflateSynced in sync.js), so a preview never
  -- reaches the wire. This is the backstop for when that stops being true --
  -- a build that skips the restore, a future writer that does not know about
  -- previews -- because the cost of being wrong is a 320px stand-in replacing
  -- the only photograph of the inside of someone's flooded house.
  --
  -- jsonb_exists() rather than the `?` operator on purpose: `?` is a parameter
  -- placeholder in several client drivers and this file must apply cleanly
  -- through all of them.
  if jsonb_typeof(merged -> 'photos') = 'array' and jsonb_typeof(older -> 'photos') = 'array' then
    select jsonb_agg(coalesce(real_photo.el, mp.el) order by mp.ord) into m
      from jsonb_array_elements(merged -> 'photos') with ordinality as mp(el, ord)
      left join lateral (
        select (mp.el - 'previewOf' - 'cloud')
               || jsonb_build_object('src', o.el -> 'src')
               || (case when jsonb_exists(o.el, 'cloud')
                        then jsonb_build_object('cloud', o.el -> 'cloud')
                        else '{}'::jsonb end) as el
          from jsonb_array_elements(older -> 'photos') as o(el)
         where jsonb_typeof(mp.el) = 'object'
           and jsonb_typeof(o.el) = 'object'
           and jsonb_exists(mp.el, 'previewOf')
           and not jsonb_exists(o.el, 'previewOf')
           and coalesce(o.el ->> 'id', '') <> ''
           and o.el ->> 'id' = mp.el ->> 'id'
           and not jsonb_exists(marks, mp.el ->> 'id')
         limit 1
      ) as real_photo on true;
    if m is not null then merged := jsonb_set(merged, array['photos'], m, true); end if;
  end if;

  return merged;
end;
$$;

ALTER FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs','equipmentScans'];
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


-- ---------------------------------------------------------------------------
-- 9. Assertions. Structural, so they bind on the CI replay too: both server
--    lists carry the scan log, and the trigger is on field_projects.
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.merge_project_blobs(jsonb, jsonb)', 'public._mf_sweep_tombstones(jsonb)'] loop
    if position('''equipmentScans''' in (select p.prosrc from pg_proc p where p.oid = f::regprocedure)) = 0 then
      raise exception '0022: % does not list equipmentScans in its id collections', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger
                  where tgname = 'project_equipment_scans' and tgrelid = 'public.field_projects'::regclass) then
    raise exception '0022: the project_equipment_scans trigger is missing from field_projects';
  end if;
end
$$;
