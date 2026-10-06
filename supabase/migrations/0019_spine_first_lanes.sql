-- ============================================================================
-- 0019 — spine-first lanes: the brief's overdue-invoice reminder and the
--        adjuster email become proposals, with one "YES n" number space
--        across both approval queues (spine step 5).
--
-- WHAT IT IS FOR: the reminder the morning brief offers and the adjuster
-- email the narrative page drafts both become email.send proposals in the
-- Approvals inbox, and approving one sends it once, logged (03 §7.3 "Lanes
-- migrated"). The spine already makes the send exactly-once (0013 row lock,
-- approve-twice is a no-op, 0014's unique outbox key). What it lacked is
-- everything around the two callers:
--
--   current_agent_id()            which agents row a signed-in machine login
--                                 is: the uuid proposed_by_id holds for an
--                                 agent's proposal, which auth.uid() is not
--   proposals_read_own_agent      an agent login reads the proposals it filed,
--                                 so the brief's 7-day "already reminded this
--                                 invoice" check sees spine rows too (0004
--                                 gave agents no read on proposals at all)
--   sms_codes_in_use()            every code a text-lane ask (pending_actions
--                                 .code) or a live proposal (sms_code) holds;
--                                 the three JS allocators of pending_actions
--                                 codes skip them all
--   proposals_sms_code_skip_text  BEFORE INSERT on proposals: a new sms_code
--                                 never lands on a code a pending text-lane
--                                 ask holds. With the allocators above, one
--                                 "YES 12" names one ask in one queue.
--   outbox_channel_ready(ch)      is a worker heartbeating in the last 10
--                                 minutes with this channel switched on? The
--                                 brief files on the spine only when email is,
--                                 and the narrative page offers "Send for
--                                 approval" only then; production runs ["sms"]
--                                 until the Gmail pair is set on Fly
--   agent:brief may propose       the first agent_authority row: propose
--   email.send                    only, never execute or approve, recorded with
--                                 an agent_authority.granted event
--
-- THE CODE SPACES. pending_actions.code is the lowest free number from 11
-- among status = 'pending' rows (roybal-brief takeCode, roybal-notify
-- sms-assist, qb-time-proxy takeCodes); proposals.sms_code comes from
-- proposals_sms_code_seq (1..9999, cycling) and is unique among live
-- proposals (0004 proposals_live_sms_code_key). Nothing kept the two apart,
-- so "YES 12" could match one row in each. From here: the JS side skips every
-- code sms_codes_in_use() returns, and the trigger moves a new proposal off
-- any code a pending ask holds by taking further sequence values. The trigger
-- does not look at live proposals: op_propose's own loop and the unique index
-- already do, and a unique_violation the trigger causes is retried by
-- op_propose's existing handler with a fresh code. Expired-but-still-pending
-- text asks count as held, as the JS allocators already treat them.
--
-- THE GRANT. 0004's rule is that a machine gets its grants from the owner,
-- one at a time, with an event. The agent_authority.grant operation does not
-- exist yet, so this file writes the one row the owner approved for step 5
-- (2026-10-06) and its event; contract_tables.test.sql now pins exactly that
-- row. It is skipped when any email.send propose row for agent:brief has ever
-- existed, so re-applying the file never revives a grant the owner revoked.
--
-- WHO: current_agent_id, sms_codes_in_use and outbox_channel_ready are
-- SECURITY DEFINER reads for authenticated and service_role (an agent login
-- cannot read agents, worker_heartbeats or other people's proposals itself);
-- the trigger function is callable by nobody. Owner postgres throughout.
--
-- Census: +4 functions, +1 policy, +1 trigger; tables, views, enums, primary
-- keys and unique constraints unchanged. The grant is a data row.
-- Roles: an agent login gains read on the proposals it filed and nothing
-- else; owner, office, crew_lead, crew and viewer read exactly what they read
-- before; anon gains nothing.
--
-- Additive: dropping the trigger, the policy and the four functions restores
-- the schema exactly as it was; revoking the grant (revoked_at = now(); the
-- row and its event stay, events is append-only) puts agent:brief back to
-- proposing nothing. The brief needs neither to roll back: REMINDERS_LANE=text
-- on roybal-brief sends it down the old lane, and it falls back by itself
-- whenever outbox_channel_ready('email') is not true or op_propose refuses.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. current_agent_id — the agents row a signed-in machine login acts as.
--
-- The same answer op_resolve_caller gives a login whose role is 'agent'
-- (0013): an enabled agents row in the caller's org linked through
-- auth_user_id. A person (even one whose login is linked to an agents row by
-- mistake), a disabled agent and the service role get null; anon cannot call
-- it. SECURITY DEFINER because agents is readable by owner and office only
-- (0004).
-- ---------------------------------------------------------------------------
create or replace function public.current_agent_id() returns uuid
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select a.id
    from public.agents a
   where a.auth_user_id = (select auth.uid())
     and a.enabled
     and a.org_id = public.current_org()
     and public.current_role_name() = 'agent'
   order by a.created_at, a.id
   limit 1;
$$;

alter function public.current_agent_id() owner to postgres;
comment on function public.current_agent_id() is
  'The enabled agents.id a signed-in machine login (profile role agent) is linked to through auth_user_id, else null: the id op_propose records as proposed_by_id for that login. Used by the proposals_read_own_agent policy (0019).';
revoke all on function public.current_agent_id() from public, anon, authenticated;
grant execute on function public.current_agent_id() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. proposals_read_own_agent — an agent login reads the proposals it filed.
--
-- matrix (03 §2.4, doc 04): proposals | agent: r(own). Nothing else changes:
-- the owner and the scoped office/crew policies of 0004 stand as they are.
-- The brief reads its own email.send rows for its 7-day per-invoice check
-- (evidence_refs {kind: "invoice", id}); before this it read none.
-- ---------------------------------------------------------------------------
drop policy if exists proposals_read_own_agent on public.proposals;
create policy proposals_read_own_agent on public.proposals
  for select to authenticated
  using (org_id = (select public.current_org())
         and proposed_by_kind = 'agent'
         and proposed_by_id = (select public.current_agent_id()));


-- ---------------------------------------------------------------------------
-- 3. sms_codes_in_use — every "YES n" number something can still answer.
--
-- Every pending_actions.code with status = 'pending' (expired ones included,
-- the rule the JS allocators already follow) plus every proposals.sms_code
-- with status = 'proposed' in the caller's org (stale ones included: the
-- unique index still holds them until op_propose's sweep). Distinct,
-- ascending, '{}' when none. pending_actions has no org column.
-- ---------------------------------------------------------------------------
create or replace function public.sms_codes_in_use() returns integer[]
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(array_agg(c.code order by c.code), '{}'::integer[])
    from (
      select pa.code
        from public.pending_actions pa
       where pa.status = 'pending' and pa.code is not null
      union
      select p.sms_code
        from public.proposals p
       where p.status = 'proposed' and p.sms_code is not null
         and p.org_id = public.current_org()
    ) c;
$$;

alter function public.sms_codes_in_use() owner to postgres;
comment on function public.sms_codes_in_use() is
  'Every SMS approval code in use across both queues: pending_actions.code of status pending rows plus proposals.sms_code of live (status proposed) rows in the caller''s org; distinct, ascending, ''{}'' when none. The pending_actions code allocators skip all of them (0019).';
revoke all on function public.sms_codes_in_use() from public, anon, authenticated;
grant execute on function public.sms_codes_in_use() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. proposals_sms_code_skip_text — a new proposal never takes a code a
--    pending text-lane ask holds.
--
-- op_propose picks a code free among live proposals, then inserts; this moves
-- it on through the same sequence while a pending pending_actions row holds
-- it. op_propose reads the row back with RETURNING, so the code it reports
-- (and writes into proposal.created) is the one this settled on. Bounded:
-- 10000 tries is more than the whole 1..9999 cycle, so running out means
-- every code is held, and the insert is refused rather than given a clash.
-- ---------------------------------------------------------------------------
create or replace function public.proposals_sms_code_skip_text() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_tries integer := 0;
begin
  if new.sms_code is null then
    return new;
  end if;
  while exists (select 1 from public.pending_actions pa
                 where pa.status = 'pending' and pa.code = new.sms_code) loop
    v_tries := v_tries + 1;
    if v_tries > 10000 then
      raise exception 'proposals: every SMS code is held by a pending text-lane ask';
    end if;
    new.sms_code := nextval('public.proposals_sms_code_seq');
  end loop;
  return new;
end;
$$;

alter function public.proposals_sms_code_skip_text() owner to postgres;
comment on function public.proposals_sms_code_skip_text() is
  'BEFORE INSERT on proposals: while a status pending pending_actions row holds new.sms_code, take the next proposals_sms_code_seq value, so one "YES n" never names an ask in each queue (0019). Live-proposal uniqueness stays with op_propose and proposals_live_sms_code_key.';
-- Not callable over RPC as a trigger function anyway; nobody holds EXECUTE.
revoke all on function public.proposals_sms_code_skip_text() from public, anon, authenticated, service_role;

create or replace trigger proposals_sms_code_skip_text
  before insert on public.proposals
  for each row execute function public.proposals_sms_code_skip_text();


-- ---------------------------------------------------------------------------
-- 5. outbox_channel_ready — would an outbox row on this channel go out now?
--
-- True only while some worker has heartbeated in the last 10 minutes (the
-- staleness worker_liveness_check alarms on) with the channel listed in
-- meta.channels as a JSON string element. The worker drops "email" from that
-- list unless the Gmail pair is set (services/worker/config.mjs), so
-- outbox_channel_ready('email') is the lane switch both callers read. Any
-- other shape of meta.channels, or a null channel, is false.
-- ---------------------------------------------------------------------------
create or replace function public.outbox_channel_ready(p_channel text) returns boolean
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select p_channel is not null
     and exists (
       select 1 from public.worker_heartbeats h
        where h.at > now() - interval '10 minutes'
          and jsonb_typeof(h.meta -> 'channels') = 'array'
          and (h.meta -> 'channels') @> jsonb_build_array(p_channel)
     );
$$;

alter function public.outbox_channel_ready(text) owner to postgres;
comment on function public.outbox_channel_ready(text) is
  'True iff a worker_heartbeats row is under 10 minutes old and lists p_channel in meta.channels. The brief files reminders on the spine, and the narrative page offers the adjuster email for approval, only while outbox_channel_ready(''email'') is true (0019).';
revoke all on function public.outbox_channel_ready(text) from public, anon, authenticated;
grant execute on function public.outbox_channel_ready(text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. agent:brief may PROPOSE email.send — the owner's go, 2026-10-06.
--
-- op_agent_permits matches agent_authority.operation against the unversioned
-- name ('email.send') or the type wildcard ('comms:*'), never 'email.send@1'
-- (0013). Propose only: the brief cannot send, and no agent can approve.
-- sms.send, job.set_stage and everything else stay refused.
-- ---------------------------------------------------------------------------
do $$
declare
  v_agent  constant uuid := '1af33481-7f1c-4485-87f5-7b0ec5e27554';   -- agent:brief (0004 seed)
  v_reason constant text :=
    'Spine step 5: the morning brief files each overdue-invoice reminder as an email.send proposal; '
    || 'the owner approves every one. Granted by migration 0019 on the owner''s go, 2026-10-06.';
  v_id     uuid;
begin
  if not exists (select 1 from public.agents where id = v_agent) then
    raise exception '0019: agent:brief (agents %) is missing; 0004 seeds it', v_agent;
  end if;

  insert into public.agent_authority as aa
    (agent_id, operation, capability, granted_by_kind, granted_by_id, reason)
  select v_agent, 'email.send', 'propose', 'system', null, v_reason
   where not exists (select 1 from public.agent_authority x
                      where x.agent_id = v_agent and x.operation = 'email.send'
                        and x.capability = 'propose')
  on conflict (agent_id, operation, capability) where revoked_at is null do nothing
  returning aa.id into v_id;

  if v_id is not null then
    perform public.emit_event(
      'agent_authority.granted', null, 'agent_authority', v_id, null, null, null,
      jsonb_build_object('agent_id', v_agent, 'agent', 'agent:brief',
                         'operation', 'email.send', 'capability', 'propose',
                         'reason', v_reason, 'granted_by', 'migration 0019'),
      'agent_authority.granted:' || v_id, 'system', null);
  end if;
end
$$;
