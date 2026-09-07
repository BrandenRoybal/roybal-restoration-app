-- ============================================================
-- QuickBooks ONLINE (Accounting) tokens — for invoice push.
-- ------------------------------------------------------------
-- Separate from qb_time_tokens: QuickBooks Time authenticates on the
-- legacy TSheets OAuth server, whose tokens CANNOT call the QuickBooks
-- Online Accounting API. Invoicing needs its own Intuit (appcenter)
-- OAuth connection with the com.intuit.quickbooks.accounting scope.
-- One row per connected company (realm).
-- ============================================================
create table if not exists public.qbo_tokens (
  id            uuid primary key default gen_random_uuid(),
  realm_id      text not null unique,     -- Intuit company/realm ID (from the OAuth callback)
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  connected_by  text,                     -- office email, informational
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.qbo_tokens enable row level security;

-- tokens: never exposed to the browser. The qbo-proxy Edge Function
-- reads/writes them with the service role (bypasses RLS). Deny the
-- authenticated role entirely so the publishable key can't read secrets.
drop policy if exists qbo_tokens_none on public.qbo_tokens;
create policy qbo_tokens_none on public.qbo_tokens
  for all to authenticated using (false) with check (false);
