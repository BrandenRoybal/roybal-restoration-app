-- ============================================================
-- 214: server-side safety net under job deletes
-- ------------------------------------------------------------
-- The field app's delete pushes a tombstone that (pre-fix) replaced the
-- row's data with a bare {id} — one confirm tap destroyed the server copy
-- of a job forever. This trigger captures the row's previous data whenever
-- a row transitions alive -> deleted, so ANY delete (old client, new
-- client, manual SQL) leaves a recoverable copy. Photo/media objects are
-- content-addressed in the field-media bucket and are never deleted, so a
-- trashed row's media markers stay resolvable.
--
-- Recovery (operator action, SQL editor / service role):
--   update field_projects fp
--      set data = t.data, deleted = false
--     from (select data from field_projects_trash
--            where id = '<job-id>' order by deleted_at desc limit 1) t
--    where fp.id = '<job-id>';
-- ============================================================

create table if not exists public.field_projects_trash (
  id uuid not null,
  data jsonb not null,
  deleted_at timestamptz not null default now(),
  primary key (id, deleted_at)
);

-- clients have no business in the trash: RLS on, and deliberately NO
-- policies — only the service role (which bypasses RLS) can read/restore.
alter table public.field_projects_trash enable row level security;

create or replace function public.field_projects_trash_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted and not coalesce(old.deleted, false) then
    insert into public.field_projects_trash (id, data) values (old.id, old.data);
  end if;
  return new;
end;
$$;

drop trigger if exists field_projects_trash_capture on public.field_projects;
create trigger field_projects_trash_capture
  before update on public.field_projects
  for each row execute function public.field_projects_trash_capture();
