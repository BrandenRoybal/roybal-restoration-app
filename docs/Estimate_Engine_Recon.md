# Estimate Engine Recon — Step 0 (report only, no code)

**Date:** 2026-10-30 · **Branch:** `feat/estimate-engine-recon` (cut from `origin/main` 7fa0dd8 = field v217) · **Brief:** `docs/Claude_Code_Prompt_Estimate_Engine.md` · **For:** Branden's review before Step 1.

Every `file:line` below is `origin/main` at 7fa0dd8. Draft PR #287 (`fix/estimate-by-column-print`, field v218, open, not merged) shifts `apps/field/js/forms.js` by +4 lines below 1916 and touches `docx.js:170`, `print.css`, `docx.test.mjs` — see §7. The golden case is the Krueger remodel (RC-KRU-1026); the customer's address, contact details, recording and photos stay on the Mac and are not quoted here (the repository is public — §6).

---

## 0. Summary

**The pipeline in one line.** Site Visit panel (`apps/field/js/sitevisit.js`) → `roybal-ai-office` action `siteVisitStart` builds ONE Claude request from the packet, the measured rooms, the transcript, the rules, the company rates and the whole Fairbanks catalog → the request runs direct (Fly phone agent, else `roybal-site-draft`, else the Batches queue) → `siteVisitResult` stamps catalog prices (`resolveLines`) → `applySiteDraft` writes the lines, notes, alternates, contingency, accuracy and duration onto the estimate → `forms.js invoice()` prints it and `docx.js` exports it. Four separate copies of the totals ladder compute the markup on the client; the model never does.

**Headline findings**

1. **Every policy in the brief lives in prompt prose or in the model's output schema.** Nothing deterministic sits between the model and the printed document except price stamping and two guardrails (hourly rate on a non-HR line, unit-class mismatch). There is no validator layer, no ledger, no fit check, no benchmark, no measurement parser.
2. **The markup math exists four times** — `forms.js recalc()`, `docx.js estimateFigures()`, `bid.js estimateTotal()`, `fincalc.js invoiceTotals()`. Three agree (contingency first, then overhead and profit each on the same base); `fincalc` has no contingency at all, so the budget flag on an approved construction estimate already disagrees with the printed sheet by the contingency's O&P.
3. **Contingency, the ± range and the duration are schema fields the prompt tells the model to fill on construction jobs** (`sitevisit.ts:256-258`, `:336`); `applySiteDraft` copies them onto the estimate (`sitevisit.js:260-262`) and both renderers print them (`forms.js:2184-2185`, `docx.js:202-203`). Items 3 and 8 of §2 are design, not model error.
4. **On a construction job every unit cost except hourly labor is the model's own number** (`priced:'estimate'`). The Fairbanks catalog is still offered in full (all ten categories, `index.ts:848`), so demo, texture and the deck lines came back at Xactimate loaded prices — including the catalog's own "1 coat primer, 1 coat paint" spec. The Xactimate reference tier is correctly off for construction. No benchmark table exists.
5. **The walk reached the model as flat text.** The reviewable scope-notes layer (`walkExtract`, V2) exists and already does half of Step 2 — but it only runs on walk *clips*; a single "Site walk recording" (what the Krueger walk was) never gets notes, so `uncoveredInstructions()` had nothing to check and the panel's "Said on the walk, not in this estimate" box stayed empty.
6. **Magicplan geometry does reach the draft** (M3 "MEASURED QUANTITIES" block; the output's Pricing Basis carries "Quantities from Magicplan LiDAR scan dated Oct 30, 2026") including a per-room ceiling height — rounded to the half foot (6'7" → `6.5 ft`, which is why the draft's assumption says "6 ft 6 in"). Nothing checks fit against it.
7. **No dictated-measurement parser exists anywhere.** The model summed the heater-cover and deck dictation itself and drifted (124.5 vs 118.5 LF; 674.5 vs 628.5 SF).
8. **The document is the generic estimate sheet**: trade sections, one totals box, alternates, Recap by Section, a notes textarea, an acceptance block. No phases, no per-phase O&P, no numbered sections, no next-steps text. Valid Until is an empty date field; Sales Tax prints $0.00; the By column prints (fixed by #287).
9. **Everything in the keep list traces to code that survives**: `recalc()`/`paintRecap()`, the alternates schema + `paintAlts()`, `jobInfo()` for the header, `formkit letterhead()`, and the prompt's "state the assumption, price the reasonable case" sentence that produced the exploratory-opening line.
10. **The fixture is buildable without STT and without committing customer data.** The Voice Memos `.qta` carries Apple's transcript with word timing (verified locally: `tsrp` atom at byte 132,958,513; 3,818 time ranges, 7,636 run entries, 30:01 long, 19,962 characters). The app-output PDF has no text layer (a Quartz print of the Chrome sheet), so the machine-readable "app output" is the estimate on the job record, not the PDF.

---

## 1. The pipeline today

### 1.1 Inputs — the Site Visit panel (`apps/field/js/sitevisit.js`)

| Input | Captured by | Stored as | Reaches the prompt as |
|---|---|---|---|
| Walk clips (🎥, one per room) | `addFiles("walk")` → media queue → `transcribeWalk()` :577 (Deepgram) | `sv.files[kind:"walk"]` with `transcript{utterances,text}`, stills as `kind:"frames"` | `rebuildTranscript()` (`walk.js:227`) → `sv.transcript` → `SITE WALK TRANSCRIPT` block, clip headers `— Clip n · Room · m:ss —` |
| One "Site walk recording" (`KINDS.audio` :66) | upload → `transcribe()` :553 → `siteVisitTranscribe` | the recording's row: `transcript{utterances,text,seconds}` | same `sv.transcript` (flat, ≤ 400,000 chars `sitevisit.ts:47`) |
| Scope notes (V2) | `draftScopeNotes()` :602 → `walkExtract` | `sv.scopeNotes.rooms[].items[]` with state ✓/✎/✕ | `scopeNotesText()` (`scopenotes.js:194`) → `WALK SCOPE NOTES` block, **accepted items only**. `canExtract()` requires transcribed clips — an audio-only visit never has notes |
| Typed scope (+ 🎙️ dictate) | textarea in `paint()` | `sv.typedScope` | `OWNER'S TYPED SCOPE` |
| Report PDFs, extra photos, note pages, Magicplan stills | `addFiles()` → `field-media` `sitevisit/<job>/…` | `sv.files[]` paths | signed URLs → document / image blocks (`buildContent` `sitevisit.ts:348-373`), ≤ 4 PDFs, ≤ 150 images |
| Magicplan measured rooms | `adoptExport()` after ⟳ Pull (`magicplancalc.js:177`) | `sv.magicplan.statistics` (+ Floor Plan rows) | `magicplanQuantities()` (`magicplancalc.js:283`) → `packet.magicplanQuantities` → `quantitiesText()` (`sitevisit.ts:124`) → `MEASURED QUANTITIES` block |
| Job facts | `siteVisitFacts()` (`officeai.js:249`) | — | `JOB HEADER AND ANY DOCUMENTED FACTS` JSON. On a construction job: `{job:{owner, property, jobType, constructionType, carrier, claim, jobId}}` only — no address parts, no jurisdiction, no estimate date |
| Company rates | `subRatesText()` (`pricing.js:38`), sent as `body.rates` (`sitevisit.js:630`), capped at 4,000 chars (`index.ts:943`) | — | `COMPANY RATES` block |

The packet is assembled by `packetForDraft()` (`sitevisit.js:89`); `start()` :620 → `startSiteVisitDraft()` (`officeai.js:271`) → action `siteVisitStart`. `packetReady()` :103 needs any one input.

### 1.2 Transcript → scope: the prompts

| Piece | Where | What it says that matters here |
|---|---|---|
| System prompt `SITE_SYSTEM` | `supabase/functions/roybal-ai-office/sitevisit.ts:263-270` | "The owner's typed scope and what the owner says on the walk are instructions: follow them." (:266) · "Take quantities from the report's printed dimensions … show arithmetic for anything derived." (:267) · "when something that changes the price is uncertain, state the assumption, price the reasonable case, and list the question." (:269) |
| User turn `buildContent()` | `sitevisit.ts:348-398` | Order: files → MEASURED QUANTITIES (:374) → OWNER'S TYPED SCOPE (:380) → WALK SCOPE NOTES if any (:381) → SITE WALK TRANSCRIPT (:382) → JOB HEADER (:383) → HOW TO WRITE IT (:384-390, "No overhead, profit or tax lines; they are applied separately") → CONSTRUCTION_SHAPE or CLAIM_SHAPE (:391) → rules text → COMPANY RATES (:392) → PRICE CATALOG (:394) |
| `CONSTRUCTION_SHAPE` | `sitevisit.ts:329-338` | Trade sections 01–16 in `room` (:331) · labor as HR lines at COMPANY RATES, material separate, a rate-priced line leaves category/code empty with `priceBasis 'estimate'` (:332) · Section 01 carries supervision, mobilization, protection, dumpster, final clean and **Allowance lines for design, engineering and permits** (:333) · every open owner choice is an **alternate** (:335) · **"Set contingencyPct for how settled the design is, accuracyPct for how firm the estimate is, and duration in weeks. Overhead and profit are applied separately at 10% and 10% when subcontractors are on the job; do not add them."** (:336) · never name a sub's company (:338) |
| Rules text `siteVisitRules()` → `estimatingRules()` | `sitevisit.ts:315-323`; `pricing.ts:341-404` | Piecework code rule (:345-349), common rules incl. "No overhead/profit/tax lines (applied separately)" (:361), inclusion rules written for insurance claims — detach-vs-replace, labor minimums (:364-367), Cat 3 package, put-back completeness and the FINISH CHAIN (:372-374). **The claim inclusion blocks are sent to construction jobs too** (`sitevisit.ts:319-321`; the comment at :308-313 says so deliberately); only the house patterns are claim-only |
| Scope-notes prompt `SCOPE_SYSTEM` | `walkextract.ts:100-121` | Ten buckets (`SCOPE_BUCKETS` :20): observations, materials, damage, **quantities ("ONLY numbers that were spoken aloud, with value and unit")**, **instructions (speaker's own words)**, preExisting, homeownerSaid, verify, safety, trades. "No citation, no item" is enforced by the parser `parseScopeNotes()` :149, not the prompt |
| Verify-scope interview `scopeInterview` | `index.ts:759` | Exists for the older `invoiceDraft` / rebuild paths only; the Site Visit draft never uses it |
| Model and run | `index.ts:112-126`; `sitevisit.ts:402-413` | `SITE_VISIT_MODEL` default `claude-fable-5-1`, effort `high`, `max_tokens 64000`, adaptive thinking, JSON-schema output (`SITE_DRAFT_SCHEMA`), one message |

### 1.3 The line-item generator

- **Output schema** `SITE_DRAFT_SCHEMA` (`sitevisit.ts:221-260`): `lossSummary`, `items[]` (`ITEM_SCHEMA` :204-219 — `room, desc, qty, unit, price, basis, category, code, priceBasis, by`), `rooms[{name, customerSummary}]`, `assumptions[]`, `exclusions[]`, `questions[]`, `pricingNotes`, `alternates[{title, description, baseCost}]` (:243-255), `contingencyPct` (:256), `accuracyPct` (:257), `duration` (:258). `basis` is free text ("Show the arithmetic for derived quantities" is advisory, :213). `by` is free text with a vocabulary suggestion (:217).
- **Run path**: `siteVisitStart` (`index.ts:922`) → `startDirect()` :1028 hands the signed job to the Fly phone agent (`services/phone-agent/draft.mjs`, first) or the edge runner `supabase/functions/roybal-site-draft` (shared runner `_shared/sitedraft-run.ts`), else `submitBatch()`; the outcome lands in `field-media sitevisit/drafts/<key>.json`. The request itself (system + content + schema) is built in `roybal-ai-office`, so a prompt or schema change deploys **only** `roybal-ai-office` (`fn-deploy.yml`); the runners stream what they are given.
- **Collect**: `siteVisitResult` (`index.ts:1143`) → `parseBatchResult()` (`sitevisit.ts:436`; clamps contingency/accuracy to 0–50, :475) → `resolvePrices()` (:1164) → `{status:"done", draft}`.
- **Price stamping** `resolveLines()` (`pricing.ts:252-332`): catalog row by `category::code` → `replace_price` / `remove_price` / `detach_reset_price` per `priceBasis`; guardrails: an hourly rate on a non-HR line is blanked and flagged (:311-317), a unit-class mismatch is flagged (:326); a miss on a piecework **claim** may fall to the reference tier; otherwise the model's number stands as `priced:'estimate'`.
- **Apply** `applySiteDraft()` (`sitevisit.js:239-280`): replaces `inv.items` (id, room, desc, qty, unit, price, code, priced, flag, refNote, by); `inv.lossSummary`; `inv.notes` = `ASSUMPTIONS / EXCLUSIONS / PRICING BASIS` block (`draftNotesText()` :222) spliced in without losing typed notes; `inv.customerScope`; `inv.alternates` (:259); `inv.contingencyPct` (:260); `inv.accuracyPct` (:261); `inv.duration` (:262); O&P 10/10 when any `by` is a sub and `opAuto` is still on (:265-266); `inv.siteVisitDraft = {at, questions, basis[]}` (:267). Then `check()` :646 runs `uncoveredInstructions()` (:666) over the bases and questions and the panel shows "Open questions from the last draft" (:983) and "Said on the walk, not in this estimate" (:989).
- **Between the model and the sheet** there is nothing else: no line-level validation, no coverage check beyond the accepted-notes one above, no number parsing.

### 1.4 Price / unit-cost source

| Tier | Where | Used on a construction job? | Krueger draft evidence |
|---|---|---|---|
| Hourly labor and sub rates | `apps/field/js/pricing.js` `LABOR_RATE` :23 ($125), `SUB_RATES` :32-37 (Roybal $125/HR; Plumbing & heating sub $200/HR; Electrical sub $150/HR; Drywall sub $5.00/SF), sent as text | Yes — the model copies the number into `price` with `priceBasis 'estimate'` | Roybal 125, plumbing 200, electrical 150 lines. No roofing/welding $150 (R1), no tile or paint sub rate: the draft invented "Tile sub" and "Painting sub" labels (allowed by `by`'s "`<trade> sub`") and priced them itself |
| Fairbanks `public.price_list` (2,959 rows, 10 categories) | `fetchCatalogRows()` `index.ts:514`; `SITE_CATS` :848 = all ten categories on a site visit; `catalogTextFromRows()` `pricing.ts:193` (piecework rows with replace / tear-out / D&R prices); stamped by `resolveLines()` | Yes, offered in full, despite CONSTRUCTION_SHAPE's hourly-labor shape | Cents-level unit prices typical of the sheet on the demo (0.72/SF remove drywall), drywall sub (4.11–4.23/SF, 8.81/LF corner bead), paint (2.13/SF seal + two coats) and **deck lines (0.91 clean, 3.86 sand, 2.27 "prime & paint deck – 1 coat primer, 1 coat paint", 16.29/LF rail)** — the 1 + 1 coat spec the brief calls below market is the catalog line's own description. Exact provenance (`priced`) is on the job record, not the PDF |
| Xactimate reference tier (`xact_ref_prices`, migration 0011) | `referenceAllowed()` `pricing.ts:131`: piecework **claims only** | No (correct, unchanged) | — |
| Model's own number | everything else, `priced:'estimate'`; on screen an amber "est." tag (`pricedTag()` `sitevisit.js:143`), nothing on paper | Yes — most of the money | slab trench 10 LF × $115; shower pan $1,450; cabinets $335/LF; microwave $537.44; washer $1,150; supervision 40 HR |
| Benchmarks | none | — | — |

### 1.5 Markup math — four copies

| Copy | Lines | Contingency | Overhead / profit base | Tax base | Who uses it |
|---|---|---|---|---|---|
| `forms.js recalc()` | 2158-2190 | `cont = subtotal × pct` (:2165) | each = `(subtotal + cont) × pct` (:2169-2170) — overhead and profit on the **same** base | base (:2177) | the on-screen and printed sheet; alternates print at `baseCost × (1+cont) × (1+op)` (:2222) |
| `docx.js estimateFigures()` | 38-60 | same (:45) | same (:48-49) | same | the Word export; pinned by `docx.test.mjs:41-43` ("contingency before O&P, O&P on that base") |
| `bid.js estimateTotal()` | 81-99 | same | same | same | Bid card, the lead tile's `estValue`, the estimate-sent patch (:376), the portal signing total (`forms.js:4561-4576` passes it to `signableDocs`) |
| `fincalc.js invoiceTotals()` | 27-38 | **none** | `subtotal × pct` (:32-33) | base | assistant confirm chips, `budgetBase()` :86 over approved `reconEstimates`, `billingSummary()`, the carrier packet (`services/worker/packet/model.mjs billedInvoice` :176 — invoices only) |

- The 10 & 10 switch: `newInvoice()` (`model.js:433-446`) carries `opAuto:true`, `overheadPct/profitPct "10"`, `taxRate ""`, `dueDate ""`; `invoice()` sets 10/10 only when `jobHasSubcontractor()` or `namesSubcontractor()` (`forms.js:2055-2075`, `:2140-2147`), else 0/0; `applySiteDraft` repeats the rule (`sitevisit.js:265-266`). The confirmed rule behind it is `docs/Estimating_Rules_Draft.md` §1.2 (O&P = GC coordination, written for insurance work).
- The model is told not to compute totals (`sitevisit.ts:390`, `pricing.ts:361`), and it doesn't. Step 1's "replace model-computed totals" is really "replace four client copies with one `computeTotals(lines, policy)` and change the ladder for construction".
- Per-phase subtotals and per-phase O&P (R2) are not computed anywhere; Recap by Section (`forms.js:2090-2133`) shows each section's share of direct cost.
- Rounding: `recalc()` sums unrounded figures, so the app's total ($89,124.32) is a cent under the sum of its printed lines ($9,687.43 + $7,427.03 + $7,427.03 + $64,582.84 = $89,124.33). The reference rounds each summary line to cents before adding (84,705.25 → OH 8,470.53 → profit 9,317.58 → 102,493.36; `84,705.25 × 1.21` straight would print 102,493.35). `computeTotals` must round per line.

### 1.6 The document renderer

- **Screen = paper.** `invoice()` (`forms.js:2076-2727`) builds one `sheet()` (`formkit.js:312`; letterhead :292; footer :307): header fields (Estimate #, Estimate Date; **Valid Until = `inv.dueDate`** :2683), Prepared For (`jobInfo` customer/address/phone/email :2688), Scope Summary (`lossSummary`), the line table `invoiceCharges()` (:1914-2047 — `#, Description, Qty, Unit, Unit Price, Total, By`; blocks derived from each line's `room` in first-appearance order :1930-1938; shaded `tr.invsec` rows), the totals box (:2610-2645 — Line Item Total, Design Contingency %/$ :2614, O&P mode, Overhead %/$, Profit %/$, "Total with Contingency & O&P" :2662, deductible/previous payments hidden on a build :2661, **Sales Tax % and Sales Tax always shown** :2643-2644, Estimate Total), `estmeta` (± range :2184, **"Estimated duration: …"** :2185), alternates (:2196-2226), Recap by Section (:2090-2133), the Notes/Assumptions/Exclusions textarea (:2700), Acceptance + owner signature block (:2704-2708), the remit/disclaimer box.
- **Print spec** `apps/field/css/print.css`: letterhead :32-44, section headings :57-62, `table.grid` :119-148 and `table.grid--inv` :150-160 (`.invdesc` wide, `.invsec` shaded), `.totals` :199-203, `.invrecap` :205-213, `.estmeta` / `.estalts` :215-221, signatures :229-236; `@page letter, 0.5in`.
- **Word** `docx.js estimateDocumentXml()` (:116-233): same figures through `estimateFigures()`; fixed widths `W = [5100, 900, 800, 1400, 1500]` twips (:152); "Valid until" only when set (:130); contingency line (:191); tax only when non-zero (:195); ± range and duration (:202-203); alternates (:207); notes (:217). #287 drops the "(by)" suffix from the description cell.
- **Portal / signature**: the customer signs a snapshot of the printed form (`signdocs.js` header; `signableDocs()` :45) — whatever Step 6 prints is what gets signed.
- **Not in this lane**: the carrier packet renders invoices only (`model.mjs readyInvoices` :170 reads `p.invoices`); QuickBooks push is invoice-only (`qboBtn` is not in the estimate's button bar); the customer e-mail (`bid.js estimateEmailDraft` :290) says "Pricing is good through <Valid Until>" when the field is set (:302) — blank today.

### 1.7 Magicplan quantities → estimator

1. **Pull** (`supabase/functions/magicplan-proxy/magicplan.ts`): `sync` reads the plan and `GET /plans/statistics/{id}`; `statsFromPlan()` :418 derives a room height from volume ÷ floor area when the plan carries none (:436); `normalizeStatistics()` :60 (client twin `apps/field/js/magicplancalc.js:63`, held equal by a lockstep test) → `ceilingFt = rHalf(height)` (:75 / `magicplancalc.js:77`, `rHalf` :56) — **rounded to 0.5 ft**: 6'7" = 6.583 → 6.5.
2. **Adopt** `adoptExport()` (`magicplancalc.js:177`): statistics onto `sv.magicplan`, measured rows into the Floor Plan table (`measuredRow()` :138 keeps `ceiling` as the text "6.5 ft"), room names.
3. **Draft**: `magicplanQuantities()` :283 → `cleanQuantities()` (`sitevisit.ts:72`) → `quantitiesText()` :124, one line per room ("- Den: 607 ft² floor, 99 LF perimeter, 6.5 ft ceiling, … ft² walls (… net of openings), n doors, n windows, … ft³"); HOW TO WRITE IT tells the model to prefer it over the PDF (:386); the Pricing Basis gets "Quantities from Magicplan LiDAR scan dated …" (`withMagicplanBasis()` `magicplancalc.js:310`; `scanBasisNotes()` `sitevisit.js:217`).
4. **On the Krueger draft** that sentence is present, so the scan was in the packet; the nook and the closet were "not in the scan" (its assumptions), so the model invented their sizes.
5. **Not carried**: wall-by-wall dimensions, door and window sizes, fixture positions, anything below room level, inch precision, and the IFC/USDZ (listed under `KINDS.mpfiles` with "Not sent to the estimate draft", `sitevisit.js:65`).
6. **Step 3 consequence**: the 7'-0" habitable-height rule can run on `ceilingFt` today; the 84" cabinet-stack, door-leaf and appliance-clearance rules need inches → carry `ceilingIn` (or 0.1-ft rounding) through both `normalizeStatistics` copies and the lockstep test.

### 1.8 Walk transcript → estimator

- **Production path**: audio → Deepgram `nova-3` with `diarize + utterances + keyterms` (`siteVisitTranscribe` `index.ts:866-891`) → `formatTranscript()` (`sitevisit.ts:158` — `[mm:ss] Speaker n: text`) and `trimUtterances()` (:186 — `{start, end, speaker, text}` kept on the file row) → `rebuildTranscript()` (`walk.js:227`) → `sv.transcript` → `packet.transcript` → the `SITE WALK TRANSCRIPT` block. **The per-utterance timestamps Step 2 wants already exist for Deepgram input.**
- **Coverage today**: `extractInput()` (`scopenotes.js:64`) takes walk clips only, so an audio-only visit has no scope notes; `uncoveredInstructions()` (:227) is the soft form of the Step 2 hard flag — it compares *accepted instruction notes* with the drafted bases, and on Krueger there were none.
- **The Krueger recording** is a Voice Memos `.qta` (133.5 MB). Verified locally with a 40-line Python script in the session scratchpad (nothing copied into the repo): the `tsrp` atom at byte offset 132,958,513 holds JSON `{attributedString:{attributeTable:[{timeRange:[start,end]}…], runs:[text, tableIndex, text, tableIndex, …]}, locale}` — 3,818 time ranges, 7,636 run entries (text/index pairs), last range ends at 1801.38 s (30:01), 19,962 characters. The brief's dictations are all there with times:
  - heater covers 22:03–24:50: "6 foot register … 21 foot … 2 foot … 8 foot. Lower units … 10 foot … 13 feet … 24 feet … **24 plus 26 feet. Hey, 26 feet** … plus another eight foot six" → 6 + 21 + 2 + 8 = 37; 10 + 13 + 24 + 26 + 8.5 = 81.5; **118.5 LF** (the brief's ambiguity example is verbatim);
  - decks 26:20–29:53: rear 6 × 3 with a three-step stair and 9 LF of rail; front upper 7 × 5'6" with 12'6" + 12 + 3 LF of rail; lower **"24 feet, 6 inches, or, I'm sorry, 28 feet … by 20"**, landing 3 × 4, "approximately 10 additional" LF of angled rail → 18 + 38.5 + 560 + 12 = **628.5 SF** (a corrected reading the parser must honor);
  - "bathroom downstairs … to this level" at 19:30; the separation door and 3 × 3 landing (deferred) from 15:02; "78 inch ceiling height" at 12:36; washer/dryer and microwave at 03:37–04:17 and 11:34; the walk-in shower and closet at 02:11–02:28.
- The app never saw that transcript: it transcribed the uploaded audio with Deepgram. A fixture can read the `tsrp` JSON and skip STT entirely; production keeps Deepgram unless a `.qta` reader is added (decision 9).

---

## 2. Failure map — the nine §2 items

Evidence is from the app-generated PDF (8 pages, in `~/Downloads`), which was printed before #287 so the By column shows.

| # | What the output shows | Code responsible | Why it happened | Where the fix lands |
|---|---|---|---|---|
| 1 | **Missed bath refresh.** Only four lines touch the lower bath (p2 line 10 remove ceiling, p2 line 25 hang ceiling, p4 lines 63-64 mask + paint ceiling). No vanity, LVP, toilet pull/reset, mirror/accessories, wall patch, moisture check or antimicrobial. | Coverage is prompt-only: `SITE_SYSTEM:266` ("what the owner says on the walk are instructions"). No ledger. `walkExtract` never ran (audio recording, not clips — `scopenotes.js canExtract()`); `uncoveredInstructions()` (:227) had nothing to compare. | missing validator | **Step 2**: build the ledger over utterances (Deepgram or `tsrp`), with `intent`; mapping + reverse check as deterministic flags; extend `extractInput()` to the audio row |
| 2 | **Over-the-range microwave.** p5 line 81 "Microwave oven – over range w/built-in hood, recirculating" $537.44 (Allowance); p3 line 51 a "dedicated 20A microwave circuit"; p6 ALT 6 even prices venting it; p7 assumption "wall cabinets are 24 in high". No hood, soffit or backsplash line. | No geometry check anywhere. `ceilingFt` (6.5) reaches the model only as prose in MEASURED QUANTITIES; `CONSTRUCTION_SHAPE` says nothing about clearances or product fit. | missing validator + half-foot precision | **Step 3**: fit checks on `MeasuredRoom` with thresholds in the policy; `ceilingIn` (§1.7) |
| 3 | **15% contingency, non-stacked O&P.** p5 totals: Design Contingency % 15 → $9,687.43; Overhead $7,427.03 and Profit $7,427.03 (each 10% of 64,582.84 + 9,687.43); "Total with Contingency & O&P" $89,124.32. | The schema asks for it (`sitevisit.ts:256 contingencyPct`), the prompt tells the model to set it (:336), `parseBatchResult` keeps 0–50 (:475), `applySiteDraft` copies it (`sitevisit.js:260`), `recalc()` applies it before O&P with overhead and profit on one base (`forms.js:2165-2170`), `estimateFigures()` / `estimateTotal()` match, the editor shows the row (:2614) and labels the total for it (:2662). `docx.test.mjs:41-43` pins the current math. | policy in prose + the ladder itself | **Step 1**: `computeTotals(lines, policy)` — stacked ×1.21, no contingency on construction, per-line rounding, per-phase column; one function behind all four call sites; the pinned tests flip |
| 4 | **Below-market units.** p2 line 16 slab trench 10 LF × $115 = $1,150 (Roybal, estimate); p4 deck: sand 3.86/SF, "prime & paint deck – 1 coat primer, 1 coat paint" 2.27/SF, rail "1 coat primer, 1 coat paint" 16.29/LF, no rail sanding; p1 line 1 supervision **40 HR** $5,000. | A `priced:'estimate'` number has no floor and no flag; catalog lines bring Xactimate's spec in their description (§1.4); nothing sizes supervision. | missing benchmark | **Step 5**: benchmark table + ">25% below" flag; supervision-by-trade-count rule; **Step 1** R1 rates; decision 10 on the catalog's role on construction jobs |
| 5 | **Measurement drift.** p3 line 45 heater covers **124.5 LF**; p4 rear deck 27 SF, front deck **674.5 SF**. | No parser; the model summed the dictation; `basis` is free text (:213). | missing deterministic step | **Step 4**: parse dictated tape from utterances, show the arithmetic, reconciliation table, flag "24 plus 26" / "24 feet 6 inches, I'm sorry, 28 feet" with both readings |
| 6 | **Den repaint in the base.** p4 line 67 mask Den 116.5 LF $255.14 + line 69 "Paint (2 coats) remaining Den walls so the room reads as one finish" 656 SF $1,049.60 = $1,304.74. | No request asked for it and nothing traces a line back to one. The claim-side FINISH CHAIN (`pricing.ts:372-374`) is sent to construction jobs (`sitevisit.ts:319-321`) and covers patches; extending it to the whole room was the model's call. | no reverse trace | **Step 2** reverse check → moves to alternates; trim the claim inclusion blocks on construction |
| 7 | **"Walk-in" semantics.** p5 line 73 "Shower pan – 36 x 60 mortar bed with pre-slope, PVC liner and **curb**"; p3 line 34 "Shower **curtain rod**"; no exhaust fan for the new shower (line 47 is the upstairs fan); p6 ALT 2 is the glass panel. | No product vocabulary or code-required-line rule anywhere; "walk-in" is undefined in prompt and policy. | policy in prose (absent) | **Step 3**: new-shower check (low threshold default, exhaust line required, no curtain rod) + policy vocabulary |
| 8 | **Duration printed.** p5 "Estimated duration: 6-8 weeks interior (winter), plus 1 week deck refinishing in spring"; also "Expected range at ±25%: $66,843.24 – $111,405.40". | `duration` and `accuracyPct` in the schema (`sitevisit.ts:257-258`), asked for by the prompt (:336), copied by `applySiteDraft` (`sitevisit.js:261-262`), printed by `forms.js:2184-2185` and `docx.js:202-203`. | schema invites it, renderer prints it | **Step 1** R6 (internal fields only) + **Step 6** renderer; decision 7 on the ± range |
| 9 | **Defaults.** p1 VALID UNTIL empty; p5 "Sales Tax $0.00" printed; p5 lines 80-83 range, microwave, washer, dryer carried as **Allowance** lines. | `dueDate ""` from `newInvoice()` (`model.js:436`) and nothing fills it (`forms.js:2683`); the tax rows always render (`forms.js:2643-2644`; `docx` already omits at 0, :195); `CONSTRUCTION_SHAPE` says Allowance for owner selections and nothing says owner-furnished (:333). | missing defaults | **Step 1**: R7 auto-fill +30 d, R8 jurisdiction → omit at 0, R5 appliance default + package alternate |

---

## 3. What it did well → the code that produced it (keep)

| Kept behaviour | Produced by | Note for Steps 1–6 |
|---|---|---|
| Recap math ties out | `recalc()` (`forms.js:2158-2190`) + `paintRecap()` (:2090-2133), shared `money()` | `computeTotals` must reproduce the recap bit-for-bit on the parts that stay; rounding per §1.5 |
| Custom-height closet door (p3 line 33, "custom 6'-0” height to fit the 6'-6” ceiling") | the measured ceiling in MEASURED QUANTITIES + the model | Step 3's door check should assert it, not hope for it |
| Exploratory opening at the chase (p1 line 7) | `SITE_SYSTEM:269` ("state the assumption, price the reasonable case") + the exclusions it wrote | R3's "real unknowns get a firm price" is this pattern; keep the sentence |
| Alternates with prices (p5-p6, six of them) | `alternates` schema (`sitevisit.ts:243-255`) → `applySiteDraft` (:259) → `paintAlts()` / `refreshAlts()` (`forms.js:2196-2226`), `docx.js:207` | only the `×(1+cont)×(1+op)` factor changes (×1.21) |
| Customer phone and e-mail | `jobInfo(project, [customer, address, phone, email])` (`forms.js:2688`); `docx.js:136` | unchanged |
| Clean letterhead | `formkit.js letterhead()` :292 / `sheet()` :312, `print.css:32-44`; `docx.js:124-126` | unchanged; Step 6 changes the body between letterhead and footer |

---

## 4. Where each R-rule would live

**The config itself.** Both the prompt builder (Deno, `roybal-ai-office`) and the validators / `computeTotals` (browser, Node tests, the worker) must read one versioned object. Recommended home: `supabase/functions/_shared/estimate-policy.json` (`version`, `rates`, `markup`, `contingency`, `allowances`, `appliances`, `customerText`, `validityDays`, `tax`, `numbering`, `fit`, `benchmarks`) with a byte-identical copy at `apps/field/js/estimatepolicy.json` held by a lockstep test — the pattern already used for `magicplancalc.js` ↔ `magicplan-proxy/magicplan.ts` and for the personas registry. Benchmarks graduate to a table (`estimate_benchmarks`, next free migration is `0027`) when the job-board loop needs to write them (decision 5).

| Rule | Today | Config key · enforcer · renderer |
|---|---|---|
| R1 labor rates by trade | `pricing.js SUB_RATES / LABOR_RATE` (client), prose in `CONSTRUCTION_SHAPE:332`; `by` free text | `policy.rates[{trade, rate, unit}]` incl. $150 roofing/welding · validator: every HR line's price ∈ rates for its trade, `by` ∈ vocabulary · RATE column when > 1 rate (`invoiceCharges` colgroup :2037-2047, `docx.js W` :152) |
| R2 markup ×1.21, per-phase O&P | four copies (§1.5), `opAuto` GC rule | `policy.markup = {overheadPct:10, profitPct:10, stacked:true}` · `computeTotals(lines, policy)` in `fincalc.js` (no DOM, already shared by field, worker and tests) returning `subtotal, overhead, profit, total, phases[{phase, direct, inclOp}], alternates[{…, inclOp}]`, per-line rounding · Estimate Summary section (Step 6) |
| R3 no blanket contingency | schema + prompt + editor row + ladder | `policy.contingency.allowed=false` (construction) · schema drops `contingencyPct` on construction or `parseBatchResult` zeroes it; validator rejects any % line · editor hides the row unless a legacy value exists |
| R4 allowances = material basis | `by:"Allowance"` free text; Section 01 allowances for design/permits | `policy.allowances.categories` · validator: an Allowance line must be an owner-selection item, desc gets "(owner selection; material basis)", assumptions get the basis boilerplate · Allowances sub-list in §4 of the document |
| R5 appliances owner-furnished | nothing; prompt lists allowances for owner selections | `policy.appliances.{keywords, packageBudget}` · validator moves appliance lines to an "Appliance package supplied by Roybal — budget $x–$y" alternate unless the ledger has a "Roybal supplies" request · prompt says the same |
| R6 no durations / dates | `duration`, `accuracyPct` schema → printed | `policy.customerText.forbidden` (weeks, days, complete by, dates; season words allowed) · validator scans `lossSummary`, notes, assumptions, exclusions, alternates, `customerScope` → flag · renderer never prints `inv.duration` / `inv.accuracyPct` (fields stay, labelled internal in the editor) |
| R7 valid-until +30 d, season text | `dueDate` blank; `estimateEmailDraft` uses it when set | `policy.validityDays=30` · `applySiteDraft` / estimate open sets `dueDate = invoiceDate + 30` when blank · assumptions boilerplate for any phase with `season` set |
| R8 tax by jurisdiction, omit at 0 | `taxRate ""`; rows always print on the sheet | `policy.tax.jurisdictions` (Fairbanks / North Pole / FNSB → 0) · derive from the job's one `address` line via `splitAddress()` (`magicplancalc.js:117`) with an override field `taxJurisdiction` on the job · hide the rows at 0 (`forms.js:2643-2644`) |
| R9 never volunteer IEP | nothing | `policy.customerText.neverVolunteer` (hygienist, IEP, clearance test, third-party testing) · validator flags unless `facts.job.carrier` or a code citation · prompt exclusion |
| R10 numbering + Rev n | `suggestEstimateNo()` (`bid.js:240`) does `RC-<LAST3>-<MMYY>` and `-2`; suggested once on open (`app.js:2178-2183`); collisions checked against every estimate on the device; no revisions | `policy.numbering` · Step 7: a revision is a new `reconEstimates` entry with `revisionOf`, `rev`, `changeSummary`; never overwrite · " Rev n" in the number and the change paragraph at the top |
| Phases (Step 6) | `room` holds "NN — Trade"; blocks by first appearance (`forms.js:1930-1938`) | each line gets `phase` (owner-deferrable area) and keeps `room`/trade for the internal CSI recap · renderer groups by `phase`, sub-group rows shaded, per-phase subtotal and ×1.21 |

---

## 5. Tests — conventions, what flips, what is new

- **Runners**: field `npm run test --workspace=apps/field` (node `--test` over `test/*.mjs` + `js/*.test.mjs`, ~60 s); functions `npm run fn:test` (`--experimental-strip-types`, imports the `.ts` directly); `npm run board:test`; SQL tests in `supabase/test/` run only in CI (`db-replay.yml`). `build.test.mjs` fails the suite if `config.js BUILD` ≠ `sw.js CACHE`.
- **Will flip under R2/R3/R6**: `apps/field/test/docx.test.mjs:41-43` (contingency math, alternate factor) and `:61-63` ("Estimated duration: 3 weeks" prints); `apps/field/test/sitevisit.test.mjs:89-105` (contingency 15, duration "7-9 weeks" applied); `supabase/functions/roybal-ai-office/sitevisit.test.mjs:201` (construction shape text) and `:234` (contingency bounds).
- **Untouched but load-bearing**: `pricing.test.mjs` (resolver and guardrails), `walkextract.test.mjs`, `magicplan*.test.mjs` (lockstep), `bid.test.mjs`.
- **New, under the same runners**: `computeTotals` golden (84,705.25 → 8,470.53 → 9,317.58 → 102,493.36; per-phase 5,460 → 6,606.60, 15,765 → 19,075.65), ledger mapping and reverse check, fit checks, the measurement parser (118.5 LF and 628.5 SF with the arithmetic), benchmark flags, a renderer snapshot of the numbered sections.

---

## 6. The golden fixture — what can and cannot be committed

- **The repository is public.** The Krueger folder holds the customer's name, address, phone and e-mail (on the app output), his voice, and photos of his home. None of it can be committed as-is. Precedents in the repo: the xact-ref loader refuses any customer / address / claim key (`tools/xact-ref/load.mjs FORBIDDEN_KEY`); `sitevisit.test.mjs` uses synthetic codes "because this repo is public".
- **What the deterministic tests need**: (a) utterances with timestamps and text (from the `tsrp` JSON), (b) the measured rooms (normalized statistics, as `cleanQuantities` takes them), (c) the reference estimate as lines `{phase, group, desc, qty, unit, price, by}` plus its totals, (d) the app's draft as lines plus its alternates, assumptions and exclusions, (e) no photos.
- **Where the app's draft actually is**: the PDF in `~/Downloads` is an 8-page Quartz print with no text layer; the Word file dated 19:14 in the folder is Branden's own Rev 0, not the app's export. The machine-readable draft is the estimate on the job record (`field_projects` blob → `reconEstimates[].items`, `.siteVisitDraft.basis`, `.alternates`, `.notes`).
- **Proposal** (decision 4): commit an anonymized derived fixture under `apps/field/test/fixtures/golden-remodel/` — customer → "Owner", address → "<address>", phone/e-mail dropped, speaker labels generic, every number and every scope statement kept, personal asides cut; keep the raw inputs on the Mac under a git-ignored `fixtures/private/`; run the model-in-the-loop golden draft by hand (a script in `tools/`, like the xact-ref loader — it needs the LLM key and costs one full draft). Branden reads the scrubbed transcript before it lands.

---

## 7. Constraints and in-flight work

- **PR #287** (By column app-only; docx drops the performer; `docx.test.mjs` updated; field v218). Step 6 rewrites the same table and test. Merge #287 first and branch Step 6 after it (decision 16). Step 1 takes v219 or later and must bump `config.js BUILD` with `sw.js CACHE`.
- **Deploys**: field/admin/board deploy from `main` (`deploy-field.yml`); `roybal-ai-office` by `fn-deploy.yml`; migrations only by `db-push.yml`; the Fly runner needs nothing for a prompt change (§1.3).
- **Staging**: the field app is hard-wired to prod and staging has no `field-media` bucket or STT key (known since the walkthrough work), so "staging first" covers migrations and functions; the golden test runs in Node; the first real draft under the new pipeline is on prod behind the gate (decision 11).
- **No feature-flag mechanism exists for estimates today**; `SITE_VISIT_MODE`, `SITE_VISIT_MODEL` and `SITE_VISIT_EFFORT` are the only env switches (`index.ts:112-122`).
- **Reference tier and EULA** unchanged; construction never touches `xact_ref_prices`. Benchmarks are Roybal's own numbers (the reference estimate and the owner's rules), not Verisk data.
- **Two untracked docs** sit in the main checkout (`docs/Xactimate_Companion_Plan.md`, `docs/Capture_Any_Phone_Decision.md`, 10/27, never committed); not touched here.
- Unrelated but noticed: the whole catalog (≈2,900 rows) rides every site-visit prompt; `SITE_DRAFT_RESERVE_USD` books one draft per start.

---

## 8. Decisions for Branden — recommended default first

1. **Scope of the new rules.** Apply Steps 1–7 to construction/remodel estimates (`jobType === "construction"`) only; insurance claim estimates and invoices keep today's engine (Xactimate-style O&P on one base, the §1.2 GC rule). *Default: yes — construction only; the shared refactor (`computeTotals`) keeps claim math identical and is tested for it.*
2. **R2 versus the confirmed GC rule.** On a construction estimate, is 10/10 stacked unconditional, or still "only when a sub is on the job" (Estimating_Rules_Draft §1.2)? *Default: unconditional on construction estimates (the reference does it; a remodel always carries GC overhead); `opAuto` stays for claims.*
3. **The contingency field.** Remove it from construction drafts and hide the editor row; legacy estimates with a value still print it. *Default: yes.*
4. **The fixture** (§6): anonymized derived JSON committed, raw inputs git-ignored, model run by hand. *Default: yes; Branden reviews the scrub first.*
5. **Policy config home.** Checked-in JSON in `_shared` mirrored to the field app with a lockstep test; benchmarks move to a table when the time-tracking loop writes them. *Default: yes (a table now would cost a migration and an offline path for the field app).*
6. **Ledger mechanism.** Extend the existing scope-notes layer (`walkExtract` + `scopenotes.js`) to the single recording and to utterances, add `intent` (add / repair / replace / defer / decline) and the mapping + reverse-check validators; keep "flag, don't block". *Default: yes, rather than a parallel system.*
7. **Duration and the ± range.** R6 bans durations; the "Expected range at ±N%" is not banned but reads as a hedge and the reference has none. *Default: stop printing both on construction estimates; keep them as internal fields.*
8. **Ceiling precision.** Carry inches through both `normalizeStatistics` copies (client + proxy) and the lockstep test. *Default: yes, in Step 3.*
9. **Measurement parser.** Deterministic (regex over utterances: feet, inches, "plus", corrections like "I'm sorry, 28"), the model only classifies which item a measurement belongs to; both readings kept on ambiguity. The `.qta` transcript is read for the fixture only; production stays on Deepgram's utterances. *Default: yes.*
10. **The catalog on construction jobs.** Keep offering the Fairbanks catalog (the demo and texture lines priced well) but add a validator that a catalog-priced line carries labor (no HR line may duplicate it) and route spec-bearing lines (deck coating, paint systems) through the benchmark table. *Default: keep with the validator; the alternative is rates + benchmarks only.*
11. **The gate.** Per-estimate `inv.engine = "v2"` set by an owner-only toggle in the Site Visit panel, plus an edge env `ESTIMATE_ENGINE_V2=on` guarding the new prompt; every draft records `engine` and `policy.version`. *Default: yes.*
12. **Phases.** Each line gets a `phase` (owner-deferrable area) in addition to the trade `room`; the model proposes phases, Branden regroups in the editor. *Default: yes (Step 6).*
13. **Appliance package budget.** Seed `$5,500–7,500` from the reference into the policy; the validator writes the alternate from it. *Default: yes.*
14. **Numbering collisions** stay device-local (one estimator today). *Default: yes; revisit when the office drafts.*
15. **Reading the Krueger job record** for the fixture: Claude reads the one `field_projects` row (read-only, prod) and scrubs it locally; nothing is committed until reviewed. *Default: yes.*
16. **Sequencing with #287.** Merge #287 first; Step 6 branches after it. *Default: yes.*
17. **The committed brief.** Its copy in `docs/` has the customer's street address redacted because the repository is public; the verbatim brief is in the owner's files. *Default: keep it redacted.*

**Step 0 changed no code.** Next: Branden's review; Step 1 starts on his go.
