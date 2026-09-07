# The $10,000 Question — and the $136,923.94 Answer

**Prepared for:** Branden Roybal — Roybal Construction, LLC
**Date:** September 7, 2026
**Horizon:** 90 days (Sept 7 – Dec 6, 2026)
**Source data:** QuickBooks A/R Aging Detail, accrual basis, as of 2026-09-07

---

## 1. The finding that changes the plan

Before spending a dollar of the $10,000, look at what is already sitting on the table:

> **$136,923.94 in open A/R. 100% of it overdue. $0.00 current.**

That is **13.7× the $10,000** — already earned, already costed, already paid for in labor
and materials. No lead cost, no COGS, no crew hours left to spend on it. It is the highest
return-on-effort money in the business, and it is the reason the answer to "how do I make
the most money fast" is *not* an investment question.

### 1.1 First, a correction you need in the CFO report

The QuickBooks **A/R Aging Summary** rollup reports **$333,066.96**. That number is wrong,
and it will be wrong every time you pull it.

The summary triple-counts every customer that has sub-customers, because it sums the parent
row, the sub-customer (job) row, *and* the "Total for X" row as three separate records:

| Bucket | Summary reports | Actual | Why |
|---|---|---|---|
| 1–30 | $39,002.43 | $39,002.43 | Cheria Fidler has no sub-customer — counted once |
| 31–60 | $203,078.46 | $67,692.82 | Hebard + Hovda counted 3× each |
| 91+ | $90,986.07 | $30,228.69 | Graham + Baham counted 3× each |
| **Total** | **$333,066.96** | **$136,923.94** | **Overstated by $196,143.02** |

The **A/R Aging Detail** report ties exactly to $136,923.94 across 8 transactions and returns
`truncated: false` — that is the real number.

**Action for the app:** `docs/CFO_Board_Integration_Recommendations.md` already plans to feed
QBO A/R into the daily CFO report. Pull from **A/R Aging Detail**, not Summary, or dedupe on
`metadata.type` and drop rows typed `GROUP`, `SUMMARY`, and `TOTAL`. Otherwise the CFO report
will tell you you're owed a third of a million dollars when you're owed $137K.

### 1.2 The actual ledger

| Customer | Job | Invoice | Invoiced | Paid | % Paid | **Open** | Days OD | Bucket |
|---|---|---|---|---:|---:|---:|---:|---|
| Jeff Hebard | 1192 Bemis Ct. | 1152 | $77,272.35 | $26,013.10 | 34% | **$51,259.25** | 60 | 31–60 |
| Cheria Fidler | — (mitigation) | Fidler-Mitigation | $49,002.43 | $10,000.00 | 20% | **$39,002.43** | 14 | 1–30 |
| Denise Graham | 264 Cindy Dr. | 1113 | $31,502.29 | $15,751.15 | **50.0%** | **$15,751.14** | 108 | 91+ |
| Don Hovda | 215 E. Birch Hill Rd. | WO 15083-5 | $11,540.31 | $0.00 | 0% | **$11,540.31** | 49 | 31–60 |
| Denise Graham | 264 Cindy Dr. | 1137 | $18,012.00 | $9,000.00 | **50.0%** | **$9,012.00** | 116 | 91+ |
| Todd Baham | 317 Le Ann Dr. | 1126 | $33,115.55 | $27,500.00 | 83% | **$5,615.55** | 132 | 91+ |
| Don Hovda | 215 E. Birch Hill Rd. | WO 15083-4 | $4,893.26 | $0.00 | 0% | **$4,893.26** | 49 | 31–60 |
| Stephen Fidler | — | (unapplied payment) | — | — | — | **−$150.00** | — | credit |
| | | | | | | **$136,923.94** | | |

---

## 2. Why this money is fast — read the payment percentages

This is not a pile of deadbeat customers. Look at the **% Paid** column:

- **Graham 1113 — 50.0% paid.** Not 48%, not 53%. Exactly half.
- **Graham 1137 — 50.0% paid.** Exactly half again.
- **Baham 1126 — 83% paid.** $27,500 in, $5,615.55 held.
- **Hebard 1152 — 34% paid.** $26,013.10 in, $51,259.25 held.

Two invoices landing on *exactly* 50.0% is not a customer deciding what to pay. That is an
**ACV/RCV split** — the carrier released actual cash value and is holding recoverable
depreciation. Baham's 83% is the same shape, further along.

**Recoverable depreciation is released by a document, not a lawsuit.** The carrier is waiting
on proof the work was completed. That is a certificate of completion, final photos, and a
final invoice. It is an afternoon of paperwork per file, and it is worth roughly **$82,000**
of the $137K.

The three files break into three different collection paths, and they are not interchangeable:

| Path | Files | Open | What actually releases it |
|---|---|---:|---|
| **A. Depreciation release** | Graham 1113 + 1137, Baham 1126, Hebard 1152 | $81,637.94 | Certificate of completion, final photos, signed COC, final invoice to the adjuster |
| **B. TPA portal** | Hovda WO 15083-4, -5 | $16,433.57 | Portal submission, not email. Zero paid on both — likely never submitted or kicked back |
| **C. Mitigation supplement** | Fidler-Mitigation | $39,002.43 | Full mitigation packet: moisture logs, dry standards, equipment days, Cat justification |

**On Hovda:** the `WO 15083-` prefix is a third-party administrator work-order format
(Alacrity / Contractor Connection / Sedgwick style). Both lines are **0% paid at 49 days**.
TPAs do not pay against emailed invoices — they pay against portal submissions, and they
silently reject anything missing a field. A single unsubmitted or kicked-back upload is the
most likely explanation for $16,433.57 sitting untouched. **Check the portal before you write
anyone a letter.** This is the cheapest $16K in the stack.

**On Fidler:** at 14 days it is not late yet, and it is your biggest single mitigation
receivable. $10,000 flat came in — an initial draft, not a claim decision. This one gets the
full documentation packet *now*, before it ages into an argument. Your field app already
captures the moisture mapping and S500 dry standards this packet needs; that documentation is
exactly what defends drying days and equipment charges when the adjuster starts trimming.

### 2.1 The other question the aging report raises

**$0.00 current.** Not one dollar of A/R is inside terms. Every open invoice is past due, and
the newest one was written August 24 — two weeks ago.

That means one of two things, and both cost money:

1. Work is finishing and not getting invoiced promptly, or
2. Everything gets invoiced and nothing gets paid on time.

Your own architecture doc already named this failure mode: *"a job hits Complete on the board
but has no invoice in QuickBooks → that's cash sitting on the table."* Run that reconciliation
in Week 1. Any completed job on the board without a matching QBO invoice is additional money
on top of the $136,923.94 — and it is not in any number in this plan.

---

## 3. Where the $10,000 goes

Timing drives this allocation. It is **September 7**. Fairbanks freeze-up starts late October;
burst-pipe season runs November through March and peaks at the −40 °F snaps in December and
January. You have roughly **six weeks** to be ready, and freight to Fairbanks takes two to
three of them. Equipment ordered in December arrives after the money has already gone to
whoever ordered in September.

| # | Bucket | Amount | Why |
|---|---|---:|---|
| 1 | Collections sprint | **$2,000** | Unlocks $137K already earned. Highest IRR in the business. |
| 2 | Drying fleet | **$4,500** | Bills daily per claim. Caps how many losses you can run at once. |
| 3 | Demand capture (LSA) | **$2,500** | Feeds the machine you already built. |
| 4 | Reserve | **$1,000** | Material float on the first big freeze-up loss. |
| | **Total** | **$10,000** | |

### Bucket 1 — Collections sprint · $2,000

Not software. Not you. **One person, three weeks, one job: close these eight lines.**

Roughly 40–45 hours of contract A/R help at $45/hr, or your office admin bought out of
everything else for three weeks. The work is unglamorous and completely mechanical:

1. Pull the completion documentation for the four Path A files.
2. Submit the two Hovda work orders through the TPA portal — check for a kickback first.
3. Build the Fidler mitigation packet from the field app's moisture data.
4. Call every adjuster by name. Email creates a record; the phone creates a decision.
5. Log every contact against the job so the next call starts where the last one ended.

**Target: $85,000–$110,000 collected within 60 days.** At $2,000 of cost against work already
performed, this is effectively free money — the margin was booked months ago.

### Bucket 2 — Drying fleet · $4,500

Equipment is the only thing you own that bills by the day whether or not a person is standing
next to it. It is also the hard cap on concurrent losses: run out of dehus in January and you
are turning down claims at the exact moment they are worth the most.

| Item | Qty | Unit | Total |
|---|---:|---:|---:|
| LGR dehumidifier (refurb / last-gen, 120–150 PPD) | 2 | ~$1,300 | $2,600 |
| Axial air mover | 6 | ~$230 | $1,380 |
| Freight to Fairbanks + contingency | — | — | $520 |
| | | | **$4,500** |

New LGRs run $2,300–$2,800 delivered; refurbished units at roughly half that bill the carrier
at the identical daily rate. Buy refurb and double the unit count — utilization beats
condition on a line item that pays per day.

**Payback math** (verify rates against your current Alaska price list — these are typical
ranges, not your actual carrier rates):

- 2 dehus @ ~$100–115/day = $200–230/day
- 6 air movers @ ~$25–30/day = $150–180/day
- **Fully deployed: ~$350–410/day**

At ~$380/day, the $4,500 pays for itself in **12 deployed days**. Over a 90-day freeze-up
season at a conservative 40% utilization (36 days), it bills roughly **$13,700** — and you
still own the equipment on day 91.

The documentation that defends day 5 and beyond is the moisture log, and your field app
already produces it against the S500 dry standards in the README. Equipment plus documentation
compound; equipment without documentation gets trimmed to three days by the adjuster.

### Bucket 3 — Demand capture · $2,500

Google Local Services Ads, water damage. National average cost per charged lead is **$154**
(median $148, typical range $89–$315), but that average is driven by competitive metros —
Los Angeles runs $240 while Cleveland runs $78. Fairbanks is small and thin on competition,
so plan **$90–$120 per lead**.

- $2,500 ÷ ~$105 ≈ **24 charged leads**
- Emergency water calls close at **40–50%** when answered live and someone is on site same day
- ≈ **9–10 jobs**

The average water damage insurance claim pays about **$11,098**, with mitigation plus rebuild
averaging **$10,500**. Discounting hard for uninsured and small jobs at a blended $6,000:
**~$54,000 in revenue on $2,500 of spend.**

Two things make this work for you specifically and not for your competitors:

1. **You already answer the phone.** The Twilio phone agent in `services/phone-agent` handles
   after-hours intake and already knows frozen and burst pipe repair. A 2 a.m. water call that
   goes to voicemail is a $10K claim handed to the next contractor on the list. You solved
   that already — this bucket just buys calls for a phone that gets answered.
2. **You hold the GC license.** Mitigation-only shops dry the structure and hand the rebuild
   to somebody else. You capture both halves of that $10,500. The mitigation is the door; the
   rebuild is the money.

Spend the $600 of profile work inside this bucket before the ad budget: Google Guaranteed
badge, background check, real job photos, and a push for reviews. LSA ranks on proximity,
responsiveness, and review volume — a thin profile burns the ad budget at a worse close rate.

### Bucket 4 — Reserve · $1,000

Material float on the first big loss, or a distressed equipment lot if one comes up before
freeze-up. Do not pre-commit it.

---

## 4. The 90-day calendar

**Weeks 1–2 (Sept 7–20) — paperwork and purchase orders**
- [ ] Check the TPA portal for Hovda WO 15083-4 and -5. Resubmit or fix the kickback. *($16,433.57)*
- [ ] Reconcile the board against QBO: every completed job with no invoice gets one this week.
- [ ] Order the drying fleet. Freight is 2–3 weeks — this cannot slip to October.
- [ ] Assign the collections person. Three weeks, one job, nothing else.
- [ ] Build the Fidler mitigation packet from the field app moisture data. *($39,002.43)*

**Weeks 3–4 (Sept 21 – Oct 4) — release the depreciation**
- [ ] Certificates of completion + final photos: Graham 1113, Graham 1137, Baham 1126, Hebard 1152. *($81,637.94)*
- [ ] Adjuster calls on all four. By name, by phone.
- [ ] LSA profile live: Google Guaranteed, photos, review push.
- [ ] Fleet arrives — tag, log, stage for deployment.

**Weeks 5–6 (Oct 5–18) — turn on demand, before the freeze**
- [ ] LSA budget live at ~$600/month.
- [ ] Confirm the phone agent handles after-hours emergency intake end to end. Test it yourself at 2 a.m.
- [ ] Second-round collections: anything unpaid at this point escalates to the adjuster's supervisor.

**Weeks 7–13 (Oct 19 – Dec 6) — run the season**
- [ ] Freeze-up. Equipment deployed, phone answered, rebuild attached to every mitigation.
- [ ] Invoice within 48 hours of completion. Do not rebuild the $0-current problem you have now.
- [ ] Weekly A/R review — 15 minutes, every Monday, permanently.

---

## 5. Expected return

**Cash collected and revenue booked, 90 days:**

| Bucket | Cost | Conservative | Expected | Strong season |
|---|---:|---:|---:|---:|
| Collections | $2,000 | $60,000 | $95,000 | $125,000 |
| Drying fleet | $4,500 | $6,000 | $13,700 | $22,000 |
| LSA demand | $2,500 | $24,000 | $54,000 | $85,000 |
| Reserve | $1,000 | — | — | — |
| **Total** | **$10,000** | **$90,000** | **$162,700** | **$232,000** |

**Being honest about what that is.** Revenue is not profit, and collections is not new margin —
it is converting work you already did into cash. The gross profit picture:

| Bucket | Basis | Expected GP |
|---|---|---:|
| Collections | Cost already sunk — effectively 100% cash | $95,000 |
| Drying fleet | ~90% margin on equipment lines, less $4,500 capex | $7,800 *(+ you keep the assets)* |
| LSA demand | ~45% blended GP on $54,000, less $2,500 spend | $21,800 |
| | **Expected 90-day gross profit contribution** | **≈ $124,600** |

The honest headline: **the $10,000 is the smallest lever in this document.** Collections is 76%
of the expected return and costs $2,000. The other $8,000 is what keeps January from being a
repeat of this conversation.

---

## 6. What not to spend it on

- **The app.** It is already good enough to run this entire plan — leads inbox, board,
  moisture logging, phone agent, QBO sync. On a 90-day horizon more development is a cost
  center, not a revenue line. Ship the collections sprint first; the one code change worth
  making is the A/R Summary-vs-Detail fix in §1.1, and that is an afternoon.
- **A truck or trailer.** Depreciates, does not bill daily.
- **Another full-time hire.** $10,000 is about five weeks of a loaded field employee and
  creates a permanent obligation against seasonal revenue. Contract the collections help
  instead.
- **Anything speculative.** You have a business with a 13.7× receivable sitting in it. There is
  no trade with that risk-adjusted return.

---

## 7. Ready-to-send collection letters

Three templates for the three paths in §2. Fill the brackets and send.

### 7.1 Path A — depreciation release *(Graham ×2, Baham, Hebard — $81,637.94)*

> **Subject:** Completion documentation — Claim [CLAIM #] — [PROPERTY ADDRESS]
>
> [Adjuster name],
>
> Work at [address] is complete. Attached is the certificate of completion, final photos, and
> the final invoice.
>
> Recoverable depreciation of $[AMOUNT] is outstanding on invoice [#], dated [DATE]. Everything
> required to release it is attached.
>
> Please confirm receipt and give me a payment date. If anything else is needed, call me
> directly at [phone].
>
> Branden Roybal
> Roybal Construction, LLC

### 7.2 Path B — TPA follow-up *(Hovda WO 15083-4, -5 — $16,433.57)*

Call first, then send. Zero dollars paid on both lines at 49 days means something is stuck in
the pipe, not that someone decided not to pay.

> **Subject:** WO 15083 — invoices 4 and 5 outstanding, 49 days
>
> [Name],
>
> Work orders 15083-4 ($4,893.26) and 15083-5 ($11,540.31) were completed and submitted
> 7/20/2026. Both still show unpaid at 49 days.
>
> I need one of two things: a payment date, or the specific reason for the kickback so I can
> correct and resubmit today.
>
> Confirming my portal submission went through on both — if it didn't, tell me and I'll upload
> again while we're on the phone.
>
> Branden Roybal
> Roybal Construction, LLC

### 7.3 Path C — mitigation packet *(Fidler — $39,002.43)*

> **Subject:** Mitigation documentation — Claim [CLAIM #] — [PROPERTY ADDRESS]
>
> [Adjuster name],
>
> Attached is the complete mitigation file for [address]: daily moisture logs, initial and
> final readings against IICRC S500 dry standards, equipment placement and run days, category
> determination, and photo documentation for each affected room.
>
> Invoiced $49,002.43 on 8/24/2026. $10,000 received. Balance $39,002.43.
>
> Equipment days and drying duration are supported by the moisture logs attached — readings are
> documented daily against material-specific dry standards, not estimated.
>
> IICRC Water Restoration Technician certified. Call me at [phone] with any questions on scope
> or method.
>
> Branden Roybal
> Roybal Construction, LLC

---

## 8. Assumptions and exclusions

**Assumptions**
1. A/R figures are QuickBooks A/R Aging Detail, accrual basis, as of 2026-09-07, and reflect
   only invoiced work. Completed-but-uninvoiced work is excluded and is likely additional.
2. Equipment billing rates ($100–115/day dehu, $25–30/day air mover) are typical industry
   ranges. **Verify against your current Alaska price list before relying on the payback math.**
3. LSA cost per lead is estimated at $90–120 for Fairbanks against a $154 national average,
   adjusted down for market size and competition. First 30 days of spend will produce the real
   number — reforecast then.
4. Close rates (40–50%) assume live 24/7 answering and same-day site arrival. Both degrade fast
   without that.
5. Freeze-up timing assumes a normal Interior season: first hard freezes late September, burst
   pipe volume from late October, peak December–January.
6. The $150.00 Stephen Fidler credit is an unapplied 2024 payment. Apply or write it off — it is
   noise on the aging report.

**Exclusions**
- No legal action, liens, or collection agency contemplated. Every dollar here is collectible
  through documentation and follow-up. Alaska mechanic's lien deadlines are not analyzed in
  this document — if any of these accounts go past 120 days without carrier movement, get
  that reviewed separately.
- No financing, factoring, or line-of-credit strategy.
- Honeybee / Pollen apartment work is not in this A/R and is not addressed here.
- Tax treatment of the equipment purchase (Section 179 vs. depreciation) is not analyzed — worth
  a call to your accountant before year end, since the buy lands in the 2026 tax year.

---

*Roybal Construction, LLC · Fairbanks, Alaska · IICRC WRT Certified*
