> **Committed copy.** The repository is public, so the customer's street address (and the file names that carry it) are redacted here as `<address>`; the verbatim brief is in the owner's files and in the side-session notes. Everything else is as written.

# Claude Code Brief — Estimate Engine Revision (v2)

**Repo:** `roybal-restoration-app` · **Owner:** Branden Roybal · **Date:** October 30, 2026
**Kickoff line:** `Read docs/Claude_Code_Prompt_Estimate_Engine.md and start Step 0.`

## 1. Why this exists

The site-visit estimator in the Field Forms app (merged in #217/#219, fed by the Site Visit panel's walk transcript and the Magicplan M1 pull) produced a clean, arithmetically correct estimate for the Krueger job. But it left out scope the owner asked for and broke the company's pricing rules. One item it chose physically won't fit the space. It also put a schedule commitment in writing.

The goal of this work: **the engine's first draft should need only judgment edits from Branden, not structural rework.** That means the pricing rules, scope coverage and physical-fit checks are enforced by code, not left to the model's prose.

## 2. Golden test case — Krueger (RC-KRU-1026)

Inputs live on the Mac under `~/Documents/Roybal Construction, LLC/Estimates/Kuerger /`. Note the trailing space in the folder name. The owner's name is spelled Krueger.

| File | What it is |
|---|---|
| `Woodland Ave.qta` | 30-min Voice Memos walk. The transcript is embedded in the `tsrp` atom as JSON (`attributedString.runs`) — no STT needed. |
| `<address>.ifc` / `Sketch.pdf` / `Statistics.pdf` | Magicplan scan: lower level 25'8½" × 25'5¼", ceiling 6'7", bath 4'9¾" × 7'10¼". |
| `<address>_Photos/` | 24 photos. |
| `RC-KRU-1026 … Job Prints Rev2.pdf` | Branden-approved layout (shower, vanity, kitchen, soffit, hood). |
| `RC-KRU-1026 … Estimate Rev1.docx/.pdf` | **Reference estimate** — Branden's approved scope and pricing. |
| App output being corrected | `Estimate RC-KRU-1026 — Oct 30, 2026 — <customer>.pdf` (app-generated; copy it into the fixture). |

**Reference numbers**

| | App output | Reference (Rev 1) |
|---|---|---|
| Direct cost (line total) | $64,582.84 | $84,705.25 |
| Markup | 15% contingency, then OH 10% + profit 10% on the same base | OH 10%, then profit 10% on (subtotal + OH) = ×1.21. No contingency. |
| Total | $89,124.32 | $102,493.36 |

**What went wrong in the app output (each one becomes a test):**

1. **Missed requested scope.** The owner asked for the downstairs bath to be brought up to the upstairs bath's finish level. The app only priced the ceiling repair. Missing: vanity at the existing rough-in, bath LVP, toilet pull/reset, mirror and accessories, wall patching, moisture verification and antimicrobial. That's about $5.3k direct.
2. **Physically impossible item.** It priced an over-the-range microwave under a 6'6"–6'7" ceiling with 24" uppers. Required cooktop clearance can't be met. It also had no hood, no soffit and no backsplash.
3. **Pricing-policy violations.** It added a blanket 15% "design contingency" and computed profit non-stacked (OH and profit on the same base).
4. **Below-market unit costs.** The slab trench was $115/LF all-in inside a bathroom; Fairbanks reality is about $230–275/LF. The deck coating spec was 1 primer + 1 paint with no rail sanding.
5. **Measurement drift.** Heater covers came out at 124.5 LF. The owner's taped dictation sums to 118.5 LF (upstairs 6 + 21 + 2 + 8 = 37; lower 10 + 13 + 24 + 26 + 8.5 = 81.5). The deck surface came out at 674.5 SF against 628.5 SF dictated.
6. **Unrequested scope in the base price.** It repainted the whole den (about $1.3k).
7. **Wrong product semantics.** "Walk-in shower" became a curbed tile pan with a curtain rod, and there was no exhaust ventilation for the new shower.
8. **Schedule commitment.** "Estimated duration: 6–8 weeks interior" is not allowed in customer docs (see R6).
9. **Defaults.** "Valid until" was left blank. Appliances were included as allowances when the walk didn't say the contractor supplies them.

What the app did **well**, which you must keep:
- Recap math ties out.
- Custom-height closet door for the low ceiling.
- Exploratory opening line at the chase.
- Useful alternates with prices.
- Captured customer phone and email.
- Clean letterhead.

## 3. Rules to enforce in code (owner policy — do not soften)

Put these in a **versioned pricing-policy config** (DB table or checked-in JSON) that both the generator and the validators read. No rule may live only in prompt prose.

**R1 — Labor rates by trade.**
- $125/man-hr: carpentry, general crew, site work, demo, finish carpentry.
- $150/man-hr: roofing, welding/steel.
- Subs (plumbing, electrical, tile, drywall, paint) at their quoted or company rates.
- When more than one labor rate is used on an estimate, show a RATE column.

**R2 — Markup.**
- Line items are always at raw direct cost.
- Summary lines run Subtotal → Overhead 10% → Profit 10% of (Subtotal + OH) → Total. Effective factor 1.21.
- Show each phase's total including O&P (×1.21) so any phase can be approved or deferred on its own.

**R3 — No blanket contingency** on remodel or reconstruction. Real unknowns get a firm price, either as their own separable phase subtotal or as a priced alternate. They never get a percentage.

**R4 — Allowances** only for owner-selection items (fixtures, cabinets, tops, tile, appliances). Label them as "material basis": above-basis selections are billed at cost plus O&P, below-basis are credited.

**R5 — Appliances default to owner-furnished** unless the transcript says Roybal supplies them. Offer a Roybal-supplied appliance package as an alternate with a budget range.

**R6 — No durations or completion dates** in customer-facing documents. Weather-dependent work may be labeled by season ("spring work"). Durations can live in internal fields only.

**R7 — Validity and season-deferred work.**
- Valid-until = estimate date + 30 days, auto-filled.
- Work deferred to a later season: the quote holds 30 days, and materials are re-confirmed before the start. Put that in the assumptions.

**R8 — Sales tax** comes from the job's jurisdiction. Fairbanks/FNSB = none. Omit the line when it's zero rather than showing $0.00.

**R9 — Never volunteer IEP or third-party clearance testing** unless it's carrier-, code- or spec-required.

**R10 — Estimate numbering:** `RC-<LAST3>-<MMYY>`, with `-2` on collision and ` Rev n` on revisions. A revision carries a one-paragraph change summary at the top.

## 4. Engine changes

### Step 0 — Recon (report only, no code)
Find and document where each of the following lives today:
- The transcript→scope prompt(s).
- The line-item generator.
- The price/unit-cost source.
- The markup math.
- The document renderer.
- How Magicplan quantities and the walk transcript feed the estimator.

Map every item in §2 to the code responsible. Deliver this as `docs/Estimate_Engine_Recon.md` and stop for owner review.

### Step 1 — Policy config + deterministic markup (R1–R10)
- Replace any model-computed totals with a pure function `computeTotals(lines, policy)`.
- Unit-test it against the reference: direct cost $84,705.25 → OH $8,470.53 → profit $9,317.58 → total $102,493.36.
- Unit-test the per-phase O&P column and alternates. Alternates are always shown at their price including O&P.

### Step 2 — Requests ledger (scope coverage)
- **Extraction.** Before generating lines, extract every owner request from the transcript into a ledger. Each entry carries the verbatim quote, the timestamp from the `tsrp` time ranges or utterances, the area, and the intent (add / repair / replace / defer / decline).
- **Mapping.** Every ledger entry must map to at least one line item, an exclusion, an alternate, or "deferred by owner".
- **Hard flag.** Any unmapped entry is a hard flag shown to Branden before the estimate can be finalized. Flag it, don't block it, consistent with the product rule "undocumented items get flagged, not blocked".
- **Reverse check.** Every base-price line must trace back to a ledger entry or to a required-by-code/means-and-methods item. Anything else (e.g., the den repaint) moves to alternates automatically.
- **Krueger expectation.** The ledger contains, among others, "bathroom downstairs … to this level" → vanity, floor, toilet reset, accessories. It also contains the deferred separation door → alternate/deferred.

### Step 3 — Physical-fit and code checks (from scan + field measurements)
Run the checks below against measured geometry. Each check emits a flag plus a suggested resolution. Resolutions go into the assumptions only after Branden accepts them.

| Check | Rule (make thresholds configurable) |
|---|---|
| Ceiling height vs habitable use | Below 7'-0" → auto-assumption: "not represented as a legal separate dwelling unit". |
| Doors | Leaf height ≤ ceiling − header/trim allowance → custom-height door line. |
| Upper cabinets | Counter 36" + ≥18" clear + cabinet height ≤ ceiling; propose 18" uppers + soffit when the ceiling is under 84". |
| Over-the-range microwave / hood | Required cooktop clearance (listing, default 24"–30") + appliance height must fit under the cabinet/soffit, or reject. Offer a ducted hood in a soffit, or a downdraft range with a recirculating kit. |
| Stacked washer/dryer | Unit height + top clearance ≤ ceiling. |
| Electrical panel | 30"W × 36"D × 6'6"H clear working space. No overcurrent devices inside a bathroom or shower room. |
| New shower | Exhaust ventilation line required. "Walk-in" = low-threshold/curbless and no curtain rod by default. |
| Range + plumbing on a shared wall | Coordination flag. |

### Step 4 — Measurement reconciliation
- When the transcript contains dictated tape measurements, parse them, sum them, and **show the arithmetic** in the line notes (e.g., "6 + 21 + 2 + 8 = 37 LF").
- Field tape beats scan when both exist. Scan beats model inference.
- Ambiguous dictation ("24 plus 26") is flagged with both readings, never silently resolved.
- Produce a reconciliation table: source → quantity → used value.

### Step 5 — Fairbanks unit-cost benchmarks
Add a benchmark table, versioned and editable by Branden. Lines that come in more than 25% below benchmark get flagged before output. Seed values from the reference estimate and owner rules:

| Item | Benchmark |
|---|---|
| Slab trench in occupied space (saw-cut, break-out, excavate, backfill, vapor barrier, dowel, re-pour) | $230–275/LF direct |
| Drywall hung, Level 4, painted | $5–6 per board SF (gut check: floor SF × 3.5 = board SF) |
| Deck refinish | Wash + sand (surfaces, rails, stairs) + 2 coats ≈ $20/SF of deck incl. rails, direct |
| Heater covers (premium slip-on) | ≈ $66/LF installed incl. accessories and freight |
| Supervision | Sized by trade count. About 16 hrs for a 4-trade, ~8-week interior remodel; don't default to 40. |

The job-board time-tracking feedback loop should write actual production rates back into this table later. Leave a hook for it, don't build it now.

### Step 6 — Output format (match the estimate spec)
- **Numbered sections:** 1 Scope Overview · 2 Scope & Pricing (owner-deferrable **phases** with subtotals, room/sub-group rows shaded) · 3 Estimate Summary (per-phase direct + incl. O&P, then the totals block) · 4 Assumptions, Allowances & Exclusions · 5 Acceptance & Next Steps.
- **Divisions:** CSI-style recaps may stay as an internal view.
- **Layout and export:** follow the house print spec already in `apps/field/css/print.css` + `formkit.js`.
  - The DESCRIPTION column gets most of the table width, with fixed column widths.
  - The Acceptance section uses Branden's standard next-step line: DocuSign + QuickBooks deposit invoice.
  - Add .docx export if the planned PR is in reach. Otherwise leave a TODO pointing to it.

### Step 7 — Revisions
When prints or owner markups change, regenerate as `Rev n` with a change summary and line-level diffs. Never overwrite a prior revision.

## 5. Acceptance criteria (the golden test must pass)

Run the engine on the Krueger fixture and assert:

1. Markup math is exact per R2. There's no contingency line, and the per-phase O&P column is present.
2. The requests ledger has 100% mapping. The downstairs bath refresh items are present. The den repaint is not in the base price.
3. Over-the-range microwave is rejected with a fit flag. Hood + soffit (or downdraft) is proposed.
4. Heater covers = 118.5 LF with the arithmetic shown. Deck surface = 628.5 SF.
5. Appliances are owner-furnished in the base, with the package as an alternate.
6. No duration or date commitments in the document. Valid-until = date + 30.
7. Slab trench unit cost is at or above benchmark, or flagged.
8. The walk-in shower has a low threshold and an exhaust fan.
9. Direct cost lands within ±10% of the reference **after normalizing** for appliances (reference $84,705.25). Report the remaining variance by phase.
10. All existing test suites stay green (field, board, fn). Add new tests under the existing conventions.

## 6. Guardrails

- **Branch and environment:** work on a feature branch off `origin/main`. Staging (`efbuagiwowcwwsezkgsw`) first. Do **not** push, merge or deploy to production — those are Branden's calls.
- **Who decides what:**
  - The model drafts lines.
  - Deterministic validators enforce the rules and raise flags.
  - Branden approves.
  - Money actions stay owner-approved (standing ruling Sept 6, 2026).
- **Don't break the live estimator.** Gate the new pipeline behind a flag until the golden test passes and Branden signs off.
- **Report format:** at each step, report what changed, test results, and any open questions as numbered decisions with a recommended default.
