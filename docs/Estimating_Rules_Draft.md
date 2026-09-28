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

## 10. Patterns mined from 40 past Xactimate estimates (2026-09-28)

> **What this is.** A second, larger pass over your own estimates. 46 Xactimate exports went in;
> after dropping duplicates and non-claim work, 40 remain: **17 mitigation, 18 full-scope
> restoration, 3 small repair tickets, 1 combined tear-out-and-rebuild, 1 fire bid.** 13 jobs have
> both a mitigation and a restoration estimate, which is what makes the put-back comparisons
> below possible. Files with no mitigation/restoration label were classified from their contents.
>
> **How to read a count.** *x/y* — *y* is the number of rooms or estimates where the pattern
> could apply, *x* is how many actually follow it. "Tendency" means under the 60% bar: listed so
> you can promote it or kill it, not treated as a rule.
>
> **What is left out on purpose.** No prices, no Xactimate codes, no customer or job names. The
> full count tables stay with the private data, outside this repo (the repo is public).
>
> **How to mark it.** Same legend as the rest of this doc — ✅ keep, ✏️ tweak (write the tweak),
> ❌ not a rule, ➕ something missing. Put the mark after the pattern's number (`M3 ✅`), or just
> reply with numbers ("R3 ✏️ only when the floor is replaced").

### 10.1 Mitigation — job-level lines (17 estimates)

- **M1** — Debris haul-off is on every mitigation estimate (17/17). Small and medium jobs get one
  pickup load (9 estimates); big tear-outs get a dump trailer, dumpster or dump truck (8
  estimates). Across all job types, 29 of the 36 haul lines are a single load.
- **M2** — Drying equipment is on 15/17; air movers on 14/17. On plain water losses, air movers
  and dehumidifiers appear together on 8/9.
- **M3** — When air movers are billed, equipment setup / take-down / monitoring hours are billed
  too (11/14), and so is equipment decontamination (10/14).
- **M4** — Decontamination quantity is one per piece of equipment placed (air movers +
  dehumidifiers + scrubbers + heaters): 8 of the 10 estimates that bill decon (3 itemize the
  pieces in the line text, 5 more add up that way).
- **M5** — Anti-microbial is on 11/17 mitigation estimates and in 43/67 mitigation rooms.
- **M6** — Contents handling is on 10/17: labor hours, move-out-then-reset per room, boxes,
  moving van, storage container and padlock.
- **M7** — Category 3 tear-out variants are used on every sewage and mold job (3/3), on 3/4 freeze
  jobs and on 1/9 plain water jobs.
- **M8** — Freeze jobs (only 4 — too few to call a rule) add the plumber's paid bill as a
  pass-through (3/4), crawlspace visqueen and drying heat.
- **M9** — Cold-weather drying heat is on 5 estimates: indirect-fired furnace, temporary heaters
  or IR panels.
- **M10** — Final clean (3/17) and floor protection (5/17) are rare on mitigation estimates. They
  belong to restoration.
- Tendencies (under 60%):
  - **M11** — Tech or cleaning labor hours: 9/17.
  - **M12** — Emergency service call: 8/17.
  - **M13** — Air scrubber: 8/17.
  - **M14** — PPE: 5/17 — the mold job, 1 of the 2 sewage jobs and 3 plain water jobs.

### 10.2 Restoration — job-level lines (18 estimates)

- **R1** — Drywall is on 18/18. Debris haul is on 17/18; 16 of those 17 are pickup loads, 14 of
  them exactly one load.
- **R2** — Mask-for-paint by the LF 17/18, PVA seal 17/18, paint 17/18.
- **R3** — Floor protection 12/18, new baseboard 12/18, final construction clean 11/18.
- **R4** — Contents are moved back on 6/18 — 5 of the 8 pairs where the mitigation estimate packed
  contents out, repeating the hours, the moving van and another container month.
- **R5** — Dust containment is on 6 of 19 restoration or combined estimates: a barrier plus zipper
  door, tension posts × days, and an air scrubber for 3–5 days. The default barrier is 48 SF (4
  estimates).

### 10.3 Room level — mitigation (67 rooms in 15 estimates)

- **MR1** — Flooring out → baseboard out: 51/52 rooms (13/13 estimates).
- **MR2** — A flood cut → baseboard out 34/35 rooms (9/9 estimates), flooring out 31/35 (9/9),
  anti-microbial 28/35 (6/9).
- **MR3** — Hard flooring out → drywall out: 28/30 rooms (12/12 estimates).
- **MR4** — Carpet out → pad out at the same SF: 19/19 rooms (4/4 estimates).
- **MR5** — Wet insulation out → drywall out: 14/15 rooms (6/7 estimates).
- **MR6** — A door slab removed → baseboard and flooring removed too: 20/20 rooms (6 estimates).
- **MR7** — Bathroom (10 rooms, 8 estimates): flooring, drywall and baseboard out 10/10; toilet
  9/10; door 8/10; vanity 7/10; tub or shower 7/10; anti-microbial 6/10; flood cut 6/10. Where the
  toilet comes out, the vanity also comes out in 7/9 and the tub or shower in 7/9 (6/7 estimates).
- **MR8** — Bedroom (11 rooms, 6 estimates): flooring and baseboard 11/11, pad 10/11, carpet 8/11.
- **MR9** — Closet (12 rooms, 7 estimates): flooring and baseboard 12/12, drywall 9/12, flood cut
  8/12, anti-microbial 8/12.
- **MR10** — Laundry (5 rooms): flood cut and baseboard 5/5. Utility (5 rooms): anti-microbial
  5/5. Hallway (5 rooms): flooring 5/5.

### 10.4 Room level — restoration (74 rooms in 18 estimates)

- **RR1** — New drywall → PVA seal 54/57 rooms (17/18 estimates), paint 54/57, mask 53/57,
  baseboard 40/57 (12/18 estimates), floor protection 34/57 (12/18 estimates).
- **RR2** — A flood-cut band → mask 39/41, seal 38/41, two-coat paint 38/41, baseboard 37/41, new
  floor 37/41 (10–11 of 11 estimates); baseboard painted or stained 25/41 (6/11 estimates).
- **RR3** — New hard floor → baseboard 29/33 rooms (10/12 estimates), floor protection 21/33
  (7/12). Floor prep for resilient flooring is on 8/12 estimates, but only in 16/33 rooms.
- **RR4** — New carpet → pad 19/20 rooms (4/5 estimates), baseboard 18/20, baseboard painted or
  stained 18/20.
- **RR5** — Baseboard installed → painted or stained in 34/50 rooms (7/12 estimates).
- **RR6** — A toilet goes back → new floor plus drywall, seal and paint 8/8 (6/6 estimates); door
  6/8; vanity, faucet or tub/shower items 5/8 each.
- **RR7** — Bathroom (12 rooms, 10 estimates): seal, two-coat paint and drywall 12/12; mask 11/12;
  floor protection 9/12; new hard floor 9/12; door 8/12; toilet 8/12.
- **RR8** — Bedroom (11 rooms): baseboard 10/11, new floor 10/11, mask 9/11, baseboard painted
  9/11, carpet and pad 8/11.
- **RR9** — Closet (14 rooms): new floor 14/14, baseboard 13/14, mask 12/14, flood cut with seal
  and paint 10/14, baseboard painted 9/14.
- **RR10** — Living (8 rooms): drywall, mask, seal and two-coat paint 8/8; baseboard 6/8. Laundry
  (6 rooms): mask and drywall 6/6; seal, paint, baseboard and flood cut 5/6.

### 10.5 Quantities

- **Q1** — Restoration copies the mitigation quantities room by room: flood-cut LF comes back as
  the same LF of drywall band (31/32 rooms, 9 pairs); removed floor SF comes back as the same SF of
  new floor, pad or prep (42/42 rooms, 11 pairs); baseboard LF comes back the same (37/44 rooms —
  in 5 rooms none came back, see D3); pad 19/19, toilets 7/7, vanities 5/5, doors 15/15.
- **Q2** — Flood-cut LF = baseboard LF: 23/37 restoration rooms (8/10 estimates) and 22/34
  mitigation rooms (7/9 estimates).
- **Q3** — Flood-cut LF = mask-for-paint LF: 29/39 rooms (9/10 estimates).
- **Q4** — Paint covers the full height of the affected walls, not just the patch: total painted SF
  ≈ 8 × the flood-cut LF in 30/38 rooms (8/10 estimates). The exceptions are 4-ft cuts and paneled
  walls.
- **Q5** — You have split seal and paint three ways (see D4):
  - March 2026 (3 estimates, 16 rooms): seal only the 2-ft band (LF × 2), paint the full wall two
    coats (LF × 8).
  - May–June 2026 (4 estimates): seal plus two coats on the lower third of the wall (LF × 2.64),
    then one coat on the upper two-thirds. The one-coat SF is twice the two-coat SF in 13/19 rooms.
  - Seal plus two coats on the full wall: 3 estimates.
- **Q6** — Two-coat paint SF = seal SF in 30/54 rooms (13/17 estimates).
- **Q7** — Floor protection SF = new floor SF: 21/27 rooms (7/8 estimates).
- **Q8** — Floor prep SF = net floor SF before waste: 12/15 rooms.
- **Q9** — Pad SF = net floor SF. Carpet is pad + 15% waste (9 rooms, 2 estimates) or equal to the
  pad (10 rooms, 2 estimates). Sheet vinyl gets +15% (6/7 rooms).
- **Q10** — Painted or stained baseboard LF = baseboard LF: 19/19 rooms (5 estimates). Trim stain
  LF = baseboard + casing LF: 13/15 rooms (2 estimates). Tack strip LF = baseboard LF: 7/7 rooms
  (2 estimates).
- **Q11** — Casing is 17 LF per door opening: 20/28 casing lines (6 estimates). A double bifold
  closet gets 19 LF.
- **Q12** — Removed pad SF = removed carpet SF: 19/19 rooms.
- **Q13** — Final clean SF is the floor area of the work area: exactly the sum of the affected
  rooms' floor SF on 4 estimates, otherwise the whole level or the containment area.
- **Q14** — Drying days stated in the line text: 2, 3, 4, 4 and 5.
- Tendencies (under 60%):
  - **Q15** — Setup / monitoring ≈ 1 hour per drying day: 5/9 estimates.
  - **Q16** — One dehumidifier per 3.3–4.5 air movers (by unit-days): 5/9 estimates.

### 10.6 Activity choices

- **AC1** — Mitigation never uses remove-and-replace. Wet porous materials are removed only:
  drywall 51/53 lines (14 estimates), carpet 19/19, pad 23/23, baseboard 51/52, hard floors 29/30,
  insulation 15/17. Every exception is on the mold job, which included its own rebuild.
- **AC2** — Restoration bills new material as replace-only, because the removal is already on the
  mitigation estimate: baseboard 40/40 lines (11 estimates), carpet 13/13, pad 12/12, hard floor
  28/30, drywall 43/50, vanity 6/6, tub 5/5, insulation 4/4.
- **AC3** — Restoration uses remove-and-replace only for items the mitigation estimate never removed
  (crawlspace visqueen, heat covers, ceilings): 3 of the 4 estimates that use it.
- **AC4** — The pairing across the two estimates is consistent. Detach in mitigation ↔ reset in
  restoration (one job: toilet, sink, washer, dryer, refrigerator, range, countertop, heat covers).
  Remove in mitigation ↔ a new item in restoration (3 toilet pairs, 2 vanity pairs, appliances on
  3 pairs).
- **AC5** — Toilets: removed in mitigation (5 estimates) or detached (2); new in restoration (5
  estimates) or reset (1).
- **AC6** — Vanities: removed in mitigation on 4 estimates; new in restoration 5/5.
- **AC7** — Door slabs: removed in mitigation (20/21 lines, 6 estimates); in restoration reset (14
  lines, 2 estimates) or replaced (5 lines, 3 estimates).
- **AC8** — Appliances: removed in mitigation (16/20 lines); in restoration 8 lines are new and 7
  are reset or remove-and-reset.
- **AC9** — Detach-and-reset for undamaged items that are in the way (lights, towel bars, shower
  doors, mirrors, faucet trim, shelving, heat covers, door slabs): 12 estimates.
- **AC10** — Hydronic baseboard-heat covers are detached and reset, or removed and replaced, so the
  drywall band can be cut out: 4 jobs.

### 10.7 What you consistently bill that engines commonly forget

- **F1** — Debris haul: 34/35 estimates.
- **F2** — Equipment decontamination (10/14) and setup / monitoring hours (11/14) whenever air
  movers are billed.
- **F3** — Mask by the LF plus PVA seal before paint (17/18 restoration estimates), with paint at
  full wall height (30/38 rooms).
- **F4** — Floor protection equal to the floor SF: 12/18.
- **F5** — Final construction clean: 11/18.
- **F6** — Putting back everything mitigation removed, at the same quantity. Baseboard is the
  most-missed item.
- **F7** — Painting or staining new baseboard: 7/12.
- **F8** — Floor prep under resilient flooring: 8/12.
- **F9** — Casing at 17 LF per door.
- **F10** — Anti-microbial after tear-out: 11/17.
- **F11** — Contents out and back, including moving van, container and padlock.
- **F12** — Tack strip and stair-step charges with carpet (only 2 estimates).
- **F13** — Cold-weather drying heat (5 estimates) and the plumber's paid bill on freeze jobs
  (3/4).
- **F14** — Dust containment plus a scrubber during restoration drywall work: 6/19.
- **F15** — Emergency service call (8/17), and PPE on Category 3 and mold jobs.
- **F16** — Crawlspace visqueen with seam tape (5 estimates) and hydronic heat covers (4 jobs).

### 10.8 Where the data disagrees with confirmed rules

Your confirmed rules above still win; these are the places your own past estimates did something
different, so you can say which one is right.

- **D1** — **Final clean and floor protection.** The engine's finish chain says *always* include a
  final construction clean and floor / surface protection on a restoration (§3.3, §5), but they
  appear on only 11/18 and 12/18 restoration estimates. Either the past estimates missed them or
  they depend on the job. The engine keeps "always" until you mark this.
- **D2** — **PPE in the Cat 3 package.** §2.6 *always* bills PPE consumables on a Cat 3 job, but
  PPE appears on only 1 of the 2 sewage jobs. The engine keeps the confirmed package.
- **D3** — **Baseboard put-back.** In 5 of 44 restoration rooms the baseboard that mitigation
  removed did not come back. That looks like a miss, not a rule — the engine now checks every
  room for it.
- **D4** — **Seal and paint split.** The split changed between March and May 2026 (Q5). The engine
  uses the May method: seal plus two coats on the lower third of the wall, one coat on the upper
  two-thirds, with paint covering the full height of the affected walls. The confirmed chain in
  §3.1 (mask → prime → two coats) still holds for the patch itself. Mark Q5 if a different method
  is what you want now.

### 10.9 What the engine now carries

- **Two blocks of text, `houseMitigation` and `houseRestoration`,** returned by `estimatingRules()`
  in `supabase/functions/roybal-ai-office/pricing.ts`. They condense the patterns above that clear
  the 60% bar — plus a few lower-support ones stated with the condition that triggers them (about
  one setup hour per drying day; contents back in when mitigation packed them out; dust
  containment in an occupied home) — into "include each unless the evidence shows it does not
  apply here." No prices, no codes, no names.
- **Where they go.** A reconstruction-estimate draft gets `houseRestoration`; a mitigation invoice
  draft gets `houseMitigation`; a site-visit draft on a claim job gets both; the supplement audit
  gets the one that matches what it is checking. A construction (non-claim) site visit gets
  neither. A site visit from a field app older than v192 (it sends no job type) is drafted as a
  claim and gets both blocks, but never the private price reference below.
- **They sit below your confirmed rules.** Each block comes after the confirmed inclusion rules it
  belongs with and is worded as a house pattern, not a mandate. Each block's header says so to the
  model in so many words: *"If a pattern here conflicts with a confirmed rule above, the rule above
  wins."* Where a pattern and a confirmed rule disagree (D1, D2), the confirmed rule wins. When you
  mark a pattern ✏️ or ❌, the block text changes to match.
- **Prices are a separate matter.** The prices on these same estimates are kept as a private,
  owner/office-only reference that never lives in this repo — see
  `docs/architecture/04-OPEN-QUESTIONS.md` C9 and ADR-12. Nothing in this section is a price. The
  reference never offers or stamps a job-specific lump sum (a bid item, an agreed price, a paid
  bill, an allowance or discount, or a line carrying that job's own quantities such as "2 units x
  5 days"): those rows stay loaded but are not unit prices. Dropping the reference tables stops new
  reference pricing only; lines already drafted keep their reference note on the job record.

---

*Draft generated from 18 past PDF estimates (8 mitigation, 9 restoration, 1 carrier) spanning
Freeze, Water, and Fire losses; §10 from a second pass over 40 estimates. Customer identities
intentionally omitted. ESX files were encrypted (Verisk proprietary) and could not be read
directly.*
