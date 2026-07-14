-- ============================================================
-- Roybal Construction — Fairbanks Xactimate price list
-- Source: Roybal_Fairbanks_Pricing_CONSOLIDATED.xlsx (pulled 2026-07-13).
-- NOTE: values were transcribed from Xactimate Price List Editor
-- screenshots — treat as a working basis and re-load from a clean
-- Xactimate CSV export when available. Estimates quote replace_price.
-- SAFE to run: only adds the price_list table; touches nothing else.
-- ============================================================

create table if not exists public.price_list (
  id                 bigint generated always as identity primary key,
  market             text not null default 'FAIRBANK',
  category           text not null,          -- Xactimate category code, e.g. 'DRY'
  category_label     text not null,          -- human label, e.g. 'Drywall'
  code               text not null,          -- Xactimate selector, e.g. 'AV'
  description        text not null,
  unit               text,                   -- SF, LF, EA, HR, DA, SY, CF ...
  replace_price      numeric(10,2),          -- Replace ($) — the quoted estimate price
  remove_price       numeric(10,2),          -- Remove ($)  — tear-out
  detach_reset_price numeric(10,2),          -- Detach & Reset ($)
  source             text not null default 'Fairbanks CONSOLIDATED 2026-07-13 (screenshot transcription)',
  created_at         timestamptz not null default now(),
  unique (market, category, code)
);

comment on table public.price_list is
  'Fairbanks Xactimate market prices — reference basis for reconstruction estimates. replace_price is the quoted unit price.';

create index if not exists price_list_category_idx on public.price_list (category);
create extension if not exists pg_trgm;
create index if not exists price_list_desc_trgm_idx on public.price_list using gin (description gin_trgm_ops);
create index if not exists price_list_code_trgm_idx on public.price_list using gin (code gin_trgm_ops);

-- Reference data: any signed-in crew member may READ; nobody edits from the
-- app (prices change only by re-seeding via service role / a new migration).
alter table public.price_list enable row level security;
drop policy if exists price_list_read on public.price_list;
create policy price_list_read on public.price_list
  for select to authenticated using (true);
