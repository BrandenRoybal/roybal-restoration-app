# Claude Code brief — web lead screening (roybal-lead)

Kickoff line: **"Read docs/Claude_Code_Prompt_Lead_Screening.md and apply it."**

## What this is

Scam and sales-pitch leads from the website form keep texting Branden. The
honeypot and the IP / subnet / hourly limits in `roybal-lead` already stop
bots; the junk that gets through is people pasting templates by hand. This
change scores each submission and, when it is screened:

- still **saves** it to the board (title gets a 🚩, notes get the reasons)
- still **emails** it (subject `[Likely spam]` or `[Sales pitch]`, reasons on top)
- does **not** text Branden
- does **not** create a CRM contact (no `contact_resolve`, no opt-in stamp)

An **emergency always texts**, screened or not, with the flag in front.
A **repeat** (same phone or email through the form in the last 24h) is saved
and emailed with `[Repeat]` but not texted again.

Nothing is ever dropped. Worst case of any failure in the new code is
today's behavior.

## Files

| File | Change |
|---|---|
| `supabase/functions/_shared/leadscreen.ts` | **new** — pure scorer (`screenLead`, `screenSummary`, `outOfState`, `nanp10`) |
| `supabase/functions/_shared/leadscreen.test.mjs` | **new** — 18 Node tests, modeled on the real Aug–Oct 2026 submissions |
| `supabase/functions/_shared/leadmail.ts` | optional `screen` / `repeat` / `texted` on `LeadForMail`; subject tag, reasons block, last-line wording. Output is byte-identical when they're absent, so `leadmail.test.mjs` should still pass |
| `supabase/functions/roybal-lead/index.ts` | runs the screen + repeat check, skips text / CRM, writes `phoneDigits`, `emailLower`, `screened`, `screen`, `repeat` on the lead's `data` |

The patch `lead-screening.patch` was built against the **deployed** `roybal-lead`
(version 44, pulled from production Oct 22, 2026), not the repo. If `main`
has drifted from what's deployed, apply with `--3way` and resolve.

## Steps

1. Branch `feat/lead-screening` off `origin/main`.
2. `git apply --3way lead-screening.patch` (or copy the four files in).
3. Tests:
   - `node --test --experimental-strip-types supabase/functions/_shared/leadscreen.test.mjs` → 18/18
   - `node --test --experimental-strip-types supabase/functions/_shared/leadmail.test.mjs` → all existing pass
   - `deno check supabase/functions/roybal-lead/index.ts` → clean
4. Commit, push, open the PR. Branden merges.
5. **Staging first** (`efbuagiwowcwwsezkgsw`): `supabase functions deploy roybal-lead --no-verify-jwt --project-ref efbuagiwowcwwsezkgsw`, then submit two test leads (a `415-555-01xx` number with a California address → no text, `[Likely spam]` email; a 907 number with a Fairbanks address → normal text).
6. **Production only on Branden's OK**: same deploy against `djpgvcvhvgrzgaziruze`.

No migration — every new field lives inside the `data` JSON.

## Knobs (Supabase secrets, no redeploy needed to change)

- `LEAD_SCREEN=off` — turns screening off entirely (instant rollback)
- `LEAD_SCREEN_THRESHOLD` — default `4`; raise to screen less, lower to screen more

## How it scores (summary)

Hard tells: 555-exchange phone (+3), out-of-state address — last segment or
non-Alaska ZIP only, so "Washington Dr" never trips it (+3), Roybal's own
address used as theirs (+2 pitch). Soft tells: non-907 phone (+1), numbered
free email *only next to* a non-907 phone (+1), a different email in the
message than on the form (+2), no Fairbanks-area place named (+1), Alaska
ZIP outside 997xx (+1). Wording: known scam templates (+2 each, capped at 4),
stock phrases like "kindly" / "at your earliest convenience" (1 point total,
never more), and separate sales-pitch rules (loans, ads/SEO, lead-gen scripts).

A scam screen needs **4+ points and at least one non-wording tell**, so
phrasing alone never screens a local number at a local address.

On the 15 real web submissions Aug–Oct 2026: 6 of 8 junk screened (two
template leads with a 907 number or an Anchorage address still text — safe
side); every real customer scored 2 or less.

## Follow-up (not in this PR)

The admin Leads tab doesn't know about `data.screened` yet. The 🚩 in the
title shows on the board as-is. A "Screened" filter/badge in the Leads Inbox
would be the natural next step.
