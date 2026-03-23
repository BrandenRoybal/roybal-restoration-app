-- Manual floor plan editor: rooms, openings, and geometry storage

create table manual_floor_plans (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  name        text not null default 'Floor Plan',
  scale       numeric not null default 50,   -- pixels per foot (display hint only)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(job_id)
);

create table floor_plan_rooms (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references manual_floor_plans(id) on delete cascade,
  name        text not null default 'Room',
  points      jsonb not null default '[]',   -- [{x: number, y: number}] in feet
  height      numeric not null default 8,    -- feet
  color       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table floor_plan_openings (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references floor_plan_rooms(id) on delete cascade,
  plan_id           uuid not null references manual_floor_plans(id) on delete cascade,
  wall_index        integer not null,          -- which polygon edge (0 = edge from point[0] to point[1])
  type              text not null check (type in ('door','window','opening')),
  width             numeric not null,          -- feet
  height            numeric not null,          -- feet
  offset_from_start numeric not null default 0, -- feet from start vertex of wall
  swing             text,                      -- 'left'|'right'|'none' for doors
  label             text,
  metadata          jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- RLS
alter table manual_floor_plans   enable row level security;
alter table floor_plan_rooms     enable row level security;
alter table floor_plan_openings  enable row level security;

-- Admin full access
create policy "admin_all_manual_floor_plans"   on manual_floor_plans  for all to authenticated using (auth.jwt() ->> 'role' = 'admin') with check (auth.jwt() ->> 'role' = 'admin');
create policy "admin_all_floor_plan_rooms"     on floor_plan_rooms    for all to authenticated using (auth.jwt() ->> 'role' = 'admin') with check (auth.jwt() ->> 'role' = 'admin');
create policy "admin_all_floor_plan_openings"  on floor_plan_openings for all to authenticated using (auth.jwt() ->> 'role' = 'admin') with check (auth.jwt() ->> 'role' = 'admin');

-- Tech read access on assigned jobs
create policy "tech_read_manual_floor_plans" on manual_floor_plans for select to authenticated
  using (
    auth.jwt() ->> 'role' = 'tech' and
    job_id in (select id from jobs where auth.uid() = any(assigned_tech_ids))
  );
create policy "tech_read_floor_plan_rooms" on floor_plan_rooms for select to authenticated
  using (
    auth.jwt() ->> 'role' = 'tech' and
    plan_id in (select id from manual_floor_plans where job_id in (select id from jobs where auth.uid() = any(assigned_tech_ids)))
  );
create policy "tech_read_floor_plan_openings" on floor_plan_openings for select to authenticated
  using (
    auth.jwt() ->> 'role' = 'tech' and
    plan_id in (select id from manual_floor_plans where job_id in (select id from jobs where auth.uid() = any(assigned_tech_ids)))
  );

-- updated_at triggers
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger manual_floor_plans_updated_at   before update on manual_floor_plans   for each row execute procedure set_updated_at();
create trigger floor_plan_rooms_updated_at     before update on floor_plan_rooms     for each row execute procedure set_updated_at();
create trigger floor_plan_openings_updated_at  before update on floor_plan_openings  for each row execute procedure set_updated_at();
