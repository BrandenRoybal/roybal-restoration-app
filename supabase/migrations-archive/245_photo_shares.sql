-- ============================================================
-- Roybal — photo_shares: insurance-facing full-size photo links.
-- One row per share the crew publishes from the field app: either a
-- job's Photo Log or its Contents item photos. Holds ONLY references
-- (content hashes into the private field-media bucket) plus the claim
-- header — never image data, never internal job fields.
--
-- Access mirrors portal_jobs (107):
--   * Crew (authenticated) publish + manage these rows via REST.
--   * The adjuster has NO table access. They present the random
--     share_token to the `roybal-portal` edge function, which returns
--     the photo list and serves each image by hash, token-checked.
--
-- SAFE & additive. Run once: Supabase Dashboard -> SQL Editor -> Run.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.photo_shares (
  id               uuid primary key default gen_random_uuid(),
  field_project_id uuid,                                -- source field job (soft link)
  share_token      text not null unique,                -- random, revocable; the bearer credential
  enabled          boolean not null default true,       -- office on/off switch
  kind             text not null default 'photos',      -- 'photos' (Photo Log) | 'contents'
  customer_name    text not null default '',
  property_address text not null default '',
  claim_no         text not null default '',
  date_of_loss     text not null default '',
  photos           jsonb not null default '[]'::jsonb,  -- [{hash,caption,room,stage,item}] — references, not image data
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists photo_shares_project_idx on public.photo_shares (field_project_id);
create index if not exists photo_shares_token_idx   on public.photo_shares (share_token);

-- Always stamp updated_at server-side (same pattern as portal_jobs).
create or replace function public.photo_shares_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_photo_shares_touch on public.photo_shares;
create trigger trg_photo_shares_touch
  before insert or update on public.photo_shares
  for each row execute function public.photo_shares_touch();

-- RLS: crew (the shared company login) may read/write; anon gets nothing.
-- Adjusters never hit this table — the edge function serves them by token.
alter table public.photo_shares enable row level security;
drop policy if exists photo_shares_all on public.photo_shares;
create policy photo_shares_all on public.photo_shares
  for all to authenticated
  using (true) with check (true);
