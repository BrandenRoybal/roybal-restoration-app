-- ============================================================================
-- Assertions for 0025_receipts_qbo_bills_parts.sql (receipts.qbo_link v2: a
-- bill is only read and noted, a receipt paid in two or three card charges
-- is one card line that tags them all, and a receipt whose QuickBooks update
-- failed is matched again as a second try).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/receipts_qbo_v2.test.sql <staging url>
-- Everything it writes is rolled back (sequence values it draws are not).
-- receipts_qbo_link.test.sql holds 0023's rules as 0025 left them; this file
-- holds what 0025 adds. Its jobs, receipts and QuickBooks ids are its own
-- (…25a1 to …25a6, v2-*, 10615 and up), so it never meets real rows or the
-- 0023 file's.
--
-- The rules it holds 0025 to:
--   1. receipt_qbo_claims is owned by postgres, has RLS on and no policy, a
--      (qbo_txn_type, qbo_txn_id) primary key that is not deferrable, and
--      the service role may SELECT it and nothing more; anon,
--      authenticated and PUBLIC hold nothing. receipt_qbo_links_claims() is
--      owned by postgres, SECURITY DEFINER with a pinned search_path, and
--      executable by nobody; its trigger is a plain (never a constraint)
--      AFTER INSERT OR DELETE OR UPDATE OF receipt_id, state, qbo_txn_type,
--      qbo_txn_id, parts FOR EACH ROW trigger on receipt_qbo_links. The five
--      functions 0025 writes exist once each (no overload).
--   2. receipt_qbo_links takes a Bill and nothing but a Purchase or a Bill;
--      parts is null, or an array of 2 or 3 on a Purchase row.
--   3. The claims follow the row: an in_qbo, queued or done row holds its
--      transaction and each of its parts; an unmatched, conflict or failed
--      row and a deleted one hold nothing; a second holder of a transaction,
--      a part included, is refused with 23505 by the claims' primary key.
--   4. The note door takes a Bill and parts, and refuses parts that are not
--      2 or 3 distinct charges led by the row's own id and SyncToken, or
--      that come on a Bill; a row that omits parts keeps its own for the same
--      transaction and drops them for another; parts null clears them; an
--      unchanged split row is not rewritten; a claim on a part another
--      receipt holds is a conflict (claimed_by_other) that holds nothing. It
--      replaces a failed row it is sent (also when the row it is sent is a
--      claimed_by_other conflict), never removes or changes a failed row it
--      is not sent, and keeps queued and done rows.
--   5. The owner's approval queues a receipt in parts as one link row that
--      keeps every charge (4 keys each) and one outbox row whose payload
--      names no transaction at the top and each charge in parts, in order;
--      the executor refuses parts that do not add up to the receipt, a first
--      part that is not the item's charge, a part change the item does not
--      ask for, an item change no part asks for, a Bill (in parts or not), a
--      new expense in parts, 1 or 4 parts, a charge named twice and a
--      malformed refile; a part another receipt holds fails in words naming
--      the part; refile and read_photo_ref (null included) are kept in
--      detail; a receipt already queued is skipped for the same parts and
--      refused for others.
--   6. The filing door offers again a card that lost a lock race
--      (deadlock detected). THE SECOND-TRY STAMP: a failed row whose receipt
--      is filed with refile.proposal_id naming the row's own proposal names
--      the card holding that try in detail.refiled_proposal_id (new, still
--      open, or declined); a refile naming another card stamps nothing. The
--      result trigger and a later approval replace the stamp with the row.
--   7. The result trigger marks the row done first and then writes each
--      charge's new SyncToken from provider_status parts=; a parts= it cannot
--      read or apply, and a part_error, still leave the receipt done. A row
--      marked dead by hand without an error reads "cancelled: marked dead by
--      hand", with one that error. A new expense another receipt holds as a
--      part is named in detail.txn_held_by (read from the claims).
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. the claims table, its trigger function and trigger, and the five
--    functions
do $$
declare
  t   constant text := 'public.receipt_qbo_claims';
  f   constant text := 'public.receipt_qbo_links_claims()';
  rl  text;
  n   text;
  problems text[] := '{}';
begin
  if to_regclass(t) is null then
    raise exception 'receipt_qbo_claims is missing';
  end if;
  if (select pg_get_userbyid(relowner) from pg_class where oid = t::regclass) is distinct from 'postgres' then
    problems := problems || 'receipt_qbo_claims is not owned by postgres'::text;
  end if;
  if not (select relrowsecurity from pg_class where oid = t::regclass) then
    problems := problems || 'RLS is off on receipt_qbo_claims'::text;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'receipt_qbo_claims') then
    problems := problems || 'receipt_qbo_claims has a policy (0025: none, on purpose)'::text;
  end if;
  if (select array_agg(attname::text || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull::text order by attnum)
        from pg_attribute where attrelid = t::regclass and attnum > 0 and not attisdropped)
     is distinct from array['qbo_txn_type:text:true', 'qbo_txn_id:text:true', 'receipt_id:text:true'] then
    problems := problems || format('receipt_qbo_claims columns are %s',
      (select array_agg(attname::text || ':' || format_type(atttypid, atttypmod) order by attnum)
         from pg_attribute where attrelid = t::regclass and attnum > 0 and not attisdropped));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = t::regclass and contype = 'p' and not condeferrable
                    and pg_get_constraintdef(oid) = 'PRIMARY KEY (qbo_txn_type, qbo_txn_id)') then
    problems := problems || 'receipt_qbo_claims has no plain (not deferrable) primary key on (qbo_txn_type, qbo_txn_id)'::text;
  end if;
  if not has_table_privilege('service_role', t, 'SELECT')
     or has_table_privilege('service_role', t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    problems := problems || 'the service role holds more or less than SELECT on receipt_qbo_claims'::text;
  end if;
  foreach rl in array array['anon', 'authenticated'] loop
    if has_table_privilege(rl, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      problems := problems || format('%s holds a privilege on receipt_qbo_claims', rl);
    end if;
  end loop;
  if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
              where c.oid = t::regclass and a.grantee = 0) then
    problems := problems || 'PUBLIC holds a privilege on receipt_qbo_claims'::text;
  end if;

  if to_regprocedure(f) is null then
    problems := problems || 'receipt_qbo_links_claims() is missing'::text;
  else
    if (select pg_get_userbyid(proowner) from pg_proc where oid = f::regprocedure) is distinct from 'postgres' then
      problems := problems || 'receipt_qbo_links_claims() is not owned by postgres'::text;
    end if;
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then
      problems := problems || 'receipt_qbo_links_claims() is not SECURITY DEFINER'::text;
    end if;
    if not coalesce((select 'search_path=public, pg_temp' = any (proconfig) from pg_proc where oid = f::regprocedure), false) then
      problems := problems || 'receipt_qbo_links_claims() has no pinned search_path'::text;
    end if;
    if (select prorettype from pg_proc where oid = f::regprocedure) is distinct from 'trigger'::regtype then
      problems := problems || 'receipt_qbo_links_claims() is not a trigger function'::text;
    end if;
    foreach rl in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(rl, f, 'EXECUTE') then
        problems := problems || format('%s can execute receipt_qbo_links_claims()', rl);
      end if;
    end loop;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = f::regprocedure and a.grantee = 0) then
      problems := problems || 'PUBLIC can execute receipt_qbo_links_claims()'::text;
    end if;
  end if;

  -- AFTER (no BEFORE bit) | ROW 1 | INSERT 4 | DELETE 8 | UPDATE 16 = 29, on
  -- exactly the five columns, no WHEN, not a constraint trigger
  if not exists (select 1 from pg_trigger g
                  where g.tgrelid = 'public.receipt_qbo_links'::regclass and g.tgname = 'receipt_qbo_links_claims'
                    and g.tgfoid = to_regprocedure(f) and g.tgtype = 29 and g.tgenabled = 'O'
                    and not g.tgisinternal and g.tgconstraint = 0 and not g.tgdeferrable and g.tgqual is null
                    and (select array_agg(a order by a) from unnest(g.tgattr::int2[]) a)
                        = (select array_agg(attnum order by attnum) from pg_attribute
                            where attrelid = 'public.receipt_qbo_links'::regclass
                              and attname in ('receipt_id', 'state', 'qbo_txn_type', 'qbo_txn_id', 'parts'))) then
    problems := problems || 'receipt_qbo_links_claims is not an enabled AFTER INSERT OR DELETE OR UPDATE OF receipt_id, state, qbo_txn_type, qbo_txn_id, parts FOR EACH ROW trigger'::text;
  end if;

  -- the four replaced functions kept their one signature, and the trigger
  -- function is the fifth
  foreach n in array array['op_exec_receipts_qbo_link', 'receipts_qbo_link_file', 'receipt_qbo_links_note',
                           'outbox_qbo_link_result', 'receipt_qbo_links_claims'] loop
    if (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
         where s.nspname = 'public' and p.proname = n) <> 1 then
      problems := problems || format('%s exists %s times', n,
        (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = n));
    end if;
  end loop;
  if to_regprocedure('public.op_exec_receipts_qbo_link(public.proposals, jsonb, text, uuid)') is null
     or to_regprocedure('public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval)') is null
     or to_regprocedure('public.receipt_qbo_links_note(uuid[], jsonb)') is null
     or to_regprocedure('public.outbox_qbo_link_result()') is null then
    problems := problems || 'a replaced function changed its signature'::text;
  end if;

  -- the link table: a Bill, and parts
  if (select format_type(atttypid, atttypmod) from pg_attribute
       where attrelid = 'public.receipt_qbo_links'::regclass and attname = 'parts' and not attisdropped) is distinct from 'jsonb' then
    problems := problems || 'receipt_qbo_links.parts is not a jsonb column'::text;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.receipt_qbo_links'::regclass and conname = 'receipt_qbo_links_qbo_txn_type_check'
                    and pg_get_constraintdef(oid) ~ 'Purchase' and pg_get_constraintdef(oid) ~ 'Bill') then
    problems := problems || 'receipt_qbo_links_qbo_txn_type_check does not allow Purchase and Bill'::text;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.receipt_qbo_links'::regclass and conname = 'receipt_qbo_links_parts_check') then
    problems := problems || 'receipt_qbo_links_parts_check is missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'receipts qbo v2 objects are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- 2–7. behaviour, as each caller. One transaction, rolled back at the end.
begin;

-- the claims a receipt holds, as 'Type:id', in order ([] for none), and a
-- part as the card files it
create function pg_temp.rq2_claims(p_receipt_id text) returns jsonb
  language sql stable
as $$
  select coalesce(jsonb_agg(c.qbo_txn_type || ':' || c.qbo_txn_id order by c.qbo_txn_type, c.qbo_txn_id collate "C"), '[]'::jsonb)
    from public.receipt_qbo_claims c where c.receipt_id = p_receipt_id
$$;
create function pg_temp.rq2_part(p_id text, p_total numeric, p_changes jsonb, p_date text default '2026-10-01') returns jsonb
  language sql immutable
as $$
  select jsonb_build_object('qbo_txn_id', p_id, 'qbo_sync_token', '0', 'qbo_total', p_total, 'qbo_date', p_date, 'changes', p_changes)
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000025f1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rq2-owner@example.invalid', '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;
insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-0000000025f1', 'rq2 test owner', 'owner')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- Jobs, their receipts projected into job_receipts by 0015's trigger.
-- 1 Chena Landings (job 1885: the Rental Zone receipt paid in two charges,
-- and the malformed items); 2 a second try; 3 a lost lock race; 4 and 6 the
-- note door's (no receipts: the note door reads none); 5 a store entry
insert into public.field_projects (id, data, deleted)
select j.id,
       jsonb_build_object('id', j.id, 'rev', 1, 'updatedAt', '2026-10-09T10:00:00.000Z', 'title', j.title, 'receipts', j.receipts),
       false
  from (values
    ('00000000-0000-0000-0000-0000000025a1'::uuid, 'Chena Landings',
     jsonb_build_array(
       jsonb_build_object('id', 'v2-rz', 'vendor', 'Rental Zone', 'date', '2026-10-07', 'amount', '351.00', 'category', 'equipment',
                          'paidWith', 'card', 'cardLast4', '1658', 'receiptNo', 'RZ 40213', 'photo', 'media:' || repeat('a', 64) || ':351'),
       jsonb_build_object('id', 'v2-rx', 'vendor', 'Rental Zone', 'date', '2026-10-03', 'amount', '80.00', 'category', 'equipment',
                          'paidWith', 'card', 'cardLast4', '1658', 'photo', 'media:' || repeat('b', 64) || ':80'))
     || (select jsonb_agg(jsonb_build_object('id', 'v2-b' || i, 'vendor', 'Rental Zone', 'date', '2026-10-01', 'amount', '100.00',
                                             'category', 'equipment', 'paidWith', 'card', 'cardLast4', '1658'))
           from generate_series(1, 13) i)),
    ('00000000-0000-0000-0000-0000000025a2'::uuid, 'Second try job', jsonb_build_array(
       jsonb_build_object('id', 'v2-sw', 'vendor', 'Home Depot', 'date', '2026-10-04', 'amount', '45.06', 'category', 'materials',
                          'paidWith', 'card', 'cardLast4', '3176'))),
    ('00000000-0000-0000-0000-0000000025a3'::uuid, 'Deadlock job', jsonb_build_array(
       jsonb_build_object('id', 'v2-dl', 'vendor', 'Home Depot', 'date', '2026-10-05', 'amount', '19.99', 'category', 'materials',
                          'paidWith', 'card', 'cardLast4', '3176', 'photo', 'media:' || repeat('c', 64) || ':19'))),
    ('00000000-0000-0000-0000-0000000025a4'::uuid, 'Note job (failed rows)', '[]'::jsonb),
    ('00000000-0000-0000-0000-0000000025a5'::uuid, 'Store job', jsonb_build_array(
       jsonb_build_object('id', 'v2-st', 'vendor', 'Spenard Builders Supply', 'date', '2026-09-29', 'amount', '88.10',
                          'category', 'materials', 'paidWith', 'account', 'receiptNo', '700630777',
                          'photo', 'media:' || repeat('d', 64) || ':88'))),
    ('00000000-0000-0000-0000-0000000025a6'::uuid, 'Note job (parts)', '[]'::jsonb)
  ) as j(id, title, receipts);

insert into public.job_qbo_links (job_id, qbo_customer_id, qbo_project_ref, qbo_name, source, set_by_kind) values
  ('00000000-0000-0000-0000-0000000025a1', '7301', '415000001', 'Chena Landings', 'picked', 'system'),
  ('00000000-0000-0000-0000-0000000025a2', '7302', '415000002', 'Second try job', 'picked', 'system'),
  ('00000000-0000-0000-0000-0000000025a3', '7303', null, 'Deadlock job', 'picked', 'system'),
  ('00000000-0000-0000-0000-0000000025a5', '7305', '415000005', 'Store job', 'picked', 'system');

-- a worker serving the qbo lane (the filing door's switch)
insert into public.worker_heartbeats (worker_id, at, meta)
values ('rq2-test-worker', now(), '{"channels": ["qbo"]}');

create temp table rq2 (k text primary key, v text);
grant all on rq2 to anon, authenticated, service_role;

-- What the matcher files for Chena Landings: Rental Zone receipt $351.00 on
-- 10/07 = Purchase 10615 $126.90 (10/02, the deposit at checkout) + Purchase
-- 10661 $224.10 (10/07, the balance at return), both untagged, card 1658.
-- The item's own id, SyncToken and total are the first charge's; the second
-- charge already carries the photo, so it asks for the tag alone.
insert into rq2 values ('item_rz', jsonb_build_object(
  'receipt_id', 'v2-rz', 'vendor', 'Rental Zone', 'date', '2026-10-07', 'amount', 351.00, 'receipt_no', 'RZ 40213',
  'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10615', 'qbo_sync_token', '0', 'qbo_doc_number', null,
  'qbo_account_name', '1658 - Chase Ink Business', 'qbo_vendor_name', 'Rental Zone', 'qbo_total', 126.90,
  'changes', '["tag", "attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('a', 64) || ':351'),
  'project_ref', '415000001', 'read_photo_ref', 'media:' || repeat('a', 64) || ':351',
  'parts', jsonb_build_array(
    pg_temp.rq2_part('10615', 126.90, '["tag", "attach"]', '2026-10-02'),
    pg_temp.rq2_part('10661', 224.10, '["tag"]', '2026-10-07')))::text);
insert into rq2 values ('input_1', jsonb_build_object(
  'job_id', '00000000-0000-0000-0000-0000000025a1', 'job_name', 'Chena Landings', 'qbo_customer_id', '7301',
  'qbo_name', 'Chena Landings', 'total_usd', 351.00, 'matcher', 'receipts.qbo_match@1')::text);


-- 2. the table takes a Bill and holds parts to 2 or 3 charges of a Purchase
savepoint s;
do $$
declare
  j  constant uuid := '00000000-0000-0000-0000-0000000025a6';
  p2 constant jsonb := jsonb_build_array(pg_temp.rq2_part('1', 1, '[]'), pg_temp.rq2_part('2', 1, '[]'));
  bad jsonb;
begin
  insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id) values ('v2-t1', j, 'in_qbo', 'Bill', '1');
  insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, parts) values ('v2-t2', j, 'unmatched', 'Purchase', '1', p2);
  insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, parts)
  values ('v2-t3', j, 'unmatched', 'Purchase', '1', p2 || jsonb_build_array(pg_temp.rq2_part('3', 1, '[]')));
  begin
    insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id) values ('v2-t4', j, 'unmatched', 'Invoice', '1');
    raise exception 'receipt_qbo_links took an Invoice';
  exception when check_violation then null;
  end;
  foreach bad in array array[
    jsonb_build_array(pg_temp.rq2_part('1', 1, '[]')),
    p2 || p2,
    '{"qbo_txn_id": "1"}'::jsonb,
    '"1,2"'::jsonb,
    '[]'::jsonb]
  loop
    begin
      insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, parts) values ('v2-t5', j, 'unmatched', 'Purchase', '1', bad);
      raise exception 'receipt_qbo_links took parts %', bad;
    exception when check_violation then null;
    end;
  end loop;
  begin
    insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, parts) values ('v2-t6', j, 'unmatched', 'Bill', '1', p2);
    raise exception 'receipt_qbo_links took a Bill in parts';
  exception when check_violation then null;
  end;
  begin
    insert into public.receipt_qbo_links (receipt_id, job_id, state, parts) values ('v2-t7', j, 'unmatched', p2);
    raise exception 'receipt_qbo_links took parts on a row that names no transaction type';
  exception when check_violation then null;
  end;
end
$$;
rollback to savepoint s;
release savepoint s;


-- 3. the claims follow the row, written past the doors
savepoint s;
do $$
declare
  j  constant uuid := '00000000-0000-0000-0000-0000000025a6';
  c  text;
  st text;
begin
  insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, parts)
  values ('v2-c1', j, 'in_qbo', 'Purchase', '40001', '0', jsonb_build_array(
    pg_temp.rq2_part('40001', 10, '[]'), pg_temp.rq2_part('40002', 20, '[]'), pg_temp.rq2_part('40003', 30, '[]')));
  if pg_temp.rq2_claims('v2-c1') is distinct from '["Purchase:40001", "Purchase:40002", "Purchase:40003"]' then
    raise exception 'an in_qbo row in three parts claims %', pg_temp.rq2_claims('v2-c1');
  end if;

  -- a second holder of a part (not the row's own transaction, so the 0023
  -- partial index cannot see it): the claims' primary key refuses it
  begin
    insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id) values ('v2-c2', j, 'done', 'Purchase', '40003');
    raise exception 'two receipts hold Purchase 40003';
  exception when unique_violation then
    get stacked diagnostics c = constraint_name, st = returned_sqlstate;
    if c is distinct from 'receipt_qbo_claims_pkey' or st is distinct from '23505' then
      raise exception 'a second holder of a part was refused by % (%), not the claims'' primary key', c, st;
    end if;
  end;
  -- the same transaction as a Bill is another transaction
  insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id) values ('v2-c3', j, 'in_qbo', 'Bill', '40003');
  if pg_temp.rq2_claims('v2-c3') is distinct from '["Bill:40003"]' then
    raise exception 'an in_qbo bill claims %', pg_temp.rq2_claims('v2-c3');
  end if;

  -- only in_qbo, queued and done hold anything; detail alone moves nothing
  foreach st in array array['unmatched', 'queued', 'conflict', 'done', 'failed', 'in_qbo'] loop
    update public.receipt_qbo_links set state = st where receipt_id = 'v2-c1';
    if pg_temp.rq2_claims('v2-c1') is distinct from
       (case when st in ('in_qbo', 'queued', 'done') then '["Purchase:40001", "Purchase:40002", "Purchase:40003"]'::jsonb else '[]'::jsonb end) then
      raise exception 'a % row in parts claims %', st, pg_temp.rq2_claims('v2-c1');
    end if;
  end loop;
  update public.receipt_qbo_links set detail = '{"note": "x"}' where receipt_id = 'v2-c1';
  if pg_temp.rq2_claims('v2-c1') is distinct from '["Purchase:40001", "Purchase:40002", "Purchase:40003"]' then
    raise exception 'a detail change moved the claims to %', pg_temp.rq2_claims('v2-c1');
  end if;
  -- the parts dropped, or another transaction: the claims follow
  update public.receipt_qbo_links set parts = null where receipt_id = 'v2-c1';
  if pg_temp.rq2_claims('v2-c1') is distinct from '["Purchase:40001"]' then
    raise exception 'a row whose parts were dropped claims %', pg_temp.rq2_claims('v2-c1');
  end if;
  update public.receipt_qbo_links set qbo_txn_id = '40009' where receipt_id = 'v2-c1';
  if pg_temp.rq2_claims('v2-c1') is distinct from '["Purchase:40009"]' then
    raise exception 'a row moved to another transaction claims %', pg_temp.rq2_claims('v2-c1');
  end if;
  -- the parts it let go are free
  insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id) values ('v2-c2', j, 'done', 'Purchase', '40003');
  if pg_temp.rq2_claims('v2-c2') is distinct from '["Purchase:40003"]' then
    raise exception 'a part let go could not be claimed again: %', pg_temp.rq2_claims('v2-c2');
  end if;
  delete from public.receipt_qbo_links where receipt_id in ('v2-c1', 'v2-c2', 'v2-c3');
  if exists (select 1 from public.receipt_qbo_claims where receipt_id in ('v2-c1', 'v2-c2', 'v2-c3')) then
    raise exception 'a deleted row still holds a claim';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;

-- the claims are the trigger's alone: the service role reads them and writes
-- nothing; a signed-in user reads nothing
savepoint s;
set local role service_role;
do $$
begin
  perform count(*) from public.receipt_qbo_claims;
  begin
    insert into public.receipt_qbo_claims (qbo_txn_type, qbo_txn_id, receipt_id) values ('Purchase', '1', 'v2-x');
    raise exception 'the service role wrote receipt_qbo_claims';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.receipt_qbo_claims;
    raise exception 'the service role deleted from receipt_qbo_claims';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  perform count(*) from public.receipt_qbo_claims;
  raise exception 'the owner, signed in, read receipt_qbo_claims';
exception when insufficient_privilege then
  null;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 4a. the note door, as the worker: parts and bills (job 6). Rolled back.
savepoint n;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  j   constant uuid := '00000000-0000-0000-0000-0000000025a6';
  pts constant jsonb := jsonb_build_array(
    jsonb_build_object('qbo_txn_id', '50601', 'qbo_sync_token', '0', 'qbo_total', 126.90, 'qbo_date', '2026-10-02'),
    jsonb_build_object('qbo_txn_id', '50602', 'qbo_sync_token', '0', 'qbo_total', 224.10, 'qbo_date', '2026-10-07'));
  n1  constant jsonb := jsonb_build_object(
    'receipt_id', 'v2-n1', 'job_id', j, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '50601',
    'qbo_sync_token', '0', 'qbo_customer_id', '7306', 'amount', 351.00, 'receipt_date', '2026-10-07',
    'detail', '{"qbo_total": 351.00}'::jsonb, 'parts', pts);
  -- an FNSB dump ticket the office entered as a bill, tagged, with the photo
  n2  constant jsonb := jsonb_build_object(
    'receipt_id', 'v2-n2', 'job_id', j, 'state', 'in_qbo', 'qbo_txn_type', 'Bill', 'qbo_txn_id', '50701',
    'qbo_sync_token', '3', 'qbo_customer_id', '7306', 'amount', 66.50, 'receipt_date', '2026-10-06',
    'detail', '{"qbo_doc_number": "1234567", "qbo_total": 66.50}'::jsonb);
  bad jsonb;
  r   jsonb;
  l   public.receipt_qbo_links;
begin
  -- refusals write nothing
  foreach bad in array array[
    -- three parts, one charge named twice
    n1 || jsonb_build_object('parts', pts || jsonb_build_array(pts -> 1)),
    -- the first part is not the row's own transaction, or not its SyncToken
    n1 || jsonb_build_object('parts', jsonb_build_array(pts -> 1, pts -> 0)),
    n1 || jsonb_build_object('parts', jsonb_build_array((pts -> 0) || '{"qbo_sync_token": "1"}', pts -> 1)),
    -- a bill in parts
    n2 || jsonb_build_object('parts', jsonb_build_array((pts -> 0) || '{"qbo_txn_id": "50701", "qbo_sync_token": "3"}', pts -> 1)),
    -- one part, four parts, not a list
    n1 || jsonb_build_object('parts', jsonb_build_array(pts -> 0)),
    n1 || jsonb_build_object('parts', pts || jsonb_build_array((pts -> 1) || '{"qbo_txn_id": "50603"}', (pts -> 1) || '{"qbo_txn_id": "50604"}')),
    n1 || jsonb_build_object('parts', pts -> 0),
    -- a part without its SyncToken, a part dated off the calendar's shape
    n1 || jsonb_build_object('parts', jsonb_build_array(pts -> 0, (pts -> 1) - 'qbo_sync_token')),
    n1 || jsonb_build_object('parts', jsonb_build_array(pts -> 0, (pts -> 1) || '{"qbo_date": "10/07/2026"}')),
    -- not a Purchase, a Bill or null
    n2 || '{"qbo_txn_type": "Invoice"}']
  loop
    begin
      perform public.receipt_qbo_links_note(array[j], jsonb_build_array(bad));
      raise exception 'the note door wrote %', bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  if exists (select 1 from public.receipt_qbo_links where job_id = j) then
    raise exception 'a refused note left a row behind';
  end if;

  -- a receipt in parts and a bill, both in QuickBooks: each claims all it holds
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1, n2));
  if r is distinct from '{"written": 2, "kept": 0, "removed": 0}' then raise exception 'the first note answered %', r; end if;
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n1';
  if l.state is distinct from 'in_qbo' or l.qbo_txn_type is distinct from 'Purchase' or l.qbo_txn_id is distinct from '50601'
     or l.qbo_sync_token is distinct from '0' or l.parts is distinct from pts or l.detail is distinct from '{"qbo_total": 351.00}' then
    raise exception 'the in_qbo row in parts is %', to_jsonb(l);
  end if;
  if pg_temp.rq2_claims('v2-n1') is distinct from '["Purchase:50601", "Purchase:50602"]' then
    raise exception 'the in_qbo row in parts claims %', pg_temp.rq2_claims('v2-n1');
  end if;
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n2';
  if l.state is distinct from 'in_qbo' or l.qbo_txn_type is distinct from 'Bill' or l.qbo_txn_id is distinct from '50701'
     or l.parts is not null or pg_temp.rq2_claims('v2-n2') is distinct from '["Bill:50701"]' then
    raise exception 'the bill''s row is % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-n2');
  end if;

  -- the same night again rewrites nothing
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1, n2));
  if r is distinct from '{"written": 0, "kept": 0, "removed": 0}' then raise exception 'an unchanged note in parts answered %', r; end if;

  -- another receipt "matched" the second charge: a conflict that claims
  -- nothing, and the charge stays v2-n1's
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1, n2, jsonb_build_object(
         'receipt_id', 'v2-n3', 'job_id', j, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '50602',
         'qbo_sync_token', '0', 'amount', 224.10, 'receipt_date', '2026-10-07', 'detail', '{}'::jsonb)));
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n3';
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' or l.state is distinct from 'conflict'
     or l.detail is distinct from '{"reason": "claimed_by_other"}' or l.qbo_txn_id is distinct from '50602'
     or pg_temp.rq2_claims('v2-n3') is distinct from '[]'
     or pg_temp.rq2_claims('v2-n1') is distinct from '["Purchase:50601", "Purchase:50602"]' then
    raise exception 'a claim on a held part answered % and wrote % (claims %, v2-n1 %)', r, to_jsonb(l),
      pg_temp.rq2_claims('v2-n3'), pg_temp.rq2_claims('v2-n1');
  end if;

  -- a row that leaves parts out keeps its own for the same transaction (a v1
  -- worker), through a write; v2-n3, no longer named, goes
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(
         (n1 - 'parts') || '{"detail": {"qbo_total": 351.00, "seen": 2}}', n2));
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n1';
  if r is distinct from '{"written": 1, "kept": 0, "removed": 1}' or l.parts is distinct from pts
     or l.detail is distinct from '{"qbo_total": 351.00, "seen": 2}'
     or pg_temp.rq2_claims('v2-n1') is distinct from '["Purchase:50601", "Purchase:50602"]' then
    raise exception 'a note without parts for the same transaction answered % and left % claiming %', r, to_jsonb(l), pg_temp.rq2_claims('v2-n1');
  end if;

  -- unmatched (the job lost its link) keeps the charges and holds none of them
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(
         n1 || '{"state": "unmatched", "detail": {"reason": "needs_job_link"}}', n2));
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n1';
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' or l.state is distinct from 'unmatched' or l.parts is distinct from pts
     or pg_temp.rq2_claims('v2-n1') is distinct from '[]' then
    raise exception 'an unmatched row in parts answered % and left % claiming %', r, to_jsonb(l), pg_temp.rq2_claims('v2-n1');
  end if;

  -- back in QuickBooks, then matched to one other expense with parts left
  -- out: the charges go, and only the new expense is held
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1, n2));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}'
     or pg_temp.rq2_claims('v2-n1') is distinct from '["Purchase:50601", "Purchase:50602"]' then
    raise exception 'putting the parts back answered % (claims %)', r, pg_temp.rq2_claims('v2-n1');
  end if;
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(
         (n1 - 'parts') || '{"qbo_txn_id": "50605", "qbo_sync_token": "4"}', n2));
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n1';
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' or l.qbo_txn_id is distinct from '50605' or l.parts is not null
     or pg_temp.rq2_claims('v2-n1') is distinct from '["Purchase:50605"]' then
    raise exception 'a note naming another transaction without parts answered % and left % claiming %', r, to_jsonb(l), pg_temp.rq2_claims('v2-n1');
  end if;

  -- parts: null clears them on the same transaction
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1, n2));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' or (select parts from public.receipt_qbo_links where receipt_id = 'v2-n1') is distinct from pts then
    raise exception 'the parts did not come back: %', r;
  end if;
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1 || '{"parts": null}', n2));
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-n1';
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' or l.qbo_txn_id is distinct from '50601' or l.parts is not null
     or pg_temp.rq2_claims('v2-n1') is distinct from '["Purchase:50601"]' then
    raise exception 'parts: null answered % and left % claiming %', r, to_jsonb(l), pg_temp.rq2_claims('v2-n1');
  end if;

  -- the receipt left the job: its row and every claim go, and a charge it
  -- held is free for another receipt the same night
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n1, n2));
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(n2, jsonb_build_object(
         'receipt_id', 'v2-n3', 'job_id', j, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '50602',
         'qbo_sync_token', '0', 'amount', 224.10, 'receipt_date', '2026-10-07', 'detail', '{}'::jsonb)));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 1}'
     or exists (select 1 from public.receipt_qbo_links where receipt_id = 'v2-n1')
     or pg_temp.rq2_claims('v2-n1') is distinct from '[]'
     or (select state from public.receipt_qbo_links where receipt_id = 'v2-n3') is distinct from 'in_qbo'
     or pg_temp.rq2_claims('v2-n3') is distinct from '["Purchase:50602"]' then
    raise exception 'a receipt in parts that left the job answered % (v2-n1 claims %, v2-n3 claims %)', r,
      pg_temp.rq2_claims('v2-n1'), pg_temp.rq2_claims('v2-n3');
  end if;
end
$$;
rollback to savepoint n;
release savepoint n;
reset role;

-- 4b. the note door and the approval path's rows (job 4): a failed row it is
--     sent is replaced, one it is not sent is never removed or changed;
--     queued and done are kept. Written past the doors first. Rolled back.
savepoint n;
insert into public.receipt_qbo_links
  (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id, amount, receipt_date,
   changes, proposal_id, outbox_id, detail, parts)
values
  ('v2-nf1', '00000000-0000-0000-0000-0000000025a4', 'failed', 'Purchase', '50101', '2', '7304', 351.00, '2026-10-07',
   '{tag,attach}', gen_random_uuid(), gen_random_uuid(),
   '{"error": "qbo_unavailable: QuickBooks answered 503", "failed_at": "2026-10-09T15:00:00Z", "vendor": "Rental Zone", "refiled_proposal_id": "00000000-0000-0000-0000-0000000025e1"}',
   '[{"qbo_txn_id": "50101", "qbo_sync_token": "2", "qbo_total": 126.90, "qbo_date": "2026-10-02"}, {"qbo_txn_id": "50102", "qbo_sync_token": "5", "qbo_total": 224.10, "qbo_date": "2026-10-07"}]'),
  ('v2-nf2', '00000000-0000-0000-0000-0000000025a4', 'failed', 'Purchase', '50201', '0', '7304', 20.00, '2026-10-01',
   '{tag}', gen_random_uuid(), gen_random_uuid(), '{"error": "tagged_other: the expense is tagged to Pollen Apartments", "failed_at": "2026-10-09T15:00:00Z"}', null),
  ('v2-nf3', '00000000-0000-0000-0000-0000000025a4', 'failed', 'Purchase', '50301', '0', '7304', 30.00, '2026-10-01',
   '{attach}', gen_random_uuid(), gen_random_uuid(), '{"error": "qbo_unavailable: QuickBooks answered 503", "failed_at": "2026-10-09T15:00:00Z"}', null),
  ('v2-nq', '00000000-0000-0000-0000-0000000025a4', 'queued', 'Purchase', '50401', '0', '7304', 40.00, '2026-10-01',
   '{tag}', gen_random_uuid(), gen_random_uuid(), '{}', null),
  ('v2-nd', '00000000-0000-0000-0000-0000000025a4', 'done', 'Purchase', '50501', '1', '7304', 50.00, '2026-10-01',
   '{tag}', gen_random_uuid(), gen_random_uuid(), '{"provider_id": "Purchase:50501:1"}',
   '[{"qbo_txn_id": "50501", "qbo_sync_token": "1", "qbo_total": 25.00, "qbo_date": "2026-10-01"}, {"qbo_txn_id": "50502", "qbo_sync_token": "1", "qbo_total": 25.00, "qbo_date": "2026-10-01"}]');
insert into rq2 select 'before:' || receipt_id, to_jsonb(l)::text from public.receipt_qbo_links l
 where job_id = '00000000-0000-0000-0000-0000000025a4';
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  j   constant uuid := '00000000-0000-0000-0000-0000000025a4';
  pts constant jsonb := jsonb_build_array(
    jsonb_build_object('qbo_txn_id', '50101', 'qbo_sync_token', '3', 'qbo_total', 126.90, 'qbo_date', '2026-10-02'),
    jsonb_build_object('qbo_txn_id', '50102', 'qbo_sync_token', '6', 'qbo_total', 224.10, 'qbo_date', '2026-10-07'));
  r   jsonb;
  l   public.receipt_qbo_links;
  rid text;
begin
  if pg_temp.rq2_claims('v2-nf1') is distinct from '[]' or pg_temp.rq2_claims('v2-nq') is distinct from '["Purchase:50401"]'
     or pg_temp.rq2_claims('v2-nd') is distinct from '["Purchase:50501", "Purchase:50502"]' then
    raise exception 'the approval path''s rows claim % / % / %', pg_temp.rq2_claims('v2-nf1'), pg_temp.rq2_claims('v2-nq'), pg_temp.rq2_claims('v2-nd');
  end if;

  -- tonight: v2-nf1's second try found both charges tagged by hand (in_qbo,
  -- in parts); v2-nf3's found the charge v2-nf1 holds (a conflict); the
  -- queued and done rows are sent as unmatched; v2-nf2 is not sent
  r := public.receipt_qbo_links_note(array[j], jsonb_build_array(
         jsonb_build_object('receipt_id', 'v2-nf1', 'job_id', j, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase',
                            'qbo_txn_id', '50101', 'qbo_sync_token', '3', 'qbo_customer_id', '7304', 'amount', 351.00,
                            'receipt_date', '2026-10-07', 'detail', '{"qbo_total": 351.00}'::jsonb, 'parts', pts),
         jsonb_build_object('receipt_id', 'v2-nf3', 'job_id', j, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase',
                            'qbo_txn_id', '50102', 'qbo_sync_token', '6', 'amount', 30.00, 'receipt_date', '2026-10-01',
                            'detail', '{}'::jsonb),
         jsonb_build_object('receipt_id', 'v2-nq', 'job_id', j, 'state', 'unmatched', 'detail', '{"reason": "not_found"}'::jsonb),
         jsonb_build_object('receipt_id', 'v2-nd', 'job_id', j, 'state', 'unmatched', 'detail', '{"reason": "not_found"}'::jsonb)));
  if r is distinct from '{"written": 2, "kept": 2, "removed": 0}' then
    raise exception 'a note over the approval path''s rows answered %, not the two failed rows written and queued and done kept', r;
  end if;

  -- the failed row it was sent: replaced, nothing of the approval left
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-nf1';
  if l.state is distinct from 'in_qbo' or l.qbo_txn_id is distinct from '50101' or l.qbo_sync_token is distinct from '3'
     or l.changes is distinct from '{}' or l.proposal_id is not null or l.outbox_id is not null
     or l.detail is distinct from '{"qbo_total": 351.00}' or l.parts is distinct from pts
     or pg_temp.rq2_claims('v2-nf1') is distinct from '["Purchase:50101", "Purchase:50102"]' then
    raise exception 'the failed row the note door was sent is % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-nf1');
  end if;
  -- the failed row it was sent, on a charge another receipt holds: a
  -- conflict, nothing of the approval left, holding nothing
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-nf3';
  if l.state is distinct from 'conflict' or l.qbo_txn_id is distinct from '50102' or l.changes is distinct from '{}'
     or l.proposal_id is not null or l.outbox_id is not null or l.detail is distinct from '{"reason": "claimed_by_other"}'
     or pg_temp.rq2_claims('v2-nf3') is distinct from '[]' then
    raise exception 'the failed row sent with a held charge is % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-nf3');
  end if;
  -- the failed row it was not sent, the queued and the done row: as they were
  foreach rid in array array['v2-nf2', 'v2-nq', 'v2-nd'] loop
    if (select to_jsonb(x) from public.receipt_qbo_links x where x.receipt_id = rid)
       is distinct from (select v::jsonb from rq2 where rq2.k = 'before:' || rid) then
      raise exception 'the note door changed % to %', rid, (select to_jsonb(x) from public.receipt_qbo_links x where x.receipt_id = rid);
    end if;
  end loop;

  -- a night that names none of them: the noted rows go, the failed row it is
  -- not sent stays, and so do queued and done
  r := public.receipt_qbo_links_note(array[j], '[]');
  if r is distinct from '{"written": 0, "kept": 0, "removed": 2}'
     or exists (select 1 from public.receipt_qbo_links where receipt_id in ('v2-nf1', 'v2-nf3')) then
    raise exception 'a note naming nothing answered %', r;
  end if;
  foreach rid in array array['v2-nf2', 'v2-nq', 'v2-nd'] loop
    if (select to_jsonb(x) from public.receipt_qbo_links x where x.receipt_id = rid)
       is distinct from (select v::jsonb from rq2 where rq2.k = 'before:' || rid) then
      raise exception 'a note naming nothing changed or removed %: %', rid, (select to_jsonb(x) from public.receipt_qbo_links x where x.receipt_id = rid);
    end if;
  end loop;
end
$$;
rollback to savepoint n;
release savepoint n;
reset role;


-- 5a. the Rental Zone receipt in two charges: filed by the worker, approved
--     by the owner; one link row with both charges, one outbox row
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  r jsonb := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a1',
               (select v::jsonb from rq2 where k = 'input_1')
               || jsonb_build_object('items', jsonb_build_array((select v::jsonb from rq2 where k = 'item_rz'))),
               '1 receipt on Chena Landings was paid in two card charges that have no job tag.', '[]');
begin
  if r -> 'filed' is distinct from 'true' then raise exception 'the split card answered %', r; end if;
  insert into rq2 values ('pa', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'pa'), 'inbox');
begin
  if p.status is distinct from 'executed' then
    raise exception 'the split card''s approval left it % (error %)', p.status, p.error;
  end if;
end
$$;
release savepoint s;
reset role;
do $$
declare
  j1    constant uuid := '00000000-0000-0000-0000-0000000025a1';
  owner constant uuid := '00000000-0000-0000-0000-0000000025f1';
  pa    uuid := (select v::uuid from rq2 where k = 'pa');
  photo constant text := 'media:' || repeat('a', 64) || ':351';
  p     public.proposals;
  l     public.receipt_qbo_links;
  o     public.outbox;
begin
  select * into p from public.proposals where id = pa;
  select * into o from public.outbox where proposal_id = pa;
  if p.result is distinct from jsonb_build_object('queued', 1, 'skipped', 0, 'outbox_ids', jsonb_build_array(o.id))
     or (select count(*) from public.outbox where proposal_id = pa) is distinct from 1 then
    raise exception 'the split card''s executor answered %', p.result;
  end if;

  select * into l from public.receipt_qbo_links where receipt_id = 'v2-rz';
  if l.state is distinct from 'queued' or l.job_id is distinct from j1 or l.qbo_txn_type is distinct from 'Purchase'
     or l.qbo_txn_id is distinct from '10615' or l.qbo_sync_token is distinct from '0' or l.qbo_customer_id is distinct from '7301'
     or l.amount is distinct from 351.00 or l.receipt_date is distinct from '2026-10-07' or l.changes is distinct from '{tag,attach}'
     or l.proposal_id is distinct from pa or l.outbox_id is distinct from o.id then
    raise exception 'v2-rz''s link row is %', to_jsonb(l);
  end if;
  -- every charge, four keys each, in order
  if l.parts is distinct from jsonb_build_array(
       jsonb_build_object('qbo_txn_id', '10615', 'qbo_sync_token', '0', 'qbo_total', 126.90, 'qbo_date', '2026-10-02'),
       jsonb_build_object('qbo_txn_id', '10661', 'qbo_sync_token', '0', 'qbo_total', 224.10, 'qbo_date', '2026-10-07')) then
    raise exception 'v2-rz''s link row keeps parts %', l.parts;
  end if;
  -- the photo as the worker read it; no refile on a first try
  if l.detail is distinct from jsonb_build_object('vendor', 'Rental Zone', 'receipt_no', 'RZ 40213',
       'qbo_account_name', '1658 - Chase Ink Business', 'qbo_total', 126.90, 'read_photo_ref', photo) then
    raise exception 'v2-rz''s link row detail is %', l.detail;
  end if;
  if pg_temp.rq2_claims('v2-rz') is distinct from '["Purchase:10615", "Purchase:10661"]' then
    raise exception 'the queued receipt in parts claims %', pg_temp.rq2_claims('v2-rz');
  end if;

  if o.channel is distinct from 'qbo' or o.status is distinct from 'pending' or o.operation is distinct from 'receipts.qbo_link@1'
     or o.job_id is distinct from j1 or o.principal_kind is distinct from 'human' or o.principal_id is distinct from owner
     or o.idempotency_key is distinct from 'outbox:' || p.idempotency_key || ':v2-rz' then
    raise exception 'the split card''s outbox row is %', to_jsonb(o) - 'payload';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(o.payload) k)
     is distinct from array['changes', 'customer_id', 'expect_sync_token', 'expect_total', 'file_base', 'job_id', 'parts',
              'photo_refs', 'project_ref', 'proposal_id', 'qbo_txn_id', 'qbo_txn_type', 'receipt_id'] then
    raise exception 'the split outbox payload carries %', (select array_agg(k order by k collate "C") from jsonb_object_keys(o.payload) k);
  end if;
  -- no transaction at the top (a qbo-proxy older than parts refuses the
  -- empty id rather than tag one charge); each charge as completePurchase
  -- checks one, in card order
  if o.payload is distinct from jsonb_build_object(
       'receipt_id', 'v2-rz', 'job_id', j1, 'proposal_id', pa, 'qbo_txn_type', 'Purchase',
       'qbo_txn_id', '', 'expect_sync_token', '', 'expect_total', null,
       'changes', '["tag", "attach"]'::jsonb, 'customer_id', '7301', 'project_ref', '415000001',
       'photo_refs', jsonb_build_array(photo), 'file_base', 'Rental Zone 2026-10-07 RZ-40213',
       'parts', jsonb_build_array(
         jsonb_build_object('qbo_txn_id', '10615', 'expect_sync_token', '0', 'expect_total', 126.90, 'changes', '["tag", "attach"]'::jsonb),
         jsonb_build_object('qbo_txn_id', '10661', 'expect_sync_token', '0', 'expect_total', 224.10, 'changes', '["tag"]'::jsonb))) then
    raise exception 'the split outbox payload is %', o.payload;
  end if;
  if o.payload -> 'expect_total' is distinct from 'null'::jsonb then
    raise exception 'the split payload''s expect_total is %, not null', o.payload -> 'expect_total';
  end if;
  if not exists (select 1 from public.events
                  where kind = 'receipts.qbo_link_queued' and proposal_id = pa and principal_id = owner
                    and data = '{"count": 1, "total_usd": 351.00}') then
    raise exception 'no receipts.qbo_link_queued event counting the receipt once at $351.00';
  end if;
end
$$;


-- 5b. malformed items: one card, every fault named, nothing written
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  base jsonb := jsonb_build_object(
    'vendor', 'Rental Zone', 'date', '2026-10-01', 'amount', 100.00, 'qbo_txn_type', 'Purchase', 'qbo_sync_token', '0',
    'qbo_total', 40.00, 'changes', '["tag"]'::jsonb, 'photo_refs', '[]'::jsonb, 'project_ref', '415000001', 'read_photo_ref', null);
  t jsonb := '["tag"]';
  items jsonb;
  r jsonb;
begin
  items := jsonb_build_array(
    -- 1: the charges add up to 90.00, not 100.00
    base || jsonb_build_object('receipt_id', 'v2-b1', 'qbo_txn_id', '11001', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11001', 40.00, t), pg_temp.rq2_part('11002', 50.00, t))),
    -- 2: the first part is not the item's charge
    base || jsonb_build_object('receipt_id', 'v2-b2', 'qbo_txn_id', '11011', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11012', 60.00, t), pg_temp.rq2_part('11011', 40.00, t))),
    -- 3: a part asks to attach; the item does not
    base || jsonb_build_object('receipt_id', 'v2-b3', 'qbo_txn_id', '11021', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11021', 40.00, t), pg_temp.rq2_part('11022', 60.00, '["tag", "attach"]'))),
    -- 4: the item attaches; no part does
    base || jsonb_build_object('receipt_id', 'v2-b4', 'qbo_txn_id', '11031', 'changes', '["tag", "attach"]'::jsonb,
      'photo_refs', jsonb_build_array('media:' || repeat('e', 64) || ':1'), 'parts', jsonb_build_array(
      pg_temp.rq2_part('11031', 40.00, t), pg_temp.rq2_part('11032', 60.00, t))),
    -- 5: a bill (only ever noted)
    base || jsonb_build_object('receipt_id', 'v2-b5', 'qbo_txn_type', 'Bill', 'qbo_txn_id', '11041'),
    -- 6, 7: one part, four parts
    base || jsonb_build_object('receipt_id', 'v2-b6', 'qbo_txn_id', '11051', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11051', 100.00, t))),
    base || jsonb_build_object('receipt_id', 'v2-b7', 'qbo_txn_id', '11061', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11061', 25.00, t), pg_temp.rq2_part('11062', 25.00, t),
      pg_temp.rq2_part('11063', 25.00, t), pg_temp.rq2_part('11064', 25.00, t))),
    -- 8: a refile whose proposal is not a uuid
    base || jsonb_build_object('receipt_id', 'v2-b8', 'qbo_txn_id', '11071',
      'refile', '{"proposal_id": "not-a-uuid", "error": "qbo_refused"}'::jsonb),
    -- 9: a new expense in parts
    base || jsonb_build_object('receipt_id', 'v2-b9', 'qbo_txn_id', '', 'qbo_sync_token', '', 'qbo_total', null,
      'changes', '["create"]'::jsonb, 'create', jsonb_build_object(
        'account_id', '53', 'vendor_id', '65', 'payment_type', 'CreditCard', 'credit', false, 'doc_number', '700630999',
        'expense_account_id', '42', 'class_id', null, 'txn_date', '2026-10-01', 'amount_abs', 100.00, 'memo', null),
      'parts', jsonb_build_array(pg_temp.rq2_part('11081', 40.00, t), pg_temp.rq2_part('11082', 60.00, t))),
    -- 10: a bill in parts
    base || jsonb_build_object('receipt_id', 'v2-b10', 'qbo_txn_type', 'Bill', 'qbo_txn_id', '11091', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11091', 40.00, t), pg_temp.rq2_part('11092', 60.00, t))),
    -- 11: a refile that is not an object
    base || jsonb_build_object('receipt_id', 'v2-b11', 'qbo_txn_id', '11101', 'refile', '"qbo_refused"'::jsonb),
    -- 12: three parts, one charge named twice
    base || jsonb_build_object('receipt_id', 'v2-b12', 'qbo_txn_id', '11111', 'parts', jsonb_build_array(
      pg_temp.rq2_part('11111', 40.00, t), pg_temp.rq2_part('11112', 30.00, t), pg_temp.rq2_part('11112', 30.00, t))),
    -- 13: a refile code longer than 60 characters
    base || jsonb_build_object('receipt_id', 'v2-b13', 'qbo_txn_id', '11121',
      'refile', jsonb_build_object('proposal_id', null, 'error', repeat('x', 61))));
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a1',
         (select v::jsonb from rq2 where k = 'input_1') || jsonb_build_object('items', items, 'total_usd', 1300), 'malformed', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the malformed card answered %', r; end if;
  insert into rq2 values ('pbad', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p    public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'pbad'), 'inbox');
  want text;
  missing text[] := '{}';
begin
  if p.status is distinct from 'failed' or coalesce(p.error, '') not like 'receipts.qbo_link: the card''s items are invalid: %' then
    raise exception 'the malformed card left % (error %)', p.status, p.error;
  end if;
  foreach want in array array[
    'item 1 parts add up to 90.00, not the receipt''s 100.00',
    'item 2 first part must be the charge the item names',
    'item 3 part 2 changes must be tag and/or attach, from the item''s changes, without repeats',
    'item 4 asks for a change no part asks for',
    'item 5 qbo_txn_type must be Purchase',
    'item 6 parts must list 2 or 3 charges',
    'item 7 parts must list 2 or 3 charges',
    'item 8 refile must be {proposal_id: a uuid or null, error: text of at most 60 characters, why: text of at most 200}',
    'item 9 comes in parts, which only card charges (Purchase, never entered) do',
    'item 10 qbo_txn_type must be Purchase',
    'item 10 comes in parts, which only card charges (Purchase, never entered) do',
    'item 11 refile must be {',
    'item 12 names charge 11112 twice',
    'item 13 refile must be {']
  loop
    if strpos(p.error, want) = 0 then
      missing := missing || want;
    end if;
  end loop;
  if array_length(missing, 1) is not null then
    raise exception 'the malformed card''s error does not say: %. It says: %', array_to_string(missing, ' | '), p.error;
  end if;
  -- the well-formed halves of the faulty items raised nothing of their own
  if p.error ~ 'item (2|3|4|6|7|8|11|12|13) parts add up' or p.error ~ 'item (1|2|3|4|6|7|8|9|11|12|13) qbo_txn_type'
     or p.error ~ 'item 9 (qbo_txn_id|qbo_sync_token|create)' then
    raise exception 'the malformed card names a fault that is not there: %', p.error;
  end if;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from public.outbox where proposal_id = (select v::uuid from rq2 where k = 'pbad'))
     or exists (select 1 from public.receipt_qbo_links where receipt_id like 'v2-b%')
     or exists (select 1 from public.receipt_qbo_claims where receipt_id like 'v2-b%')
     or exists (select 1 from public.events where proposal_id = (select v::uuid from rq2 where k = 'pbad')
                                               and kind = 'receipts.qbo_link_queued') then
    raise exception 'a refused card wrote something';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

-- 5c. a charge another receipt holds: refused in words that name the part
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  photo constant text := 'media:' || repeat('b', 64) || ':80';
  r jsonb;
begin
  -- another receipt, on another job, is in QuickBooks as the second charge
  r := public.receipt_qbo_links_note(array['00000000-0000-0000-0000-0000000025a6'::uuid], jsonb_build_array(jsonb_build_object(
         'receipt_id', 'v2-hold', 'job_id', '00000000-0000-0000-0000-0000000025a6', 'state', 'in_qbo', 'qbo_txn_type', 'Purchase',
         'qbo_txn_id', '10701', 'qbo_sync_token', '0', 'qbo_customer_id', '7306', 'amount', 50.00, 'receipt_date', '2026-10-03',
         'detail', '{}'::jsonb)));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' then raise exception 'the holder''s note answered %', r; end if;
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a1',
         (select v::jsonb from rq2 where k = 'input_1') || jsonb_build_object('total_usd', 80.00, 'items', jsonb_build_array(jsonb_build_object(
           'receipt_id', 'v2-rx', 'vendor', 'Rental Zone', 'date', '2026-10-03', 'amount', 80.00, 'receipt_no', null,
           'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10700', 'qbo_sync_token', '0', 'qbo_total', 30.00,
           'changes', '["tag", "attach"]'::jsonb, 'photo_refs', jsonb_build_array(photo), 'project_ref', '415000001',
           'read_photo_ref', photo, 'parts', jsonb_build_array(
             pg_temp.rq2_part('10700', 30.00, '["tag", "attach"]', '2026-10-01'),
             pg_temp.rq2_part('10701', 50.00, '["tag", "attach"]', '2026-10-03'))))),
         'held', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the held card answered %', r; end if;
  insert into rq2 values ('pheld', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'pheld'), 'inbox');
begin
  if p.status is distinct from 'failed'
     or p.error is distinct from 'receipts.qbo_link: QuickBooks Purchase 10701 (part 2 of 2) is already matched to receipt v2-hold, so nothing was queued' then
    raise exception 'a card with a held charge left % (error %)', p.status, p.error;
  end if;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from public.outbox where proposal_id = (select v::uuid from rq2 where k = 'pheld'))
     or exists (select 1 from public.receipt_qbo_links where receipt_id = 'v2-rx')
     or exists (select 1 from public.receipt_qbo_claims where qbo_txn_id = '10700')
     or pg_temp.rq2_claims('v2-hold') is distinct from '["Purchase:10701"]' then
    raise exception 'a card refused on a held charge wrote something';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

-- 5d. v2-rz is queued: a later card with the same charges is skipped, one
--     with another charge fails. Undone afterwards.
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  item jsonb := (select v::jsonb from rq2 where k = 'item_rz');
  r    jsonb;
begin
  -- the same two charges, tag only, the second already complete (no
  -- changes: only checked, which the executor accepts)
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a1',
         (select v::jsonb from rq2 where k = 'input_1') || jsonb_build_object('items', jsonb_build_array(
           item || jsonb_build_object('changes', '["tag"]'::jsonb, 'photo_refs', '[]'::jsonb, 'parts', jsonb_build_array(
             (item #> '{parts,0}') || '{"changes": ["tag"]}', (item #> '{parts,1}') || '{"changes": []}')))),
         'same charges', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'a later card with the same charges answered %', r; end if;
  insert into rq2 values ('psame', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'psame'), 'inbox');
begin
  if p.status is distinct from 'executed' or p.result is distinct from '{"queued": 0, "skipped": 1, "outbox_ids": []}' then
    raise exception 'a card naming the same charges of a queued receipt left % with %', p.status, coalesce(p.error, p.result::text);
  end if;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from public.outbox where proposal_id = (select v::uuid from rq2 where k = 'psame'))
     or (select proposal_id from public.receipt_qbo_links where receipt_id = 'v2-rz') is distinct from (select v::uuid from rq2 where k = 'pa') then
    raise exception 'a skipped receipt in parts was queued again';
  end if;
end
$$;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  item jsonb := (select v::jsonb from rq2 where k = 'item_rz');
  r    jsonb;
begin
  -- the balance matched to another charge of the same amount
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a1',
         (select v::jsonb from rq2 where k = 'input_1') || jsonb_build_object('items', jsonb_build_array(
           jsonb_set(item, '{parts,1,qbo_txn_id}', '"10662"'))), 'other charge', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'a later card with another charge answered %', r; end if;
  insert into rq2 values ('pother', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'pother'), 'inbox');
begin
  if p.status is distinct from 'failed'
     or p.error is distinct from 'receipts.qbo_link: receipt v2-rz is already queued with QuickBooks Purchase 10615, so nothing was queued' then
    raise exception 'a card naming other charges of a queued receipt left % (error %)', p.status, p.error;
  end if;
end
$$;
reset role;
do $$
begin
  if exists (select 1 from public.outbox where proposal_id = (select v::uuid from rq2 where k = 'pother'))
     or exists (select 1 from public.receipt_qbo_claims where qbo_txn_id = '10662')
     or pg_temp.rq2_claims('v2-rz') is distinct from '["Purchase:10615", "Purchase:10661"]'
     or (select proposal_id from public.receipt_qbo_links where receipt_id = 'v2-rz') is distinct from (select v::uuid from rq2 where k = 'pa') then
    raise exception 'a refused card over a queued receipt in parts wrote something';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 6a. a card that lost a lock race (deadlock detected) is offered again
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  photo constant text := 'media:' || repeat('c', 64) || ':19';
  v_in  jsonb := jsonb_build_object(
    'job_id', '00000000-0000-0000-0000-0000000025a3', 'job_name', 'Deadlock job', 'qbo_customer_id', '7303',
    'qbo_name', 'Deadlock job', 'total_usd', 19.99, 'matcher', 'receipts.qbo_match@1',
    'items', jsonb_build_array(jsonb_build_object(
      'receipt_id', 'v2-dl', 'vendor', 'Home Depot', 'date', '2026-10-05', 'amount', 19.99,
      'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10640', 'qbo_sync_token', '0', 'qbo_total', 19.99,
      'changes', '["tag", "attach"]'::jsonb, 'photo_refs', jsonb_build_array(photo), 'project_ref', null,
      'read_photo_ref', photo)));
  r jsonb;
begin
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a3', v_in, 'd', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the deadlock job''s card answered %', r; end if;
  insert into rq2 values ('pdl', r ->> 'proposal_id');
  insert into rq2 values ('input_dl', v_in::text);
end
$$;
reset role;
-- what an approval leaves when the executor dies in a deadlock (op_execute
-- keeps the message only)
update public.proposals
   set status = 'failed', error = 'deadlock detected', approved_by_kind = 'human',
       approved_by_ref = '00000000-0000-0000-0000-0000000025f1', approved_via = 'inbox', approved_at = now()
 where id = (select v::uuid from rq2 where k = 'pdl');
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  pdl uuid := (select v::uuid from rq2 where k = 'pdl');
  r   jsonb := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a3', (select v::jsonb from rq2 where k = 'input_dl'), 'd', '[]');
begin
  if r -> 'filed' is distinct from 'true' or r ->> 'proposal_id' is not distinct from pdl::text
     or (select input -> 'offer' from public.proposals where id = (r ->> 'proposal_id')::uuid) is distinct from '1' then
    raise exception 'a card that lost a lock race was not offered again as offer 1: %', r;
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 6b. THE SECOND TRY. v2-sw (no photo: read_photo_ref null) is queued by
--     the owner, and QuickBooks refuses it for good: the row is failed.
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  item jsonb := jsonb_build_object(
    'receipt_id', 'v2-sw', 'vendor', 'Home Depot', 'date', '2026-10-04', 'amount', 45.06, 'receipt_no', null,
    'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10630', 'qbo_sync_token', '0', 'qbo_doc_number', null,
    'qbo_account_name', '3176 - Citi - Home Depot Consumer Credit Card', 'qbo_total', 45.06,
    'changes', '["tag"]'::jsonb, 'photo_refs', '[]'::jsonb, 'project_ref', '415000002', 'read_photo_ref', null);
  v_in jsonb := jsonb_build_object(
    'job_id', '00000000-0000-0000-0000-0000000025a2', 'job_name', 'Second try job', 'qbo_customer_id', '7302',
    'qbo_name', 'Second try job', 'total_usd', 45.06, 'matcher', 'receipts.qbo_match@1');
  r jsonb;
begin
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2', v_in || jsonb_build_object('items', jsonb_build_array(item)), 'first', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'v2-sw''s first card answered %', r; end if;
  insert into rq2 values ('p0', r ->> 'proposal_id');
  insert into rq2 values ('item_sw', item::text);
  insert into rq2 values ('input_2', v_in::text);
end
$$;
release savepoint s;
reset role;
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'p0'), 'inbox');
begin
  if p.status is distinct from 'executed' then raise exception 'v2-sw''s first card left % (error %)', p.status, p.error; end if;
end
$$;
release savepoint s;
reset role;
do $$
declare
  l public.receipt_qbo_links;
  o public.outbox;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-sw';
  select * into o from public.outbox where id = l.outbox_id;
  -- the photo the worker read was none: recorded as null, not left out
  if l.state is distinct from 'queued' or l.parts is not null or not (l.detail ? 'read_photo_ref')
     or l.detail -> 'read_photo_ref' is distinct from 'null'::jsonb or l.detail ? 'refile' then
    raise exception 'v2-sw''s queued row is %', to_jsonb(l);
  end if;
  -- one transaction: 0023's payload, key for key
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(o.payload) k)
     is distinct from array['changes', 'customer_id', 'expect_sync_token', 'expect_total', 'file_base', 'job_id', 'photo_refs',
              'project_ref', 'proposal_id', 'qbo_txn_id', 'qbo_txn_type', 'receipt_id']
     or o.payload ->> 'qbo_txn_id' is distinct from '10630' or o.payload ->> 'expect_sync_token' is distinct from '0'
     or o.payload -> 'expect_total' is distinct from '45.06' then
    raise exception 'v2-sw''s payload is %', o.payload;
  end if;
  update public.outbox set status = 'sending', locked_by = 'rq2-test-worker', lease_until = now() + interval '2 minutes',
                           attempts = attempts + 1
   where id = o.id;
end
$$;
savepoint s;
set local role service_role;
select public.outbox_failed((select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-sw'), 'rq2-test-worker',
                            'qbo_unavailable: QuickBooks answered 503 three times', true) \g /dev/null
release savepoint s;
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-sw';
  if l.state is distinct from 'failed' or l.proposal_id is distinct from (select v::uuid from rq2 where k = 'p0')
     or l.detail ->> 'error' is distinct from 'qbo_unavailable: QuickBooks answered 503 three times' or l.detail ->> 'failed_at' is null
     or pg_temp.rq2_claims('v2-sw') is distinct from '[]' then
    raise exception 'a dead row left v2-sw as % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-sw');
  end if;
end
$$;

-- 6c. the worker re-files it as a second try: the failed row names the new
--     card; the same filing again (card open) keeps it there, and stamps it
--     there again if the stamp is gone
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  p0   uuid := (select v::uuid from rq2 where k = 'p0');
  v_in jsonb := (select v::jsonb from rq2 where k = 'input_2') || jsonb_build_object('items', jsonb_build_array(
                  (select v::jsonb from rq2 where k = 'item_sw')
                  || jsonb_build_object('refile', jsonb_build_object('proposal_id', p0, 'error', 'qbo_unavailable',
                                                                     'why', 'QuickBooks answered 503 three times'))));
  r    jsonb;
  p1   uuid;
  l    public.receipt_qbo_links;
begin
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2', v_in, 'second try', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the second try answered %', r; end if;
  p1 := (r ->> 'proposal_id')::uuid;
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-sw';
  if l.state is distinct from 'failed' or l.detail ->> 'refiled_proposal_id' is distinct from p1::text
     or l.detail ->> 'error' is distinct from 'qbo_unavailable: QuickBooks answered 503 three times' or l.proposal_id is distinct from p0 then
    raise exception 'the failed row of a second try is %', to_jsonb(l);
  end if;

  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2', v_in, 'again', '[]');
  if r is distinct from jsonb_build_object('filed', false, 'proposal_id', p1, 'status', 'proposed', 'superseded', 0)
     or (select detail ->> 'refiled_proposal_id' from public.receipt_qbo_links where receipt_id = 'v2-sw') is distinct from p1::text then
    raise exception 'the same second try again answered % (stamp %)', r,
      (select detail ->> 'refiled_proposal_id' from public.receipt_qbo_links where receipt_id = 'v2-sw');
  end if;
  insert into rq2 values ('p1', p1::text);
  insert into rq2 values ('input_2b', v_in::text);
end
$$;
reset role;
update public.receipt_qbo_links set detail = detail - 'refiled_proposal_id' where receipt_id = 'v2-sw';
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  p1 uuid := (select v::uuid from rq2 where k = 'p1');
  r  jsonb := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2', (select v::jsonb from rq2 where k = 'input_2b'), 'again', '[]');
begin
  if r ->> 'proposal_id' is distinct from p1::text or r ->> 'status' is distinct from 'proposed'
     or (select detail ->> 'refiled_proposal_id' from public.receipt_qbo_links where receipt_id = 'v2-sw') is distinct from p1::text then
    raise exception 'a second try on an open card did not stamp that card: % (stamp %)', r,
      (select detail ->> 'refiled_proposal_id' from public.receipt_qbo_links where receipt_id = 'v2-sw');
  end if;
end
$$;
release savepoint s;
reset role;

-- 6d. the owner declines the second try: the same items again stay quiet,
--     and the stamp names the declined card. Undone afterwards.
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_decline((select v::uuid from rq2 where k = 'p1'), 'it is a duplicate charge');
begin
  if p.status is distinct from 'declined' then raise exception 'the decline left the card %', p.status; end if;
end
$$;
reset role;
update public.receipt_qbo_links set detail = detail - 'refiled_proposal_id' where receipt_id = 'v2-sw';
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  p1 uuid := (select v::uuid from rq2 where k = 'p1');
  r  jsonb := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2', (select v::jsonb from rq2 where k = 'input_2b'), 'again', '[]');
begin
  if r is distinct from jsonb_build_object('filed', false, 'proposal_id', p1, 'status', 'declined', 'superseded', 0)
     or (select detail ->> 'refiled_proposal_id' from public.receipt_qbo_links where receipt_id = 'v2-sw') is distinct from p1::text then
    raise exception 'a declined second try filed again answered % (stamp %)', r,
      (select detail ->> 'refiled_proposal_id' from public.receipt_qbo_links where receipt_id = 'v2-sw');
  end if;
  if exists (select 1 from public.proposals where job_id = '00000000-0000-0000-0000-0000000025a2' and status = 'proposed') then
    raise exception 'a declined second try was filed again';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

-- 6e. a refile naming another card (not the failed row's own) stamps
--     nothing. Undone afterwards.
savepoint s;
update public.receipt_qbo_links set detail = detail - 'refiled_proposal_id' where receipt_id = 'v2-sw';
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  r jsonb := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2',
               (select v::jsonb from rq2 where k = 'input_2') || jsonb_build_object('items', jsonb_build_array(
                 (select v::jsonb from rq2 where k = 'item_sw')
                 || jsonb_build_object('refile', jsonb_build_object('proposal_id', '00000000-0000-0000-0000-0000000025e9',
                                                                    'error', 'qbo_unavailable')))),
               'another card''s try', '[]');
begin
  if r -> 'filed' is distinct from 'true' then raise exception 'a refile naming another card answered %', r; end if;
  if (select detail from public.receipt_qbo_links where receipt_id = 'v2-sw') ? 'refiled_proposal_id' then
    raise exception 'a refile naming another card stamped the failed row: %',
      (select detail from public.receipt_qbo_links where receipt_id = 'v2-sw');
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

-- 6f. the owner approves the second try: queued again, the refile kept, the
--     failure and the stamp gone
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'p1'), 'inbox');
begin
  if p.status is distinct from 'executed' or (p.result ->> 'queued')::int is distinct from 1 then
    raise exception 'the second try''s approval left % with %', p.status, coalesce(p.error, p.result::text);
  end if;
end
$$;
release savepoint s;
reset role;
do $$
declare
  p0 uuid := (select v::uuid from rq2 where k = 'p0');
  p1 uuid := (select v::uuid from rq2 where k = 'p1');
  l  public.receipt_qbo_links;
  o  public.outbox;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-sw';
  select * into o from public.outbox where proposal_id = p1;
  if l.state is distinct from 'queued' or l.proposal_id is distinct from p1 or l.outbox_id is distinct from o.id
     or l.qbo_txn_id is distinct from '10630' or l.changes is distinct from '{tag}' or l.parts is not null
     or l.detail is distinct from jsonb_build_object(
          'vendor', 'Home Depot', 'qbo_account_name', '3176 - Citi - Home Depot Consumer Credit Card', 'qbo_total', 45.06,
          'read_photo_ref', null,
          'refile', jsonb_build_object('proposal_id', p0, 'error', 'qbo_unavailable', 'why', 'QuickBooks answered 503 three times'))
     or pg_temp.rq2_claims('v2-sw') is distinct from '["Purchase:10630"]' then
    raise exception 'the approved second try left v2-sw as % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-sw');
  end if;
  -- the payload is the one-transaction payload; the refile stays here
  if (select count(*) from jsonb_object_keys(o.payload)) is distinct from 12 or o.payload ? 'refile'
     or o.payload ->> 'proposal_id' is distinct from p1::text then
    raise exception 'the second try''s payload is %', o.payload;
  end if;
end
$$;
-- only a failed row is stamped: a filing whose refile names the queued
-- row's own card leaves that row alone. Undone afterwards.
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  r jsonb := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a2',
               (select v::jsonb from rq2 where k = 'input_2') || jsonb_build_object('items', jsonb_build_array(
                 (select v::jsonb from rq2 where k = 'item_sw')
                 || jsonb_build_object('refile', jsonb_build_object('proposal_id', (select v from rq2 where k = 'p1'),
                                                                    'error', 'qbo_unavailable')))),
               'a queued receipt', '[]');
begin
  if r -> 'filed' is distinct from 'true' then raise exception 'a filing over a queued receipt answered %', r; end if;
  if (select state from public.receipt_qbo_links where receipt_id = 'v2-sw') is distinct from 'queued'
     or (select detail from public.receipt_qbo_links where receipt_id = 'v2-sw') ? 'refiled_proposal_id' then
    raise exception 'the filing door stamped a queued row: %', (select to_jsonb(l) from public.receipt_qbo_links l where receipt_id = 'v2-sw');
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 7a. the result trigger: a row marked dead by hand. With an error it reads
--     that error; without one, "cancelled: marked dead by hand". The second
--     try's refile stays on the failed row; a stamp, had one been left on
--     the row, would not (the stamp names a card for the failure before).
savepoint s;
update public.receipt_qbo_links set detail = detail || '{"refiled_proposal_id": "00000000-0000-0000-0000-0000000025e2"}'
 where receipt_id = 'v2-sw';
update public.outbox set status = 'dead', error = 'cancelled: Branden, wrong job'
 where id = (select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-sw');
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-sw';
  if l.state is distinct from 'failed' or l.detail ->> 'error' is distinct from 'cancelled: Branden, wrong job'
     or l.detail ->> 'failed_at' is null or l.detail -> 'refile' ->> 'error' is distinct from 'qbo_unavailable'
     or l.detail ? 'refiled_proposal_id' or pg_temp.rq2_claims('v2-sw') is distinct from '[]' then
    raise exception 'a row marked dead with an error left v2-sw as %', to_jsonb(l);
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
update public.outbox set status = 'dead'
 where id = (select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-sw');
do $$
declare
  l public.receipt_qbo_links;
begin
  if (select error from public.outbox where id = (select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-sw')) is not null then
    raise exception 'the outbox row marked dead by hand carries an error';
  end if;
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-sw';
  if l.state is distinct from 'failed' or l.detail ->> 'error' is distinct from 'cancelled: marked dead by hand'
     or l.detail ->> 'failed_at' is null or l.detail -> 'refile' ->> 'error' is distinct from 'qbo_unavailable'
     or l.detail ? 'refiled_proposal_id' or pg_temp.rq2_claims('v2-sw') is distinct from '[]' then
    raise exception 'a row marked dead by hand left v2-sw as %', to_jsonb(l);
  end if;
end
$$;

-- 7b. the receipt in two charges is sent: done first, then each charge's new
--     SyncToken. A parts= the trigger cannot read, one it cannot apply, and a
--     part_error each still leave it done (each undone).
update public.outbox set status = 'sending', locked_by = 'rq2-test-worker', lease_until = now() + interval '2 minutes',
                         attempts = attempts + 1
 where id = (select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-rz');
savepoint s;
set local role service_role;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-rz'), 'rq2-test-worker',
                          'Purchase:10615:7', 'tagged=done;attached=2;parts=10615:7,10661', 0) \g /dev/null
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-rz';
  if l.state is distinct from 'done' or l.qbo_sync_token is distinct from '7'
     or l.parts -> 0 ->> 'qbo_sync_token' is distinct from '0' or l.parts -> 1 ->> 'qbo_sync_token' is distinct from '0'
     or l.detail ->> 'provider_status' is distinct from 'tagged=done;attached=2;parts=10615:7,10661' then
    raise exception 'an unreadable parts= left v2-rz as %', to_jsonb(l);
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
savepoint s;
set local role service_role;
-- the same charge three times reads, and makes four parts the row's check
-- refuses: the trigger's own block warns and keeps the old SyncTokens
set local client_min_messages = error;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-rz'), 'rq2-test-worker',
                          'Purchase:10615:7', 'tagged=done;attached=2;parts=10615:7,10615:8,10615:9', 0) \g /dev/null
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-rz';
  if l.state is distinct from 'done' or l.qbo_sync_token is distinct from '7' or jsonb_array_length(l.parts) is distinct from 2
     or l.parts -> 0 ->> 'qbo_sync_token' is distinct from '0' or l.parts -> 1 ->> 'qbo_sync_token' is distinct from '0'
     or (select status from public.outbox where id = l.outbox_id) is distinct from 'sent' then
    raise exception 'a parts= the trigger could not apply left v2-rz as %', to_jsonb(l);
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
savepoint s;
set local role service_role;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-rz'), 'rq2-test-worker',
                          'Purchase:10615:7', 'tagged=done;attached=1;parts=10615:7,10661:0;part_error=qbo_refused', 0) \g /dev/null
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-rz';
  if l.state is distinct from 'done' or l.parts -> 0 ->> 'qbo_sync_token' is distinct from '7'
     or l.parts -> 1 ->> 'qbo_sync_token' is distinct from '0'
     or l.detail ->> 'provider_status' is distinct from 'tagged=done;attached=1;parts=10615:7,10661:0;part_error=qbo_refused'
     or pg_temp.rq2_claims('v2-rz') is distinct from '["Purchase:10615", "Purchase:10661"]' then
    raise exception 'a part_error left v2-rz as % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-rz');
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;
savepoint s;
set local role service_role;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-rz'), 'rq2-test-worker',
                          'Purchase:10615:7', 'tagged=done;attached=2;parts=10615:7,10661:9', 0) \g /dev/null
release savepoint s;
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-rz';
  if l.state is distinct from 'done' or l.qbo_txn_id is distinct from '10615' or l.qbo_sync_token is distinct from '7'
     or l.parts is distinct from jsonb_build_array(
          jsonb_build_object('qbo_txn_id', '10615', 'qbo_sync_token', '7', 'qbo_total', 126.90, 'qbo_date', '2026-10-02'),
          jsonb_build_object('qbo_txn_id', '10661', 'qbo_sync_token', '9', 'qbo_total', 224.10, 'qbo_date', '2026-10-07'))
     or l.detail ->> 'provider_id' is distinct from 'Purchase:10615:7'
     or l.detail ->> 'provider_status' is distinct from 'tagged=done;attached=2;parts=10615:7,10661:9'
     or l.detail ->> 'delivered_at' is null or l.detail ? 'error'
     or l.detail ->> 'read_photo_ref' is distinct from 'media:' || repeat('a', 64) || ':351'
     or pg_temp.rq2_claims('v2-rz') is distinct from '["Purchase:10615", "Purchase:10661"]' then
    raise exception 'a sent receipt in parts left v2-rz as % claiming %', to_jsonb(l), pg_temp.rq2_claims('v2-rz');
  end if;
end
$$;

-- 7c. a store entry whose new expense another receipt already holds as its
--     second charge: done, holding nothing, and the holder named from the
--     claims (the holder's own qbo_txn_id is another expense)
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  photo constant text := 'media:' || repeat('d', 64) || ':88';
  r jsonb;
begin
  r := public.receipt_qbo_links_note(array['00000000-0000-0000-0000-0000000025a6'::uuid], jsonb_build_array(jsonb_build_object(
         'receipt_id', 'v2-sp', 'job_id', '00000000-0000-0000-0000-0000000025a6', 'state', 'in_qbo', 'qbo_txn_type', 'Purchase',
         'qbo_txn_id', '10998', 'qbo_sync_token', '0', 'qbo_customer_id', '7306', 'amount', 100.00, 'receipt_date', '2026-09-29',
         'detail', '{}'::jsonb, 'parts', jsonb_build_array(
           jsonb_build_object('qbo_txn_id', '10998', 'qbo_sync_token', '0', 'qbo_total', 11.90, 'qbo_date', '2026-09-28'),
           jsonb_build_object('qbo_txn_id', '10999', 'qbo_sync_token', '0', 'qbo_total', 88.10, 'qbo_date', '2026-09-29')))));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' then raise exception 'the parts holder''s note answered %', r; end if;
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-0000000025a5', jsonb_build_object(
         'job_id', '00000000-0000-0000-0000-0000000025a5', 'job_name', 'Store job', 'qbo_customer_id', '7305',
         'qbo_name', 'Store job', 'total_usd', 88.10, 'matcher', 'receipts.qbo_match@1',
         'items', jsonb_build_array(jsonb_build_object(
           'receipt_id', 'v2-st', 'vendor', 'Spenard Builders Supply', 'date', '2026-09-29', 'amount', 88.10, 'receipt_no', '700630777',
           'qbo_txn_type', 'Purchase', 'qbo_txn_id', '', 'qbo_sync_token', '', 'qbo_total', null,
           'changes', '["create", "attach"]'::jsonb, 'photo_refs', jsonb_build_array(photo), 'project_ref', '415000005',
           'read_photo_ref', photo,
           'create', jsonb_build_object('account_id', '53', 'vendor_id', '65', 'payment_type', 'CreditCard', 'credit', false,
                                        'doc_number', '700630777', 'expense_account_id', '42', 'class_id', null,
                                        'txn_date', '2026-09-29', 'amount_abs', 88.10,
                                        'memo', 'Spenard Builders Supply 700630777 (from the job receipts app)')))),
         'store', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the store card answered %', r; end if;
  insert into rq2 values ('pst', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000025f1", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq2 where k = 'pst'), 'inbox');
begin
  if p.status is distinct from 'executed' or (p.result ->> 'queued')::int is distinct from 1 then
    raise exception 'the store card left % with %', p.status, coalesce(p.error, p.result::text);
  end if;
end
$$;
reset role;
update public.outbox set status = 'sending', locked_by = 'rq2-test-worker', lease_until = now() + interval '2 minutes',
                         attempts = attempts + 1
 where proposal_id = (select v::uuid from rq2 where k = 'pst');
set local role service_role;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'v2-st'), 'rq2-test-worker',
                          'Purchase:10999:0', 'tagged=adopted;attached=0', 0) \g /dev/null
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'v2-st';
  if l.state is distinct from 'done' or l.qbo_txn_id is not null or l.detail ->> 'txn_held_by' is distinct from 'v2-sp'
     or l.detail ->> 'provider_id' is distinct from 'Purchase:10999:0'
     or pg_temp.rq2_claims('v2-st') is distinct from '[]'
     or pg_temp.rq2_claims('v2-sp') is distinct from '["Purchase:10998", "Purchase:10999"]' then
    raise exception 'a new expense another receipt holds as a part left v2-st as % (claims %, holder %)', to_jsonb(l),
      pg_temp.rq2_claims('v2-st'), pg_temp.rq2_claims('v2-sp');
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

rollback;
