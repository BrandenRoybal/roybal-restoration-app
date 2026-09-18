# Staging carried a migration that no file describes (found 2026-09-18)

Read from `efbuagiwowcwwsezkgsw` (Roybal-Staging) on 2026-09-18, while
preparing the first `db push` through `.github/workflows/db-push.yml`.

Production's history read `0000 baseline, 0001, 0002, 0003` — the repaired
state of 2026-09-07, nothing pending but `0004_backbone_contract_tables`.
Staging's read the same four **plus a fifth row, `0004 p1_contract_tables`,
with no statements recorded**, and a schema to match: a broader draft of the
P1 backbone than the one that merged as PR #209, sharing most of its names.
It is in no branch of this repository. Pushing the real `0004` onto it would
have done nothing (the CLI matches on version), and the rehearsal would have
proved nothing.

## What the draft added, and only that

Everything else in `public` was byte-for-byte production: columns, triggers,
policies, indexes and function bodies of the 54 shared tables compared equal
by `md5` over `pg_catalog`, with the one exception below.

| kind | objects |
|---|---|
| tables (17) | `agent_authority`, `agent_runs`, `agents`, `ai_caps`, `api_tokens`, `approval_policies`, `connections`, `divisions`, `events`, `external_refs`, `jobs_queue`, `operation_catalog`, `orgs`, `outbox`, `proposals`, `role_permissions`, `worker_heartbeats` |
| functions (19) | `bridge_role`, `claim_job`, `current_principal(text,uuid)`, `default_division_id`, `default_org_id`, `emit_event`, `enqueue`, `events_append_only`, `finish_job`, `jobs_queue_sweep_leases`, `op_exec_email_send`, `op_exec_job_set_stage`, `op_exec_sms_send`, `op_proposal_approve`, `op_proposal_decline`, `op_propose`, `principal_may`, `proposals_expire_sweep`, `proposals_guard` |
| columns on an existing table | `integration_runs.connection_id uuid` (FK to `connections`), `integration_runs.principal_id uuid` |
| standalone sequences (5) | `agent_runs_id_seq`, `events_id_seq`, `jobs_queue_id_seq`, `outbox_id_seq`, `proposals_sms_code_seq` |
| cron jobs (2) | `proposals-expire-sweep` (every 5 min), `jobs-queue-sweep-leases` (every min) |
| extension | `pg_jsonschema` (production does not have it) |
| seed rows | `agents` 6, `agent_authority` 10, `role_permissions` 45, `operation_catalog` 5, `approval_policies` 3, `ai_caps` 3, `orgs` 1, `divisions` 1 |
| history | one row, version `0004`, name `p1_contract_tables`, `statements` null |

## How it was cleared

Once, through the Supabase connector's SQL tool, in one transaction — a
housekeeping write on a database that serves no crews, undoing a change that
was never a file. This is not the path for schema (that is `db-push.yml`);
it is the path for putting staging back so that path means something.

```sql
begin;

select cron.unschedule(jobid) from cron.job
 where jobname in ('proposals-expire-sweep', 'jobs-queue-sweep-leases');

alter table public.integration_runs
  drop column if exists connection_id,
  drop column if exists principal_id;

drop table if exists
  public.agent_authority, public.agent_runs, public.agents, public.ai_caps,
  public.api_tokens, public.approval_policies, public.connections,
  public.divisions, public.events, public.external_refs, public.jobs_queue,
  public.operation_catalog, public.orgs, public.outbox, public.proposals,
  public.role_permissions, public.worker_heartbeats
cascade;

drop function if exists
  public.bridge_role(text,text),
  public.claim_job(text,interval),
  public.current_principal(text,uuid),
  public.default_division_id(),
  public.default_org_id(),
  public.emit_event(text,text,uuid,jsonb,text,text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text),
  public.enqueue(text,jsonb,timestamp with time zone,integer,text,uuid,uuid),
  public.events_append_only(),
  public.finish_job(bigint,text,boolean,text),
  public.jobs_queue_sweep_leases(),
  public.op_proposal_approve(uuid,text,jsonb,text,text,text,uuid),
  public.op_proposal_decline(uuid,text,text,uuid),
  public.op_propose(text,jsonb,text,uuid,uuid,text,jsonb,interval,text,text,uuid),
  public.principal_may(text,uuid,text,text,text,text),
  public.proposals_expire_sweep(),
  public.proposals_guard()
cascade;
-- op_exec_email_send, op_exec_job_set_stage and op_exec_sms_send take the
-- proposals row type and go with the table.

drop sequence if exists
  public.agent_runs_id_seq, public.events_id_seq, public.jobs_queue_id_seq,
  public.outbox_id_seq, public.proposals_sms_code_seq;

drop extension if exists pg_jsonschema;

delete from supabase_migrations.schema_migrations where version = '0004';

commit;
```

Verify afterwards: `supabase_migrations.schema_migrations` holds exactly
`0000..0003`; `pg_tables` in `public` counts 54 and `pg_policies` 114, the
production census of 2026-09-07.

## Two things staging's seeding left different from production

Neither affects `0004`, which enables RLS and revokes grants explicitly, but
whoever re-seeds staging should know them:

1. **Grants.** On staging, `anon` and `authenticated` hold all seven
   privileges on every one of the 59 tables and views (413 grant rows each);
   production holds 331 and 343. The baseline's `ALTER DEFAULT PRIVILEGES`
   hands out `GRANT ALL` at creation and `pg_dump` records no revokes, so a
   replayed baseline over-grants relative to the database it was dumped from.
   The CI replay database has the same shape. A future migration should carry
   production's revokes explicitly so the three agree.
2. **The `ensure_rls` event trigger.** Production has it
   (`rls_auto_enable()` on `ddl_command_end`); the baseline dump carries no
   `CREATE EVENT TRIGGER`, so neither staging nor the CI replay does. A
   migration that forgets `enable row level security` passes both and is
   caught only by production. Every migration should enable RLS itself, as
   `0004` does.

## If staging drifts again

Compare `pg_catalog` on both projects as above, remove what is not in
production the same way, and delete any history row production lacks. When
the drift is wider than a handful of objects, re-seed instead: run
`db-baseline.yml` against production for a fresh dump, drop and recreate
staging's `public` schema, apply the dump, then `supabase migration repair
--status applied` for every version production lists.
