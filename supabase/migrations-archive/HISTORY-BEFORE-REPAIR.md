# Migration history as it stood before the 2026-09-07 repair

`supabase_migrations.schema_migrations` on `djpgvcvhvgrzgaziruze`, read immediately
before `supabase migration repair` replaced it with the single row `0000`.

This file exists so the repair is reversible from the repository alone, and so
the drift it fixed stays legible. **Nothing here is a set of instructions.** The
schema these 74 rows describe is `supabase/migrations/0000_baseline.sql`; the
files they were once paired with are their siblings in this directory.

## What the drift was

74 rows recorded remotely. 72 files on disk. They did not correspond, because
the same changes were recorded under two naming schemes over six months of
SQL-editor applies: short `NNN_` names in the repository, Supabase's own
timestamps in the database. `supabase db push` refused to run at all:

    Remote migration versions not found in local migrations directory.

Forcing it would have re-run 46 old scripts — including non-idempotent
`create policy` — against live production data.

## What the repair did

    supabase migration repair --status reverted <the 74 versions below>
    supabase migration repair --status applied 0000

It writes one bookkeeping table and nothing else. Verified immediately after,
against `pg_catalog`: tables 54, policies 114, triggers 33, views 5,
non-extension functions 48, cron jobs 9 — every number identical to before the
repair. Row counts likewise untouched (field_projects 42, coordination_jobs 82,
contacts 41). `supabase db push --dry-run` then reported *Remote database is up
to date* for the first time.

## To reverse it

Delete the `0000` row and re-insert the 74 versions below. The schema is not
involved; only this table changes.

## The 74 rows

| # | version | name |
|---:|---|---|
| 1 | `001` | initial_schema |
| 2 | `002` | storage |
| 3 | `003` | qb_time |
| 4 | `004` | remove_qb_time |
| 5 | `005` | phase2_enum_values |
| 6 | `006` | phase2_expansion |
| 7 | `007` | phase3_reconstruction |
| 8 | `008` | canvas_floor_plans |
| 9 | `009` | opening_enhancements |
| 10 | `010` | floor_plan_manual |
| 11 | `011` | floor_plans_public_bucket |
| 12 | `012` | work_authorizations |
| 13 | `100` | field_projects |
| 14 | `101` | coordination |
| 15 | `102` | time_entries |
| 16 | `103` | qb_time_field |
| 17 | `104` | qbo_tokens |
| 18 | `105` | labor_log_billing_gate |
| 19 | `106` | sms_messages |
| 20 | `107` | portal_jobs |
| 21 | `108` | portal_messages |
| 22 | `109` | price_list |
| 23 | `110` | price_list_data |
| 24 | `200` | ai_backbone |
| 25 | `201` | ai_usage |
| 26 | `202` | qb_time_cron |
| 27 | `20260713231439` | price_list |
| 28 | `20260718030545` | sms_messages |
| 29 | `20260718043157` | ai_usage_tts |
| 30 | `20260719015535` | phone_agent_rls |
| 31 | `20260723020916` | brief_machine_rls |
| 32 | `20260724013239` | pending_actions |
| 33 | `20260801025829` | portal_selections |
| 34 | `20260801025842` | portal_selection_responses |
| 35 | `20260810193421` | field_projects_trash |
| 36 | `20260811012450` | blob_history_phase0_tourniquet |
| 37 | `20260811015422` | individual_logins_phase1 |
| 38 | `20260811024210` | push_project_rpc_phase2a |
| 39 | `20260811031938` | sync_rpcs_and_build_gate_phase2b |
| 40 | `20260811035238` | tombstone_rev_highwater |
| 41 | `20260811160322` | field_photos_table_phase3 |
| 42 | `20260811161408` | field_photos_projection_phase3 |
| 43 | `20260811162057` | photo_projection_hardening |
| 44 | `20260811163550` | photo_projection_trustworthy |
| 45 | `20260811181317` | photo_deleted_view_and_restore |
| 46 | `20260811191043` | sync_client_telemetry |
| 47 | `20260811191111` | revoke_direct_field_writes |
| 48 | `20260812170929` | web_receptionist |
| 49 | `20260812182753` | admin_fix_cron_helper |
| 50 | `20260812182959` | admin_fix_cron_use_alter_job |
| 51 | `20260812183200` | drop_admin_fix_cron_helper |
| 52 | `20260812191937` | readd_admin_fix_cron_for_backfill |
| 53 | `20260812192244` | drop_admin_fix_cron_after_backfill |
| 54 | `20260814013345` | contacts_crm_phase1 |
| 55 | `20260814022830` | contact_links_crm_steps_2_3 |
| 56 | `20260814042910` | coordination_job_patch_board_tier1 |
| 57 | `20260814194208` | portal_drying_cf2 |
| 58 | `20260814201652` | contact_sessions_cf1 |
| 59 | `20260814203521` | portal_crew_lines_cf2 |
| 60 | `20260814204117` | portal_closeout_cf4 |
| 61 | `20260814205123` | portal_money_cf3 |
| 62 | `20260814224939` | clockin_crew_line |
| 63 | `20260814225433` | cron_keys_new_format |
| 64 | `20260815012857` | crew_photos_bucket |
| 65 | `20260815013530` | crew_intro_ids |
| 66 | `20260816031113` | marketing_opt_in_at |
| 67 | `20260816231859` | merge_delete_tombstones |
| 68 | `20260816232442` | restore_photo_clears_tombstone |
| 69 | `20260816234441` | losstypes_merge_union |
| 70 | `20260817030721` | crew_digest_cron |
| 71 | `20260901225151` | lead_triage_grant |
| 72 | `20260907003149` | e0_ledger_and_rls_hardening |
| 73 | `20260907023023` | tmp_validate_scalar_merge_248 |
| 74 | `20260907023253` | merge_scalar_filled_beats_empty |

**Note on the last three.** `20260907003149` (E0 hardening) and `20260907023253`
(the scalar-merge fix) were applied on 2026-09-07 through MCP `apply_migration`,
the practice P1 ends. `20260907023023` is `tmp_validate_scalar_merge_248` — a
temporary validation step that was never meant to be a migration and is recorded
as one anyway. It is the clearest single illustration of why this table stopped
describing the database.

Total: 74 rows.
