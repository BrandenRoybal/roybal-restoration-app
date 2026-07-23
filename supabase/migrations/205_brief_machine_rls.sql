-- 205: morning-brief machine user — read-only by construction
--
-- roybal-brief signs in as office-brief@roybalconstruction.com (password only
-- in edge-function secrets) and reads the shop under RLS like any login.
-- Same defense-in-depth as the phone agent (204): RESTRICTIVE policies
-- subtract ALL write rights from this email on the operational tables, so a
-- compromised brief function can look at everything and change nothing. Its
-- only permitted writes are the rows every lane may create: capture_events
-- envelopes and the sms_messages row roybal-notify logs for the text.

do $$
declare
  t text;
  op text;
begin
  foreach t in array array['field_projects', 'coordination_jobs', 'crew_members', 'time_entries', 'unified_jobs', 'portal_messages'] loop
    foreach op in array array['insert', 'update', 'delete'] loop
      execute format(
        'create policy %I on public.%I as restrictive for %s to authenticated %s (coalesce(auth.email(), '''') <> ''office-brief@roybalconstruction.com'')',
        'brief agent cannot ' || op || ' ' || t, t, op,
        case when op = 'insert' then 'with check' else 'using' end);
    end loop;
  end loop;
end $$;
