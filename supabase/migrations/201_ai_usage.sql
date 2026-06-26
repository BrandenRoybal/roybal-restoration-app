-- ============================================================
-- Roybal AI Field Data Backbone — AI usage ledger (additive)
-- ============================================================
-- Step C support table. The roybal-ai-ingest Edge Function writes
-- ONE row here per AI ingest call (voice capture), recording what it
-- spent on speech-to-text + LLM extraction. The function sums the
-- current billing month BEFORE each call and refuses new AI spend once
-- the monthly cap is reached (default $50, set via the SPEND_CAP_USD
-- function secret).
--
-- SAFE + ADDITIVE: creates one new table only. Touches nothing in
-- field_projects, coordination_jobs, jobs, or the 200_ai_backbone tables.
-- Depends on 200_ai_backbone.sql (capture_events, unified_jobs) and
-- coordination_touch() from 101. Run AFTER 200.
--
-- Run once: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.ai_usage (
  id                uuid primary key default gen_random_uuid(),
  -- what this spend was for (all nullable: the ledger survives row deletes)
  capture_event_id  uuid references public.capture_events (id) on delete set null,
  unified_job_id    uuid references public.unified_jobs (id)   on delete set null,
  captured_by       text,                       -- which tech triggered it
  form_key          text,                       -- moistureMaps | dryingLogs | photos | constructionLogs
  -- providers / models used (for an auditable per-call record)
  provider          text,                       -- 'deepgram+anthropic' | 'anthropic' (transcript passthrough) | ...
  stt_model         text,
  llm_model         text,
  -- measured usage
  audio_seconds     numeric  not null default 0,
  input_tokens      integer  not null default 0,
  output_tokens     integer  not null default 0,
  -- cost breakdown (USD)
  stt_cost_usd      numeric  not null default 0,
  llm_cost_usd      numeric  not null default 0,
  cost_usd          numeric  not null default 0,  -- stt + llm; the field the cap sums
  -- a call refused at the cap is recorded with capped=true and cost_usd=0,
  -- so you can see who hit the wall and when.
  capped            boolean  not null default false,
  note              text,
  created_at        timestamptz not null default now(),
  -- 'YYYY-MM' (UTC) of created_at — the cheap monthly bucket the cap query filters on.
  -- Set by the BEFORE INSERT trigger below: a STORED generated column can't be used
  -- here because to_char()/timezone conversions are only STABLE, not IMMUTABLE.
  billing_month     text
);

-- Stamp billing_month from created_at in UTC, matching the Edge Function's
-- monthly bucket (new Date().toISOString().slice(0,7)).
create or replace function public.ai_usage_set_month()
returns trigger language plpgsql as $$
begin
  new.billing_month := to_char(coalesce(new.created_at, now()) at time zone 'UTC', 'YYYY-MM');
  return new;
end;
$$;

drop trigger if exists trg_ai_usage_set_month on public.ai_usage;
create trigger trg_ai_usage_set_month
  before insert on public.ai_usage
  for each row execute function public.ai_usage_set_month();

create index if not exists ai_usage_month_idx on public.ai_usage (billing_month);
create index if not exists ai_usage_job_idx   on public.ai_usage (unified_job_id);

-- ============================================================
-- Row level security — mirror the operational tables in 200:
-- full access for authenticated (single-company shared login). The
-- Edge Function forwards the caller's JWT, so reads (the cap sum) and
-- the ledger insert run as the signed-in user under this policy.
-- ============================================================
alter table public.ai_usage enable row level security;

drop policy if exists ai_usage_all on public.ai_usage;
create policy ai_usage_all on public.ai_usage
  for all to authenticated using (true) with check (true);

-- ============================================================
-- Done. Verify with:
--   select billing_month, count(*), round(sum(cost_usd), 4) as spent
--   from public.ai_usage group by billing_month order by billing_month desc;
--   -- month-to-date spend (what the cap compares against):
--   select coalesce(round(sum(cost_usd), 4), 0)
--   from public.ai_usage where billing_month = to_char(now(), 'YYYY-MM');
-- ============================================================
