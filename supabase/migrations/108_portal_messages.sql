-- ============================================================
-- Roybal — portal_messages: the customer <-> office conversation
-- for a shared job. One row per message on a job's portal thread.
--
-- This is the communication backbone of the portal. A message is
-- either INBOUND (from the customer, typed on portal.roybalconstruction.com)
-- or OUTBOUND (from the office / an AI draft the office approved). The
-- thread spans channels: today `portal`; `sms` is reserved for the
-- toll-free bridge (a later chunk) so an inbound text and a portal reply
-- land in the same thread.
--
-- Privacy: a message is free text the two parties chose to exchange, so it
-- is customer-safe by construction. Internal data (costs, adjuster notes,
-- Field Reports) is never written here. Customers have NO direct table
-- access — they reach their own thread only through the `roybal-portal`
-- edge function, gated by the same unguessable share_token as the job view.
--
-- SAFE & additive. Run once: Supabase Dashboard -> SQL Editor -> Run.
-- Requires 107_portal_jobs.sql.
-- ============================================================

create table if not exists public.portal_messages (
  id                uuid primary key default gen_random_uuid(),
  portal_job_id     uuid not null references public.portal_jobs (id) on delete cascade,
  direction         text not null check (direction in ('in', 'out')),   -- in = from customer, out = from office
  channel           text not null default 'portal' check (channel in ('portal', 'sms')),
  author            text not null default 'office' check (author in ('customer', 'office', 'ai')),
  body              text not null,
  read_by_office    boolean not null default false,   -- office has seen this inbound message
  read_by_customer  boolean not null default false,   -- customer has seen this outbound message
  created_at        timestamptz not null default now()
);

create index if not exists portal_messages_job_idx  on public.portal_messages (portal_job_id, created_at);
create index if not exists portal_messages_unread_idx on public.portal_messages (portal_job_id)
  where direction = 'in' and read_by_office = false;

-- Row Level Security: crew (the shared company login) may read/write; the
-- anon role gets nothing. Customers never hit this table directly — the
-- roybal-portal edge function serves + accepts their messages by share_token.
alter table public.portal_messages enable row level security;
drop policy if exists portal_messages_all on public.portal_messages;
create policy portal_messages_all on public.portal_messages
  for all to authenticated
  using (true) with check (true);
