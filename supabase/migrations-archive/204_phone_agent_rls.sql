-- 204: phone-agent machine user — defense-in-depth RLS (Phase 6 phone lane)
--
-- The Fly.io phone receptionist signs in as phone-agent@roybalconstruction.com
-- (password only in Fly secrets) and runs RLS-scoped like any crew login.
-- JWT-as-truth: these RESTRICTIVE policies subtract rights from that email on
-- top of the existing permissive policies — the agent can INSERT a lead into
-- coordination_jobs but can never UPDATE/DELETE board jobs, and can never
-- touch field_projects at all. A hijacked or prompt-injected agent is bounded
-- to junk-lead inserts (rate-limited in the agent) and its own log rows.

-- board jobs: leads in, nothing changed or removed
create policy "phone agent cannot update board jobs"
  on public.coordination_jobs as restrictive for update to authenticated
  using (coalesce(auth.email(), '') <> 'phone-agent@roybalconstruction.com');

create policy "phone agent cannot delete board jobs"
  on public.coordination_jobs as restrictive for delete to authenticated
  using (coalesce(auth.email(), '') <> 'phone-agent@roybalconstruction.com');

-- field projects: the phone lane has no business writing job documentation
create policy "phone agent cannot insert field projects"
  on public.field_projects as restrictive for insert to authenticated
  with check (coalesce(auth.email(), '') <> 'phone-agent@roybalconstruction.com');

create policy "phone agent cannot update field projects"
  on public.field_projects as restrictive for update to authenticated
  using (coalesce(auth.email(), '') <> 'phone-agent@roybalconstruction.com');

create policy "phone agent cannot delete field projects"
  on public.field_projects as restrictive for delete to authenticated
  using (coalesce(auth.email(), '') <> 'phone-agent@roybalconstruction.com');
