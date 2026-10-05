-- ============================================================================
-- Assertions for 0015_job_receipts.sql (the 🧾 Receipts tile's office table).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/job_receipts.test.sql <staging url>
-- Everything it inserts is rolled back.
--
-- The rules it holds the table to:
--   1. RLS is on; anon holds nothing; authenticated holds SELECT and nothing
--      else (the baseline's default privileges would grant ALL otherwise).
--   2. A job row's receipts array becomes rows, with the field app's
--      normalisation: the assistant's free-text category maps, "$1,234.50"
--      parses, the photo's media marker is kept as a reference, the vendor's
--      store number stays.
--   3. An edit updates the row; a receipt dropped from the array is
--      soft-deleted, never removed; trashing the job soft-deletes them all;
--      restoring the job brings the live ones back.
--   4. The trigger never fails the job write: a receipt with an impossible
--      date raises a warning, the push still lands.
--   5. An owner reads the rows (with a REAL user JWT's claims, role =
--      "authenticated"); a crew member reads none; an authenticated insert or
--      update is refused; anon reads nothing.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. grants and RLS
do $$
declare
  p text;
  problems text[] := '{}';
begin
  if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'job_receipts') then
    raise exception 'RLS is not enabled on job_receipts';
  end if;
  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('anon', 'public.job_receipts', p) then
      problems := problems || format('anon has %s', p);
    end if;
    if p <> 'SELECT' and has_table_privilege('authenticated', 'public.job_receipts', p) then
      problems := problems || format('authenticated has %s', p);
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.job_receipts', 'SELECT') then
    problems := problems || 'authenticated cannot SELECT'::text;
  end if;
  foreach p in array array['anon', 'authenticated'] loop
    if has_function_privilege(p, 'public.reconcile_job_receipts(uuid, jsonb)', 'EXECUTE') then
      problems := problems || format('%s can execute reconcile_job_receipts', p);
    end if;
    if has_function_privilege(p, 'public.project_job_receipts()', 'EXECUTE') then
      problems := problems || format('%s can execute project_job_receipts', p);
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'project_job_receipts' and tgrelid = 'public.field_projects'::regclass) then
    problems := problems || 'the project_job_receipts trigger is missing from field_projects'::text;
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'job_receipts grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2–5. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000c015', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rc-owner@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000c016', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rc-crew@example.invalid',  '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000c015', 'rc test owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c016', 'rc test crew',  'crew')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 2. a job with two receipts becomes two rows
savepoint s;
set local role service_role;
insert into public.field_projects (id, data) values
  ('00000000-0000-0000-0000-0000000e0015',
   '{"customer": "Receipt test", "receipts": [
      {"id": "r-1", "vendor": " THE HOME DEPOT #1234 ", "amount": "$1,234.50", "subtotal": 1200, "category": "Materials",
       "date": "2026-10-03", "paidWith": "card", "cardLast4": "************4558", "receiptNo": "9012 00034",
       "photo": "media:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:123456",
       "by": "test-rc-crew@example.invalid", "createdAt": "2026-10-03T19:00:00Z", "ai": {"at": "2026-10-03T19:00:05Z"},
       "items": [{"id": "i1", "desc": "3/4 CDX plywood", "qty": "4", "unit": "sht", "price": "42.5", "sku": "123456"}]},
      {"id": "r-2", "vendor": "FNSB Landfill", "amount": 35.5, "category": "dump fees", "date": "2026-10-04",
       "loggedBy": "office-assistant", "at": "2026-10-04T18:00:00Z"},
      {"vendor": "no id, not a row", "amount": 1},
      "not an object"
    ]}'::jsonb);
reset role;
do $$
declare r public.job_receipts;
begin
  if (select count(*) from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015') <> 2 then
    raise exception 'expected 2 receipt rows, got %', (select count(*) from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015');
  end if;
  select * into r from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-1';
  if r.vendor <> 'THE HOME DEPOT #1234' then raise exception 'vendor not trimmed/kept: %', r.vendor; end if;
  if r.amount <> 1234.50 then raise exception 'amount "$1,234.50" did not parse: %', r.amount; end if;
  if r.subtotal <> 1200 then raise exception 'subtotal lost: %', r.subtotal; end if;
  if r.tax is not null then raise exception 'tax should be null when absent'; end if;
  if r.category <> 'materials' then raise exception 'category Materials did not map: %', r.category; end if;
  if r.receipt_date <> date '2026-10-03' then raise exception 'date lost: %', r.receipt_date; end if;
  if r.paid_with <> 'card' or r.card_last4 <> '4558' or r.receipt_no <> '9012 00034' then
    raise exception 'payment fields wrong: % % %', r.paid_with, r.card_last4, r.receipt_no;
  end if;
  if r.photo_ref <> 'media:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:123456' or not r.has_photo then
    raise exception 'photo marker not kept: % %', r.photo_ref, r.has_photo;
  end if;
  if r.logged_by <> 'test-rc-crew@example.invalid' or r.logged_at <> '2026-10-03T19:00:00Z'::timestamptz then
    raise exception 'logged_by/at wrong: % %', r.logged_by, r.logged_at;
  end if;
  if r.ai_read_at <> '2026-10-03T19:00:05Z'::timestamptz then raise exception 'ai_read_at wrong: %', r.ai_read_at; end if;
  if jsonb_array_length(r.items) <> 1 or r.items->0->>'desc' <> '3/4 CDX plywood' then raise exception 'items lost: %', r.items; end if;
  if r.deleted_at is not null then raise exception 'a live receipt carries deleted_at'; end if;

  select * into r from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-2';
  if r.category <> 'dump' then raise exception 'category "dump fees" did not map: %', r.category; end if;
  if r.amount <> 35.5 then raise exception 'numeric amount lost: %', r.amount; end if;
  if r.logged_by <> 'office-assistant' or r.logged_at <> '2026-10-04T18:00:00Z'::timestamptz then
    raise exception 'assistant receipt attribution wrong: % %', r.logged_by, r.logged_at;
  end if;
  if r.has_photo or r.photo_ref is not null then raise exception 'phantom photo on r-2'; end if;
end
$$;

-- 3a. an edit lands; a dropped receipt is soft-deleted, not removed
set local role service_role;
update public.field_projects
   set data = jsonb_set(data, '{receipts}', '[{"id": "r-1", "vendor": "Home Depot", "amount": "1300", "category": "materials", "date": "2026-10-03"}]'::jsonb)
 where id = '00000000-0000-0000-0000-0000000e0015';
reset role;
do $$
begin
  if (select amount from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-1') <> 1300 then
    raise exception 'edited amount did not land';
  end if;
  if (select vendor from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-1') <> 'Home Depot' then
    raise exception 'edited vendor did not land';
  end if;
  if (select deleted_at from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-2') is null then
    raise exception 'a receipt dropped from the array was not soft-deleted';
  end if;
  if (select count(*) from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015') <> 2 then
    raise exception 'a dropped receipt was removed instead of kept';
  end if;
end
$$;

-- 3b. trashing the job soft-deletes the rest; restoring it brings the live one back
set local role service_role;
update public.field_projects set deleted = true where id = '00000000-0000-0000-0000-0000000e0015';
reset role;
do $$
begin
  if (select count(*) from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and deleted_at is null) <> 0 then
    raise exception 'trashing the job left live receipt rows';
  end if;
end
$$;
set local role service_role;
update public.field_projects set deleted = false where id = '00000000-0000-0000-0000-0000000e0015';
reset role;
do $$
begin
  if (select deleted_at from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-1') is not null then
    raise exception 'restoring the job did not bring r-1 back';
  end if;
  if (select deleted_at from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015' and id = 'r-2') is null then
    raise exception 'restoring the job resurrected the dropped r-2';
  end if;
end
$$;

-- 4. a receipt the projection cannot take never blocks the job write
set local role service_role;
update public.field_projects
   set data = jsonb_set(data, '{receipts}', '[{"id": "r-1", "vendor": "Home Depot", "amount": "1300", "category": "materials", "date": "2026-02-30"}]'::jsonb)
 where id = '00000000-0000-0000-0000-0000000e0015';
reset role;
do $$
begin
  if (select data->'receipts'->0->>'date' from public.field_projects where id = '00000000-0000-0000-0000-0000000e0015') <> '2026-02-30' then
    raise exception 'the job write was blocked by the receipts projection';
  end if;
end
$$;
release savepoint s;

-- 5a. the owner reads the rows, with the claims a real access token carries
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c015", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.job_receipts where job_id = '00000000-0000-0000-0000-0000000e0015';
  if n <> 2 then
    raise exception 'the owner (profiles.role owner, JWT role authenticated) reads % of 2 job_receipts rows', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5b. a crew member reads nothing
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c016", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.job_receipts;
  if n <> 0 then
    raise exception 'a crew member reads % job_receipts row(s)', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5c. an authenticated insert or update is refused — even the owner's
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c015", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    insert into public.job_receipts (job_id, id, vendor) values ('00000000-0000-0000-0000-0000000e0015', 'forged', 'forged');
    raise exception 'an authenticated user inserted into job_receipts';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.job_receipts set amount = 0;
    raise exception 'an authenticated user updated job_receipts';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 5d. anon has nothing at all
savepoint s;
set local role anon;
do $$
begin
  begin
    perform 1 from public.job_receipts;
    raise exception 'anon can read job_receipts';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

rollback;
