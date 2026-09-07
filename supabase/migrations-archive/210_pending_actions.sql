-- ============================================================
-- Roybal — APPROVE-BY-TEXT: the pending_actions proposal ledger
-- ------------------------------------------------------------
-- Organs of the operations brain (the morning brief first) PROPOSE
-- actions here; the owner texts YES <code> and the inbound SMS
-- webhook executes server-side. Nothing in this table DOES anything
-- by existing — execution requires the owner's reply AND the
-- executor re-verifying the row.
--
--   code        short number the owner texts back ("YES 12")
--   kind        'emailSend' (v1) — what a YES performs
--   params      executor payload (to/subject/body/jobId/threadId…)
--   label       human line for the brief + confirmation text
--   status      pending → approved → executed | failed | declined
--               (or expired by time — enforced on read, see expires_at)
--
-- RLS: signed-in company logins may READ (the admin shows the queue)
-- and INSERT (the brief's read-only machine user may PROPOSE — a
-- proposal changes nothing until the owner approves it). Nobody but
-- the service role may UPDATE or DELETE: approval/execution state
-- only ever changes server-side after a verified owner text.
-- ============================================================

create table if not exists public.pending_actions (
  id          uuid primary key default gen_random_uuid(),
  code        int not null,
  kind        text not null,
  label       text not null default '',
  params      jsonb not null default '{}'::jsonb,
  job_id      text,
  proposed_by text not null default '',
  status      text not null default 'pending'
              check (status in ('pending','approved','executed','failed','declined','expired')),
  result      jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  executed_at timestamptz
);

create index if not exists pending_actions_live_idx
  on public.pending_actions (status, expires_at desc, created_at desc);

alter table public.pending_actions enable row level security;

drop policy if exists pending_actions_read on public.pending_actions;
create policy pending_actions_read on public.pending_actions
  for select to authenticated using (true);

drop policy if exists pending_actions_propose on public.pending_actions;
create policy pending_actions_propose on public.pending_actions
  for insert to authenticated
  with check (status = 'pending' and executed_at is null);

-- no UPDATE/DELETE policies for authenticated: state transitions are
-- service-role only (the verified inbound-SMS path).
