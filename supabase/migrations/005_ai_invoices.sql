-- ============================================================
-- Roybal Restoration — AI Photo Analysis + Invoices Migration
-- Run via the Supabase SQL editor or: supabase db push
-- ============================================================

-- ============================================================
-- AI PHOTO ANALYSIS
-- ============================================================
alter table photos
  add column if not exists ai_caption   text,
  add column if not exists ai_analysis  jsonb,
  add column if not exists ai_analyzed_at timestamptz;

-- ============================================================
-- AI JOB NARRATIVE (editable, stored on the job)
-- ============================================================
alter table jobs
  add column if not exists narrative text,
  add column if not exists narrative_updated_at timestamptz;

-- ============================================================
-- INVOICES
-- ============================================================
create type invoice_status as enum ('draft', 'sent', 'paid');

create sequence invoice_number_seq start 1;

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs (id) on delete cascade,
  invoice_number   text unique not null default '',
  status           invoice_status not null default 'draft',
  report_type      text not null default 'invoice', -- 'invoice' | 'estimate'
  title            text not null default '',
  invoice_date     date not null default current_date,
  overhead_percent float not null default 10,
  markup_percent   float not null default 10,
  tax_percent      float not null default 0,
  notes            text,
  ai_generated     boolean not null default false,
  created_by       uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Auto-generate invoice_number: INV-2026-001 style
create or replace function generate_invoice_number()
returns trigger language plpgsql as $$
begin
  new.invoice_number := 'INV-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('invoice_number_seq')::text, 3, '0');
  return new;
end;
$$;

create trigger set_invoice_number
  before insert on invoices
  for each row execute function generate_invoice_number();

create trigger invoices_updated_at
  before update on invoices
  for each row execute function touch_updated_at();

-- ============================================================
-- INVOICE ITEMS
-- ============================================================
create table invoice_items (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices (id) on delete cascade,
  job_id      uuid not null references jobs (id) on delete cascade,
  room_name   text,
  code        text,             -- Xactimate-style code, e.g. WTR-EXTC
  category    text not null default 'other',
  description text not null,
  quantity    float not null default 1,
  unit        text not null default 'EA',
  -- unit_price stored as integer cents (e.g. $12.50 → 1250)
  unit_price  integer not null default 0,
  total_cents integer generated always as (
    round(quantity * unit_price)::integer
  ) stored,
  notes       text,
  source      text not null default 'manual', -- 'ai' | 'manual' | 'scope'
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger invoice_items_updated_at
  before update on invoice_items
  for each row execute function touch_updated_at();

-- ============================================================
-- INDEXES
-- ============================================================
create index invoices_job_id_idx      on invoices (job_id);
create index invoice_items_invoice_idx on invoice_items (invoice_id, sort_order);
create index invoice_items_job_id_idx on invoice_items (job_id);
create index photos_ai_analyzed_idx   on photos (job_id, ai_analyzed_at);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table invoices      enable row level security;
alter table invoice_items enable row level security;

create policy "Admin can do anything with invoices"
  on invoices for all using (is_admin());

create policy "Tech can access invoices on assigned jobs"
  on invoices for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

create policy "Admin can do anything with invoice items"
  on invoice_items for all using (is_admin());

create policy "Tech can access invoice items on assigned jobs"
  on invoice_items for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));
