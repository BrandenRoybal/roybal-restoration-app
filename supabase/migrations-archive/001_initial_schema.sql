-- ============================================================
-- Roybal Restoration — Initial Schema Migration
-- Run this in the Supabase SQL editor or via the CLI:
--   supabase db push
-- ============================================================

-- Enable necessary extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
create type job_status as enum (
  'new', 'active', 'drying', 'final_inspection', 'invoicing', 'closed'
);

create type loss_type as enum (
  'water', 'fire', 'mold', 'smoke', 'other'
);

create type loss_category as enum (
  'cat1', 'cat2', 'cat3'
);

create type photo_category as enum (
  'before', 'during', 'after', 'moisture', 'equipment', 'general'
);

create type equipment_type as enum (
  'lgr_dehumidifier',
  'refrigerant_dehumidifier',
  'air_mover',
  'hepa_scrubber',
  'hepa_vac',
  'axial_fan',
  'other'
);

create type billing_type as enum ('tm', 'scope');

create type user_role as enum ('admin', 'tech', 'viewer');

-- ============================================================
-- PROFILES (extends auth.users)
-- ============================================================
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  role       user_role not null default 'tech',
  phone      text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create profile on user signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'tech')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- JOB NUMBER SEQUENCE
-- ============================================================
create sequence job_number_seq start 1;

-- ============================================================
-- JOBS
-- ============================================================
create table jobs (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  job_number            text unique not null default '',
  status                job_status not null default 'new',
  loss_type             loss_type,
  loss_category         loss_category,
  date_of_loss          date,
  property_address      text not null default '',
  owner_name            text,
  owner_phone           text,
  owner_email           text,
  insurance_carrier     text,
  claim_number          text,
  adjuster_name         text,
  adjuster_phone        text,
  adjuster_email        text,
  assigned_tech_ids     uuid[] not null default '{}',
  magicplan_project_id  text,
  notes                 text,
  created_by            uuid references auth.users (id)
);

-- Auto-generate job_number: RC-2026-001 style
create or replace function generate_job_number()
returns trigger language plpgsql as $$
begin
  new.job_number := 'RC-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('job_number_seq')::text, 3, '0');
  return new;
end;
$$;

create trigger set_job_number
  before insert on jobs
  for each row execute function generate_job_number();

-- Auto-update updated_at
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger jobs_updated_at
  before update on jobs
  for each row execute function touch_updated_at();

-- ============================================================
-- ROOMS
-- ============================================================
create table rooms (
  id          uuid primary key default uuid_generate_v4(),
  job_id      uuid not null references jobs (id) on delete cascade,
  name        text not null,
  floor_level text not null default 'Main',
  affected    boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- PHOTOS
-- ============================================================
create table photos (
  id           uuid primary key default uuid_generate_v4(),
  job_id       uuid not null references jobs (id) on delete cascade,
  room_id      uuid references rooms (id) on delete set null,
  uploaded_by  uuid references auth.users (id),
  storage_path text not null,
  caption      text,
  category     photo_category not null default 'general',
  taken_at     timestamptz not null default now(),
  gps_lat      float,
  gps_lng      float,
  created_at   timestamptz not null default now()
);

-- ============================================================
-- MOISTURE READINGS
-- ============================================================
create table moisture_readings (
  id                   uuid primary key default uuid_generate_v4(),
  job_id               uuid not null references jobs (id) on delete cascade,
  room_id              uuid not null references rooms (id) on delete cascade,
  reading_date         date not null default current_date,
  location_description text not null,
  material_type        text not null,
  moisture_pct         float not null,
  -- is_dry is computed via view / function, stored for performance
  is_dry               boolean not null default false,
  recorded_by          uuid references auth.users (id),
  created_at           timestamptz not null default now()
);

-- Auto-compute is_dry based on IICRC dry standards
create or replace function compute_is_dry()
returns trigger language plpgsql as $$
begin
  new.is_dry := case
    when lower(new.material_type) in ('drywall', 'gypsum', 'sheetrock')    then new.moisture_pct <= 1.0
    when lower(new.material_type) in ('wood', 'hardwood', 'subfloor', 'osb', 'plywood') then new.moisture_pct <= 19.0
    when lower(new.material_type) in ('concrete', 'slab', 'block')         then new.moisture_pct <= 4.0
    else new.moisture_pct <= 16.0  -- generic threshold
  end;
  return new;
end;
$$;

create trigger moisture_compute_dry
  before insert or update on moisture_readings
  for each row execute function compute_is_dry();

-- ============================================================
-- EQUIPMENT LOGS
-- ============================================================
create table equipment_logs (
  id             uuid primary key default uuid_generate_v4(),
  job_id         uuid not null references jobs (id) on delete cascade,
  room_id        uuid references rooms (id) on delete set null,
  equipment_type equipment_type not null,
  equipment_name text not null,
  asset_number   text,
  serial_number  text,
  date_placed    date not null default current_date,
  date_removed   date,
  -- days_on_site computed in queries: coalesce(date_removed, current_date) - date_placed
  placed_by      uuid references auth.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger equipment_logs_updated_at
  before update on equipment_logs
  for each row execute function touch_updated_at();

-- ============================================================
-- LINE ITEMS
-- ============================================================
create table line_items (
  id           uuid primary key default uuid_generate_v4(),
  job_id       uuid not null references jobs (id) on delete cascade,
  room_id      uuid references rooms (id) on delete set null,
  category     text not null default 'General',
  description  text not null,
  quantity     float not null default 1,
  unit         text not null default 'EA',
  -- unit_price stored as integer cents (e.g. $12.50 → 1250)
  unit_price   integer not null default 0,
  -- total_cents is computed: quantity * unit_price (rounded)
  total_cents  integer generated always as (
    round(quantity * unit_price)::integer
  ) stored,
  notes        text,
  billing_type billing_type not null default 'scope',
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger line_items_updated_at
  before update on line_items
  for each row execute function touch_updated_at();

-- ============================================================
-- FLOOR PLANS
-- ============================================================
create table floor_plans (
  id                   uuid primary key default uuid_generate_v4(),
  job_id               uuid not null references jobs (id) on delete cascade,
  magicplan_project_id text not null,
  file_url             text,
  storage_path         text,
  version              integer not null default 1,
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index jobs_status_idx       on jobs (status);
create index jobs_created_by_idx   on jobs (created_by);
create index jobs_tech_ids_idx     on jobs using gin (assigned_tech_ids);
create index photos_job_id_idx     on photos (job_id);
create index photos_room_id_idx    on photos (room_id);
create index moisture_job_id_idx   on moisture_readings (job_id, reading_date);
create index equipment_job_id_idx  on equipment_logs (job_id);
create index line_items_job_id_idx on line_items (job_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table profiles         enable row level security;
alter table jobs             enable row level security;
alter table rooms            enable row level security;
alter table photos           enable row level security;
alter table moisture_readings enable row level security;
alter table equipment_logs   enable row level security;
alter table line_items       enable row level security;
alter table floor_plans      enable row level security;

-- Helper: is current user admin?
create or replace function is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Helper: is current user assigned to this job?
create or replace function is_assigned_to_job(job_uuid uuid)
returns boolean language sql security definer as $$
  select exists (
    select 1 from jobs
    where id = job_uuid
      and (auth.uid() = any(assigned_tech_ids) or created_by = auth.uid())
  );
$$;

-- ---- PROFILES ----
create policy "Users can read own profile"
  on profiles for select using (id = auth.uid());

create policy "Admin can read all profiles"
  on profiles for select using (is_admin());

create policy "Users can update own profile"
  on profiles for update using (id = auth.uid());

create policy "Admin can update any profile"
  on profiles for update using (is_admin());

-- ---- JOBS ----
create policy "Admin can do anything with jobs"
  on jobs for all using (is_admin());

create policy "Tech can read assigned jobs"
  on jobs for select
  using (
    auth.uid() = any(assigned_tech_ids)
    or created_by = auth.uid()
  );

create policy "Tech can update assigned jobs"
  on jobs for update
  using (
    auth.uid() = any(assigned_tech_ids)
    or created_by = auth.uid()
  );

create policy "Tech can create jobs"
  on jobs for insert with check (auth.uid() is not null);

-- ---- ROOMS ----
create policy "Admin can do anything with rooms"
  on rooms for all using (is_admin());

create policy "Tech can access rooms on assigned jobs"
  on rooms for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

-- ---- PHOTOS ----
create policy "Admin can do anything with photos"
  on photos for all using (is_admin());

create policy "Tech can access photos on assigned jobs"
  on photos for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

-- ---- MOISTURE READINGS ----
create policy "Admin can do anything with moisture"
  on moisture_readings for all using (is_admin());

create policy "Tech can access moisture on assigned jobs"
  on moisture_readings for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

-- ---- EQUIPMENT LOGS ----
create policy "Admin can do anything with equipment"
  on equipment_logs for all using (is_admin());

create policy "Tech can access equipment on assigned jobs"
  on equipment_logs for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

-- ---- LINE ITEMS ----
create policy "Admin can do anything with line items"
  on line_items for all using (is_admin());

create policy "Tech can access line items on assigned jobs"
  on line_items for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

-- ---- FLOOR PLANS ----
create policy "Admin can do anything with floor plans"
  on floor_plans for all using (is_admin());

create policy "Tech can read floor plans on assigned jobs"
  on floor_plans for select
  using (is_assigned_to_job(job_id));
