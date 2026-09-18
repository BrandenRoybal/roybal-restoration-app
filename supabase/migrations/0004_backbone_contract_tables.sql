-- ============================================================================
-- 0004 — the contract tables: proposals, events, jobs_queue, outbox, and the
--        permission spine that says who may propose, approve and execute
--
-- This is P1 step two (docs/architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md
-- §2.2 "The contract in Postgres", §2.4 "The permission matrix", §7.3 "P1";
-- the same work is J3 in docs/architecture/08-VOICE-CONTROL-ROADMAP.md §5).
-- Step one — the baseline squash into 0000_baseline.sql — has shipped.
--
-- WHAT THIS IS FOR. Today an assistant that wants to do something either
-- writes a `pending_actions` row (three action kinds, approved only by a text
-- from one hard-coded phone number) or it hands seventeen prose-specified
-- actions to a browser tab and hopes the tab is still open. There is no queue,
-- no audit trail worth the name, no record of which machine was allowed to do
-- what, and no place for a second office person's permissions to live. These
-- nine tables are that place:
--
--   proposals          every write anything wants to make, before it happens
--   events             the append-only record of what did happen
--   jobs_queue         work the worker leases, retries and eventually gives up on
--   outbox             one row per external side effect, with delivery state
--   agents             the machine principals, by name, instead of email strings
--   agent_authority    what each machine may do — deny by default
--   role_permissions   what each human role may do — data, not code
--   approval_policies  the money threshold lane, built and deliberately OFF
--   operation_catalog  the published list of operations the ops registry emits
--
-- WHAT THIS IS NOT. No `op_*` function, no `emit_event()`, no `enqueue`, no
-- `claim_job`, no worker, no Approvals inbox, no cron sweeper, and no role-enum
-- migration. Those are the other P1 steps and each is its own change. Nothing
-- reads or writes these tables yet, so this migration cannot change the
-- behaviour of a single live lane. `pending_actions` is untouched and stays the
-- live spine until P2 (§7.3, "Data migration").
--
-- THE TRAP THIS MIGRATION HAS TO STEP AROUND. This database carries
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO anon;
--     GRANT ALL ON TABLES TO authenticated;
-- (0000_baseline.sql:6375-6378). A bare `create table` in `public` is therefore
-- INSERT/UPDATE/DELETE-able by an anonymous browser the moment it exists, and
-- the `rls_auto_enable` event trigger (0000_baseline.sql:1630) only turns RLS
-- on — a table with RLS on and no policy is closed, but the grant is still
-- sitting there waiting for the first policy anyone adds. Every table below is
-- therefore followed by an explicit
--   revoke all on public.<t> from anon, authenticated;
--   grant select on public.<t> to authenticated;   -- reads only
-- Writes are never granted. They arrive through `op_*` functions in a later
-- migration, which run SECURITY DEFINER. §8.5 step 2 states this rule; the
-- default privileges above are why it has to be written out every time.
--
-- TENANCY. `org_id` is on every table here, `not null` with a constant default,
-- per Decision record §7 and 04-OPEN-QUESTIONS R12 option (a) — the documented
-- default, which the owner has not overruled. There is no `orgs` table and no
-- second org; the column costs nothing now and adding it later would touch
-- every policy, every unique constraint and the JWT claim under load. There is
-- also no `divisions` table yet (it lands with the domain tables), so
-- `division_id` is a plain nullable uuid with no foreign key; the FK is added by
-- the migration that creates `divisions`.
--
-- CIRCULAR REFERENCES. `proposals.execution_job_id` points at `jobs_queue`,
-- `proposals.executed_event_id` points at `events`, and `events.proposal_id`
-- points back at `proposals`. The tables are created first and those three
-- foreign keys are added at the end, once all three exist.
--
-- ROLE VOCABULARY. `role_permissions.role` and `approval_policies.approver_role`
-- carry the TARGET vocabulary — owner, office, crew_lead, crew, viewer, agent —
-- as `text` with a check constraint, per the §3.4 convention that enumerations
-- are never Postgres enums. The live `public.user_role` enum still says
-- admin/tech/viewer/office and is not touched here: remapping it is the
-- three-step N/N+1/N+2 migration of §2.4, which has to be sequenced against
-- `_sync_guard` so that no device fails a push, and it does not belong in a
-- migration that only creates tables. `current_role_name()` below bridges the
-- two vocabularies so the policies here are correct on both sides of that
-- change.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Helpers the policies read.
--
-- All three are claim-first with a fallback, exactly as Decision record §5 and
-- 07-MULTI-TENANCY-AND-BILLING.md §4.1 specify: the Custom Access Token hook
-- that stamps principal_id / role / division_id / org_id is not deployed yet,
-- and the field app holds a token until under 60 s before it expires
-- (apps/field/js/supa.js:34-86), so a fleet of phones will present pre-hook
-- tokens for a while after it is. STABLE and the `(select auth.uid())` initplan
-- form are not stylistic — they are what keeps these off the per-row path.
-- ---------------------------------------------------------------------------

create or replace function public.current_org() returns uuid
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id', '')::uuid,
    -- One org today. When a second one exists this falls back to a profiles
    -- lookup instead (07 §3.1); until then a constant is honest and greppable.
    'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid
  );
$$;

alter function public.current_org() owner to postgres;
comment on function public.current_org() is
  'The caller''s org, from the JWT claim when the token hook has stamped it, else the single org constant. Decision record §7; 07 §4.1.';
revoke all on function public.current_org() from public;
grant execute on function public.current_org() to authenticated, service_role;


create or replace function public.current_principal() returns uuid
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'principal_id', '')::uuid,
    (select auth.uid())
  );
$$;

alter function public.current_principal() owner to postgres;
comment on function public.current_principal() is
  'The caller''s principal id, from the JWT claim when present, else auth.uid(). Decision record §5.';
revoke all on function public.current_principal() from public;
grant execute on function public.current_principal() to authenticated, service_role;


create or replace function public.current_role_name() returns text
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''),
    -- Pre-hook tokens and every session until the role-enum migration lands:
    -- read profiles and translate today's vocabulary into the target one.
    -- `admin` maps to `owner` here because both live admin logins are the
    -- owner's today and this function gates READS of the backbone tables only.
    -- Which of the two live admin profiles becomes `office` is decided by the
    -- reviewed per-row remap table in the N+1 migration of §2.4, not here.
    (select case p.role::text
              when 'admin'  then 'owner'
              when 'office' then 'office'
              when 'tech'   then 'crew'
              when 'viewer' then 'viewer'
            end
       from public.profiles p
      where p.id = (select auth.uid()))
  );
$$;

alter function public.current_role_name() owner to postgres;
comment on function public.current_role_name() is
  'The caller''s role in the TARGET vocabulary (owner/office/crew_lead/crew/viewer/agent), from the JWT claim when present, else translated from profiles.role. Bridges both sides of the role-enum migration of §2.4.';
revoke all on function public.current_role_name() from public;
grant execute on function public.current_role_name() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- agents — machine principals, by name.
--
-- matrix: agents | owner: r | office: r | crew_lead: - | crew: - | viewer: - | agent: -
--
-- Replaces the free labels that stand in for a machine today — 'qb-time',
-- 'quickbooks-time', 'web-agent', 'office' in pending_actions.proposed_by,
-- time_entries.data.enteredBy and sms_messages.sent_by — and the 26 restrictive
-- policies that name two literal email addresses (§2.4).
-- ---------------------------------------------------------------------------
create table if not exists public.agents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  name          text not null,
  -- The document names six seed agents but never enumerates `kind`. Two
  -- categories cover all six and every principal §4 names for later lanes: a
  -- lane that runs itself ('automation'), and a lane that exists because a
  -- human is on the other end of a channel ('channel'). 'integration' is
  -- separated out because an integration principal's grants are pulls from a
  -- third party rather than work of our own.
  kind          text not null check (kind in ('automation', 'channel', 'integration')),
  auth_user_id  uuid references auth.users (id) on delete set null,
  enabled       boolean not null default true,
  created_by_kind text not null default 'system'
                  check (created_by_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  created_by_id uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint agents_name_per_org_key unique (org_id, name)
);

comment on table public.agents is
  'Machine principals. One row per named lane; the worker selects its principal per queue kind from a table in services/worker, never from a default (§2.2).';

create index if not exists agents_org_idx on public.agents (org_id);
create index if not exists agents_auth_user_idx on public.agents (auth_user_id) where auth_user_id is not null;

create or replace trigger agents_updated_at
  before update on public.agents
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- agent_authority — what a machine may do. Deny by default.
--
-- matrix: agent_authority | owner: r | office: r | crew_lead: - | crew: - | viewer: - | agent: -
--
-- A new agent holds nothing. The owner adds rows through the `agent_authority.grant`
-- operation, which emits an event; `agent_authority.revoke` does the same and is
-- effective on the next op call, because the op checks the row rather than a
-- cached claim. `capability` deliberately has no 'approve' value: an agent can
-- never approve anything (§2.4, "Machine principals and the widening path").
-- ---------------------------------------------------------------------------
create table if not exists public.agent_authority (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  agent_id    uuid not null references public.agents (id) on delete cascade,
  -- An operation name ('sms.send') or an action type wildcard ('comms:*').
  operation   text not null,
  capability  text not null check (capability in ('read', 'propose', 'execute')),
  -- {max_amount_usd, kinds[], quiet_hours, division_ids[]}
  conditions  jsonb not null default '{}'::jsonb,
  granted_by_kind text not null default 'human'
                  check (granted_by_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  granted_by_id   uuid,
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  revoked_by_kind text
                  check (revoked_by_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  revoked_by_id   uuid,
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.agent_authority is
  'Per-agent grants. Deny by default: an agent with no row here may do nothing. Grant and revoke are operations that emit events (§2.4).';

create index if not exists agent_authority_agent_idx on public.agent_authority (agent_id);
create index if not exists agent_authority_org_idx on public.agent_authority (org_id);

-- One live grant per (agent, operation, capability); revoked rows stay for the
-- audit trail and do not block a later re-grant.
create unique index if not exists agent_authority_live_key
  on public.agent_authority (agent_id, operation, capability)
  where revoked_at is null;

create or replace trigger agent_authority_updated_at
  before update on public.agent_authority
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- operation_catalog — the published operations.
--
-- matrix: operation_catalog | owner: r | office: r | crew_lead: r | crew: r | viewer: r | agent: r
--
-- Published by CI from packages/domain/ops; the database never invents an
-- operation. `op_propose` validates a proposal's `input` against `input_schema`
-- with pg_jsonschema, and CI diffs this table against the deployed `op_*`
-- signatures (§2.3). Every role may read it: it is the tool list, and what a
-- principal may actually DO with an entry is decided by role_permissions and
-- agent_authority, never by whether they can see the name.
--
-- No org_id: like price_list (07 §3.2), the catalog is reference data rather
-- than customer data. CI publishes one list and every org runs the same
-- operations; what differs per org is who may call them, which is what
-- role_permissions and agent_authority carry.
-- ---------------------------------------------------------------------------
create table if not exists public.operation_catalog (
  name                 text not null,
  version              integer not null check (version >= 1),
  action_type          text not null
                       check (action_type in ('read', 'capture', 'job', 'money',
                                              'comms', 'external', 'schedule', 'admin')),
  description          text not null,
  input_schema         jsonb not null default '{}'::jsonb,
  output_schema        jsonb not null default '{}'::jsonb,
  runtime              text not null check (runtime in ('sql', 'edge', 'worker')),
  -- The role that approves by default, or 'auto' where a policy row may.
  approval_default     text not null default 'owner'
                       check (approval_default in ('owner', 'office', 'crew_lead', 'auto')),
  -- Which output field carries the amount approval_policies thresholds against.
  amount_field         text,
  emits                text[] not null default '{}'::text[],
  idempotency_template text,
  definition_sha       text not null,
  published_at         timestamptz not null default now(),
  deprecated_at        timestamptz,
  constraint operation_catalog_pkey primary key (name, version)
);

comment on table public.operation_catalog is
  'The published operation registry. Written by CI from packages/domain/ops; never hand-edited (§2.3).';

create index if not exists operation_catalog_action_type_idx
  on public.operation_catalog (action_type)
  where deprecated_at is null;


-- ---------------------------------------------------------------------------
-- role_permissions — what a human role may do. Data, not code.
--
-- matrix: role_permissions | owner: r | office: r | crew_lead: - | crew: - | viewer: - | agent: -
--
-- Edited only through the owner's `role.grant` op, which emits an event; a CI
-- snapshot asserts every catalog operation has a row here or an explicit deny,
-- which is what `allow` is for — a denied capability is a row that says so,
-- not an absent row nobody can tell from an oversight.
-- ---------------------------------------------------------------------------
create table if not exists public.role_permissions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  role        text not null
              check (role in ('owner', 'office', 'crew_lead', 'crew', 'viewer', 'agent')),
  -- An operation name ('invoice.add_line') or an action type wildcard ('money:*').
  operation   text not null,
  capability  text not null check (capability in ('read', 'propose', 'approve', 'execute')),
  scope       text not null default 'all' check (scope in ('all', 'division', 'assigned', 'own')),
  allow       boolean not null default true,
  -- {kinds[], quiet_hours, max_amount_usd, …}; the per-kind quiet-hours setting
  -- of §2.4 lives here rather than in code.
  conditions  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint role_permissions_key unique (org_id, role, operation, capability)
);

comment on table public.role_permissions is
  'The permission matrix of §2.4 as rows. `allow = false` is an explicit deny, which is not the same as a missing row.';

create index if not exists role_permissions_role_idx on public.role_permissions (role, operation);

create or replace trigger role_permissions_updated_at
  before update on public.role_permissions
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- approval_policies — money's magnitude dimension. Built, and off.
--
-- matrix: approval_policies | owner: r | office: r | crew_lead: - | crew: - | viewer: - | agent: -
--
-- OWNER RULING, 2026-09-06 (Decision record §17): the seed is owner-only with
-- `auto = false` on every row. No threshold and no policy approves a money
-- action today. There is deliberately NO constraint enforcing that — widening
-- is the owner's grant, not a deploy — so the seed below is the ruling and the
-- migration test asserts it holds as shipped.
--
-- A row with auto = true approves below its threshold and stamps
-- approved_by_kind = 'policy', approved_by_ref = approval_policies.id, so
-- "who approved" is never empty.
-- ---------------------------------------------------------------------------
create table if not exists public.approval_policies (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  action_type    text not null
                 check (action_type in ('read', 'capture', 'job', 'money',
                                        'comms', 'external', 'schedule', 'admin')),
  operation      text,
  division_id    uuid,
  max_amount_usd numeric(12,2),
  approver_role  text not null
                 check (approver_role in ('owner', 'office', 'crew_lead')),
  auto           boolean not null default false,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.approval_policies is
  'Who approves what, and up to how much. Seeded owner-only with auto = false per the owner ruling of 2026-09-06 (Decision record §17).';

create index if not exists approval_policies_lookup_idx
  on public.approval_policies (action_type, operation, division_id)
  where active;

create or replace trigger approval_policies_updated_at
  before update on public.approval_policies
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- proposals — every write, before it happens. Supersedes pending_actions.
--
-- matrix: proposals | owner: r | office: r(division) | crew_lead: r(own) | crew: r(own) | viewer: - | agent: r(own)
--
--   proposed → approved | declined | expired | superseded
--   approved → executing → executed | failed
--
-- `input` is immutable after insert (trigger below); an edit before approval
-- goes to `edited_params` so the record still shows what was proposed. Every
-- transition emits an event. A schedule proposal is ONE row whose input holds
-- N assignments and is applied atomically. A repeat `idempotency_key` returns
-- the existing row.
-- ---------------------------------------------------------------------------
create table if not exists public.proposals (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  division_id       uuid,

  -- what is being proposed
  operation         text not null,                    -- 'invoice.add_line@1'
  action_type       text not null
                    check (action_type in ('read', 'capture', 'job', 'money',
                                           'comms', 'external', 'schedule', 'admin')),
  input             jsonb not null default '{}'::jsonb,
  input_schema_hash text,
  edited_params     jsonb,

  -- who proposed it, and through what
  proposed_by_kind  text not null
                    check (proposed_by_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  proposed_by_id    uuid,
  proposed_via      text not null
                    check (proposed_via in ('ui', 'chip', 'agent', 'cron', 'sms', 'mcp', 'voice')),
  -- The agent_runs FK is added by the migration that creates agent_runs; the
  -- column exists now so op_propose has somewhere to put the run id.
  agent_run_id      uuid,
  rationale         text,
  evidence_refs     jsonb not null default '[]'::jsonb,

  -- what it is about
  job_id            uuid,
  claim_id          uuid,

  -- who it is waiting on
  assigned_role     text check (assigned_role in ('owner', 'office', 'crew_lead', 'crew')),
  assignee_id       uuid,
  escalate_after    timestamptz,
  -- Allocated by a sequence inside op_propose, unique only among live
  -- proposals — which is what lets "YES 12" be two digits forever. This index
  -- deletes the two app-side "lowest free integer" allocators in
  -- qb-time-proxy/index.ts:345-356 and roybal-brief/index.ts:262-266.
  sms_code          integer,

  status            text not null default 'proposed'
                    check (status in ('proposed', 'approved', 'declined', 'expired',
                                      'superseded', 'executing', 'executed', 'failed')),
  expires_at        timestamptz not null default (now() + interval '24 hours'),

  -- the decision
  approved_by_kind  text check (approved_by_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  approved_by_ref   uuid,
  approved_via      text check (approved_via in ('inbox', 'chip', 'sms', 'policy', 'override', 'voice')),
  -- §2.7 / 08 §2.7: what backed a spoken approval. null for a channel that is
  -- its own second factor.
  second_factor     text check (second_factor in ('sms', 'inbox', 'pin')),
  approved_at       timestamptz,
  decline_reason    text,

  -- the execution
  execution_job_id  uuid,     -- → jobs_queue(id), added below
  executed_event_id bigint,   -- → events(id),     added below
  result            jsonb,
  error             text,

  supersedes_id     uuid references public.proposals (id) on delete set null,
  idempotency_key   text not null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint proposals_idempotency_key_key unique (idempotency_key),
  -- An approved row says who approved it and how. §7.3's verify step reads
  -- "approved_by_kind is never null"; this is that sentence as a constraint.
  constraint proposals_approval_recorded check (
    status not in ('approved', 'executing', 'executed', 'failed')
    or (approved_by_kind is not null and approved_via is not null and approved_at is not null)
  )
);

comment on table public.proposals is
  'Every write anything wants to make, before it happens. Supersedes pending_actions, which stays live until P2 (§2.2, §7.3).';

create sequence if not exists public.proposals_sms_code_seq as integer start with 1 cycle maxvalue 9999;
comment on sequence public.proposals_sms_code_seq is
  'Allocates proposals.sms_code inside op_propose. Cycles: the partial unique index below is what keeps a code unique among LIVE proposals, so two digits suffice however many proposals the company ever files.';
revoke all on sequence public.proposals_sms_code_seq from anon, authenticated;
grant usage on sequence public.proposals_sms_code_seq to service_role;

create unique index if not exists proposals_live_sms_code_key
  on public.proposals (org_id, sms_code)
  where status = 'proposed' and sms_code is not null;

create index if not exists proposals_inbox_idx
  on public.proposals (org_id, status, division_id, assigned_role, assignee_id)
  where status = 'proposed';
create index if not exists proposals_expiry_idx
  on public.proposals (expires_at)
  where status = 'proposed';
create index if not exists proposals_job_idx on public.proposals (job_id) where job_id is not null;
create index if not exists proposals_claim_idx on public.proposals (claim_id) where claim_id is not null;
create index if not exists proposals_proposed_by_idx on public.proposals (proposed_by_id) where proposed_by_id is not null;
create index if not exists proposals_supersedes_idx on public.proposals (supersedes_id) where supersedes_id is not null;
create index if not exists proposals_agent_run_idx on public.proposals (agent_run_id) where agent_run_id is not null;
create index if not exists proposals_execution_job_idx on public.proposals (execution_job_id) where execution_job_id is not null;
create index if not exists proposals_executed_event_idx on public.proposals (executed_event_id) where executed_event_id is not null;

create or replace trigger proposals_updated_at
  before update on public.proposals
  for each row execute function public.touch_updated_at();


-- `input` is the record of what was proposed. If an approver changes something
-- before approving, that belongs in `edited_params` beside it — otherwise the
-- audit trail says the owner approved a thing nobody ever proposed.
create or replace function public.proposals_input_immutable() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  if new.input is distinct from old.input then
    raise exception
      'proposals.input is immutable after insert (proposal %); record the change in edited_params',
      old.id
      using errcode = 'restrict_violation';
  end if;
  if new.operation is distinct from old.operation or new.action_type is distinct from old.action_type then
    raise exception
      'proposals.operation and action_type are immutable after insert (proposal %); supersede the row instead',
      old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

alter function public.proposals_input_immutable() owner to postgres;

create or replace trigger proposals_input_immutable
  before update on public.proposals
  for each row execute function public.proposals_input_immutable();


-- ---------------------------------------------------------------------------
-- events — append-only. What did happen.
--
-- matrix: events | owner: r | office: r(division) | crew_lead: r(own) | crew: r(own) | viewer: r | agent: r(own)
--
-- No UPDATE and no DELETE for any role INCLUDING the service role — the trigger
-- raises regardless of who is asking, because an audit table a compromised
-- service key can rewrite is not an audit table. A wrong fact is corrected by a
-- compensating event, never by an edit (§3.4, soft delete). Retention: kept;
-- month-partitioning is a P5 item (§2.2, "Retention, honestly").
--
-- Inserts happen through emit_event() SECURITY DEFINER, which every op_* body
-- calls in its own transaction. That function lands with the ops; until then
-- only the service role can insert, which is what the grants below say.
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  org_id          uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  division_id     uuid,

  principal_kind  text not null
                  check (principal_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  principal_id    uuid,

  kind            text not null,     -- 'proposal.approved', 'equipment.placed', …
  operation       text,              -- 'invoice.add_line@1'

  aggregate_type  text,
  aggregate_id    uuid,
  job_id          uuid,
  claim_id        uuid,
  proposal_id     uuid,              -- → proposals(id), added below

  correlation_id  uuid,
  causation_id    bigint references public.events (id) on delete set null,

  data            jsonb not null default '{}'::jsonb,
  idempotency_key text
);

comment on table public.events is
  'Append-only audit log. UPDATE and DELETE raise for every role including service_role; inserts go through emit_event() (§2.2).';

create unique index if not exists events_idempotency_key
  on public.events (idempotency_key)
  where idempotency_key is not null;

-- One heap with a monthly index, per §2.2's retention paragraph.
create index if not exists events_at_idx on public.events (at desc);
create index if not exists events_org_at_idx on public.events (org_id, at desc);
create index if not exists events_kind_at_idx on public.events (kind, at desc);
create index if not exists events_job_idx on public.events (job_id, at desc) where job_id is not null;
create index if not exists events_claim_idx on public.events (claim_id, at desc) where claim_id is not null;
create index if not exists events_proposal_idx on public.events (proposal_id) where proposal_id is not null;
create index if not exists events_principal_idx on public.events (principal_id, at desc) where principal_id is not null;
create index if not exists events_aggregate_idx on public.events (aggregate_type, aggregate_id) where aggregate_id is not null;
create index if not exists events_correlation_idx on public.events (correlation_id) where correlation_id is not null;
create index if not exists events_causation_idx on public.events (causation_id) where causation_id is not null;


create or replace function public.events_append_only() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  raise exception
    'public.events is append-only: % is not permitted for any role. Correct a wrong fact with a compensating event.',
    tg_op
    using errcode = 'restrict_violation';
  return null;
end;
$$;

alter function public.events_append_only() owner to postgres;

create or replace trigger events_no_update
  before update on public.events
  for each row execute function public.events_append_only();

create or replace trigger events_no_delete
  before delete on public.events
  for each row execute function public.events_append_only();

-- A row-level trigger never sees a TRUNCATE, and TRUNCATE would take the whole
-- ledger with it.
create or replace trigger events_no_truncate
  before truncate on public.events
  for each statement execute function public.events_append_only();


-- ---------------------------------------------------------------------------
-- jobs_queue — work the worker leases.
--
-- matrix: jobs_queue | owner: r | office: r | crew_lead: - | crew: - | viewer: - | agent: -
--
--   queued → leased → done | failed (retry: run_after = now() + 2^attempts min,
--                                    capped at 1 h)
--                          | dead  (attempts ≥ max_attempts)
--
-- `locked_by` and `lease_until` are COLUMNS, not a row lock: FOR UPDATE SKIP
-- LOCKED alone releases at commit, and a worker that dies mid-job would orphan
-- the row forever. The lease outliving the claiming transaction is the whole
-- point. Per-kind lease is 5 min by default, 10 min for document.render, 30 min
-- for agent.run; the worker heartbeats every 30 s and extends lease_until, and a
-- pg_cron sweeper requeues leased rows past their lease. Those three live with
-- the worker and the cron registration, not here.
--
-- Partition-free by design: the debounced projection caps at one job per job
-- per minute, which the arithmetic in §2.2 puts inside what one heap holds.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_queue (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  kind            text not null,                       -- 'job.project', 'document.render', …
  payload         jsonb not null default '{}'::jsonb,

  principal_kind  text not null default 'system'
                  check (principal_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  principal_id    uuid,

  priority        integer not null default 0,
  run_after       timestamptz not null default now(),
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,

  status          text not null default 'queued'
                  check (status in ('queued', 'leased', 'done', 'failed', 'dead')),
  locked_by       text,
  lease_until     timestamptz,
  heartbeat_at    timestamptz,
  last_error      text,

  idempotency_key text not null,
  job_id          uuid,
  correlation_id  uuid,

  created_at      timestamptz not null default now(),
  finished_at     timestamptz,

  constraint jobs_queue_idempotency_key_key unique (idempotency_key),
  constraint jobs_queue_lease_recorded check (
    status <> 'leased' or (locked_by is not null and lease_until is not null)
  )
);

comment on table public.jobs_queue is
  'The work queue. Claimed by UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) setting locked_by and lease_until as columns (§2.2).';

-- The claim statement's index: status, then priority desc, then run_after.
create index if not exists jobs_queue_claim_idx
  on public.jobs_queue (status, priority desc, run_after)
  where status = 'queued';
-- The lease sweeper's index.
create index if not exists jobs_queue_lease_idx
  on public.jobs_queue (lease_until)
  where status = 'leased';
-- The daily purge reads (status, finished_at); dead rows are read whole.
create index if not exists jobs_queue_finished_idx
  on public.jobs_queue (status, finished_at)
  where finished_at is not null;
create index if not exists jobs_queue_job_idx on public.jobs_queue (job_id) where job_id is not null;
create index if not exists jobs_queue_correlation_idx on public.jobs_queue (correlation_id) where correlation_id is not null;


-- ---------------------------------------------------------------------------
-- outbox — one row per external side effect.
--
-- matrix: outbox | owner: r | office: r | crew_lead: r(own) | crew: r(own) | viewer: r | agent: r(own)
--
--   pending → sending → sent → delivered | failed (retry) | dead
--
-- `sent` and `delivered` are different facts, and conflating them is the live
-- bug this table is shaped around: 174 of 175 outbound SMS rows are frozen at
-- `queued` because nothing settles the Twilio status callback. The monthly SMS
-- cap counts `delivered`. `sms_messages` stays the SMS log; this is the
-- delivery state.
-- ---------------------------------------------------------------------------
create table if not exists public.outbox (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  channel         text not null check (channel in ('sms', 'email', 'qbo', 'portal')),
  operation       text,
  payload         jsonb not null default '{}'::jsonb,
  idempotency_key text not null,

  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'delivered', 'failed', 'dead')),
  -- Twilio SID, Gmail id, QBO Id + SyncToken.
  provider_id     text,
  provider_status text,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  error           text,

  principal_kind  text not null default 'system'
                  check (principal_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  principal_id    uuid,
  proposal_id     uuid references public.proposals (id) on delete set null,
  job_id          uuid,
  cost_usd        numeric(12,2),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint outbox_idempotency_key_key unique (idempotency_key)
);

comment on table public.outbox is
  'One row per external side effect, with its delivery state. sent and delivered are different facts; the SMS cap counts delivered (§2.2).';

create index if not exists outbox_deliver_idx
  on public.outbox (status, next_attempt_at)
  where status in ('pending', 'sending', 'failed');
create index if not exists outbox_provider_idx
  on public.outbox (channel, provider_id)
  where provider_id is not null;
create index if not exists outbox_delivered_idx
  on public.outbox (channel, delivered_at)
  where delivered_at is not null;
create index if not exists outbox_proposal_idx on public.outbox (proposal_id) where proposal_id is not null;
create index if not exists outbox_job_idx on public.outbox (job_id) where job_id is not null;
create index if not exists outbox_principal_idx on public.outbox (principal_id) where principal_id is not null;

create or replace trigger outbox_updated_at
  before update on public.outbox
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- The three foreign keys that could not be declared inline, now that all of
-- proposals, events and jobs_queue exist.
-- ---------------------------------------------------------------------------
do $fks$
begin
  if not exists (select 1 from pg_constraint where conname = 'proposals_execution_job_id_fkey' and conrelid = 'public.proposals'::regclass) then
    alter table public.proposals
      add constraint proposals_execution_job_id_fkey
      foreign key (execution_job_id) references public.jobs_queue (id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'proposals_executed_event_id_fkey' and conrelid = 'public.proposals'::regclass) then
    alter table public.proposals
      add constraint proposals_executed_event_id_fkey
      foreign key (executed_event_id) references public.events (id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'events_proposal_id_fkey' and conrelid = 'public.events'::regclass) then
    alter table public.events
      add constraint events_proposal_id_fkey
      foreign key (proposal_id) references public.proposals (id) on delete set null;
  end if;
end
$fks$;


-- ============================================================================
-- Grants and RLS.
--
-- Read the header again before changing anything here: ALTER DEFAULT PRIVILEGES
-- in this database hands anon and authenticated GRANT ALL on every new table in
-- public. The revoke is not belt-and-braces, it is the only thing standing
-- between these tables and an anonymous DELETE.
--
-- Writes are granted to nobody but service_role. They arrive through op_*.
-- ============================================================================

alter table public.agents             enable row level security;
alter table public.agent_authority    enable row level security;
alter table public.operation_catalog  enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.approval_policies  enable row level security;
alter table public.proposals          enable row level security;
alter table public.events             enable row level security;
alter table public.jobs_queue         enable row level security;
alter table public.outbox             enable row level security;

revoke all on public.agents            from anon, authenticated;
revoke all on public.agent_authority   from anon, authenticated;
revoke all on public.operation_catalog from anon, authenticated;
revoke all on public.role_permissions  from anon, authenticated;
revoke all on public.approval_policies from anon, authenticated;
revoke all on public.proposals         from anon, authenticated;
revoke all on public.events            from anon, authenticated, service_role;
revoke all on public.jobs_queue        from anon, authenticated;
revoke all on public.outbox            from anon, authenticated;

grant select on public.agents            to authenticated;
grant select on public.agent_authority   to authenticated;
grant select on public.operation_catalog to authenticated;
grant select on public.role_permissions  to authenticated;
grant select on public.approval_policies to authenticated;
grant select on public.proposals         to authenticated;
grant select on public.events            to authenticated;
grant select on public.jobs_queue        to authenticated;
grant select on public.outbox            to authenticated;

grant all on public.agents            to service_role;
grant all on public.agent_authority   to service_role;
grant all on public.operation_catalog to service_role;
grant all on public.role_permissions  to service_role;
grant all on public.approval_policies to service_role;
grant all on public.proposals         to service_role;
grant all on public.jobs_queue        to service_role;
grant all on public.outbox            to service_role;
-- events: insert only, even for service_role. The triggers refuse UPDATE and
-- DELETE anyway; withholding the grant means the refusal is not the only thing
-- standing between a bug and the audit trail.
grant select, insert on public.events to service_role;


-- --- the admin surface: owner and office read, nobody writes ----------------

drop policy if exists agents_read_admin on public.agents;
create policy agents_read_admin on public.agents
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office'));

drop policy if exists agent_authority_read_admin on public.agent_authority;
create policy agent_authority_read_admin on public.agent_authority
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office'));

drop policy if exists role_permissions_read_admin on public.role_permissions;
create policy role_permissions_read_admin on public.role_permissions
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office'));

drop policy if exists approval_policies_read_admin on public.approval_policies;
create policy approval_policies_read_admin on public.approval_policies
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office'));

-- The queue is worker internals. Crews have no use for it and every row names
-- a lane rather than a job they are on.
drop policy if exists jobs_queue_read_admin on public.jobs_queue;
create policy jobs_queue_read_admin on public.jobs_queue
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office'));


-- --- the catalog: every signed-in principal may read the tool list ----------

drop policy if exists operation_catalog_read on public.operation_catalog;
create policy operation_catalog_read on public.operation_catalog
  for select to authenticated
  using (true);


-- --- proposals: the inbox scoping of §2.2 ----------------------------------
--
-- "mine (assignee_id) ∪ my role in my division ∪ unassigned in my division",
-- plus what the caller proposed themselves. Crew reads stay division-wide
-- until job_assignments and assigned_job_ids() land in P3 (§7.3) — at which
-- point the crew branch gains `job_id = any ((select assigned_job_ids()))`.

drop policy if exists proposals_read_owner on public.proposals;
create policy proposals_read_owner on public.proposals
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) = 'owner');

drop policy if exists proposals_read_scoped on public.proposals;
create policy proposals_read_scoped on public.proposals
  for select to authenticated
  using (
    org_id = (select public.current_org())
    and (select public.current_role_name()) in ('office', 'crew_lead', 'crew')
    and (
      assignee_id = (select public.current_principal())
      or proposed_by_id = (select public.current_principal())
      or assigned_role = (select public.current_role_name())
      or assigned_role is null
    )
  );


-- --- the ledgers: read down the roles, write through nothing ----------------

drop policy if exists events_read_office on public.events;
create policy events_read_office on public.events
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office', 'viewer'));

drop policy if exists events_read_own on public.events;
create policy events_read_own on public.events
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('crew_lead', 'crew')
         and principal_id = (select public.current_principal()));

drop policy if exists outbox_read_office on public.outbox;
create policy outbox_read_office on public.outbox
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office', 'viewer'));

drop policy if exists outbox_read_own on public.outbox;
create policy outbox_read_own on public.outbox
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('crew_lead', 'crew')
         and principal_id = (select public.current_principal()));


-- ============================================================================
-- Seeds.
-- ============================================================================

-- --- the six machine principals of §7.3 -------------------------------------
--
-- Fixed ids, not gen_random_uuid(): services/worker selects its principal per
-- queue kind from a table of these, and a later migration granting one of them
-- an authority row has to be able to name it. The principals §4 names for later
-- lanes (agent:integrations, agent:correspondence, agent:collections,
-- agent:worker, agent:intake, agent:mcp) are added by the migration of the
-- phase whose lane first runs under them (§3.7).
--
-- Every one of them starts with NO agent_authority row, which is the point:
-- deny by default, and the owner widens each one deliberately.
insert into public.agents (id, name, kind, enabled, created_by_kind) values
  ('193d7dd0-74f9-407d-9891-8cb7aab22f82', 'agent:billing',    'automation', true, 'system'),
  ('a40bbef2-cf95-4b7f-85bf-4712534e8217', 'agent:projection', 'automation', true, 'system'),
  ('0a7ac824-5042-4bb5-ab0d-8569cea209b1', 'agent:outbox',     'automation', true, 'system'),
  ('1af33481-7f1c-4485-87f5-7b0ec5e27554', 'agent:brief',      'automation', true, 'system'),
  ('4b3353d3-6b71-49f6-94df-c79b959f0eb5', 'agent:phone',      'channel',    true, 'system'),
  ('951f7f7d-eb77-4cda-9d98-1db89cf30541', 'agent:web',        'channel',    true, 'system')
on conflict (id) do nothing;


-- --- the permission matrix of §2.4, at action-type granularity ---------------
--
-- §8.5 step 5 says these rows are generated from the op definitions by
-- ops-catalog. That generator does not exist yet and neither does an op, so the
-- seed below is the matrix at the action-type wildcard level — the granularity
-- the document's own table is written at. Per-operation rows override the
-- wildcard when the generator starts emitting them.
--
-- The `agent` rows are a CEILING, not a grant: an agent also needs an
-- agent_authority row, and has none. Both have to allow.
--
-- Two departures from the matrix as printed, both deliberate:
--   * office × money × approve is allow = false. The matrix gives office
--     approval up to a threshold, but the owner's 2026-09-06 ruling is that
--     every money action reaches him. The capability is present and off; the
--     owner widens it with role.grant after an office hire, not with a deploy.
--   * crew and crew_lead scopes read 'division' where the matrix says
--     'assigned', because job_assignments does not exist until P3 and §7.3
--     states crew reads stay division-wide until it does.
insert into public.role_permissions (role, operation, capability, scope, allow, conditions) values
  -- read
  ('owner',     'read:*',     'read',    'all',      true,  '{}'),
  ('office',    'read:*',     'read',    'division', true,  '{}'),
  ('crew_lead', 'read:*',     'read',    'division', true,  '{}'),
  ('crew',      'read:*',     'read',    'division', true,  '{}'),
  ('viewer',    'read:*',     'read',    'division', true,  '{}'),
  ('agent',     'read:*',     'read',    'all',      true,  '{}'),

  -- capture
  ('owner',     'capture:*',  'execute', 'all',      true,  '{}'),
  ('office',    'capture:*',  'execute', 'division', true,  '{}'),
  ('crew_lead', 'capture:*',  'execute', 'division', true,  '{}'),
  ('crew',      'capture:*',  'execute', 'division', true,  '{}'),
  ('viewer',    'capture:*',  'execute', 'all',      false, '{}'),
  ('agent',     'capture:*',  'propose', 'all',      true,  '{}'),

  -- job
  ('owner',     'job:*',      'execute', 'all',      true,  '{}'),
  ('office',    'job:*',      'execute', 'division', true,  '{}'),
  ('crew_lead', 'job:*',      'execute', 'division', true,  '{}'),
  ('crew_lead', 'job:*',      'propose', 'division', true,  '{}'),
  ('crew',      'job:*',      'propose', 'division', true,  '{}'),
  ('viewer',    'job:*',      'propose', 'all',      false, '{}'),
  ('agent',     'job:*',      'propose', 'all',      true,  '{}'),

  -- money — the owner ruling of 2026-09-06 is what the office rows encode
  ('owner',     'money:*',    'approve', 'all',      true,  '{}'),
  ('owner',     'money:*',    'execute', 'all',      true,  '{}'),
  ('office',    'money:*',    'execute', 'division', true,  '{"drafts_only": true}'),
  ('office',    'money:*',    'approve', 'division', false, '{"widen_with": "role.grant", "ruling": "2026-09-06 owner-only"}'),
  ('office',    'money:*',    'propose', 'division', true,  '{}'),
  ('crew_lead', 'money:*',    'propose', 'division', true,  '{}'),
  ('crew',      'money:*',    'propose', 'all',      false, '{}'),
  ('viewer',    'money:*',    'propose', 'all',      false, '{}'),
  ('agent',     'money:*',    'propose', 'all',      true,  '{}'),

  -- comms — the 7am-8pm Alaska window is a condition here, not a constant in
  -- three different files. No kind is exempt: exempting the crew-line kinds is
  -- an owner option recorded in 04-OPEN-QUESTIONS, not an assumption.
  ('owner',     'comms:*',    'approve', 'all',      true,  '{}'),
  ('owner',     'comms:*',    'execute', 'all',      true,  '{}'),
  ('office',    'comms:*',    'approve', 'division', true,  '{}'),
  ('office',    'comms:*',    'execute', 'division', true,  '{}'),
  ('crew_lead', 'comms:*',    'propose', 'division', true,  '{}'),
  ('crew_lead', 'comms:*',    'execute', 'division', true,
     '{"kinds": ["crewSchedule", "onOurWay", "crewLine"], "quiet_hours": {"start": "07:00", "end": "20:00", "tz": "America/Anchorage"}}'),
  ('crew',      'comms:*',    'propose', 'division', true,  '{}'),
  ('crew',      'comms:*',    'execute', 'division', true,
     '{"kinds": ["onOurWay", "crewLine"], "quiet_hours": {"start": "07:00", "end": "20:00", "tz": "America/Anchorage"}}'),
  ('viewer',    'comms:*',    'propose', 'all',      false, '{}'),
  ('agent',     'comms:*',    'propose', 'all',      true,  '{}'),

  -- external
  ('owner',     'external:*', 'approve', 'all',      true,  '{}'),
  ('owner',     'external:*', 'execute', 'all',      true,  '{}'),
  ('office',    'external:*', 'approve', 'division', true,  '{}'),
  ('office',    'external:*', 'execute', 'division', true,  '{"pulls_only": true}'),
  ('crew_lead', 'external:*', 'propose', 'all',      false, '{}'),
  ('crew',      'external:*', 'propose', 'all',      false, '{}'),
  ('viewer',    'external:*', 'propose', 'all',      false, '{}'),
  ('agent',     'external:*', 'execute', 'all',      true,  '{"pulls_only": true}'),

  -- schedule
  ('owner',     'schedule:*', 'approve', 'all',      true,  '{}'),
  ('owner',     'schedule:*', 'execute', 'all',      true,  '{}'),
  ('office',    'schedule:*', 'approve', 'division', true,  '{}'),
  ('office',    'schedule:*', 'execute', 'division', true,  '{}'),
  ('crew_lead', 'schedule:*', 'approve', 'division', true,  '{}'),
  ('crew_lead', 'schedule:*', 'execute', 'division', true,  '{}'),
  ('crew',      'schedule:*', 'execute', 'own',      true,  '{"operations": ["availability.set"]}'),
  ('crew',      'schedule:*', 'propose', 'division', true,  '{}'),
  ('viewer',    'schedule:*', 'propose', 'all',      false, '{}'),
  ('agent',     'schedule:*', 'propose', 'all',      true,  '{}'),

  -- admin
  ('owner',     'admin:*',    'execute', 'all',      true,  '{}'),
  ('office',    'admin:*',    'read',    'all',      true,  '{}'),
  ('office',    'admin:*',    'execute', 'all',      false, '{}'),
  ('crew_lead', 'admin:*',    'read',    'all',      false, '{}'),
  ('crew',      'admin:*',    'read',    'all',      false, '{}'),
  ('viewer',    'admin:*',    'read',    'all',      false, '{}'),
  ('agent',     'admin:*',    'read',    'all',      false, '{}'),

  -- the ledgers: events, ai_usage, agent_runs, outbox, integration_runs
  ('owner',     'ledgers:*',  'read',    'all',      true,  '{}'),
  ('office',    'ledgers:*',  'read',    'all',      true,  '{}'),
  ('crew_lead', 'ledgers:*',  'read',    'own',      true,  '{}'),
  ('crew',      'ledgers:*',  'read',    'own',      true,  '{}'),
  ('viewer',    'ledgers:*',  'read',    'all',      true,  '{}'),
  ('agent',     'ledgers:*',  'read',    'own',      true,  '{}')
on conflict (org_id, role, operation, capability) do nothing;


-- --- approval_policies: owner-only, auto = false ----------------------------
--
-- Decision record §17, the owner ruling of 2026-09-06. One row per action type
-- that has anything to approve, every one of them owner, every one of them
-- auto = false, and max_amount_usd null — there is no threshold, so nothing is
-- below one. Widening is the owner's role.grant, not a deploy, which is why
-- there is no constraint forbidding the other shape; the migration test asserts
-- the seed ships as ruled.
insert into public.approval_policies (action_type, operation, division_id, max_amount_usd, approver_role, auto, active)
select t.action_type, null, null, null, 'owner', false, true
  from unnest(array['money', 'comms', 'external', 'schedule', 'job', 'admin']) as t(action_type)
 where not exists (
   select 1 from public.approval_policies p
    where p.action_type = t.action_type
      and p.operation is null
      and p.division_id is null
 );
