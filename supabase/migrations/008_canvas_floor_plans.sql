-- ============================================================
-- Migration 008: Canvas Floor Plans
-- In-app SVG/canvas-based floor plan editor
-- Separate from the file-based floor_plans table (Magicplan/uploads)
-- ============================================================

-- ============================================================
-- CANVAS_PLANS — in-app drawn floor plans per job
-- ============================================================
create table canvas_plans (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references jobs (id) on delete cascade,
  name                 text not null default 'Floor Plan',
  level_name           text not null default 'Main Floor',
  -- scale: pixels per foot at zoom=1 (default 20 → 1ft = 20px)
  scale                float not null default 20,
  unit_system          text not null default 'imperial' check (unit_system in ('imperial', 'metric')),
  -- canvas logical size in feet
  canvas_width         float not null default 60,
  canvas_height        float not null default 60,
  -- optional background image for tracing a sketch
  background_image_url text,
  background_opacity   float not null default 0.3,
  created_by           uuid references auth.users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger canvas_plans_updated_at
  before update on canvas_plans
  for each row execute function touch_updated_at();

create index canvas_plans_job_id_idx on canvas_plans (job_id);

-- ============================================================
-- EXTEND ROOMS — add geometry + restoration metadata
-- ============================================================

-- Link room to a canvas plan (nullable — rooms can exist without canvas geometry)
alter table rooms
  add column if not exists canvas_plan_id uuid references canvas_plans (id) on delete set null,
  -- Polygon geometry stored as JSONB array of {x, y} points in feet
  add column if not exists polygon_points jsonb,
  -- Wall height in feet (default 8ft)
  add column if not exists height float not null default 8,
  -- Computed stats (calculated by app, stored for display/reporting)
  add column if not exists floor_area    float,   -- sq ft
  add column if not exists perimeter     float,   -- linear ft
  add column if not exists wall_area     float,   -- sq ft (perimeter × height)
  add column if not exists ceiling_area  float,   -- sq ft (= floor_area)
  add column if not exists centroid_x    float,   -- feet (for label placement)
  add column if not exists centroid_y    float,   -- feet
  -- Display
  add column if not exists color         text not null default '#1e3a5f',
  -- Restoration-specific metadata
  add column if not exists room_notes    text,
  add column if not exists category_of_water text  check (category_of_water in ('cat1','cat2','cat3')),
  add column if not exists class_of_loss     text  check (class_of_loss in ('class1','class2','class3','class4')),
  add column if not exists demo_status       text  check (demo_status in ('none','partial','complete')) default 'none',
  add column if not exists drying_status     text  check (drying_status in ('not_started','in_progress','complete')) default 'not_started',
  -- Checkbox flags for restoration work items
  add column if not exists checkbox_flags    jsonb not null default '{}',
  -- updated_at tracking
  add column if not exists updated_at        timestamptz not null default now();

create trigger rooms_updated_at
  before update on rooms
  for each row execute function touch_updated_at();

create index rooms_canvas_plan_id_idx on rooms (canvas_plan_id);

-- ============================================================
-- ROOM_OPENINGS — doors, windows, pass-throughs on walls
-- ============================================================
create table room_openings (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references rooms (id) on delete cascade,
  type        text not null default 'door' check (type in ('door','window','opening')),
  -- Which polygon edge this opening is on (0-indexed wall number)
  wall_index  integer not null default 0,
  -- Position along the wall as a 0..1 fraction (0 = start vertex, 1 = end vertex)
  position    float not null default 0.5,
  -- Dimensions in feet
  width       float not null default 3,
  height      float not null default 6.8,
  notes       text,
  created_at  timestamptz not null default now()
);

create index room_openings_room_id_idx on room_openings (room_id);

-- ============================================================
-- ROOM_MARKERS — pins on the canvas (equipment, labels, moisture)
-- ============================================================
create table room_markers (
  id              uuid primary key default gen_random_uuid(),
  canvas_plan_id  uuid not null references canvas_plans (id) on delete cascade,
  room_id         uuid references rooms (id) on delete set null,
  type            text not null default 'label' check (type in ('label','equipment','moisture','fixture')),
  -- Position in feet on the canvas
  x               float not null,
  y               float not null,
  label           text,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create index room_markers_canvas_plan_id_idx on room_markers (canvas_plan_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table canvas_plans  enable row level security;
alter table room_openings enable row level security;
alter table room_markers  enable row level security;

-- CANVAS_PLANS
create policy "Admin can do anything with canvas plans"
  on canvas_plans for all using (is_admin());

create policy "Tech can access canvas plans on assigned jobs"
  on canvas_plans for all
  using (is_assigned_to_job(job_id))
  with check (is_assigned_to_job(job_id));

-- ROOM_OPENINGS (access via room → canvas_plan → job)
create policy "Admin can do anything with room openings"
  on room_openings for all using (is_admin());

create policy "Tech can access room openings"
  on room_openings for all
  using (
    exists (
      select 1 from rooms r
      where r.id = room_openings.room_id
        and is_assigned_to_job(r.job_id)
    )
  )
  with check (
    exists (
      select 1 from rooms r
      where r.id = room_openings.room_id
        and is_assigned_to_job(r.job_id)
    )
  );

-- ROOM_MARKERS (access via canvas_plan → job)
create policy "Admin can do anything with room markers"
  on room_markers for all using (is_admin());

create policy "Tech can access room markers"
  on room_markers for all
  using (is_assigned_to_job((select job_id from canvas_plans where id = room_markers.canvas_plan_id)))
  with check (is_assigned_to_job((select job_id from canvas_plans where id = room_markers.canvas_plan_id)));
