-- ============================================================================
-- 0020 — an agent login reads the outbox rows of the proposals it filed, so
--        the brief can see that a reminder it was approved for never went out
--        (spine step 5, review round 2).
--
-- WHAT IT IS FOR: the morning brief's 7-day "already reminded this invoice"
-- check (roybal-brief, reminders.ts) holds an invoice while its spine reminder
-- is proposed, approved, executing or executed. On the spine, executed only
-- means queued: op_exec_email_send (0014) wrote the outbox row and the worker
-- delivers it. When the worker gives the row up (dead: Gmail refused it for
-- good, it ran out of tries, or it waited longer than EMAIL_MAX_AGE_HOURS for
-- a worker with email on), nothing writes back to the proposal, so the brief
-- went on holding the invoice for the rest of the week and nothing offered
-- the reminder again. The old lane did: a failed gmail-proxy send left the
-- pending_actions row 'failed', which the check does not hold, and the next
-- morning's brief offered it once more. To do the same, the brief reads, for
-- the ids of its executed reminders,
--   outbox?proposal_id=in.(<ids>)&select=proposal_id,status&limit=200
-- and releases an invoice whose email is dead and was never sent. 0004 gave
-- an agent login no read on outbox (owner/office/viewer read the org's rows,
-- crew_lead/crew the rows they are the principal of), so until this file that
-- read answers [] under RLS (never an error) and the brief holds everything,
-- as it did before.
--
--   outbox_read_own_agent     an agent login reads the outbox rows whose
--                             proposal it filed (proposed_by_kind 'agent',
--                             proposed_by_id its current_agent_id())
--
-- WHY THE PROPOSAL AND NOT principal_id: an outbox row's principal is whoever
-- approved the send (op_execute hands the executor the approver), so for the
-- brief's reminder it is the owner, never agent:brief. "Own" for an agent is
-- the rows its proposals produced. The exists below reads proposals as the
-- caller; proposals_read_own_agent (0019) lets an agent login read exactly the
-- rows it filed, which are the ones this asks about. What the brief can read
-- in such a row (to, subject, body, status, error) is what it proposed, or
-- the owner's edit of it, plus whether it went out.
--
-- WHO: the policy is for authenticated, like every outbox read policy; the
-- table grant does not change (authenticated already holds SELECT on outbox,
-- and nothing else, since 0004). No functions.
--
-- Census: +1 policy; tables, triggers, views, enums, functions, primary keys
-- and unique constraints unchanged.
-- Roles: an agent login gains read on the outbox rows of the proposals it
-- filed and nothing else (not another agent's, not a person's, not another
-- org's, not a row with no proposal); owner, office, crew_lead, crew and
-- viewer read exactly what they read before; anon gains nothing.
--
-- Additive: dropping the policy restores the schema exactly as it was, and the
-- brief goes back to holding a dead reminder for the week; nothing else reads
-- through it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. outbox_read_own_agent — an agent login reads the outbox rows of the
--    proposals it filed.
--
-- matrix (0004, doc 04): outbox | agent: r(own). The same identity test as
-- proposals_read_own_agent: the role is 'agent' and current_agent_id() is the
-- enabled agents row the login is linked to, so a person whose login is linked
-- to an agents row by mistake, a disabled agent and anon read nothing new. The
-- 0004 policies stand as they are.
-- ---------------------------------------------------------------------------
drop policy if exists outbox_read_own_agent on public.outbox;
create policy outbox_read_own_agent on public.outbox
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) = 'agent'
         and exists (select 1
                       from public.proposals p
                      where p.id = outbox.proposal_id
                        and p.proposed_by_kind = 'agent'
                        and p.proposed_by_id = (select public.current_agent_id())));
