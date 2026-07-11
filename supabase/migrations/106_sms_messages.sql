-- ============================================================
-- Roybal — sms_messages: one row per text sent (or later, received)
-- through the roybal-notify edge function. The durable message log:
-- the client-side project.smsLog records composed texts; this table
-- records REAL sends with Twilio delivery status.
-- SAFE & additive. Run once: Supabase Dashboard → SQL Editor → Run.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.sms_messages (
  id             uuid primary key default gen_random_uuid(),
  unified_job_id uuid,                                  -- -> unified_jobs (soft link, like ai_usage)
  direction      text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  to_number      text not null,
  from_number    text not null default '',
  body           text not null default '',
  kind           text not null default 'text',          -- onOurWay | fieldReport | ...
  sent_by        text,                                   -- tech identity (captured_by)
  twilio_sid     text,
  status         text not null default 'pending',        -- pending | sent | delivered | failed | ...
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists sms_messages_job_idx  on public.sms_messages (unified_job_id);
create index if not exists sms_messages_sid_idx  on public.sms_messages (twilio_sid);
create index if not exists sms_messages_time_idx on public.sms_messages (created_at);

alter table public.sms_messages enable row level security;
drop policy if exists sms_messages_all on public.sms_messages;
create policy sms_messages_all on public.sms_messages
  for all to authenticated
  using (true) with check (true);
