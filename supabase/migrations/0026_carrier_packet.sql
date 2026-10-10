-- ============================================================================
-- 0026 — the carrier packet: one numbered, versioned PDF per water job, sent
--        to the adjuster from Approvals (operations spine phase 5, the first
--        slice of roadmap P4 Documents).
--
-- WHAT IT IS FOR: when a water job is dry and invoiced, the worker's new
-- packet.build queue kind (services/worker/lanes/packet.mjs) assembles the
-- certificate, work authorization, plans, moisture maps, drying logs, photos,
-- documents and invoices into one PDF and files it as ONE card in the office
-- Approvals tab. Approving the card emails the PDF to the adjuster once, and
-- the packet row records it as sent, with the address it went to. If the job
-- changes afterwards, the next run builds version 2 under the same number.
-- docs/Carrier_Packet_Design.md is the contract; §7 and §8 are this file:
--
--   document_sequences          one counter per (org, kind, year): PKT-2026-0001
--   document_next_number        allocates the next number and moves the
--                               counter, inside the caller's transaction.
--                               Internal
--   carrier_packets             one row per build, never reused: number,
--                               version, the model hash that decided it, the
--                               stored PDF, the card, the delivery
--   carrier_packet_holds        why an in-scope job is not getting a card, and
--                               whether the owner has been texted about it
--   packet.send@1               the catalog row: comms, runtime sql, waits on
--                               the owner (the seeded comms policy)
--   op_exec_packet_send         the executor: under the job's lock, checks the
--                               recipient the owner confirmed and that the card
--                               is still the job's newest PDF, and writes ONE
--                               outbox row on the new 'packet' channel. Internal
--   carrier_packet_offer_card   files a packet.send card as agent:documents,
--                               offer by offer, with no text code. Internal
--   carrier_packet_reserve      the run's first door per job: decides skip,
--                               reoffer or build, and reserves the build row
--   carrier_packet_file         a finished build becomes the job's card
--   carrier_packet_reoffer      the same PDF on a fresh card
--   carrier_packet_fail         a build that did not finish
--   carrier_packet_withdraw     a job that left scope loses its card
--   carrier_packet_hold,        a job held back (no invoice, readings to
--   carrier_packet_hold_texted  check, too large, storage full) and its one text
--   carrier_packet_candidates   the jobs a run looks at
--   carrier_packet_state        the photo numbers and the last sent version
--   carrier_packet_pdfs_to_remove,
--   carrier_packet_pdfs_removed the cleanup of PDFs nobody can send any more
--   carrier_packet_storage_bytes,
--   carrier_packet_media_sizes  object sizes from storage.objects, for the
--                               size budget and the storage cap
--   outbox_packet_result        AFTER UPDATE OF status on outbox: a 'packet' row
--                               sent marks its packet sent, a dead one
--                               undelivered
--   agent:documents             the principal the lane files as, seeded with a
--                               fixed id, and its one grant: propose
--                               packet.send
--   outbox channel 'packet'     the outbox check constraint gains it
--   carrier-packet-hourly       pg_cron, minute 25 of every hour: enqueue
--                               packet.build once per Alaska hour (the key)
--
-- WHAT THIS CHANGES TODAY: nothing reaches a carrier until three things
-- happen, in this order: the worker carrying the new lane is deployed, it
-- heartbeats the 'packet' channel (outbox_channel_ready('packet'), which every
-- reserve reads first: lane_off until then), and the owner approves a card.
-- The cron row enqueues from the hour this is applied; until a worker claims
-- packet.build each hour's row waits queued, harmlessly, and the lane answers
-- {skipped: "stale"} to any it picks up more than 2 hours late (0021 and 0023
-- are in the same position). packet.build is a queue kind, not a catalog
-- operation, so nobody can propose it. Crews see nothing new.
--
-- WHY A TABLE AND NOT THE BLOB: the number, the version and the sent state
-- live in carrier_packets, never in field_projects.data, because the blob
-- merge lets a stale device's newer updatedAt win a whole top-level value and
-- would silently revert a version. A version is decided by a hash of what
-- prints (the worker's model), never by updatedAt or rev, which the payment
-- pull, autosaves and drying-log opens bump without changing the document.
--
-- VERSIONS: a build's version is 1 + the highest version actually sent, so an
-- adjuster never receives version 2 without having received version 1; a
-- build that replaces an unanswered or declined card keeps that card's
-- version. The number is the job's for good: every row of a job carries it.
--
-- THE LOCK PROTOCOL (design §7): every function that touches a job's packet
-- rows (reserve, file, reoffer, fail, withdraw and the executor) first takes
-- pg_advisory_xact_lock(hashtextextended('carrier_packet:' || job_id, 0)),
-- then row locks. A proposal row is never waited on while holding that lock:
-- superseding a card takes it FOR UPDATE SKIP LOCKED, and a card that cannot
-- be locked is an approval in progress (which waits on this lock inside the
-- executor), so the door steps aside instead of deadlocking it. No
-- lock_timeout, for the reason 0021 gives.
--
-- THE TO IS NEVER FILED. The card carries suggested_to for the office app to
-- prefill; the owner's approval sends p_edited_params {to, cc}, which
-- op_proposal_approve validates against the schema, and the executor refuses
-- an approval whose edit is anything else ("Reload Approvals and confirm the
-- recipient."), so an old cached card that cannot send a To can never send
-- the suggested one. Cards are filed with no SMS code (cleared after
-- op_propose): he should look at the PDF before it goes to a carrier.
--
-- EXACTLY ONCE: the approval is locked and idempotent and op_execute never
-- re-runs (0013); the outbox key is the proposal's key, written ON CONFLICT DO
-- NOTHING; the outbox row carries the PDF's sha256 and size, which the worker
-- checks before it sends; and the adapter adopts its own earlier send by
-- Message-ID (design §9). The 'packet' channel is new, so a worker that does
-- not know packets never claims one (it would send the email without the PDF).
--
-- THE GRANT. The owner said go for phase 5 on 2026-10-10, which includes
-- agent:documents proposing packet.send. As in 0019, 0021 and 0023, the
-- agent_authority.grant operation does not exist yet, so this file writes
-- that one row and its event, and skips it when any such row has ever
-- existed, so re-applying the file never revives a grant the owner revoked.
--
-- WHO: the three tables are read by the service role alone (RLS on, no
-- policy: the card reads its proposal and outbox row, never these) and
-- written only by the doors. The executor, the number allocator, the card
-- helper and the trigger function are callable by nobody (op_execute, the
-- doors and the trigger run them as postgres); every carrier_packet_* door by
-- service_role alone. Owner postgres throughout. The storage helpers read
-- storage.objects through dynamic SQL behind to_regclass, so this file
-- applies where storage-api is absent (db-replay) and they answer 0 and no
-- rows there. No storage bucket is created here: the worker creates the
-- private 'carrier-packets' bucket on first use.
--
-- Census: +3 tables, +1 trigger, +4 primary keys and unique constraints (the
-- three pkeys and carrier_packets (job_id, seq)), +17 functions; policies,
-- views and enums unchanged (one building, one ready and one sent row per
-- version are partial unique indexes, not constraints). The agent, the
-- catalog row, the grant and the cron row are data; the outbox channel list
-- is a check constraint.
-- Roles: the service role gains the doors and read on the three tables;
-- agent:documents gains one propose grant; the owner approves packet.send as
-- he approves every comms operation (the comms policy routes it to him, so
-- office's comms approval does not reach it); no human role may propose
-- packet.send (section 13b: explicit deny rows); otherwise owner, office,
-- crew_lead, crew, viewer, agent logins and anon read and write exactly what
-- they did before.
--
-- PUSH ORDER: 0025 (PR #276) goes to each database before this file.
-- db-push.yml runs `supabase db push` without --include-all, so a database
-- that has 0026 refuses a later 0025. If this file has to reach a database
-- first, it is renumbered instead; --include-all is not the answer.
--
-- KILL SWITCH AND ROLLBACK: CARRIER_PACKET=off on the worker makes every run
-- return {skipped: "off"} and stops serving the 'packet' channel, so no card
-- is filed (lane_off) and no packet email is delivered. To stop the schedule,
-- select cron.unschedule('carrier-packet-hourly'). To stop filing for good,
-- revoke the grant (update agent_authority set revoked_at = now() where
-- agent_id = agent:documents and operation = 'packet.send'; the row and its
-- event stay, events is append-only): every reserve then skips the job as
-- not_permitted before anything is built, and re-granting picks the jobs up
-- again. Open cards expire on their own; setting the catalog row's
-- deprecated_at makes them decline-only and stops reserving the same way. A queued packet email nobody should send is
-- cancelled by marking its outbox row dead (its packet then reads
-- undelivered). Additive: dropping the trigger, the seventeen functions and
-- the three tables, and putting the outbox channel constraint back, restores
-- the schema exactly as it was. PDFs already stored stay in the bucket until
-- someone empties it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. agent:documents — the principal the lane files as.
--
-- A fixed id, as 0004 and 0023 seeded theirs: the worker names it per queue
-- kind, the cron row enqueues as it, and the grant below has to be able to
-- name it. It starts with no agent_authority row; section 13 gives it the one
-- the owner approved.
-- ---------------------------------------------------------------------------
insert into public.agents (id, name, kind, enabled, created_by_kind)
values ('b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'agent:documents', 'automation', true, 'system')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 2. document_sequences and document_next_number — a number nobody reuses.
--
-- One row per (org, kind, year); next_value is the number the next call
-- hands out. The allocation is an upsert, so it holds the row lock until the
-- caller's transaction ends: two reserves for two jobs in one year queue on
-- it for a moment and never get the same number, and a reserve that rolls
-- back gives its number back with it (nothing was ever printed with it). The
-- year is the caller's, in Alaska time; the worker passes it.
-- ---------------------------------------------------------------------------
create table if not exists public.document_sequences (
  org_id      uuid    not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  kind        text    not null check (kind ~ '^[A-Z]{2,8}$'),
  year        integer not null check (year between 2000 and 2999),
  next_value  integer not null default 1 check (next_value >= 1),
  constraint document_sequences_pkey primary key (org_id, kind, year)
);

comment on table public.document_sequences is
  'Document number counters, one per (org, kind, year): next_value is what document_next_number() hands out next (PKT-2026-0001, then 0002). Written only by document_next_number() (0026).';

alter table public.document_sequences owner to postgres;
alter table public.document_sequences enable row level security;
revoke all on public.document_sequences from public, anon, authenticated, service_role;
grant select on public.document_sequences to service_role;


create or replace function public.document_next_number(p_kind text, p_year integer) returns text
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_n integer;
begin
  if p_kind is null or p_kind !~ '^[A-Z]{2,8}$' then
    raise exception 'document_next_number: kind must be 2 to 8 capital letters, not %', coalesce(p_kind, 'null')
      using errcode = 'invalid_parameter_value';
  end if;
  if p_year is null or p_year not between 2000 and 2999 then
    raise exception 'document_next_number: year % is not a four-digit year', p_year
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.document_sequences as s (org_id, kind, year, next_value)
  values (public.current_org(), p_kind, p_year, 2)
  on conflict (org_id, kind, year) do update set next_value = s.next_value + 1
  returning s.next_value - 1 into v_n;

  -- four digits, and more once a year passes 9999 rather than wrapping
  return p_kind || '-' || p_year::text || '-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
end;
$$;

alter function public.document_next_number(text, integer) owner to postgres;
comment on function public.document_next_number(text, integer) is
  'Allocates the next document number of a kind for a year (Alaska), KIND-YYYY-NNNN, and moves the counter; never hands out a number twice. Internal: carrier_packet_reserve() calls it inside the reserving transaction (0026).';
revoke all on function public.document_next_number(text, integer) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. carrier_packets — one row per build.
--
--   building → ready (filed: the PDF and the card) → sent | undelivered
--            → failed (a build that did not finish; relabel is not a try)
--   ready, undelivered → superseded (a newer build, or the job left scope)
--   undelivered → ready (the same PDF on a fresh card)
--
-- Rows are never reused and never deleted: a row is what was built, and the
-- sent ones are what the carrier holds. job_id is field_projects.id with no
-- foreign key, for the reason 0018 gives (a job row can be rewritten under
-- its id by the sync RPCs). meta is the card's counts and notes, as the
-- worker computed them; section_hashes and photo_nums are what the next
-- version compares against and keeps.
-- ---------------------------------------------------------------------------
create table if not exists public.carrier_packets (
  id              uuid        primary key default gen_random_uuid(),
  org_id          uuid        not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  job_id          uuid        not null,                      -- field_projects.id
  number          text        not null check (number ~ '^PKT-[0-9]{4}-[0-9]{4,}$'),
  version         integer     not null check (version >= 1),
  seq             integer     not null check (seq >= 1),
  model_hash      text        not null check (model_hash ~ '^[0-9a-f]{64}$'),
  section_hashes  jsonb       not null default '{}'::jsonb check (jsonb_typeof(section_hashes) = 'object'),
  photo_nums      jsonb       not null default '{}'::jsonb check (jsonb_typeof(photo_nums) = 'object'),
  meta            jsonb       not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  status          text        not null default 'building'
                  check (status in ('building', 'failed', 'ready', 'superseded', 'sent', 'undelivered')),
  build_token     uuid        not null default gen_random_uuid(),
  error           text,
  permanent       boolean     not null default false,
  bucket          text,
  path            text,
  sha256          text        check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes           bigint      check (bytes > 0),
  pages           integer     check (pages > 0),
  mode            text        check (mode in ('full', 'compact')),
  proposal_id     uuid,
  offer           integer     not null default 0 check (offer >= 0),
  outbox_id       uuid,
  sent_at         timestamptz,
  sent_to         text,
  pdf_removed_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint carrier_packets_job_seq_key unique (job_id, seq),
  -- a card is a stored PDF and a proposal; a sent row says when
  constraint carrier_packets_ready_filed check (
    status <> 'ready' or (proposal_id is not null and bucket is not null and path is not null and sha256 is not null)),
  constraint carrier_packets_sent_recorded check (status <> 'sent' or sent_at is not null)
);

comment on table public.carrier_packets is
  'One row per carrier packet build (docs/Carrier_Packet_Design.md §7): the job''s one number, the printed version (1 + the highest version sent), the model hash that decided it, the stored PDF (bucket carrier-packets), the packet.send card (proposal_id, offer) and the delivery (outbox_id, sent_at, sent_to). Status building, failed, ready, superseded, sent or undelivered. Written only by the carrier_packet_* doors, op_exec_packet_send() and the outbox_packet_result trigger (0026).';
comment on column public.carrier_packets.build_token is
  'Set at reserve; carrier_packet_file() and carrier_packet_fail() compare-and-set on it, so a build a later run marked abandoned can never file.';
comment on column public.carrier_packets.error is
  'Why a build failed (relabel: the label moved while it was built, not counted as a try; abandoned: building for over 30 minutes), why delivery failed (undelivered), or withdrawn: <reason>.';
comment on column public.carrier_packets.offer is
  'How many re-offers the current card took: 0 for the first card, + 1 for each carrier_packet_reoffer(); the idempotency key carries it.';
comment on column public.carrier_packets.pdf_removed_at is
  'The PDF was deleted from storage. Never set for a sent or undelivered row, or for one an outbox row references.';

create unique index if not exists carrier_packets_one_building
  on public.carrier_packets (job_id) where status = 'building';
create unique index if not exists carrier_packets_one_ready
  on public.carrier_packets (job_id) where status = 'ready';
create unique index if not exists carrier_packets_sent_version_key
  on public.carrier_packets (job_id, version) where status = 'sent';
create index if not exists carrier_packets_outbox_idx
  on public.carrier_packets (outbox_id) where outbox_id is not null;
create index if not exists carrier_packets_proposal_idx
  on public.carrier_packets (proposal_id) where proposal_id is not null;

alter table public.carrier_packets owner to postgres;
alter table public.carrier_packets enable row level security;
revoke all on public.carrier_packets from public, anon, authenticated, service_role;
grant select on public.carrier_packets to service_role;


-- ---------------------------------------------------------------------------
-- 4. carrier_packet_holds — why an in-scope job is not getting a card.
--
-- One row per job: the reason it is held now (no_invoice, unchecked_fills,
-- unread_meter_photos, failed_cap, too_large…), since when, and which reason
-- the owner was last texted about, so he hears about each once. A hold for
-- the whole lane (storage_full) uses the nil uuid as job_id. A build deletes
-- its job's hold.
-- ---------------------------------------------------------------------------
create table if not exists public.carrier_packet_holds (
  job_id         uuid        primary key,                    -- field_projects.id, or the nil uuid for the lane
  org_id         uuid        not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  reason         text        not null check (reason ~ '^[a-z][a-z0-9_]{0,39}$'),
  detail         text        check (char_length(detail) <= 500),
  since          timestamptz not null default now(),
  texted_at      timestamptz,
  texted_reason  text,
  updated_at     timestamptz not null default now()
);

comment on table public.carrier_packet_holds is
  'Why an in-scope job is not getting a carrier packet card (reason, detail, since) and the reason the owner was last texted about (texted_reason, texted_at), so each reason texts once per job. job_id 00000000-0000-0000-0000-000000000000 holds the whole lane (storage_full). Written only by carrier_packet_hold(), carrier_packet_hold_texted() and carrier_packet_reserve() (0026).';

alter table public.carrier_packet_holds owner to postgres;
alter table public.carrier_packet_holds enable row level security;
revoke all on public.carrier_packet_holds from public, anon, authenticated, service_role;
grant select on public.carrier_packet_holds to service_role;


-- ---------------------------------------------------------------------------
-- 5. The outbox learns the 'packet' channel.
--
-- A packet row is an email with one PDF attached, delivered by the email
-- adapter in packet mode. It is its own channel so that a worker that does
-- not know packets, which claims by channel, never takes one and sends the
-- email without the PDF. The constraint is 0004's inline check, recreated
-- with one more value; every existing row already satisfies it.
-- ---------------------------------------------------------------------------
alter table public.outbox drop constraint if exists outbox_channel_check;
alter table public.outbox add constraint outbox_channel_check
  check (channel in ('sms', 'email', 'qbo', 'portal', 'packet'));


-- ---------------------------------------------------------------------------
-- 6. The catalog row.
--
-- input_schema is what op_validate_input checks (0013), and what
-- op_proposal_approve checks input || edited_params against. packet_version_id
-- and offer are stamped by the filing doors, never sent by the worker. to and
-- cc are in the schema only so the owner's approval can add them: the doors
-- refuse an input that carries either, and the executor refuses an approval
-- that does not name the To or edits anything else. No amount field: comms
-- has no money threshold.
-- ---------------------------------------------------------------------------
insert into public.operation_catalog
  (name, version, action_type, description, input_schema, runtime, approval_default,
   amount_field, emits, idempotency_template, definition_sha)
select c.name, 1, 'comms', c.description, c.input_schema::jsonb, 'sql', 'owner',
       null, array['packet.queued'], c.idempotency_template,
       md5(c.name || '@1:' || c.input_schema::jsonb::text)
  from (values
    ('packet.send',
     'Email the carrier packet to the adjuster. Execution writes one outbox row on the packet channel carrying the stored PDF; the worker sends it once through Gmail, to the address confirmed on the card, and the packet is recorded as sent.',
     '{"type": "object", "additionalProperties": false,
       "required": ["packet_version_id", "offer", "subject", "body", "filename"],
       "properties": {
         "packet_version_id": {"type": "string", "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},
         "offer":             {"type": "integer"},
         "subject":           {"type": "string", "maxLength": 300},
         "body":              {"type": "string", "maxLength": 100000},
         "filename":          {"type": "string", "maxLength": 200},
         "suggested_to":      {"type": "string", "maxLength": 320},
         "suggested_from":    {"type": "string", "maxLength": 200},
         "to":                {"type": "string", "maxLength": 320, "pattern": "^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$"},
         "cc":                {"type": "string", "maxLength": 1000}}}',
     'packet.send:{packet_version_id}:{offer}')
  ) as c(name, description, input_schema, idempotency_template)
on conflict (name, version) do nothing;


-- ---------------------------------------------------------------------------
-- 7. op_exec_packet_send — the executor. Called only by op_execute (0013),
--    inside the owner's approval, as postgres.
--
-- The packet comes from the proposal's own input, never from the edit; the
-- edit may carry the To and the Cc and nothing else, and must carry the To.
-- Under the job's lock the packet row must still be this card's, the job's
-- newest live row (no ready, sent or undelivered row above it), with its PDF
-- still stored, and the job must still exist, live and unarchived. Any of
-- these failing raises, which op_execute records as the card's failure with
-- nothing written; the next hourly run offers the same PDF again on a fresh
-- card when the job is still in scope.
--
-- Writes ONE outbox row (channel packet, key outbox:<proposal key>), records
-- it on the packet row, and emits packet.queued. Returns {outbox_id,
-- packet_version_id, to}.
-- ---------------------------------------------------------------------------
create or replace function public.op_exec_packet_send(
  p_proposal public.proposals, p_params jsonb, p_principal_kind text, p_principal_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_edit    jsonb := p_proposal.edited_params;
  v_pid     uuid;
  v_job     uuid;
  v_to      text;
  v_cc      text;
  v_data    jsonb;
  v_deleted boolean;
  v_row     public.carrier_packets;
  v_payload jsonb;
  v_outbox  uuid;
begin
  -- 1. the recipient is the owner's, confirmed on the card
  if v_edit is null or jsonb_typeof(v_edit) <> 'object' or not (v_edit ? 'to')
     or exists (select 1 from jsonb_object_keys(v_edit) k where k not in ('to', 'cc'))
     or jsonb_typeof(v_edit -> 'to') is distinct from 'string'
     or btrim(v_edit ->> 'to') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or coalesce(jsonb_typeof(v_edit -> 'cc'), 'null') not in ('string', 'null') then
    raise exception 'Reload Approvals and confirm the recipient.';
  end if;
  v_to := btrim(v_edit ->> 'to');
  v_cc := btrim(coalesce(v_edit ->> 'cc', ''));

  -- 2. the packet the card was filed for
  begin
    v_pid := (p_proposal.input ->> 'packet_version_id')::uuid;
  exception when others then
    v_pid := null;
  end;
  if v_pid is null then
    raise exception 'packet.send: the card names no packet';
  end if;
  select job_id into v_job from public.carrier_packets where id = v_pid;
  if not found then
    raise exception 'packet.send: packet % does not exist', v_pid;
  end if;
  if p_proposal.job_id is distinct from v_job then
    raise exception 'packet.send: packet % is job %, not the card''s job %', v_pid, v_job, p_proposal.job_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carrier_packet:' || v_job::text, 0));

  -- 3. the job is still one a packet goes out for
  select data, deleted into v_data, v_deleted from public.field_projects where id = v_job;
  if not found then
    raise exception 'packet.send: job % does not exist, so nothing was sent', v_job;
  end if;
  if v_deleted then
    raise exception 'packet.send: the job is deleted, so nothing was sent';
  end if;
  if coalesce(v_data ->> 'archivedAt', '') <> '' then
    raise exception 'packet.send: the job is archived, so nothing was sent';
  end if;

  -- 4. this card is still the job's newest PDF, and the PDF is still there
  select * into v_row from public.carrier_packets where id = v_pid for update;
  if v_row.status <> 'ready' or v_row.proposal_id is distinct from p_proposal.id then
    raise exception 'packet.send: this card is no longer the packet''s current card (the packet is %), so nothing was sent', v_row.status;
  end if;
  if exists (select 1 from public.carrier_packets n
              where n.job_id = v_job and n.seq > v_row.seq and n.status in ('ready', 'sent', 'undelivered')) then
    raise exception 'packet.send: a newer version of this packet exists, so nothing was sent';
  end if;
  if v_row.path is null or v_row.pdf_removed_at is not null then
    raise exception 'packet.send: the PDF is no longer stored, so nothing was sent';
  end if;
  -- an earlier send of this job's packet that someone set going again
  if exists (select 1 from public.outbox o
              where o.channel = 'packet' and o.job_id = v_job
                and o.status in ('pending', 'sending', 'failed')
                and o.idempotency_key <> 'outbox:' || p_proposal.idempotency_key) then
    raise exception 'packet.send: an earlier send of this packet is still going out, so nothing was sent';
  end if;

  -- 5. one outbox row; the subject, body and file name are as filed
  v_payload := jsonb_build_object(
    'to',                v_to,
    'cc',                v_cc,
    'subject',           p_proposal.input ->> 'subject',
    'body',              p_proposal.input ->> 'body',
    'packet_version_id', v_row.id,
    'job_id',            v_job,
    'attachments',       jsonb_build_array(jsonb_build_object(
                           'bucket',       v_row.bucket,
                           'path',         v_row.path,
                           'filename',     p_proposal.input ->> 'filename',
                           'content_type', 'application/pdf',
                           'sha256',       v_row.sha256,
                           'bytes',        v_row.bytes)));

  insert into public.outbox
    (channel, operation, payload, idempotency_key, principal_kind, principal_id, proposal_id, job_id)
  values
    ('packet', p_proposal.operation, v_payload, 'outbox:' || p_proposal.idempotency_key,
     p_principal_kind, p_principal_id, p_proposal.id, v_job)
  on conflict (idempotency_key) do nothing
  returning id into v_outbox;
  if v_outbox is null then
    select id into v_outbox from public.outbox where idempotency_key = 'outbox:' || p_proposal.idempotency_key;
  end if;

  update public.carrier_packets set outbox_id = v_outbox, updated_at = now() where id = v_row.id;

  perform public.emit_event(
    'packet.queued', p_proposal.operation, 'outbox', v_outbox, v_job, p_proposal.claim_id, p_proposal.id,
    jsonb_build_object('to', v_to, 'packet_version_id', v_row.id, 'number', v_row.number,
                       'version', v_row.version, 'bytes', v_row.bytes),
    'packet.queued:' || v_outbox, p_principal_kind, p_principal_id);

  return jsonb_build_object('outbox_id', v_outbox, 'packet_version_id', v_row.id, 'to', v_to);
end;
$$;

alter function public.op_exec_packet_send(public.proposals, jsonb, text, uuid) owner to postgres;
comment on function public.op_exec_packet_send(public.proposals, jsonb, text, uuid) is
  'Executor for packet.send@1: refuses an approval whose edited_params is not {to[, cc]} with a valid To ("Reload Approvals and confirm the recipient."); under the job''s carrier_packet lock checks the job is live and unarchived and the packet row is ready, this card''s, the job''s newest live row, with its PDF stored; writes one outbox row on channel packet (key outbox:<proposal key>) with the To, Cc, subject, body and the PDF attachment, records outbox_id on the row and emits packet.queued (0026).';
revoke all on function public.op_exec_packet_send(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 8. carrier_packet_offer_card — file one packet.send card for a packet row.
--
-- The 0021 offer pattern: the key is the packet and the offer, so the door
-- tries offer p_from_offer, then the next, until op_propose hands back a card
-- that is open and was filed by agent:documents (a key whose card is already
-- answered moves on). A card on our key filed by anyone else is refused
-- rather than stepped over: it means the caller is not who the door files as.
-- Then the card's SMS code is cleared: a packet is approved in the office
-- app, after looking at the PDF, never by "YES n". Callers hold the job's
-- lock and have run op_expire_proposals. Internal.
-- ---------------------------------------------------------------------------
create or replace function public.carrier_packet_offer_card(
  p_packet        public.carrier_packets,
  p_input         jsonb,
  p_rationale     text,
  p_evidence_refs jsonb,
  p_from_offer    integer
) returns public.proposals
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_agent constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';   -- agent:documents (0026 seed)
  v_row   public.proposals;
begin
  for v_offer in p_from_offer .. p_from_offer + 49 loop
    v_row := public.op_propose(
      'packet.send',
      p_input || jsonb_build_object('packet_version_id', p_packet.id, 'offer', v_offer),
      p_packet.job_id, null, p_rationale, coalesce(p_evidence_refs, '[]'::jsonb), 'agent', v_agent,
      interval '14 days');
    if v_row.status = 'proposed' then
      if v_row.proposed_by_kind is distinct from 'agent' or v_row.proposed_by_id is distinct from v_agent then
        raise exception 'carrier_packet: card % on this packet''s key was filed by %/%, not agent:documents',
          v_row.id, v_row.proposed_by_kind, v_row.proposed_by_id;
      end if;
      update public.proposals set sms_code = null where id = v_row.id and sms_code is not null;
      v_row.sms_code := null;
      return v_row;
    end if;
  end loop;
  raise exception 'carrier_packet: no free offer for packet % from offer %', p_packet.id, p_from_offer;
end;
$$;

alter function public.carrier_packet_offer_card(public.carrier_packets, jsonb, text, jsonb, integer) owner to postgres;
comment on function public.carrier_packet_offer_card(public.carrier_packets, jsonb, text, jsonb, integer) is
  'Internal to the carrier packet doors: files a packet.send card for the row through op_propose as agent:documents (proposed_via agent, 14 days), input || {packet_version_id, offer}, trying offers from p_from_offer until it gets an open card of its own, then clears the card''s SMS code (0026).';
revoke all on function public.carrier_packet_offer_card(public.carrier_packets, jsonb, text, jsonb, integer) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 9. carrier_packet_reserve — the run's first door per job.
--
-- The worker gated the job and hashed its model; this decides what the hash
-- means, under the job's lock, after op_expire_proposals (so a card past its
-- expiry reads expired, not open). In order (design §7):
--   1. no worker heartbeating the 'packet' channel     → skip lane_off
--      agent:documents holds no live packet.send grant, or the catalog row
--      is deprecated (the owner switched filing off)   → skip not_permitted
--   2. a building row: under 30 minutes old            → skip building
--      older, it failed (abandoned, not permanent, its PDF's path kept so
--      the cleanup removes an upload) and the run goes on
--   3. this hash failed permanently, or 3 times not counting relabel
--                                                      → skip failed_cap,
--      with the last try's error (the worker holds the job and texts once)
--      a packet outbox row of the job is pending, sending or failed (to be
--      retried)                                        → skip in_flight
--   4. S = the newest sent row; R = the ready row (locked) and its card
--   5. R's card approved, executing or executed        → skip in_flight
--   6. R has this hash: card proposed → skip open; declined → skip declined;
--      expired, superseded or failed → reoffer R while R.offer < 3, else
--      skip offer_cap
--   7. no R; U = the newest undelivered row above S, with this hash: its
--      error is about size → skip too_large; its stored PDF is missing or
--      does not match → build (9); else reoffer U while U.offer < 3, else
--      skip offer_cap
--   8. S has this hash: the carrier already has this document. A newer
--      ready row (its card locked SKIP LOCKED; locked or approved → skip
--      in_flight) and undelivered rows above S are superseded, an open card
--      with them (withdrawn), and → skip sent
--   9. build: a building row, seq max + 1, version S.version + 1 (1 with no
--      S), the job's number (allocated on its first row), a new build token;
--      the job's hold is deleted, and so is the lane-wide storage_full hold
-- Returns {action: "skip", reason} or {action: "build" | "reoffer",
-- packet_id, number, version, seq, build_token, path, sha256, bytes, pages,
-- mode, replaces}: the row's own values (for a build, the path its PDF is to
-- be stored at, <job id>/<number>-v<version>-b<seq>.pdf, and no sha256,
-- bytes, pages or mode yet), and replaces S as {version, sent_at, sent_to,
-- section_hashes}, or null.
-- ---------------------------------------------------------------------------
create or replace function public.carrier_packet_reserve(
  p_job_id         uuid,
  p_model_hash     text,
  p_section_hashes jsonb,
  p_photo_nums     jsonb,
  p_meta           jsonb,
  p_year           integer
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_build  public.carrier_packets;
  v_tries  integer;
  v_perm   boolean;
  v_sent   public.carrier_packets;
  v_ready  public.carrier_packets;
  v_und    public.carrier_packets;
  v_pick   public.carrier_packets;
  v_card   text;
  v_action text;
  v_number text;
  v_seq    integer;
  v_err    text;
  r        record;
begin
  if p_job_id is null then
    raise exception 'carrier_packet_reserve: job id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_model_hash is null or p_model_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'carrier_packet_reserve: model hash must be 64 lowercase hex characters'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_section_hashes is null or jsonb_typeof(p_section_hashes) <> 'object' then
    raise exception 'carrier_packet_reserve: section hashes must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if p_photo_nums is not null and jsonb_typeof(p_photo_nums) <> 'object' then
    raise exception 'carrier_packet_reserve: photo numbers must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if p_meta is not null and jsonb_typeof(p_meta) <> 'object' then
    raise exception 'carrier_packet_reserve: meta must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if p_year is null or p_year not between 2000 and 2999 then
    raise exception 'carrier_packet_reserve: year % is not a four-digit year', p_year using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carrier_packet:' || p_job_id::text, 0));
  perform public.op_expire_proposals();

  -- 1. a card nobody can deliver is not built
  if not public.outbox_channel_ready('packet') then
    return jsonb_build_object('action', 'skip', 'reason', 'lane_off');
  end if;
  -- the owner's switches (the header): nothing is built that could not be filed
  if not exists (select 1 from public.operation_catalog c
                  where c.name = 'packet.send' and c.version = 1 and c.deprecated_at is null)
     or not public.op_agent_permits('b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'packet.send', 'comms', 'propose') then
    return jsonb_build_object('action', 'skip', 'reason', 'not_permitted');
  end if;

  -- 2. one build at a time; one that never finished is a failed try
  select * into v_build from public.carrier_packets
   where job_id = p_job_id and status = 'building' for update;
  if found then
    if v_build.created_at > now() - interval '30 minutes' then
      return jsonb_build_object('action', 'skip', 'reason', 'building');
    end if;
    -- the PDF may have been uploaded before the worker stopped: its path
    -- lets the cleanup remove it
    update public.carrier_packets
       set status = 'failed', error = 'abandoned', permanent = false,
           bucket = coalesce(bucket, 'carrier-packets'),
           path = coalesce(path, job_id::text || '/' || number || '-v' || version || '-b' || seq || '.pdf'),
           updated_at = now()
     where id = v_build.id;
  end if;

  -- 3. the tries this model has had
  select count(*), coalesce(bool_or(permanent), false) into v_tries, v_perm
    from public.carrier_packets
   where job_id = p_job_id and status = 'failed' and model_hash = p_model_hash
     and coalesce(error, '') <> 'relabel';
  if v_perm or v_tries >= 3 then
    select c.error into v_err from public.carrier_packets c
     where c.job_id = p_job_id and c.status = 'failed' and c.model_hash = p_model_hash
       and coalesce(c.error, '') <> 'relabel'
     order by c.seq desc limit 1;
    return jsonb_build_object('action', 'skip', 'reason', 'failed_cap', 'error', left(v_err, 300));
  end if;

  -- a send of this job's packet is going out: an approved card's, or a dead
  -- one someone set going again after its PDF was offered afresh. The outbox
  -- settles it first; a card or a build now could send the carrier two.
  if exists (select 1 from public.outbox o
              where o.channel = 'packet' and o.job_id = p_job_id and o.status in ('pending', 'sending', 'failed')) then
    return jsonb_build_object('action', 'skip', 'reason', 'in_flight');
  end if;

  -- 4. what was sent, and what is on offer
  select * into v_sent from public.carrier_packets
   where job_id = p_job_id and status = 'sent' order by seq desc limit 1;
  select * into v_ready from public.carrier_packets
   where job_id = p_job_id and status = 'ready' for update;

  if v_ready.id is not null then
    select p.status into v_card from public.proposals p where p.id = v_ready.proposal_id;
    -- 5. the owner approved it: the outbox trigger settles it soon
    if v_card in ('approved', 'executing', 'executed') then
      return jsonb_build_object('action', 'skip', 'reason', 'in_flight');
    end if;
    -- 6. the card on offer is this model
    if v_ready.model_hash = p_model_hash then
      if v_card = 'proposed' then
        return jsonb_build_object('action', 'skip', 'reason', 'open');
      elsif v_card = 'declined' then
        return jsonb_build_object('action', 'skip', 'reason', 'declined');
      elsif v_ready.offer >= 3 then
        return jsonb_build_object('action', 'skip', 'reason', 'offer_cap');
      end if;
      v_pick := v_ready;
      v_action := 'reoffer';
    end if;
  else
    -- 7. a send that failed, with this model
    select * into v_und from public.carrier_packets
     where job_id = p_job_id and status = 'undelivered' and seq > coalesce(v_sent.seq, 0)
     order by seq desc limit 1;
    if v_und.id is not null and v_und.model_hash = p_model_hash then
      -- Gmail refused it for its size (413, "too large"): the same PDF would
      -- be refused again
      if coalesce(v_und.error, '') ~* '(too[ _-]?large|\m413\M)' then
        return jsonb_build_object('action', 'skip', 'reason', 'too_large');
      end if;
      -- its stored PDF is gone or no longer matches (the packet adapter's
      -- permanent errors): offering it again would fail the same way, so it
      -- is built afresh (step 9), and filing supersedes this row
      if coalesce(v_und.error, '') !~* 'packet PDF (is missing from storage|in storage does not match)' then
        if v_und.offer >= 3 then
          return jsonb_build_object('action', 'skip', 'reason', 'offer_cap');
        end if;
        v_pick := v_und;
        v_action := 'reoffer';
      end if;
    end if;
  end if;

  if v_action is null then
    -- 8. the carrier already has this model (a change was undone): what is
    --    newer would only send the carrier its own copy again as a "version
    --    2", so it is withdrawn
    if v_sent.id is not null and v_sent.model_hash = p_model_hash then
      if v_ready.id is not null then
        -- a card the owner is approving right now is locked: leave it to run
        select p.status into v_card from public.proposals p where p.id = v_ready.proposal_id for update skip locked;
        if not found or v_card is null or v_card in ('approved', 'executing', 'executed') then
          return jsonb_build_object('action', 'skip', 'reason', 'in_flight');
        end if;
        if v_card = 'proposed' then
          update public.proposals p
             set status = 'superseded',
                 result = jsonb_build_object('superseded_reason', 'withdrawn',
                                             'reason', 'the carrier already has this version')
           where p.id = v_ready.proposal_id and p.status = 'proposed'
          returning p.id, p.operation, p.job_id, p.claim_id, p.result into r;
          if found then
            perform public.emit_event(
              'proposal.superseded', r.operation, 'proposal', r.id, r.job_id, r.claim_id, r.id,
              r.result, 'proposal.superseded:' || r.id, 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65'::uuid);
          end if;
        end if;
        update public.carrier_packets
           set status = 'superseded', error = 'withdrawn: the carrier already has this version', updated_at = now()
         where id = v_ready.id;
      end if;
      update public.carrier_packets
         set status = 'superseded', updated_at = now()
       where job_id = p_job_id and status = 'undelivered' and seq > v_sent.seq;
      return jsonb_build_object('action', 'skip', 'reason', 'sent');
    end if;

    -- 9. build: the job's one number, the next seq, the version after the
    --    last one sent
    select c.number into v_number from public.carrier_packets c
     where c.job_id = p_job_id order by c.seq limit 1;
    if v_number is null then
      v_number := public.document_next_number('PKT', p_year);
    end if;
    select coalesce(max(c.seq), 0) + 1 into v_seq from public.carrier_packets c where c.job_id = p_job_id;

    insert into public.carrier_packets
      (job_id, number, version, seq, model_hash, section_hashes, photo_nums, meta, status, build_token)
    values
      (p_job_id, v_number, coalesce(v_sent.version, 0) + 1, v_seq, p_model_hash, p_section_hashes,
       coalesce(p_photo_nums, '{}'::jsonb), coalesce(p_meta, '{}'::jsonb), 'building', gen_random_uuid())
    returning * into v_pick;
    v_action := 'build';

    delete from public.carrier_packet_holds where job_id = p_job_id;
    -- the worker checks Storage before it reserves, so a build means there
    -- is room again: the lane-wide hold goes too, and a later full bucket
    -- texts afresh
    delete from public.carrier_packet_holds
     where job_id = '00000000-0000-0000-0000-000000000000'::uuid and reason = 'storage_full';
  end if;

  return jsonb_build_object(
    'action',      v_action,
    'packet_id',   v_pick.id,
    'number',      v_pick.number,
    'version',     v_pick.version,
    'seq',         v_pick.seq,
    'build_token', v_pick.build_token,
    -- a build's PDF goes where design §10 puts it; a reoffer's is stored
    'path',        case when v_action = 'build'
                        then v_pick.job_id::text || '/' || v_pick.number || '-v' || v_pick.version
                             || '-b' || v_pick.seq || '.pdf'
                        else v_pick.path end,
    'sha256',      v_pick.sha256,
    'bytes',       v_pick.bytes,
    'pages',       v_pick.pages,
    'mode',        v_pick.mode,
    'replaces',    case when v_sent.id is null then null
                        else jsonb_build_object('version', v_sent.version, 'sent_at', v_sent.sent_at,
                                                'sent_to', v_sent.sent_to, 'section_hashes', v_sent.section_hashes) end);
end;
$$;

alter function public.carrier_packet_reserve(uuid, text, jsonb, jsonb, jsonb, integer) owner to postgres;
comment on function public.carrier_packet_reserve(uuid, text, jsonb, jsonb, jsonb, integer) is
  'The carrier packet lane''s first door per job (design §7): under the job''s lock, after op_expire_proposals, skips (lane_off, building, failed_cap, in_flight, open, declined, offer_cap, too_large, sent), returns a reoffer of the ready or undelivered row holding this model hash, or reserves a building row (seq max + 1, version 1 + the highest sent, the job''s PKT number, a new build token) and deletes the job''s hold. Returns {action, reason} or {action, packet_id, number, version, seq, build_token, path, sha256, bytes, pages, mode, replaces}. service_role only (0026).';
revoke all on function public.carrier_packet_reserve(uuid, text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function public.carrier_packet_reserve(uuid, text, jsonb, jsonb, jsonb, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 10. carrier_packet_file — a finished build becomes the job's card.
--
-- p_pdf = {bucket, path, sha256, bytes, pages, mode}: the PDF the worker
-- stored, in the carrier-packets bucket under the job's folder. p_input =
-- {subject, body, filename, suggested_to, suggested_from}: never a to or cc.
-- Under the job's lock:
--   * the row must be building with this token, else {status: "lost"} (a
--     later run marked it abandoned; the worker removes its upload)
--   * its label must still be right: version 1 + the highest sent, and a
--     ready row's card lockable (SKIP LOCKED) and not approved. Otherwise
--     the row fails as relabel, which is not a try, keeping the PDF's path so
--     the cleanup removes it if the worker does not, and {status: "relabel"};
--     the next run rebuilds with the right label
--   * the card is filed (carrier_packet_offer_card, offer 0 up), the ready
--     row's open card is superseded by it (proposal.superseded, and the new
--     card's supersedes_id names it), the ready row and any undelivered row
--     above the last sent one become superseded, and this row becomes ready
--     with the PDF, the card and its offer
-- Returns {status: "filed", proposal_id, superseded: [{bucket, path}]}: the
-- PDFs the worker may delete now (superseded rows never sent that no outbox
-- row references). Raises on a malformed call, and 42501 from op_propose when
-- agent:documents holds no live grant.
-- ---------------------------------------------------------------------------
create or replace function public.carrier_packet_file(
  p_packet_id     uuid,
  p_build_token   uuid,
  p_pdf           jsonb,
  p_input         jsonb,
  p_rationale     text,
  p_evidence_refs jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_agent   constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';   -- agent:documents (0026 seed)
  v_job     uuid;
  v_row     public.carrier_packets;
  v_ready   public.carrier_packets;
  v_sentv   integer;
  v_sentseq integer;
  v_card    text;
  v_relabel boolean := false;
  v_prop    public.proposals;
  v_gone    jsonb := '[]'::jsonb;
  r         record;
begin
  if p_packet_id is null or p_build_token is null then
    raise exception 'carrier_packet_file: packet id and build token are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_pdf is null or jsonb_typeof(p_pdf) <> 'object'
     or p_pdf ->> 'bucket' is distinct from 'carrier-packets'
     or jsonb_typeof(p_pdf -> 'path') is distinct from 'string'
     or (p_pdf ->> 'path') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}\.pdf$'
     or (p_pdf ->> 'path') like '%..%'
     or coalesce(p_pdf ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_pdf -> 'bytes') is distinct from 'number' or (p_pdf ->> 'bytes') !~ '^[1-9][0-9]{0,11}$'
     or jsonb_typeof(p_pdf -> 'pages') is distinct from 'number' or (p_pdf ->> 'pages') !~ '^[1-9][0-9]{0,5}$'
     or coalesce(p_pdf ->> 'mode', '') not in ('full', 'compact') then
    raise exception 'carrier_packet_file: pdf must be {bucket: carrier-packets, path: <job id>/<name>.pdf, sha256, bytes, pages, mode: full | compact}'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'carrier_packet_file: input must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if p_input ? 'to' or p_input ? 'cc' then
    raise exception 'carrier_packet_file: the To is never filed; send suggested_to, and the owner confirms the recipient on the card'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_evidence_refs is not null and jsonb_typeof(p_evidence_refs) <> 'array' then
    raise exception 'carrier_packet_file: evidence_refs must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  select job_id into v_job from public.carrier_packets where id = p_packet_id;
  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  if (p_pdf ->> 'path') not like v_job::text || '/%' then
    raise exception 'carrier_packet_file: the PDF must be stored under the job''s folder %/', v_job
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carrier_packet:' || v_job::text, 0));

  select * into v_row from public.carrier_packets where id = p_packet_id for update;
  if v_row.status <> 'building' or v_row.build_token is distinct from p_build_token then
    return jsonb_build_object('status', 'lost');
  end if;

  -- the label it was built with is still the label it would get now
  select max(c.version) into v_sentv from public.carrier_packets c where c.job_id = v_job and c.status = 'sent';
  if v_row.version <> coalesce(v_sentv, 0) + 1 then
    v_relabel := true;
  else
    select * into v_ready from public.carrier_packets
     where job_id = v_job and status = 'ready' for update;
    if v_ready.id is not null then
      -- a card the owner is approving right now is locked: step aside
      select p.status into v_card from public.proposals p where p.id = v_ready.proposal_id for update skip locked;
      if not found or v_card is null
         or v_card not in ('proposed', 'declined', 'expired', 'superseded', 'failed') then
        v_relabel := true;
      end if;
    end if;
  end if;

  if v_relabel then
    update public.carrier_packets
       set status = 'failed', error = 'relabel', permanent = false,
           bucket = p_pdf ->> 'bucket', path = p_pdf ->> 'path', sha256 = p_pdf ->> 'sha256',
           bytes = (p_pdf ->> 'bytes')::bigint, pages = (p_pdf ->> 'pages')::integer, mode = p_pdf ->> 'mode',
           updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('status', 'relabel');
  end if;

  perform public.op_expire_proposals();
  v_prop := public.carrier_packet_offer_card(v_row, p_input, p_rationale, p_evidence_refs, 0);

  -- the card it replaces, and the rows nobody will send now
  if v_ready.id is not null then
    update public.proposals p
       set status = 'superseded', result = jsonb_build_object('superseded_by', v_prop.id)
     where p.id = v_ready.proposal_id and p.status = 'proposed'
    returning p.id, p.operation, p.job_id, p.claim_id, p.result into r;
    if found then
      perform public.emit_event(
        'proposal.superseded', r.operation, 'proposal', r.id, r.job_id, r.claim_id, r.id,
        r.result, 'proposal.superseded:' || r.id, 'agent', v_agent);
      update public.proposals set supersedes_id = r.id where id = v_prop.id;
    end if;
    update public.carrier_packets set status = 'superseded', updated_at = now() where id = v_ready.id;
    if v_ready.path is not null and v_ready.pdf_removed_at is null and v_ready.outbox_id is null
       and not exists (select 1 from public.outbox o
                        where o.channel = 'packet' and o.payload ->> 'packet_version_id' = v_ready.id::text) then
      v_gone := jsonb_build_array(jsonb_build_object('bucket', v_ready.bucket, 'path', v_ready.path));
    end if;
  end if;
  select max(c.seq) into v_sentseq from public.carrier_packets c where c.job_id = v_job and c.status = 'sent';
  update public.carrier_packets
     set status = 'superseded', updated_at = now()
   where job_id = v_job and status = 'undelivered' and seq > coalesce(v_sentseq, 0);

  update public.carrier_packets
     set status = 'ready',
         bucket = p_pdf ->> 'bucket', path = p_pdf ->> 'path', sha256 = p_pdf ->> 'sha256',
         bytes = (p_pdf ->> 'bytes')::bigint, pages = (p_pdf ->> 'pages')::integer, mode = p_pdf ->> 'mode',
         proposal_id = v_prop.id, offer = (v_prop.input ->> 'offer')::integer, error = null,
         updated_at = now()
   where id = v_row.id;

  return jsonb_build_object('status', 'filed', 'proposal_id', v_prop.id, 'superseded', v_gone);
end;
$$;

alter function public.carrier_packet_file(uuid, uuid, jsonb, jsonb, text, jsonb) owner to postgres;
comment on function public.carrier_packet_file(uuid, uuid, jsonb, jsonb, text, jsonb) is
  'Files a finished carrier packet build (design §7): under the job''s lock the row must be building with this token ({status: lost} otherwise) and its label still right (else failed as relabel, not a try: {status: relabel}); files the packet.send card as agent:documents with no SMS code (input || {packet_version_id, offer}; never a to or cc), supersedes the ready row''s open card and the ready and undelivered rows above the last sent one, and makes the row ready with the PDF. Returns {status: filed, proposal_id, superseded: [{bucket, path}]}. service_role only (0026).';
revoke all on function public.carrier_packet_file(uuid, uuid, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.carrier_packet_file(uuid, uuid, jsonb, jsonb, text, jsonb) to service_role;


-- ---------------------------------------------------------------------------
-- 11. The other doors.
--
-- carrier_packet_reoffer: the same PDF on a fresh card. The row must be
-- ready with a dead card (expired, superseded or failed) or undelivered,
-- still the job's newest live row (ready, sent or undelivered), below the
-- offer cap (3) and with its PDF stored. Files the card at offer + 1 (as
-- carrier_packet_file does) and sets the row ready with it, clearing
-- outbox_id and error. Returns {status: "filed", proposal_id, offer,
-- superseded: []}, or {status: "lost", reason} when the row no longer
-- qualifies (missing, not_offerable, open, declined, in_flight, not_latest,
-- offer_cap, pdf_removed): the worker files nothing and texts nothing.
-- ---------------------------------------------------------------------------
create or replace function public.carrier_packet_reoffer(
  p_packet_id     uuid,
  p_input         jsonb,
  p_rationale     text,
  p_evidence_refs jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_job  uuid;
  v_row  public.carrier_packets;
  v_card text;
  v_prop public.proposals;
  v_off  integer;
begin
  if p_packet_id is null then
    raise exception 'carrier_packet_reoffer: packet id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'carrier_packet_reoffer: input must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if p_input ? 'to' or p_input ? 'cc' then
    raise exception 'carrier_packet_reoffer: the To is never filed; send suggested_to, and the owner confirms the recipient on the card'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_evidence_refs is not null and jsonb_typeof(p_evidence_refs) <> 'array' then
    raise exception 'carrier_packet_reoffer: evidence_refs must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  select job_id into v_job from public.carrier_packets where id = p_packet_id;
  if not found then
    return jsonb_build_object('status', 'lost', 'reason', 'missing');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carrier_packet:' || v_job::text, 0));
  perform public.op_expire_proposals();

  select * into v_row from public.carrier_packets where id = p_packet_id for update;
  if v_row.status = 'ready' then
    select p.status into v_card from public.proposals p where p.id = v_row.proposal_id;
    if v_card = 'proposed' then
      return jsonb_build_object('status', 'lost', 'reason', 'open');
    elsif v_card = 'declined' then
      return jsonb_build_object('status', 'lost', 'reason', 'declined');
    elsif v_card is null or v_card not in ('expired', 'superseded', 'failed') then
      return jsonb_build_object('status', 'lost', 'reason', 'not_offerable');
    end if;
  elsif v_row.status <> 'undelivered' then
    return jsonb_build_object('status', 'lost', 'reason', 'not_offerable');
  end if;
  -- a send of this job's packet is going out (a dead row someone set going
  -- again): the outbox settles it
  if exists (select 1 from public.outbox o
              where o.channel = 'packet' and o.job_id = v_job and o.status in ('pending', 'sending', 'failed')) then
    return jsonb_build_object('status', 'lost', 'reason', 'in_flight');
  end if;
  if exists (select 1 from public.carrier_packets n
              where n.job_id = v_job and n.seq > v_row.seq and n.status in ('ready', 'sent', 'undelivered')) then
    return jsonb_build_object('status', 'lost', 'reason', 'not_latest');
  end if;
  if v_row.offer >= 3 then
    return jsonb_build_object('status', 'lost', 'reason', 'offer_cap');
  end if;
  if v_row.path is null or v_row.pdf_removed_at is not null then
    return jsonb_build_object('status', 'lost', 'reason', 'pdf_removed');
  end if;

  v_prop := public.carrier_packet_offer_card(v_row, p_input, p_rationale, p_evidence_refs, v_row.offer + 1);
  v_off := (v_prop.input ->> 'offer')::integer;

  update public.carrier_packets
     set status = 'ready', proposal_id = v_prop.id, offer = v_off, outbox_id = null, error = null,
         updated_at = now()
   where id = v_row.id;

  return jsonb_build_object('status', 'filed', 'proposal_id', v_prop.id, 'offer', v_off, 'superseded', '[]'::jsonb);
end;
$$;

alter function public.carrier_packet_reoffer(uuid, jsonb, text, jsonb) owner to postgres;
comment on function public.carrier_packet_reoffer(uuid, jsonb, text, jsonb) is
  'Offers a carrier packet''s stored PDF again on a fresh packet.send card (offer + 1, at most 3 re-offers): the row must be ready with an expired, superseded or failed card, or undelivered, the job''s newest live row, with its PDF stored. Sets it ready with the new card, clearing outbox_id and error. Returns {status: filed, proposal_id, offer, superseded: []} or {status: lost, reason}. service_role only (0026).';
revoke all on function public.carrier_packet_reoffer(uuid, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.carrier_packet_reoffer(uuid, jsonb, text, jsonb) to service_role;


-- carrier_packet_fail: a build that did not finish. Compare-and-set building
-- → failed with the error; p_permanent for a PDF too large to email and for
-- data that can never render. capped is true when this model has now spent
-- its tries (a permanent failure, or 3 not counting relabel), which is when
-- the worker holds the job with a text. A row that is not building with this
-- token is {status: "lost", capped: false}.
create or replace function public.carrier_packet_fail(
  p_packet_id   uuid,
  p_build_token uuid,
  p_error       text,
  p_permanent   boolean
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_job   uuid;
  v_row   public.carrier_packets;
  v_tries integer;
  v_perm  boolean;
begin
  if p_packet_id is null then
    raise exception 'carrier_packet_fail: packet id is required' using errcode = 'invalid_parameter_value';
  end if;

  select job_id into v_job from public.carrier_packets where id = p_packet_id;
  if not found then
    return jsonb_build_object('status', 'lost', 'capped', false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carrier_packet:' || v_job::text, 0));

  -- the path the PDF was to be stored at, so the cleanup removes an upload
  -- the worker could not
  update public.carrier_packets
     set status = 'failed', error = left(coalesce(nullif(btrim(p_error), ''), 'failed'), 2000),
         permanent = coalesce(p_permanent, false),
         bucket = coalesce(bucket, 'carrier-packets'),
         path = coalesce(path, job_id::text || '/' || number || '-v' || version || '-b' || seq || '.pdf'),
         updated_at = now()
   where id = p_packet_id and status = 'building' and build_token = p_build_token
  returning * into v_row;
  if not found then
    return jsonb_build_object('status', 'lost', 'capped', false);
  end if;

  select count(*), coalesce(bool_or(permanent), false) into v_tries, v_perm
    from public.carrier_packets
   where job_id = v_job and status = 'failed' and model_hash = v_row.model_hash
     and coalesce(error, '') <> 'relabel';

  return jsonb_build_object('status', 'failed', 'capped', v_perm or v_tries >= 3);
end;
$$;

alter function public.carrier_packet_fail(uuid, uuid, text, boolean) owner to postgres;
comment on function public.carrier_packet_fail(uuid, uuid, text, boolean) is
  'Marks a carrier packet build failed (compare-and-set on building and the build token) with its error and whether it is permanent. Returns {status: failed | lost, capped}: capped when this model hash now has a permanent failure or 3 counted failures (relabel does not count). service_role only (0026).';
revoke all on function public.carrier_packet_fail(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.carrier_packet_fail(uuid, uuid, text, boolean) to service_role;


-- carrier_packet_withdraw: the job left scope (deleted, archived, not water,
-- unticked, no certificate, no invoice, unchecked readings), so its ready row
-- must leave no approvable PDF behind. The card is locked SKIP LOCKED: a card
-- being approved right now, or one already approved (in flight), is left to
-- run. An open card is superseded (proposal.superseded, superseded_reason
-- withdrawn); the row becomes superseded with error "withdrawn: <reason>".
-- Returns {withdrawn, pdf}: pdf is {bucket, path} when the worker may delete
-- the PDF now (no outbox row references it), else null.
create or replace function public.carrier_packet_withdraw(p_job_id uuid, p_reason text) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_agent  constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';   -- agent:documents (0026 seed)
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'out of scope'), 200);
  v_ready  public.carrier_packets;
  v_card   text;
  v_pdf    jsonb;
  r        record;
begin
  if p_job_id is null then
    raise exception 'carrier_packet_withdraw: job id is required' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carrier_packet:' || p_job_id::text, 0));

  select * into v_ready from public.carrier_packets where job_id = p_job_id and status = 'ready' for update;
  if not found then
    return jsonb_build_object('withdrawn', false, 'pdf', null);
  end if;

  select p.status into v_card from public.proposals p where p.id = v_ready.proposal_id for update skip locked;
  if not found or v_card in ('approved', 'executing', 'executed') then
    return jsonb_build_object('withdrawn', false, 'pdf', null);
  end if;

  if v_card = 'proposed' then
    update public.proposals p
       set status = 'superseded',
           result = jsonb_build_object('superseded_reason', 'withdrawn', 'reason', v_reason)
     where p.id = v_ready.proposal_id and p.status = 'proposed'
    returning p.id, p.operation, p.job_id, p.claim_id, p.result into r;
    if found then
      perform public.emit_event(
        'proposal.superseded', r.operation, 'proposal', r.id, r.job_id, r.claim_id, r.id,
        r.result, 'proposal.superseded:' || r.id, 'agent', v_agent);
    end if;
  end if;

  update public.carrier_packets
     set status = 'superseded', error = 'withdrawn: ' || v_reason, updated_at = now()
   where id = v_ready.id;

  if v_ready.path is not null and v_ready.pdf_removed_at is null and v_ready.outbox_id is null
     and not exists (select 1 from public.outbox o
                      where o.channel = 'packet' and o.payload ->> 'packet_version_id' = v_ready.id::text) then
    v_pdf := jsonb_build_object('bucket', v_ready.bucket, 'path', v_ready.path);
  end if;
  return jsonb_build_object('withdrawn', true, 'pdf', v_pdf);
end;
$$;

alter function public.carrier_packet_withdraw(uuid, text) owner to postgres;
comment on function public.carrier_packet_withdraw(uuid, text) is
  'Withdraws a job''s ready carrier packet when the job leaves scope: supersedes its open card (SKIP LOCKED; a card being approved or in flight is left alone) and sets the row superseded with error withdrawn: <reason>. Returns {withdrawn, pdf: {bucket, path} | null}. service_role only (0026).';
revoke all on function public.carrier_packet_withdraw(uuid, text) from public, anon, authenticated;
grant execute on function public.carrier_packet_withdraw(uuid, text) to service_role;


-- carrier_packet_hold: why an in-scope job is not getting a card. Upserts the
-- job's hold (since restarts when the reason changes); text_due is true when
-- the owner has not been texted about this reason for this job. The nil uuid
-- holds the lane. carrier_packet_hold_texted records the text once it went.
create or replace function public.carrier_packet_hold(p_job_id uuid, p_reason text, p_detail text) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_hold public.carrier_packet_holds;
begin
  if p_job_id is null then
    raise exception 'carrier_packet_hold: job id is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,39}$' then
    raise exception 'carrier_packet_hold: reason must be a short snake_case word, not %', coalesce(p_reason, 'null')
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.carrier_packet_holds as h (job_id, reason, detail, since, updated_at)
  values (p_job_id, p_reason, left(nullif(btrim(coalesce(p_detail, '')), ''), 500), now(), now())
  on conflict (job_id) do update
     set since      = case when h.reason = excluded.reason then h.since else now() end,
         reason     = excluded.reason,
         detail     = excluded.detail,
         updated_at = now()
  returning * into v_hold;

  return jsonb_build_object('text_due', v_hold.texted_reason is distinct from v_hold.reason);
end;
$$;

alter function public.carrier_packet_hold(uuid, text, text) owner to postgres;
comment on function public.carrier_packet_hold(uuid, text, text) is
  'Upserts a carrier packet hold (job id, or the nil uuid for the whole lane; reason; detail). Returns {text_due}: true when the owner has not been texted about this reason for this job (carrier_packet_hold_texted). service_role only (0026).';
revoke all on function public.carrier_packet_hold(uuid, text, text) from public, anon, authenticated;
grant execute on function public.carrier_packet_hold(uuid, text, text) to service_role;


create or replace function public.carrier_packet_hold_texted(p_job_id uuid, p_reason text) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  if p_job_id is null or p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,39}$' then
    raise exception 'carrier_packet_hold_texted: job id and reason are required' using errcode = 'invalid_parameter_value';
  end if;
  update public.carrier_packet_holds
     set texted_at = now(), texted_reason = p_reason, updated_at = now()
   where job_id = p_job_id;
  return jsonb_build_object('recorded', found);
end;
$$;

alter function public.carrier_packet_hold_texted(uuid, text) owner to postgres;
comment on function public.carrier_packet_hold_texted(uuid, text) is
  'Records that the owner was texted about a carrier packet hold''s reason (texted_at, texted_reason), so carrier_packet_hold() answers text_due false for it. Returns {recorded}. service_role only (0026).';
revoke all on function public.carrier_packet_hold_texted(uuid, text) from public, anon, authenticated;
grant execute on function public.carrier_packet_hold_texted(uuid, text) to service_role;


-- carrier_packet_candidates: the jobs a run looks at, oldest updated_at first
-- (a job with no field_projects row first of all):
--   * live jobs with a certificate (sigTech, uploadedPages or uploadedDoc)
--     changed in the last p_lookback_days + 2 days (the gate's lookback is on
--     the job's anchor date; this is only the cheap outer bound)
--   * live jobs changed since their newest packet row was created, whatever
--     the window (the gate skips the lookback for a job with rows)
--   * jobs with a ready row, deleted ones included, so a job that left scope
--     has its card withdrawn
-- has_row: the job has any packet row; open_row: it has a ready row.
create or replace function public.carrier_packet_candidates(p_lookback_days integer, p_limit integer)
  returns table (job_id uuid, updated_at timestamptz, has_row boolean, open_row boolean)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  with built as (
    select cp.job_id as id, max(cp.created_at) as last_created, bool_or(cp.status = 'ready') as ready
      from public.carrier_packets cp
     group by cp.job_id
  ),
  picked as (
    select fp.id
      from public.field_projects fp
     where not fp.deleted
       and fp.updated_at > now() - make_interval(days => greatest(0, least(coalesce(p_lookback_days, 14), 365)) + 2)
       and (case jsonb_typeof(fp.data #> '{certDrying,sigTech}')
              when 'string' then (fp.data #>> '{certDrying,sigTech}') <> '' else false end
            or case jsonb_typeof(fp.data #> '{certDrying,uploadedPages}')
                 when 'array' then jsonb_array_length(fp.data #> '{certDrying,uploadedPages}') > 0 else false end
            or case jsonb_typeof(fp.data #> '{certDrying,uploadedDoc}')
                 when 'string' then (fp.data #>> '{certDrying,uploadedDoc}') <> ''
                 when 'object' then (fp.data #> '{certDrying,uploadedDoc}') <> '{}'::jsonb
                 else false end)
    union
    select b.id
      from built b
      join public.field_projects fp on fp.id = b.id
     where not fp.deleted and fp.updated_at > b.last_created
    union
    select b.id from built b where b.ready
  )
  select p.id, fp.updated_at, b.id is not null, coalesce(b.ready, false)
    from picked p
    left join public.field_projects fp on fp.id = p.id
    left join built b on b.id = p.id
   order by fp.updated_at asc nulls first, p.id
   limit greatest(1, least(coalesce(p_limit, 200), 2000));
$$;

alter function public.carrier_packet_candidates(integer, integer) owner to postgres;
comment on function public.carrier_packet_candidates(integer, integer) is
  'The jobs a packet.build run looks at, oldest updated_at first: live jobs with a certificate changed in the last lookback + 2 days, live jobs changed since their newest packet row, and every job with a ready row (to withdraw). Columns job_id, updated_at, has_row, open_row. service_role only (0026).';
revoke all on function public.carrier_packet_candidates(integer, integer) from public, anon, authenticated;
grant execute on function public.carrier_packet_candidates(integer, integer) to service_role;


-- carrier_packet_state: what the next model of a job keeps from the last one.
-- photo_nums is the newest row's (photo numbers never move between versions);
-- last_sent is the newest sent row as {version, sent_at, sent_to,
-- section_hashes}, or null.
create or replace function public.carrier_packet_state(p_job_id uuid) returns jsonb
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'photo_nums', (select c.photo_nums from public.carrier_packets c
                    where c.job_id = p_job_id order by c.seq desc limit 1),
    'last_sent',  (select jsonb_build_object('version', s.version, 'sent_at', s.sent_at,
                                             'sent_to', s.sent_to, 'section_hashes', s.section_hashes)
                     from public.carrier_packets s
                    where s.job_id = p_job_id and s.status = 'sent' order by s.seq desc limit 1));
$$;

alter function public.carrier_packet_state(uuid) owner to postgres;
comment on function public.carrier_packet_state(uuid) is
  'A job''s carrier packet state for the next model: {photo_nums of the newest row, last_sent: {version, sent_at, sent_to, section_hashes} | null}. service_role only (0026).';
revoke all on function public.carrier_packet_state(uuid) from public, anon, authenticated;
grant execute on function public.carrier_packet_state(uuid) to service_role;


-- carrier_packet_pdfs_to_remove / carrier_packet_pdfs_removed: the PDFs nobody
-- can send any more. Superseded and failed rows with a stored PDF, and ready
-- rows whose card was declined more than 14 days ago (the declining update is
-- the card's last), never a sent or undelivered row, and never a row an
-- outbox row references (by outbox_id, or by the packet_version_id a dead
-- outbox row still carries after a re-offer): those PDFs are the record of
-- what went to the carrier, or tried to. The worker deletes each object,
-- then stamps the rows; the stamp re-checks the same rules and returns how
-- many rows it stamped.
create or replace function public.carrier_packet_pdfs_to_remove(p_limit integer)
  returns table (id uuid, bucket text, path text)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select cp.id, cp.bucket, cp.path
    from public.carrier_packets cp
    left join public.proposals p on p.id = cp.proposal_id
   where cp.path is not null
     and cp.pdf_removed_at is null
     and cp.outbox_id is null
     and (cp.status in ('superseded', 'failed')
          or (cp.status = 'ready' and p.status = 'declined' and p.updated_at < now() - interval '14 days'))
     and not exists (select 1 from public.outbox o
                      where o.channel = 'packet' and o.payload ->> 'packet_version_id' = cp.id::text)
   order by cp.updated_at, cp.id
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

alter function public.carrier_packet_pdfs_to_remove(integer) owner to postgres;
comment on function public.carrier_packet_pdfs_to_remove(integer) is
  'Carrier packet PDFs the worker may delete: superseded and failed rows with a path, and ready rows whose card was declined over 14 days ago; never sent or undelivered rows, never one an outbox row references, never one already removed. Columns id, bucket, path; at most 100. service_role only (0026).';
revoke all on function public.carrier_packet_pdfs_to_remove(integer) from public, anon, authenticated;
grant execute on function public.carrier_packet_pdfs_to_remove(integer) to service_role;


create or replace function public.carrier_packet_pdfs_removed(p_ids uuid[]) returns integer
  language sql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  with stamped as (
    update public.carrier_packets cp
       set pdf_removed_at = now(), updated_at = now()
     where cp.id = any (coalesce(p_ids[1:1000], '{}'::uuid[]))
       and cp.path is not null
       and cp.pdf_removed_at is null
       and cp.outbox_id is null
       and (cp.status in ('superseded', 'failed')
            or (cp.status = 'ready'
                and exists (select 1 from public.proposals p
                             where p.id = cp.proposal_id and p.status = 'declined'
                               and p.updated_at < now() - interval '14 days')))
       and not exists (select 1 from public.outbox o
                        where o.channel = 'packet' and o.payload ->> 'packet_version_id' = cp.id::text)
    returning 1
  )
  select count(*)::integer from stamped;
$$;

alter function public.carrier_packet_pdfs_removed(uuid[]) owner to postgres;
comment on function public.carrier_packet_pdfs_removed(uuid[]) is
  'Stamps pdf_removed_at on carrier packet rows whose PDF the worker deleted, re-checking carrier_packet_pdfs_to_remove''s rules (never sent, undelivered or outbox-referenced rows); at most 1000 ids. Returns how many rows it stamped. service_role only (0026).';
revoke all on function public.carrier_packet_pdfs_removed(uuid[]) from public, anon, authenticated;
grant execute on function public.carrier_packet_pdfs_removed(uuid[]) to service_role;


-- carrier_packet_storage_bytes / carrier_packet_media_sizes: object sizes from
-- storage.objects (metadata.size, bytes), for the storage cap (the whole
-- carrier-packets bucket) and the size budget (named field-media objects,
-- read before anything is downloaded). Dynamic SQL behind to_regclass, so the
-- functions are created where storage-api never ran (db-replay) and answer 0
-- and no rows there.
create or replace function public.carrier_packet_storage_bytes() returns bigint
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_bytes bigint;
begin
  if to_regclass('storage.objects') is null then
    return 0;
  end if;
  execute $q$
    select coalesce(sum(case when o.metadata ->> 'size' ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)::bigint
      from storage.objects o
     where o.bucket_id = $1$q$
    into v_bytes
    using 'carrier-packets';
  return coalesce(v_bytes, 0);
end;
$$;

alter function public.carrier_packet_storage_bytes() owner to postgres;
comment on function public.carrier_packet_storage_bytes() is
  'Total bytes stored in the carrier-packets bucket (storage.objects metadata.size), 0 where storage.objects does not exist. service_role only (0026).';
revoke all on function public.carrier_packet_storage_bytes() from public, anon, authenticated;
grant execute on function public.carrier_packet_storage_bytes() to service_role;


create or replace function public.carrier_packet_media_sizes(p_names text[])
  returns table (name text, bytes bigint)
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  if cardinality(p_names) > 5000 then
    raise exception 'carrier_packet_media_sizes: at most 5000 names per call' using errcode = 'invalid_parameter_value';
  end if;
  if p_names is null or cardinality(p_names) = 0 or to_regclass('storage.objects') is null then
    return;
  end if;
  return query execute $q$
    select o.name::text,
           (case when o.metadata ->> 'size' ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint end)::bigint
      from storage.objects o
     where o.bucket_id = 'field-media' and o.name = any ($1)$q$
    using p_names;
end;
$$;

alter function public.carrier_packet_media_sizes(text[]) owner to postgres;
comment on function public.carrier_packet_media_sizes(text[]) is
  'Sizes (storage.objects metadata.size, bytes) of the named field-media objects that exist; a name with no object has no row. No rows where storage.objects does not exist. service_role only (0026).';
revoke all on function public.carrier_packet_media_sizes(text[]) from public, anon, authenticated;
grant execute on function public.carrier_packet_media_sizes(text[]) to service_role;


-- ---------------------------------------------------------------------------
-- 12. outbox_packet_result — a 'packet' outbox row's fate becomes its
--     packet's.
--
-- outbox_sent, outbox_failed (0016) and sweep_leases settle the outbox row
-- and never touch a packet, so without this the packet would read ready
-- forever. sent or delivered → sent, with sent_at and the address it went to
-- (the payload's To, the owner's); dead → undelivered, with the error. Only
-- the packet row that recorded this outbox row is touched, or, for a send,
-- the one its payload names: a dead row someone set going again after the
-- lane re-offered its PDF still records the send, and the re-offer's open
-- card is superseded. Like
-- outbox_qbo_link_result it can never fail the write that fired it: the
-- worker's report of an email Gmail already took must always land.
-- ---------------------------------------------------------------------------
create or replace function public.outbox_packet_result() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_pid  uuid;
  v_prop uuid;
  r      record;
begin
  if new.status in ('sent', 'delivered') then
    -- the packet the row carries, also when a re-offer has since cleared
    -- outbox_id (a dead row someone set going again): the carrier has it
    begin
      v_pid := (new.payload ->> 'packet_version_id')::uuid;
    exception when others then
      v_pid := null;
    end;
    update public.carrier_packets
       set status = 'sent', sent_at = coalesce(new.sent_at, now()), sent_to = new.payload ->> 'to',
           outbox_id = new.id, error = null, updated_at = now()
     where (outbox_id = new.id or id = v_pid) and status <> 'sent'
    returning proposal_id into v_prop;
    -- a fresh card for the same PDF is now pointless: it goes
    if v_prop is not null then
      update public.proposals p
         set status = 'superseded', result = jsonb_build_object('superseded_reason', 'sent', 'outbox_id', new.id)
       where p.id = v_prop and p.status = 'proposed' and p.id is distinct from new.proposal_id
      returning p.id, p.operation, p.job_id, p.claim_id, p.result into r;
      if found then
        perform public.emit_event(
          'proposal.superseded', r.operation, 'proposal', r.id, r.job_id, r.claim_id, r.id,
          r.result, 'proposal.superseded:' || r.id, 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65'::uuid);
      end if;
    end if;
  else
    update public.carrier_packets
       set status = 'undelivered', error = left(coalesce(new.error, 'undelivered'), 2000), updated_at = now()
     where outbox_id = new.id and status = 'ready';
  end if;
  return null;
exception when others then
  raise warning 'outbox_packet_result failed for outbox %: %', new.id, sqlerrm;
  return null;
end;
$$;

alter function public.outbox_packet_result() owner to postgres;
comment on function public.outbox_packet_result() is
  'AFTER UPDATE OF status on outbox, channel packet, status now sent, delivered or dead: marks the carrier_packets row whose outbox_id is this row, or that the payload''s packet_version_id names, sent (sent_at, sent_to = payload to, outbox_id; an open re-offered card for it is superseded), or the row whose outbox_id is this row undelivered (error). Exception-guarded: it never fails the outbox update (0026).';
revoke all on function public.outbox_packet_result() from public, anon, authenticated, service_role;

drop trigger if exists outbox_packet_result on public.outbox;
create trigger outbox_packet_result
  after update of status on public.outbox
  for each row
  when (new.channel = 'packet' and new.status is distinct from old.status and new.status in ('sent', 'delivered', 'dead'))
  execute function public.outbox_packet_result();


-- ---------------------------------------------------------------------------
-- 13. agent:documents may PROPOSE packet.send — the owner's go, 2026-10-10
--     (operations spine phase 5).
--
-- The bare name, as op_agent_permits matches it (0013). Propose only: no
-- other comms operation, never execute, and no agent can approve.
-- ---------------------------------------------------------------------------
do $$
declare
  v_agent  constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';   -- agent:documents (0026 seed)
  v_reason constant text :=
    'Phase 5 carrier packet: the hourly packet.build run files each dry, invoiced water job''s numbered PDF '
    || 'as one packet.send proposal; the owner confirms the recipient and approves every one in the inbox. '
    || 'Granted by migration 0026 on the owner''s go, 2026-10-10.';
  v_id     uuid;
begin
  if not exists (select 1 from public.agents where id = v_agent and name = 'agent:documents') then
    raise exception '0026: agent:documents (agents %) is missing; section 1 seeds it', v_agent;
  end if;

  insert into public.agent_authority as aa
    (agent_id, operation, capability, granted_by_kind, granted_by_id, reason)
  select v_agent, 'packet.send', 'propose', 'system', null, v_reason
   where not exists (select 1 from public.agent_authority x
                      where x.agent_id = v_agent and x.operation = 'packet.send'
                        and x.capability = 'propose')
  on conflict (agent_id, operation, capability) where revoked_at is null do nothing
  returning aa.id into v_id;

  if v_id is not null then
    perform public.emit_event(
      'agent_authority.granted', null, 'agent_authority', v_id, null, null, null,
      jsonb_build_object('agent_id', v_agent, 'agent', 'agent:documents',
                         'operation', 'packet.send', 'capability', 'propose',
                         'reason', v_reason, 'granted_by', 'migration 0026'),
      'agent_authority.granted:' || v_id, 'system', null);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 13b. Nobody files packet.send by hand.
--
-- Every role may propose comms:* (0004's matrix), which would let any
-- signed-in login put a "Carrier packet" card in the owner's inbox with a
-- link of its choosing, or take a packet's next offer key so its re-offer
-- can never be filed. A packet card is only ever the lane's: an explicit
-- deny on the operation itself beats the wildcard (op_role_permits), for
-- propose and, through it, execute-implies-propose. The owner's approve is
-- untouched (it comes from his comms:* execute), and agent:documents is
-- governed by the agent role and its own grant, not by these rows.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, operation, capability, allow)
select r.role, 'packet.send', 'propose', false
  from (values ('owner'), ('office'), ('crew_lead'), ('crew'), ('viewer')) as r(role)
on conflict (org_id, role, operation, capability) do nothing;


-- ---------------------------------------------------------------------------
-- 14. Every catalog operation that can be proposed has an executor, whatever
--     its runtime (0021 section 6, repeated for the new row).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select name from public.operation_catalog
     where deprecated_at is null and runtime in ('sql', 'worker')
       and name not in ('proposal.approve', 'proposal.decline')
  loop
    if to_regprocedure(format('public.%I(public.proposals, jsonb, text, uuid)',
                              'op_exec_' || replace(r.name, '.', '_'))) is null then
      raise exception 'ops: % has no op_exec_ executor', r.name;
    end if;
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- 15. The hourly run, at minute 25. The Alaska hour is the key, so a second
--     firing in the same hour is the same queue row (and the repeated hour
--     when the clocks fall back runs once). Priority -10 lets approvals (0)
--     go first. cron.schedule is idempotent on the name; the job runs as
--     postgres, which owns enqueue.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0026: pg_cron is not installed here; carrier-packet-hourly not scheduled';
    return;
  end if;
  perform cron.schedule('carrier-packet-hourly', '25 * * * *', $cmd$select public.enqueue(
    'packet.build',
    jsonb_build_object('run_hour', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD"T"HH24')),
    'packet.build:' || to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD"T"HH24'),
    now(), -10, 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65'::uuid)$cmd$);
end
$$;
