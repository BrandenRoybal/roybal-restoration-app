# Phase 1 Build Plan — Voice Capture on the AI Backbone

**For:** Branden Roybal · Roybal Restoration
**Date:** June 25, 2026
**Builds on:** `supabase/migrations/200_ai_backbone.sql` (the additive backbone) and the architecture doc.
**Decisions locked:** Option B (additive) · voice is online-only · capture the tech (`captured_by`) · premium-accuracy AI with a monthly spend cap · Transcribe button on **Moisture Map, Drying Log, Photos, Daily Construction Log**.

> Plain-English summary: a tech taps 🎙️, talks, and the app turns their words into tappable, pre-filled fields — then checks the job against the IICRC required-form rules and tells them what's still missing *before they leave the site*. Nothing gets rebuilt later; every future feature feeds the same pipeline.

---

## 1. The pieces we add (and what each is for)

| Piece | Where it lives | Job |
|---|---|---|
| **`200_ai_backbone.sql`** | Supabase (already written) | The new tables + the seeded water-mit required matrix. |
| **`roybal-ai-ingest` Edge Function** | `supabase/functions/` | The online-only brain: audio → text → structured candidates. Holds the AI keys safely server-side (same pattern as your `magicplan-proxy`). |
| **Completeness engine** | `apps/field/js/` (shared logic) | Reads the required matrix, walks the job, returns hard/soft gaps. |
| **Transcribe UI** | `apps/field/js/forms.js` + `formkit.js` | The 🎙️ button, recording, tap-to-confirm chips, the missing-field prompt. |
| **Tech identity** | `apps/field` (device-stored) | Tech picks their name once; rides along as `captured_by`. |

**Why an Edge Function and not in the app:** the speech + AI step needs secret API keys and a network connection. Keys can't sit in a phone app safely. Your repo already does exactly this for Magicplan and QuickBooks Time, so this is the established pattern, not a new one.

---

## 2. The capture flow (end to end)

1. Tech opens, say, the **Drying Log** on a job and taps **🎙️ Transcribe**.
2. App records audio. On stop, it creates a **`capture_events`** row (`source_type='voice'`, `form_key='dryingLogs'`, `captured_by=<tech>`, `status='pending'`) and uploads the audio to the `roybal-ai-ingest` function.
3. Function runs **speech-to-text** (premium engine), saves the `transcript`, then runs **LLM extraction** with a JSON schema scoped to that form + the job's `waterCategory`/`waterClass`.
4. Function writes the extracted **candidate fields** to `capture_events.result`, sets `status='extracted'`, returns them.
5. App shows candidates as **tap-to-confirm chips** (not a text box). Tech taps the right ones / fixes a number.
6. On confirm: values are written into the existing `field_projects` blob via the app's current save path; `capture_events.status='confirmed'`.
7. App runs the **completeness engine** for the job's current phase and shows the **missing-field prompt** if hard gaps remain.

**Offline behavior:** recording and manual entry work offline. If there's no signal at step 2, the audio + capture event **queue** (your apps already have an offline write queue) and process when signal returns. Voice is an *enhancement on top of* the always-offline manual path — never a blocker.

---

## 3. The extraction schema (how the AI returns clean data, not prose)

The LLM is forced to return JSON matching a fixed schema per form. Example for the **Drying Log** (field names match `model.js` exactly):

```json
{
  "form_key": "dryingLogs",
  "psychrometric": [
    { "location": "affected", "temp": 72, "rh": 55, "confidence": 0.93 },
    { "location": "outside",  "temp": 38, "rh": 70, "confidence": 0.88 }
  ],
  "equipment": [
    { "type": "air_mover", "count": 2, "location": "living room", "confidence": 0.95 },
    { "type": "lgr_dehumidifier", "count": 1, "location": "hallway", "confidence": 0.90 }
  ],
  "unmapped": ["mentioned a musty smell"]
}
```

- **Moisture Map:** `{ room, material, readings:[{location, mc_pct}] }` (dry goal auto-fills from material, as today).
- **Photos:** `{ photo_ref, stage: before|during|after, room, caption }` — caption is the free-form win.
- **Daily Construction Log:** `{ rows:[{employee, task, start, finish, hours}] }` — flows to the Board + QBO.
- Every value carries a **confidence**; low-confidence chips render in amber so the tech double-checks them. Anything the model can't map goes in `unmapped` so nothing is silently dropped.

---

## 4. The missing-field engine (the billing-protection win)

1. Look up the job's phase template (`water_mit`) and pull its `required_forms` + `field_requirements`.
2. Apply the job's conditions: always-required rules + any active add-ons (`contents`, `cleaning`, `cat3` when `waterCategory='3'`).
3. Walk the `field_projects` blob and mark each requirement present/absent (the `[]` paths mean "per affected room/day").
4. Write **`completeness_state`**: `hard_gaps`, `soft_gaps`, `present_count/required_count`, and `is_billable = (hard_gaps is empty)`.
5. Surface it: in the field as the "before you leave" prompt; on the Board as a phase badge; at billing as the gate.

Example prompt:

> "Got your moisture map and equipment log. Still missing for this Cat 3 drying phase: **psychrometric temp + RH** (affected area, today) and **'after' photos** for the kitchen. Capture now?"

The hard/soft split (which fields *block billing* vs. just *warn*) is exactly the matrix seeded in the migration — **please red-line it**; you know your adjusters.

---

## 5. Cost & the spend cap

- Premium speech-to-text + a strong extraction model lands around **a few cents per voice capture** (a typical daily log is well under $0.05).
- The Edge Function will **count monthly spend and refuse new AI calls past a cap you set** (default suggestion: $50/mo, adjustable), falling back to plain manual entry. So a runaway loop or a bad month can't surprise you.
- `captured_by` + `capture_events` give you a per-tech, per-job usage log if you ever want to see who's using it and how much.

---

## 6. Build sequence (each step ends in something you can see)

1. **Run `200_ai_backbone.sql`** in Supabase → confirm the seeded matrix with the verify queries at the bottom of the file. *(Visible: rows in `phase_templates` / `required_forms` / `field_requirements`.)*
2. **Spine + crosswalk:** on field-app job open, create/find a `unified_jobs` row and link `field_project_id` (and `coordination_job_id` if a Board job matches by claim #). *(Visible: one unified row per job.)*
3. **Completeness engine, read-only first:** compute gaps for an existing job and just *display* them — no AI yet. *(Visible: a "what's missing" panel. This alone is useful day one.)*
4. **Edge Function:** `roybal-ai-ingest` with STT + extraction + spend cap, provider key in Supabase secrets. *(Visible: paste a transcript, get structured JSON back.)*
5. **Transcribe UI on the Drying Log** (highest-value, hardest form) → record → chips → confirm → write-back. *(Visible: speak a log, tap to confirm, it saves.)*
6. **Roll out to Moisture Map, Photos (captions), Daily Construction Log.**
7. **Wire the missing-field prompt** to fire after each confirm.
8. **Distribute:** show the completeness badge on the Board phase and expose `is_billable`.

Steps 1–3 deliver value with **zero AI cost** (the completeness check is pure logic). Steps 4–8 layer voice on top. We can stop and ship after any step.

---

## 7. What becomes reusable (so we never rebuild)

The `capture_events` envelope, the extraction service, and the completeness engine built here are the shared backbone. Later: **carrier email drafting** = a new consumer of completeness + job data; **estimating help** = extraction over scope/line items; **crew no-show coverage** = the Board scheduler + crew load you already have; **QBO Time category auto-fix** = a new `source_type='qbo_time'` CaptureEvent. All plug in — none start a new backend.

---

## 8. Open items for you

1. **Red-line the required-form matrix** in the migration (Section 4) — confirm hard vs. soft gates.
2. **AI provider:** you chose premium accuracy — OK to default to Deepgram (speech) + a strong LLM, or do you have an existing account to use? Sets the keys in step 4.
3. **Spend cap number** (default $50/mo).
4. **Tech roster:** the list of names for the one-time "who are you" picker (or pull from the Board's `crew_members`).

---

*Roybal Construction, LLC · Roybal Restoration · North Pole, Alaska · IICRC WRT Certified*
