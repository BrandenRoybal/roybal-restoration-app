-- ============================================================
-- 224: make the photo projection trustworthy (Phase 3, step 1c)
-- ------------------------------------------------------------
-- Adversarial review of 221–223 found a mass-delete and five more real
-- defects. Rows must mirror the blob EXACTLY before anything reads them, so
-- all of it is fixed here, while nothing depends on these rows yet.
--
-- 1. ⛔ MASS DELETE ON AN ABSENT `photos` KEY (critical, reproduced).
--    `if new.deleted or jsonb_typeof(arr) <> 'array'` never fired when the
--    key was simply missing: `arr` is SQL NULL, jsonb_typeof(NULL) is NULL,
--    `false OR NULL` is NULL, and plpgsql treats that as not-true — so it
--    fell through, `incoming` came out empty, and the sweep soft-deleted
--    EVERY row for that job. The guard caught every malformed shape except
--    the most likely one. Reachable today: reviving a bare `{id}` tombstone
--    writes a photos-less blob with deleted=false. Now an explicit NULL test.
--
-- 2. CROSS-JOB ROW THEFT. The key was `id` alone and the upsert reassigned
--    job_id, so two blobs listing the same photo made the row ping-pong
--    between them — the losing job showed zero photos with no soft-delete
--    marker to recover from. The blob tolerates a shared id; the rows must
--    too. Re-keyed to (job_id, id), which is the real identity.
--
-- 3. DELETION WAS NOT DURABLE. An admin hard-deleting (or soft-deleting) a
--    row had it resurrected by the next save, because the projection clears
--    deleted_at and re-inserts from the blob. `purged_at` is a marker the
--    projection will not touch, so a deliberate purge sticks.
--
-- 4. SWALLOWED FAILURES WERE NOT SELF-HEALING. 223 rightly stopped the
--    projection from ever blocking a field save, but claimed the next write
--    would re-reconcile — untrue, because the trigger short-circuits unless
--    `photos` itself changed, and a finished job never writes again. Added a
--    real reconciler plus a nightly pg_cron sweep, so a missed projection is
--    repaired within a day instead of silently forever.
--
-- 5. THE DRIFT VIEW WAS BLIND to exactly the divergence it existed to catch
--    (it matched on photo id without job id) and false-positived on every
--    tombstoned job. Both arms are now job-aware.
--
-- 6. ATTRIBUTION. Under the projection, an unattributable photo was credited
--    to whoever's push happened to carry it — provably the wrong person on a
--    merged union. It now stays NULL rather than naming a bystander.
--
-- Also: photos the projection cannot represent (no id, or a non-uuid id from
-- the crypto.randomUUID fallback) are counted and warned about instead of
-- vanishing silently.
-- ============================================================

set lock_timeout = '5s';

-- ---------- 2: identity is (job, photo), matching the blob ----------
alter table public.field_photos add column if not exists purged_at timestamptz;

do $$
begin
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.field_photos'::regclass and c.contype = 'p'
       and (select count(*) from unnest(c.conkey)) = 1
  ) then
    alter table public.field_photos drop constraint field_photos_pkey;
    alter table public.field_photos add primary key (job_id, id);
  end if;
end;
$$;

-- a photo id still needs a fast lookup of its own (sync, repair, drift)
create index if not exists field_photos_id on public.field_photos (id);
create index if not exists field_photos_purged on public.field_photos (purged_at) where purged_at is not null;

comment on column public.field_photos.purged_at is
  'Deliberate, durable removal. The blob→row projection re-creates anything '
  'the blob still lists, so an ordinary delete cannot stick; a row marked '
  'here is skipped by the projection and stays gone.';

-- ---------- 6: never credit a bystander ----------
create or replace function public.stamp_field_photo()
returns trigger
language plpgsql
set search_path = public
as $$
declare projecting boolean := coalesce(current_setting('app.projection', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    -- under the projection, authorship comes from the blob's own `by` stamp;
    -- falling back to auth.uid() would credit whoever's push carried it,
    -- which on a merged union is provably not the photographer
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

-- ---------- the reconciler: one job's rows made to match one photos array ----------
-- Shared by the trigger and the nightly repair, so they can never drift apart.
create or replace function public.reconcile_job_photos(p_job uuid, p_arr jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare touched int := 0; swept int := 0; skipped int := 0;
begin
  if p_job is null or p_arr is null or jsonb_typeof(p_arr) <> 'array' then
    return 0;                                   -- never infer "no photos" from a shape we don't trust
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
  incoming as (      -- a duplicated id would otherwise abort the statement
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
      where field_photos.purged_at is null        -- a deliberate purge stays purged
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
$$;

-- ---------- the trigger: guarded, and never able to block a save ----------
create or replace function public.project_field_photos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare arr jsonb := new.data -> 'photos';
begin
  -- an ABSENT key is not an empty gallery: never infer deletions from it
  if new.deleted or arr is null or jsonb_typeof(arr) <> 'array' then return null; end if;
  if tg_op = 'UPDATE' and (old.data -> 'photos') is not distinct from arr then return null; end if;

  perform public.reconcile_job_photos(new.id, arr);
  return null;
exception when others then
  -- derived data must never cost the crew a save; the nightly repair fixes it
  raise warning 'project_field_photos failed for job %: %', new.id, sqlerrm;
  return null;
end;
$$;

drop trigger if exists project_field_photos on public.field_projects;
create trigger project_field_photos
  after insert or update on public.field_projects
  for each row execute function public.project_field_photos();

-- ---------- 4: real self-healing ----------
-- The trigger only fires when `photos` changes, so a swallowed failure on a
-- job that never touches photos again would be permanent. This re-reconciles
-- every live job; at 40 jobs / ~450 photos it costs nothing.
create or replace function public.repair_field_photos()
returns int
language plpgsql
security definer
set search_path = public
as $$
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

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('repair-field-photos'); exception when others then null; end;
    perform cron.schedule('repair-field-photos', '37 9 * * *',
      $r$ select public.repair_field_photos(); $r$);
  end if;
end;
$$;

-- ---------- 5: a drift view that can actually see drift ----------
drop view if exists public.field_photos_drift;
create view public.field_photos_drift as
with blob_photos as (
  select fp.id as job_id, (p->>'id')::uuid as photo_id
  from public.field_projects fp,
       lateral jsonb_array_elements(fp.data->'photos') p
  where not fp.deleted
    and jsonb_typeof(fp.data->'photos') = 'array'
    and jsonb_typeof(p) = 'object'
    and (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
select b.job_id, b.photo_id, 'missing row'::text as problem
  from blob_photos b
 where not exists (select 1 from public.field_photos f
                    where f.id = b.photo_id and f.job_id = b.job_id      -- job-aware
                      and f.deleted_at is null)
   and not exists (select 1 from public.field_photos f                    -- a purge is intentional
                    where f.id = b.photo_id and f.job_id = b.job_id and f.purged_at is not null)
union all
select f.job_id, f.id, 'row not in blob'
  from public.field_photos f
  join public.field_projects fp on fp.id = f.job_id and not fp.deleted    -- tombstoned jobs keep their rows by design
 where f.deleted_at is null
   and not exists (select 1 from blob_photos b
                    where b.photo_id = f.id and b.job_id = f.job_id);

revoke all on public.field_photos_drift from anon, authenticated;

comment on view public.field_photos_drift is
  'Operator check that field_photos mirrors the job blobs (223, fixed in '
  '224). Expect zero rows. The projection swallows its own errors so a field '
  'save is never blocked, and the nightly repair-field-photos job re-'
  'reconciles; this is how anything left over is noticed. Run it before '
  'Phase 3 flips reads onto these rows.';

revoke execute on function public.project_field_photos()              from public, anon, authenticated;
revoke execute on function public.reconcile_job_photos(uuid, jsonb)   from public, anon, authenticated;
revoke execute on function public.repair_field_photos()               from public, anon, authenticated;
