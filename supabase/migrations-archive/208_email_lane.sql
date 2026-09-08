-- ============================================================
-- Roybal — EMAIL LANE (Gmail integration)
-- ------------------------------------------------------------
-- gmail_tokens:    the office Gmail OAuth connection (one row per
--                  account), service-role only — mirror of qbo_tokens.
-- email_messages:  ONLY job-matched email (the privacy contract lives
--                  in gmail-proxy/emailmatch.ts — unmatched mail is
--                  never stored). Read by the admin + assistant +
--                  morning brief; written by gmail-proxy (service role).
-- ============================================================

-- ---------- tokens ----------
create table if not exists public.gmail_tokens (
  id              uuid primary key default gen_random_uuid(),
  account         text not null unique,     -- the connected mailbox (branden@…)
  access_token    text not null,
  refresh_token   text not null,
  expires_at      timestamptz not null,
  last_pull_epoch bigint,                   -- inbox scan cursor (epoch seconds)
  connected_by    text,                     -- office email, informational
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.gmail_tokens enable row level security;

-- tokens: never exposed to the browser (same stance as qbo_tokens)
drop policy if exists gmail_tokens_none on public.gmail_tokens;
create policy gmail_tokens_none on public.gmail_tokens
  for all to authenticated using (false) with check (false);

-- ---------- job-matched email ----------
create table if not exists public.email_messages (
  id                uuid primary key default gen_random_uuid(),
  gmail_id          text not null unique,   -- Gmail message id (dedup across pulls)
  thread_id         text not null default '',
  direction         text not null check (direction in ('in', 'out')),
  from_addr         text not null default '',
  from_name         text not null default '',   -- raw From header ("Jane <jane@x>")
  to_addr           text not null default '',
  subject           text not null default '',
  body_text         text not null default '',
  message_id_header text not null default '',   -- RFC Message-ID, for reply threading
  job_id            text,                       -- field_projects id it was filed under
  matched_by        text not null default '',   -- customer-email | claim | customer-name | sent
  received_at       timestamptz not null default now(),
  read_by_office    boolean not null default false,
  sent_by           text,                       -- outbound only: which office login confirmed the send
  created_at        timestamptz not null default now()
);

create index if not exists email_messages_job_idx on public.email_messages (job_id, received_at desc);
create index if not exists email_messages_unread_idx on public.email_messages (read_by_office) where direction = 'in';

alter table public.email_messages enable row level security;

-- the shared office/crew login reads threads and marks them handled;
-- INSERTS only ever come from gmail-proxy (service role bypasses RLS)
drop policy if exists email_messages_read on public.email_messages;
create policy email_messages_read on public.email_messages
  for select to authenticated using (true);
drop policy if exists email_messages_mark on public.email_messages;
create policy email_messages_mark on public.email_messages
  for update to authenticated using (true) with check (true);

-- the read-only brief machine user must stay read-only here too
-- (restrictive: AND-ed with the policies above, same as migration 205)
drop policy if exists email_messages_machine_deny_upd on public.email_messages;
create policy email_messages_machine_deny_upd on public.email_messages
  as restrictive for update to authenticated
  using (coalesce(auth.email(), '') not like 'office-brief@%')
  with check (coalesce(auth.email(), '') not like 'office-brief@%');
