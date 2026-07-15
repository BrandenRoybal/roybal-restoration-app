# Estimating Inclusion Rules — DRAFT v1 (for Branden to correct)

> **Purpose.** This is the "judgment layer" for the estimating engine — the rules that
> decide *which line items to include* for a given loss, on top of the Fairbanks
> `AKFA8X` price list. It was reverse-engineered from **18 of your real estimates**
> (8 mitigation, 9 restoration, 1 carrier) across Freeze, Water, and Fire losses.
>
> **How to use this doc.** Read each rule. Mark it:
> - ✅ correct — keep as-is
> - ✏️ almost — needs the tweak I write next to it
> - ❌ wrong / not a rule — delete it
> - ➕ missing — a rule you always follow that I didn't catch
>
> Once you've marked it up, I compile the confirmed rules into the estimator prompt
> in `roybal-ai-office/index.ts` so every future estimate applies them automatically.

---

## 1. The two-estimate structure

Every job splits into **two separate estimates**, and the engine should treat them as
two different modes (it already has `reconEstimate` vs invoice modes):

| Estimate | What it bills | Carries O&P? |
|---|---|---|
| **MITIGATION** | Emergency + demo + dry-out (tear out wet materials, extract water, run equipment) | Only if GC rule met (§1.2) |
| **RESTORATION** | Rebuild — put back everything removed, then finish (prime, paint, clean) | Only if GC rule met (§1.2) |

### 1.2 O&P (Overhead & Profit) — CONFIRMED RULE ✅

Apply **10% overhead + 10% profit** **only when Roybal is acting as General Contractor
over at least one subcontractor** — i.e. **2+ trades/contractors on the job that must be
coordinated.** Insurance justifies O&P as GC coordination cost.

- **≥ 1 subcontractor on the job → apply 10/10.**
- **Roybal is the only contractor (self-performed) → NO O&P.**

Engine implication: O&P is a function of *how many contractors are on the job*, not the
loss type. The engine should ask / infer whether a sub is involved before adding O&P.

**Rule 1.1** — The restoration scope is *derived from* the mitigation scope: **whatever
was torn out or detached in mitigation gets put back in restoration.** This is the single
biggest inclusion rule (see §4).

---

## 2. MITIGATION — always include

Grounded in 8/8 mitigation estimates carrying `GENERAL DEMOLITION` + `WATER EXTRACTION & REMEDIATION`.

**2.1 Equipment / dry-out (the drying package)** — appears on nearly every water/freeze job:
- Air movers — "Air mover axial fan … (per 24 hr period)" × unit-count × days
- Dehumidifier — "(per 24 hr period) - 70-109 ppd" (LGR) × days
- **Equipment setup, take down, and monitoring (hourly charge)** — the labor to run the above
- **Equipment decontamination charge - per piece of equipment** — one per piece
- Water Extraction & Remediation Technician - per hour (Cat 2/3 extraction)

**2.2 Demolition** — tear out wet/non-salvageable materials:
- Tear out wet drywall — *bag for Cat 3*, *no bagging up to 2' tall* for clean losses
- Tear out non-salvageable flooring + underlayment, **bag for disposal**
- Remove baseboard, paneling, interior doors, insulation as affected

**2.3 Detach fixtures that survive** (so demo/drying can proceed) — see mirror list §4:
- Toilet - Detach, Sink - Detach, Cabinet (base) - Detach, Refrigerator - Detach
- Remove Toilet paper holder, Remove Towel ring

**2.4 Debris haul + service:**
- Haul debris - per pickup truck load **or** Dumpster / Tandem axle dump trailer (job-size dependent)
- Emergency service call - during business hours (first-response jobs)

**2.5 Treatments & pass-throughs:**
- Apply anti-microbial agent to the floor/surface (Cat 2/3)
- Plumbing (Paid Bill) / bid items — pass-through the sub/plumber invoice as a line

### 2.6 CATEGORY 3 MANDATORY PACKAGE — CONFIRMED RULE ✅ (auto-add on EVERY Cat 3 job)

> Branden's note: "one thing I almost always forget." **Whenever the loss is Category 3
> (black water — sewage, ground water, gross contamination), the engine must ALWAYS add
> this entire package.** Never omit it on a Cat 3 job.

**Containment & air control:**
- **Containment barrier** (poly / zipper walls) around the affected area
- **Negative air fan / HEPA air scrubber** (per 24 hr period × days)
- **Floor protection** (self-adhesive film / heavy paper) over unaffected paths

**Cleaning:**
- **HEPA vacuuming** of affected surfaces

**PPE & consumables (per-job replacement — these are billable "equipment replacement"):**
- **Type-X / Tyvek suits** (disposable coveralls)
- **HEPA / P100 respirator cartridges** (air cartridges)
- **Gloves**
- **Boot covers**

Engine behavior: this package is **gated on `category === 3`** (or the loss being flagged
gross-contamination/sewage). When Cat 3 is detected, inject every line above unless the
estimator explicitly removes one. Also drives §4: Cat 3 + porous materials → REPLACE.

### 2.7 HEPA filter replacement (negative-air scrubber consumable) — CONFIRMED RULE ✅

Whenever a **negative-air fan / HEPA scrubber is on the job**, add a HEPA filter replacement
line. Filter ≈ $220 each. **Quantity is category-driven** (per scrubber unit):

| Loss | Qty per scrubber | Justification to put on the line |
|---|---|---|
| **Cat 1 / 2** (clean / gray) | **0.5** | proportional filter life consumed this job |
| **Cat 3 / mold** | **1.0** | filter contaminated by sewage/mold aerosols — must be discarded |

Why partial on clean jobs: adjusters routinely accept 0.25–0.5 without question because it
reads as honest wear allocation; a full 1.0 on a clean loss gets flagged as billing a new
filter you likely reused. Full 1.0 is only defended by **contamination** (Cat 3 / mold).

Engine behavior: qty = (# HEPA scrubbers on job) × factor, factor = 1.0 if Cat 3 or mold else
0.5. Attach the justification text above to the line so it survives adjuster review. Flag it
editable so Branden can bump/trim per job.

### 2.8 Equipment QUANTITIES — use the existing sizing engine, don't guess ✅

**Do NOT let the AI estimate equipment counts.** The app already has the exact IICRC
WRT/S500 worksheet math in **`apps/field/js/dryingcalc.js`** (deterministic, node-tested,
adjuster-defensible). The estimating engine must **call this and convert the returned counts
into priced line items** — this is the answer to "how do you size the equipment."

The module exports `equipmentCalc({ rooms, waterClass, waterCategory, affT, ceiling, dehuType … })`
and returns a `low–high` count for each of:

| Equipment | Function | Method (from the worksheet) |
|---|---|---|
| **Air movers** | `airmoverCalc` | 1/room + wet-floor SF ÷70–÷50 + wall/ceiling >2 ft SF ÷150–÷100 + 1 per inset >18"; **or** lower-walls-only: 1 per 14 LF. Round up. |
| **Dehumidifiers** | `dehuCalc` | volume cu ft ÷ class factor = PPD ÷ AHAM rating. LGR factors: Cls1 100 / Cls2 50 / Cls3 40 / Cls4 40. Desiccant uses ACH. |
| **Air scrubbers / negative air (AFD)** | `scrubberCalc` | **Cat 3 → 4 ACH, Cat 2 → 2 ACH, Cat 1 → none.** vol × ACH ÷ 60 = CFM ÷ 500-CFM units. |
| **Auxiliary heat** | (temp check) | if affected-air temp < 70°F → add aux heat per S500 (**common on Alaska freeze jobs**). |

**How this ties the rules together:**
- `scrubberCalc` count = the # of negative-air units → **drives §2.6** (Cat 3 package) **and the
  §2.7 HEPA-filter quantity** (0.5 or 1.0 × this count).
- Inputs (`rooms` = per-room floorSF + perimeter, ceiling, class, category, psychrometrics)
  come from the **AI floor-plan takeoff + drying log** the app already produces.
- Equipment line items = counts × **days deployed** (from the drying log) × the price_list
  per-24-hr rates. The mitigation "run days" come from the actual monitoring log, not a guess.

**Reconciled against the official IICRC worksheets (7.1.22 airmover / 3.1.22 dehu), Jul 2026:**
- ✅ Air movers — `dryingcalc.js` matches the worksheet exactly (1/room, floor ÷70/÷50,
  wall+ceiling >2 ft ÷150/÷100, +1 per inset >18", round up, 14-LF lower-walls rule).
- ✅ Dehumidifiers — factor chart matches exactly (Conv 100/40/30/NA · LGR 100/50/40/40 ·
  Desiccant 1/2/3/3 ACH); both refrigerant and desiccant formulas match.
- ✅ Air scrubbers/AFD — worksheet explicitly says the desiccant formula "can also be used to
  determine AFD calculations," which is exactly what `scrubberCalc` does. Correct.
- ➕ **Gap:** the airmover worksheet also has a **Gallons-of-Water** calc (L×W×water depth =
  cu ft × 7.48 = gallons) that `dryingcalc.js` does NOT compute. Gallons is used to size/justify
  **water extraction** billing. *Consider adding it so extraction line-item qty is defensible.*
- Minor: worksheet notes a small-room discretion ("under ~25 SF, one airmover may be adequate");
  the code follows the literal formula and may count 1 extra on tiny rooms — discretionary, fine.

**Dehu config — CONFIRMED ✅:** Branden **rents** dehumidifiers (no owned stock), always **LGR**,
in **three AHAM sizes: 70 / 110 / 130 PPD** — which already matches `DEHU_SIZES = [70,110,130]`
and the LGR default in `dryingcalc.js`. Engine: size with LGR factors, pick the smallest of
70/110/130 that meets the PPD, and bill as a **rental** (per-24-hr price_list rate × days).

---

## 3. RESTORATION — always include

Grounded in category presence: GENERAL DEMOLITION 8/9, PAINTING 8/9, DRYWALL 7/9, CLEANING 6/9.

**3.1 The paint/finish chain** (this is nearly universal — 6/9 to 8/9):
- Mask and prep for paint - plastic, paper, tape (per LF)
- Seal the surface area w/ PVA primer - one coat  →  Paint the walls - two coats
- **Rule:** any new/patched drywall → **prime + 2 coats paint**, and mask/prep first.

**3.2 Drywall rebuild** (7/9):
- 1/2" drywall per LF - up to 2' tall (flood-cut put-back) **or** R&R 5/8" drywall hung/taped/floated
- **Drywall labor minimum** when the drywall quantity is small (see §5)

**3.3 Cleanup (6/9):**
- **Final cleaning - construction - Residential** — essentially every restoration
- Haul debris - per pickup truck load — post-construction cleanout
- Floor protection (self-adhesive film / heavy paper & tape) while working

**3.4 Flooring put-back** (5/9 vinyl):
- Floor preparation for resilient flooring → **then** the flooring (vinyl plank, laminate, carpet + pad)
- **Rule:** never install flooring without a floor-prep line first.

---

## 4. The put-back mirror (Rule 1.1, itemized)

The strongest structural rule. For each mitigation action, the restoration has its inverse:

| MITIGATION (remove/detach) | → | RESTORATION (install/reset) |
|---|---|---|
| Remove / tear out vinyl-plank flooring | → | Floor prep + Vinyl plank flooring - install |
| Tear out wet drywall | → | 1/2" drywall put-back → prime → paint |
| Baseboard - Detach *(or remove)* | → | Baseboard - 3 1/4" install (or Reset) |
| Remove paneling | → | Paneling - install |
| Interior door - Remove | → | Install interior door **or** Interior door - Reset |
| Toilet - Detach | → | Install Toilet |
| Sink / Vanity - Detach | → | Vanity + Vanity top (cultured marble) install |
| Cabinet (base) - Detach | → | Reset / R&R cabinet |
| Toilet paper holder / Towel ring - Remove | → | Reset / install (finish hardware) |
| Refrigerator / Washer / Dryer - Detach | → | Install / reset appliance |

**Detach & Reset vs Remove & Replace — CONFIRMED RULE ✅**

Decide per item using loss category + material + damage:

1. **REPLACE (Remove & Replace)** if **either**:
   - the item is **damaged by the loss**, OR
   - the loss is **Category 3 (black water)** *and* the item is a **porous material**
     (plywood, particleboard/fiberboard, MDF) — porous + Cat 3 can't be decontaminated.
2. **DETACH & RESET** if the item was only removed to **dry out the wall/floor behind it**,
   it is **undamaged**, and it's **not** a Cat-3-porous case.

Worked example (from Branden): a vanity pulled to dry the wall behind it — if it's Cat 1 and
undamaged → detach & reset; if it's Cat 3 and the cabinet box is plywood/fiberboard → replace.

---

## 5. Always-add "support" lines (easy to forget, you rarely do)

- **Labor minimums — CONFIRMED RULE ✅ (discretionary, do NOT auto-add):** apply a trade's
  labor minimum **only when the estimator judges it necessary** — not automatically.
  **Carriers dislike labor minimums and flag/cut them nearly every time.** Engine behavior:
  do **not** pad estimates with labor minimums by default. At most, *surface a suggestion*
  ("drywall qty is small — a labor minimum may apply, but expect the carrier to push back")
  and let Branden decide. Never silently inflate with minimums.
- **Floor / surface protection** while working (3/9 restorations).
- **Final construction cleaning** on every restoration.
- **Mask & prep** before any painting.
- **Equipment decontamination** — one per piece of drying equipment on mitigation.

---

## 6. Loss-type differences (from the sample)

- **Freeze** (4 jobs in sample): plumbing pass-through common; large detach lists
  (whole rooms of fixtures); insulation R&R.
- **Water** (5 jobs in sample): heavy extraction-tech hours,
  containment barrier / dehumidifier, anti-microbial, content manipulation.
- **Fire** (1 job in sample): **No fire history to learn from — Branden's first real fire job is still
  ahead (and he's yet to take the IICRC fire cert).** We build the fire ruleset *as the first
  job happens*, not from past data. Placeholder starting scope to refine live: seal for
  smoke/odor (thermal fog / seal & paint), contents cleaning, HVAC/duct cleaning, soot HEPA
  vacuuming. **Do not auto-apply until validated on a real job.**
- **Mold:** none in sample — same approach (build when the first one lands).

---

## 7. Status of judgment-call questions

1. **O&P** — ✅ ANSWERED → §1.2 (apply only when GC over ≥1 subcontractor).
2. **Detach&Reset vs R&R** — ✅ ANSWERED → §4 (replace if damaged, or Cat3+porous; else reset).
3. **Labor minimums** — ✅ ANSWERED → §5 (discretionary only; do NOT auto-add — carriers
   flag and cut them nearly every time).
4. **Equipment sizing** — ✅ MOSTLY RESOLVED → §2.8. Already implemented as WRT/S500 worksheet
   math in `apps/field/js/dryingcalc.js`; engine should call it, not guess. Pending: Branden's
   S500 worksheet PDF (to reconcile) + confirm Fairbanks dehu defaults (LGR vs desiccant, AHAM
   pint rating stocked).
5. **Content manipulation** — ✅ ANSWERED: pure Time & Material, log actual crew hours
   (Content Manipulation charge - per hour). No formula.
6. **Anything flagged ❌/➕** above — ⏳ pending Branden's markup.
7. **Fire & mold coverage** — ✅ DECIDED: no history exists; build these rulesets live on the
   first real job of each type. Not a blocker. (§6)

> Branden's Q5 answer trailed off ("…keep track of the time. And") — anything after "And"
> still to capture.

---

## 8. Implementation plan (how the rules get wired into the engine)

Data flow confirmed by code read (Jul 2026):
- **Line-item drafting** = `supabase/functions/roybal-ai-office/index.ts` → `invoiceDraft` (:366)
  and `invoiceAudit` (:472). Prompts built from string blocks; already has a light Cat 3 touch (:411).
- **Facts digest** (engine input) built client-side in `apps/field/js/officeai.js`
  (`invoiceFacts`, `reconEstimateFacts`) + `convert.js` (`rebuildFacts`).
- **Equipment sizing** = `apps/field/js/dryingcalc.js` (`equipmentCalc`) — verified vs IICRC worksheets.
- **O&P** applied client-side in `forms.js:1359` (`subtotal × overheadPct`), default 10/10 in
  `model.js:341`. Drafter deliberately omits O&P. **No "sub on job" signal exists yet.**

| Phase | Change | Files | Risk | Status |
|---|---|---|---|---|
| **A. Inclusion rules** | `INCLUSION_RULES` prompt block: put-back completeness, detach-vs-replace (§4), full Cat 3 package (§2.6), HEPA filter (§2.7), discretionary labor minimums (§5), paint/finish chain, final clean | `index.ts` (prompt only) | Low | ✅ DONE |
| **B. Equipment sizing** | Prompt bills equipment from `facts.equipmentSizing.recommended` (already flows via `equipmentSizingSummary`) × deployed unit-days — no guessing | `index.ts` (prompt only) | Low | ✅ DONE |
| **C. O&P GC rule** | Flat 10/10 default → auto-detect a sub on the job from sub invoices; O&P 10/10 when present, 0 when self-performed; manual override | `model.js`, `forms.js` | Med (billing) | ✅ DONE |
| **D. Gallons calc** | ~~Add gallons to `dryingcalc.js`~~ | — | — | ❌ DROPPED — Roybal bills extraction HOURLY only (no way to measure extracted water). Gallons calc unnecessary. |

**A + B shipped** (Jul 2026) in `invoiceDraft` + `invoiceAudit`. Both drafter and supplement
auditor now carry the ruleset. Data-flow discovery: `facts.equipmentSizing` (S500 counts) and
`facts.equipment` (deployed unit-days) already reach the engine — B needed only a prompt change.

**C decision (confirmed):** auto-detect from sub invoices + keep the 10/10 default when a sub is
present; default 0 (no O&P) when self-performed; manual override retained.

**C implementation (shipped Jul 2026):** `newInvoice()` carries `opAuto:true`; `invoice()` sets
O&P to 10/10 when `jobHasSubcontractor(project)` (a "Subcontractor invoice" attachment exists),
else 0/0. Editing an O&P % sets `opAuto:false` so the manual value sticks. Legacy invoices
(`opAuto` undefined) and imported-Xactimate "amount" mode are never touched. A note under the
O&P row explains the auto-set. Verified: 7 unit tests (self-performed/ sub/ material-only/ legacy/
override/ amount mode) + full field-app suite (581 checks, exit 0).

## 9. Status summary (Jul 2026)

- **Rules captured & confirmed:** O&P-when-GC · detach-vs-replace · discretionary labor minimums ·
  Cat 3 mandatory package · HEPA filter 0.5/1.0 · equipment sizing via `dryingcalc.js` (verified
  vs IICRC worksheets) · dehu = LGR rental 70/110/130 · put-back mirror · paint chain · final clean.
- **Engine wired:** Phases A + B + C shipped and verified. D dropped (extraction billed hourly).
- **Open / future:** fire & mold rulesets built live on the first real job of each type; Branden's
  markup pass (✅/✏️/❌/➕) on this doc; changes are uncommitted on branch
  `claude/fairbanks-price-list-estimating`.

---

*Draft generated from 18 past PDF estimates (8 mitigation, 9 restoration, 1 carrier) spanning
Freeze, Water, and Fire losses. Customer identities intentionally omitted. ESX files were
encrypted (Verisk proprietary) and could not be read directly.*
