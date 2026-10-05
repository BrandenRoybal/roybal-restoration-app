-- ============================================================================
-- 0015 — job_receipts: every receipt snapped on a job, as rows the office can
-- query by vendor, by job and by item (Job Receipts plan, phase 1).
--
-- WHERE THE TRUTH IS: the field app. A receipt is an element of
-- field_projects.data->'receipts' — the job blob the crew edits offline and
-- push_project merges — exactly like a job photo. This table is a PROJECTION
-- of that array, kept by a trigger on field_projects the same way
-- project_field_photos keeps field_photos: nothing writes it but the trigger,
-- and the trigger can never fail a sync push (exception-guarded, as its photo
-- twin is). Edits made here would be overwritten on the next push, so nothing
-- may write here: no insert/update/delete grant, no policy for them.
--
-- WHO READS IT: owner/office over PostgREST — the plan's phase 2 Receipts
-- library in the admin app and the phase 3 QuickBooks matcher. The field app
-- never reads it; the job page sums the array it holds (receiptcalc.js).
--
-- WHAT A ROW HOLDS: the receipt's fields and line items, who logged it, and
-- the photo's field-media marker (media:<sha256>:<length>) — the content
-- address sync stored the image under in the field-media bucket — never the
-- image itself. A receipt removed from the job, or whose whole job went to
-- the trash, keeps its row with deleted_at set: a receipt the bank feed has
-- already matched must stay findable.
--
-- CATEGORY and AMOUNT are normalised here with the same rules as the field
-- app's receiptcalc.js (receiptCategory, amountNum), so the office's totals
-- and the crew's job page agree. Keep the two in step.
--
-- Additive: dropping the trigger, the two functions and the table restores
-- the app exactly as it was.
-- ============================================================================

create table if not exists public.job_receipts (
  job_id        uuid          not null,                     -- field_projects.id
  id            text          not null,                     -- the receipt's id inside the job blob
  vendor        text          not null default '',
  receipt_date  date,
  amount        numeric(12,2) not null default 0,           -- the receipt total: what the job's running total sums
  subtotal      numeric(12,2),
  tax           numeric(12,2),
  category      text          not null default 'other'
                check (category in ('materials', 'equipment', 'dump', 'other')),
  paid_with     text          not null default ''           -- phase 3 keys off it: card/bank waits for the feed, account becomes its own expense
                check (paid_with in ('', 'card', 'account', 'cash', 'personal')),
  card_last4    text          not null default '',
  receipt_no    text          not null default '',
  notes         text          not null default '',
  items         jsonb         not null default '[]'::jsonb, -- [{id, desc, qty, unit, price, sku}] as read by the AI and corrected in the field
  photo_ref     text,                                       -- media:<sha256>:<length> marker of the photo in field-media; null until sync offloads it
  has_photo     boolean       not null default false,
  ai_read_at    timestamptz,                                -- when the AI last read it (blob ai.at)
  logged_by     text          not null default '',          -- email of who snapped it (blob `by`), or 'office-assistant'
  logged_at     timestamptz,                                -- when it was snapped (blob createdAt)
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),
  deleted_at    timestamptz,                                -- left the job's list (or the job was trashed); never hard-deleted by the trigger
  primary key (job_id, id)
);

comment on table public.job_receipts is
  'One row per receipt in field_projects.data->''receipts'' (the 🧾 Receipts tile), projected by the project_job_receipts trigger — the office''s view for vendor/job/item lookups and the QuickBooks link. Read by owner/office; written by nothing but the trigger. The field app is the source of truth.';
comment on column public.job_receipts.amount is 'The receipt total as paid — the figure the job''s running material total and the budget flag sum.';
comment on column public.job_receipts.photo_ref is 'The photo''s content address in the field-media bucket (media:<sha256>:<length>), as sync stored it; the image itself never lives here.';
comment on column public.job_receipts.deleted_at is 'Set when the receipt leaves the job''s list or the job is trashed; cleared if it comes back. Rows are never removed by the trigger.';

create index if not exists job_receipts_vendor_idx
  on public.job_receipts (lower(vendor), receipt_date)
  where deleted_at is null;

alter table public.job_receipts enable row level security;

-- The baseline's default privileges grant ALL on every new table to anon and
-- authenticated (0000_baseline.sql; 0008). Take it all back: anon holds
-- nothing, authenticated may SELECT (RLS narrows that to owner/office). The
-- trigger function below is SECURITY DEFINER owned by postgres, so it needs
-- no grant to write.
revoke all on public.job_receipts from anon, authenticated;
grant select on public.job_receipts to authenticated;

-- Read: owner/office. role_is() rather than current_role_name() for the
-- reason 0010 gives: a real user JWT carries role = "authenticated" as a
-- claim. No insert/update/delete policy — see the header.
drop policy if exists job_receipts_read_office on public.job_receipts;
create policy job_receipts_read_office on public.job_receipts
  for select to authenticated
  using ((select public.role_is('owner', 'office')));


-- ---------------------------------------------------------------------------
-- reconcile_job_receipts(job, array): upsert every element of the blob's
-- receipts array into job_receipts and soft-delete the rows no longer in it.
-- Returns the number of rows touched. Shared by the trigger and the backfill.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_job_receipts(p_job uuid, p_arr jsonb) returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare touched int := 0; gone int := 0;
begin
  if p_job is null or p_arr is null or jsonb_typeof(p_arr) <> 'array' then
    return 0;
  end if;

  with parsed as (
    select
      left(p->>'id', 80)                                                           as id,
      ord,
      left(btrim(coalesce(p->>'vendor', '')), 120)                                 as vendor,
      case when (p->>'date') ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])'
           then left(p->>'date', 10)::date end                                     as receipt_date,
      -- the same tolerant money parse as receiptcalc.js amountNum: "$1,234.50" → 1234.50, else 0
      case when regexp_replace(coalesce(p->>'amount', ''), '[$,\s]', '', 'g') ~ '^-?\d*\.?\d+$'
           then round(regexp_replace(p->>'amount', '[$,\s]', '', 'g')::numeric, 2) else 0 end as amount,
      case when regexp_replace(coalesce(p->>'subtotal', ''), '[$,\s]', '', 'g') ~ '^-?\d*\.?\d+$'
           then round(regexp_replace(p->>'subtotal', '[$,\s]', '', 'g')::numeric, 2) end      as subtotal,
      case when regexp_replace(coalesce(p->>'tax', ''), '[$,\s]', '', 'g') ~ '^-?\d*\.?\d+$'
           then round(regexp_replace(p->>'tax', '[$,\s]', '', 'g')::numeric, 2) end           as tax,
      -- receiptcalc.js receiptCategory, rule for rule
      case
        when lower(btrim(coalesce(p->>'category', ''))) in ('materials', 'equipment', 'dump', 'other')
          then lower(btrim(p->>'category'))
        when lower(coalesce(p->>'category', '')) ~ 'equip|rental|rent\M'                          then 'equipment'
        when lower(coalesce(p->>'category', '')) ~ 'dump|landfill|disposal|transfer station|tipping' then 'dump'
        when lower(coalesce(p->>'category', '')) ~ 'material|lumber|supply|supplies|hardware|paint|plumb|electric' then 'materials'
        else 'other'
      end                                                                          as category,
      case when p->>'paidWith' in ('card', 'account', 'cash', 'personal') then p->>'paidWith' else '' end as paid_with,
      right(regexp_replace(coalesce(p->>'cardLast4', ''), '\D', '', 'g'), 4)       as card_last4,
      left(btrim(coalesce(p->>'receiptNo', '')), 40)                               as receipt_no,
      left(coalesce(p->>'notes', ''), 400)                                         as notes,
      case when jsonb_typeof(p->'items') = 'array' then p->'items' else '[]'::jsonb end as items,
      case when (p->>'photo') ~ '^media:[0-9a-f]{64}:\d+$' then p->>'photo' end    as photo_ref,
      coalesce(p->>'photo', '') <> ''                                              as has_photo,
      case when (p->'ai'->>'at') ~ '^\d{4}-\d{2}-\d{2}T' then (p->'ai'->>'at')::timestamptz end as ai_read_at,
      left(coalesce(nullif(p->>'by', ''), p->>'loggedBy', ''), 120)                as logged_by,
      case when coalesce(p->>'createdAt', p->>'at') ~ '^\d{4}-\d{2}-\d{2}T'
           then coalesce(p->>'createdAt', p->>'at')::timestamptz end               as logged_at
    from jsonb_array_elements(p_arr) with ordinality as t(p, ord)
    where jsonb_typeof(p) = 'object'
      and coalesce(p->>'id', '') <> ''
  ),
  incoming as (
    -- a duplicated id (two devices, one merge) resolves to the last copy
    select distinct on (id) *
    from parsed
    order by id, ord desc
  ),
  upserted as (
    insert into public.job_receipts
      (job_id, id, vendor, receipt_date, amount, subtotal, tax, category, paid_with, card_last4, receipt_no,
       notes, items, photo_ref, has_photo, ai_read_at, logged_by, logged_at, created_at, updated_at)
    select p_job, i.id, i.vendor, i.receipt_date, i.amount, i.subtotal, i.tax, i.category, i.paid_with, i.card_last4, i.receipt_no,
           i.notes, i.items, i.photo_ref, i.has_photo, i.ai_read_at, i.logged_by, i.logged_at, coalesce(i.logged_at, now()), now()
    from incoming i
    on conflict (job_id, id) do update
      set vendor       = excluded.vendor,
          receipt_date = excluded.receipt_date,
          amount       = excluded.amount,
          subtotal     = excluded.subtotal,
          tax          = excluded.tax,
          category     = excluded.category,
          paid_with    = excluded.paid_with,
          card_last4   = excluded.card_last4,
          receipt_no   = excluded.receipt_no,
          notes        = excluded.notes,
          items        = excluded.items,
          photo_ref    = excluded.photo_ref,
          has_photo    = excluded.has_photo,
          ai_read_at   = excluded.ai_read_at,
          logged_by    = excluded.logged_by,
          logged_at    = excluded.logged_at,
          updated_at   = now(),
          deleted_at   = null
      where (job_receipts.vendor, job_receipts.receipt_date, job_receipts.amount, job_receipts.subtotal, job_receipts.tax,
             job_receipts.category, job_receipts.paid_with, job_receipts.card_last4, job_receipts.receipt_no, job_receipts.notes,
             job_receipts.items, job_receipts.photo_ref, job_receipts.has_photo, job_receipts.ai_read_at, job_receipts.logged_by,
             job_receipts.logged_at, job_receipts.deleted_at)
            is distinct from
            (excluded.vendor, excluded.receipt_date, excluded.amount, excluded.subtotal, excluded.tax,
             excluded.category, excluded.paid_with, excluded.card_last4, excluded.receipt_no, excluded.notes,
             excluded.items, excluded.photo_ref, excluded.has_photo, excluded.ai_read_at, excluded.logged_by,
             excluded.logged_at, null::timestamptz)
    returning 1
  )
  select count(*) into touched from upserted;

  -- rows whose receipt left the array: soft-delete, never remove
  update public.job_receipts r
     set deleted_at = now(), updated_at = now()
   where r.job_id = p_job
     and r.deleted_at is null
     and not exists (
       select 1 from jsonb_array_elements(p_arr) e
        where jsonb_typeof(e) = 'object' and left(e->>'id', 80) = r.id);
  get diagnostics gone = row_count;

  return touched + gone;
end;
$$;

alter function public.reconcile_job_receipts(uuid, jsonb) owner to postgres;
comment on function public.reconcile_job_receipts(uuid, jsonb) is
  'Projects one job''s receipts array (field_projects.data->''receipts'') into job_receipts: upsert by (job, id), soft-delete the rest. Called by the project_job_receipts trigger and the 0015 backfill.';
-- Default privileges hand EXECUTE on every new function to anon and
-- authenticated directly (0008). Nobody but the trigger calls this.
revoke all on function public.reconcile_job_receipts(uuid, jsonb) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- project_job_receipts(): the trigger. Same shape as project_field_photos —
-- fires after every insert/update of a job row, skips unchanged arrays, and
-- can never fail the write that fired it.
-- ---------------------------------------------------------------------------
create or replace function public.project_job_receipts() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare arr jsonb := new.data -> 'receipts';
begin
  if new.deleted then
    -- the whole job went to the trash: its receipts leave the live set but
    -- keep their rows (a feed match or a return still needs them)
    update public.job_receipts set deleted_at = now(), updated_at = now()
     where job_id = new.id and deleted_at is null;
    return null;
  end if;
  if arr is null or jsonb_typeof(arr) <> 'array' then return null; end if;
  -- unchanged array on a live job: nothing to do (a restore from the trash
  -- re-projects even an unchanged array, to clear deleted_at)
  if tg_op = 'UPDATE' and not old.deleted and (old.data -> 'receipts') is not distinct from arr then return null; end if;

  perform public.reconcile_job_receipts(new.id, arr);
  return null;
exception when others then
  raise warning 'project_job_receipts failed for job %: %', new.id, sqlerrm;
  return null;
end;
$$;

alter function public.project_job_receipts() owner to postgres;
comment on function public.project_job_receipts() is
  'AFTER INSERT OR UPDATE on field_projects: keeps job_receipts in step with the blob''s receipts array. Exception-guarded — a sync push never fails because of it.';
revoke all on function public.project_job_receipts() from public, anon, authenticated;

drop trigger if exists project_job_receipts on public.field_projects;
create trigger project_job_receipts
  after insert or update on public.field_projects
  for each row execute function public.project_job_receipts();


-- ---------------------------------------------------------------------------
-- Backfill: the receipts already in job blobs (the office assistant's
-- receiptLog chip has been writing the same array) become rows now, so the
-- office never sees a job with a running total and no receipts behind it.
-- ---------------------------------------------------------------------------
do $$
declare r record; n int := 0;
begin
  for r in
    select id, data
      from public.field_projects
     where not deleted
       and jsonb_typeof(data -> 'receipts') = 'array'
       and jsonb_array_length(data -> 'receipts') > 0
  loop
    begin
      perform public.reconcile_job_receipts(r.id, r.data -> 'receipts');
      n := n + 1;
    exception when others then
      raise warning '0015 backfill: job % skipped: %', r.id, sqlerrm;
    end;
  end loop;
  raise notice '0015: receipts projected for % job(s)', n;
end
$$;
