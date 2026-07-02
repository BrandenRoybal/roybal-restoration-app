# QuickBooks Time → Daily Construction Log — Implementation Plan

**Prepared for:** Branden Roybal — Roybal Construction, LLC
**Date:** July 2, 2026
**Branch:** `claude/field-restoration-app-s6j2zk` (field / board / admin line)
**Goal:** Each day, pull that day's QB Time entries per job and land them in the field app's **Daily Construction Log**, per job, per day — with manual crew rows still allowed.

---

## 1. Where we're starting (this is ~80% done, just on the wrong line)

**Already built and reusable:**
- **`supabase/functions/qb-time-proxy/index.ts`** — a complete server-side QB Time proxy: OAuth code exchange, **automatic token refresh**, `syncJobcodes`, `getTimesheets` (per jobcode + date range), `getUsers`, `getCurrentTotals`. Client Secret stays server-side. *This is the expensive part and it's finished.*
- **`003_qb_time.sql`** — `qb_time_tokens`, `qb_time_jobcodes` cache.
- **Daily Construction Log form already exists** — `constructionLog()` in `apps/field/js/forms.js:618`, registry key `constructionLogs`. Row shape: `{employee, task, start, finish, hours}`. Instance blob: `{date, rows[], notes, issues, materials, completedBy, signature}`.

**The catch:** the proxy's schema + all the connect/display UI target the **old React `apps/web`** schema (`jobs` table, `is_admin()`, `auth.users`). The live line uses `coordination_jobs`, `field_projects` (JSONB), `crew_members`, and a JSONB `time_entries` table — with a **shared crew login**, no `is_admin()`. So the function ports over, the schema RLS and UI do not.

**"Webhook" reframed:** QB Time's API is **pull-based** — Intuit's real webhooks are for QBO *accounting* (invoices/customers), not Time. There is no "time entry created" event to subscribe to. The correct mechanism is a **scheduled daily pull**, which fits the goal better anyway. The polling code (`getTimesheets`) already exists.

---

## 2. Target data flow

```
QB Time (Intuit)
   │  OAuth (one-time connect)  →  qb_time_tokens
   │  getTimesheets(jobcode, date)   ← daily scheduled pull  +  on-demand button
   ▼
qb-time-proxy (Edge Function, ported to live line)
   ▼
time_entries  (canonical hours store — already exists, flat JSONB rows)
   │   row: { jobId, date, hours, employee, task, start, finish,
   │          source:'qbtime', qbTimesheetId, qbUserId }   ← idempotent on qbTimesheetId
   ▼
Daily Construction Log (field app)  reads time_entries for {jobId, date}
   → prefills the labor table; manual rows still allowed (source:'manual')
```

**Design decision — `time_entries` is the single source of truth for hours**, not the log's own `rows[]`. Reasons: (1) it already exists and is server-writable (flat table, service role), so the scheduled pull is trivial; (2) it avoids server-side merging into the field's JSONB project blob, which is fragile; (3) the board/CFO report can read the same hours later. The construction log becomes a *view* of `time_entries` for that job+date, plus any manual rows.

**Manual job↔jobcode link:** per your choice, each job gets an explicit QB Time jobcode picker (no fuzzy name-matching). Stored on the field project blob as `project.qbJobcodeId`.

---

## 3. Schema changes

New migration `103_qb_time_field.sql` (additive):

1. **RLS re-point** — `qb_time_tokens` / `qb_time_jobcodes` policies rewritten from `is_admin()` to the live line's model (`to authenticated using(true)`), matching `time_entries` in `102`.
2. **Drop the `alter table jobs add qb_jobcode_id`** dependency (no `jobs` table here). The link lives in the field project JSONB instead — no column needed.
3. **Extend `time_entries.data` shape** (JSONB, no DDL) to carry: `employee`, `task`, `start`, `finish`, `source` (`'manual'|'qbtime'`), `qbTimesheetId`, `qbUserId`. Existing manual rows stay valid (`source` defaults to `'manual'`).
4. *(Optional, phase 3)* `qb_user_map` table or a `crew_members.data.qbUserId` field to tie a QB employee to a crew member (for hourly-rate/labor-cost roll-ups). **Not required for the log** — v1 uses the QB user's name string directly.

---

## 4. Files to add / change

**Backend**
- `supabase/functions/qb-time-proxy/index.ts` — mostly reused. Add one action `pullDay({ jobcodeId | all, date })` that fetches timesheets and **upserts into `time_entries`** (idempotent on `qbTimesheetId`), returning a count. Keep existing actions.
- `supabase/functions/qb-time-daily/index.ts` *(new, phase 2)* — thin scheduled entry point: for every job with a `qbJobcodeId`, call the pull for "yesterday+today." Invoked by Supabase **pg_cron + pg_net** (no external scheduler).
- `103_qb_time_field.sql` *(new)* — section 3 above.

**Field app (`apps/field/js/`)**
- `qbtime.js` *(new)* — small client module: `connectStatus()`, `pickJobcode(project)` (the manual link picker), `pullNow(project, date)` (calls `pullDay`), `entriesFor(jobId, date)` (reads `time_entries`).
- `forms.js` — `constructionLog()` gains: a "🔗 QuickBooks job" label + a "Pull today's hours" button; on open it merges `time_entries` rows (QB-sourced, read-only cells) above the manual rows. Manual add/edit unchanged.
- `app.js` — job home: surface the jobcode link + connection state; register nothing new in the form registry (log already registered).
- `sw.js` — **bump `CACHE`** and add `qbtime.js` to the CORE precache (per the field-app rule: new module → precache + version bump, or PWAs serve stale code).

**Admin app** — a "Connect QuickBooks Time" button + status (reuse the OAuth flow from `apps/web/SettingsPage.tsx`, ported to the admin app). One-time connect lives here, not in the field PWA.

---

## 5. Idempotency & merge rules (the part that bites if skipped)

- Each pulled row carries `qbTimesheetId`; the pull **upserts** on it — re-running the daily pull (or tapping the button twice) updates in place, never duplicates.
- A crew member editing a QB-sourced row: v1 keeps QB rows read-only in the log (edit in QB Time, re-pull). Manual rows (`source:'manual'`) are freely editable and never overwritten by a pull.
- Deleting time in QB after a pull: phase 2 daily pull can mark rows `deleted` if their `qbTimesheetId` vanished from the day's fetch. Phase 1 ignores this (rare, office can delete).

---

## 6. Phased build

| Phase | Work | Proves |
|---|---|---|
| **P1 — Prove the pipe** | Port proxy RLS to live line; deploy; Admin "Connect QB Time" (one-time OAuth); jobcode picker on a field job; `pullDay` action → `time_entries`; "Pull today's hours" button in the log. | Real QB hours land on the right job & date, visible in the log. Manual + no cron yet. |
| **P2 — Automate daily** | `qb-time-daily` function + pg_cron nightly (e.g. 6am AKT). Deleted-in-QB handling. | Hours appear each morning with no taps. |
| **P3 — Polish** | Crew ↔ QB user map (hourly-rate roll-up); labor $ in the log/CFO report; "currently clocked in" surfaced. | Labor cost + oversight, ties into CFO report. |

---

## 7. Config / secrets needed from you (one-time)

- An **Intuit Developer app** with the **QuickBooks Time** scope (`com.intuit.quickbooks.time`), redirect URI = the Admin app's `/qb-callback`.
- Supabase Edge Function secrets: `QB_TIME_CLIENT_ID`, `QB_TIME_CLIENT_SECRET`, `QB_TIME_REDIRECT_URI`.
- Deploy: `supabase functions deploy qb-time-proxy` (and `qb-time-daily` in P2).

---

## 8. Open decisions

1. **Connect UI home** — Admin app (recommended) vs. a hidden field-app settings screen. Office connects once; techs never see OAuth.
2. **Daily pull window & time** — "yesterday full day" at ~6am, or "today so far" on a rolling pull? Alaska time zone.
3. **QB rows editable in the log?** v1 read-only (edit in QB, re-pull). Confirm that's acceptable, or we allow local override.
4. **P3 crew map** — worth tying QB employees to `crew_members` for labor-cost math, or is the name-on-the-log enough?

---

*Roybal Construction, LLC · Fairbanks, Alaska*
