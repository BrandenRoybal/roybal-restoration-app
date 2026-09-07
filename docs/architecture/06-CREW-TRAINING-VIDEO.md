# Crew Training Video — Production Document
**Roybal Construction LLC · Version 1.4 · 2026-09-07**
**Source: `05-CREW-CAPTURE-SOP.md` v1.4 (2026-09-07)**

---

## 1. Read this first

### What this is

You asked for a training video version of the SOP. This is the shooting script for it.

> **This version has been walked by three independent reviewers before anyone filmed anything, and the corrections in it came from reading the app's source, not from watching footage fail.** All three returned *ship-with-fixes*. Every control label, every on-screen string and every claim about what the app does when you tap something was re-checked against `apps/field/js` and `apps/field/css` in the process — and roughly two dozen beats turned out to have been written against behaviour the app does not have. **None of them were cut.** In almost every case what the app actually does is a better demonstration than the one that was scripted, and the beat was re-staged onto the real behaviour. §11 records what was wrong and what changed.

It is not a video. Nothing in this file plays. What it is: a production document complete enough that you can pick up a phone and the company iPad and film the whole thing without making a single creative or technical decision while the camera is running. Every module below tells you what to point the camera at, what to say, what to tap on screen, how long each shot runs, what has to be built beforehand, and what order to cut it in.

Where a decision was genuinely yours to make and not mine, I did not make it. Those are collected at the end of every module under **Open questions**, and the six that block filming are in §2.

### What it is not

- **It is not a script somebody else can shoot.** It assumes you are the one on camera and a lead tech is the hands. Two people, most days one.
- **It is not a finished curriculum.** Six modules are written out in full. **Seven more** are outlined in §3 and have no script yet — M2, M3 and M9 in the every-tech track, M10, M11 and M12 in the lead track, and M13 in the office track. **Five of those seven are blocked by a ruling** (M3 by R1, M9 by R3+R4, M10 by R2, M11 by R5, M12 by R6), so writing them now would be writing them twice.
- **It does not reach Leonard Sheldon.** §6 says what he gets instead, and it is not a link.
- **It is not permanent.** Three of the six scripted modules teach around app defects that are already queued for repair in SOP §12.6. When those fixes land, beats die. §9 says which ones, so this does not rot into a video teaching a rule the app no longer has.

### What filming it will actually cost you

Honest number, built by adding up the per-module estimates in §5 **and then checking that §4.5's session plan actually spends them.** It does: the eleven sessions in §4.5 sum to **716 minutes**, and that is where the twelve hours comes from. If you change a session, change this table.

| | Hours |
|---|---|
| Principal photography, six scripted modules (§4.5 sessions 0–8) | **630 min · ~10.5 hours** |
| Voice-over passes (§4.5 session 9, truck cab, separate days) | **86 min · ~1.5 hours** |
| **Principal + VO — what §4.5 schedules** | **716 min · ~12 hours** |
| Editing | **~12 hours** |
| Prop building and throwaway-job setup | **~4 hours** |
| The three unscripted every-tech modules, when written and shot | ~6 hours more |
| **Total for the scripted six** | **~28 hours** |

That is spread across a **minimum of seven calendar days**, not four, and three of them are fixed by something other than your calendar:

- **Sessions 0 and 3 are exactly 48 hours apart.** M7's destructive test has to soak that long under a running dehu before the reveal can be shot — and session 0 is also the only day M7's Day-0 footage (shots 2A, 2B, 2C) exists. Miss the window and you rebuild all three panels and wait again.
- **Session 5b is weather-gated.** M8's beats A4, C and D are outdoors, in cold, with a real cab-to-outside delta; M8's own *Format and audio* section now recommends shooting them at +10 to +25°F rather than holding for December. It is the same gate M7 has, and §2.3 lists both.
- **Session 9 cannot start until rough cuts exist**, which is at least one editing day after the last principal session.

**The three tablet sessions (6, 7 and 8) are on three separate days on purpose.** Session 6 is 2h15m of one-way destructive work on one device, and §5's M5 says in as many words: do not schedule it as a 90-minute afternoon. Stacking M5, M6 and M4's screen beats into one "unhurried" block makes it a five-hour afternoon of continuous one-way work, which is worse, not better — the earlier version of §4.5 did exactly that.

**The single biggest line in the budget is M5, "Six taps that cost money":** 2h15m of tablet session and 3–4 hours of editing, because six of its beats destroy the state they need and each retake costs a rebuild. It is also the module with the most money attached.

**The 28 hours buy you something a printed card cannot.** Everything in the video is already in the SOP. What the SOP cannot do is be your face saying *never write a reading for a visit that did not happen*, and it cannot show a marker set vanishing when a floor plan imports. Motion, consequence, and where a control physically sits on the screen — those three things are what earn a module. Anything that teaches none of them should be a paragraph in the app's Help page instead, and I have cut two planned modules on exactly that test (§9).

### How to read a module

Every module carries, in this order: a status block (CLEAR or BLOCKED, and what blocks it), what the tech can do afterward, the shot-by-shot script as a three-column table, production notes and traps, a shot list you can work off on the day, a props-and-setup list, the assessment that closes it, and the open questions it leaves you.

The **AUDIO** column is written to be spoken to technicians. Everything else in this document is written to you.

---

## 2. Blocked until you rule

Six owner decisions are open (SOP §12.0 and §14's closing list). Four of them are printed on the laminated field card, which is why §12.0 holds the card back from the laminator. They block video the same way they block the card.

**Read this section before you film anything.** It is the part of this document that saves you a reshoot.

### 2.1 The six rulings, ranked by how much filming each one unblocks

| # | Ruling | Blocks | Unblocks | Cost of ruling wrong *after* filming |
|---|---|---|---|---|
| **R1** | **Asset-tag format** (§12.0.1) — `AM-014` recommended | **M3 outright**, and **the asset half of M2** (its objective is a hand-typed tag, which needs a tagged fleet). Contaminates two beats of M8, the 66-second walking take's chamber, and one shot of M1. | The whole shop day. §12.1's fleet-tagging exercise tags the fleet to whatever you rule, and produces the master asset list as a by-product. **A1 and A2 in §7.2 both sit inside that block** — A0 is clear and runs an hour earlier (§8.0, 0:07–0:09). | Fleet re-tagged for nothing; M3 reshot; M8's beats G3/G4 reshot (10 min); M8's C1–C3 one-take reshot if a chamber label was legible; M1's Shot 5 reshot if a tag was legible. |
| **R2** | **The dry-goal rule** (§12.0.2) — control + 2, table only when no control was taken | **M10 outright.** Contaminates two shots of M6, two shots of M4, three beats of M5 plus M5's closing paper insert, and one beat of M8. | The lead track's first module and the card's Material line. | M6 beats 3 and 8 reshot; M4 Shots 10 and 12C re-framed; M5 beats I1–I3 reshot (8 min screen + VO) and K-end re-shot as a 10-second insert; M8's H1 re-framed. |
| **R3** | **The daily-visit commitment** (§12.0.3) | **M9 (jointly with R4).** Contaminates M1 Beat 7 and all of M8's narration. | The assembly module the whole every-tech track builds toward. | M1 Beat 7 reshot — and it sits inside the lav'd Branden setup, so it is the expensive end of that module. |
| **R4** | **Grain depression** (§12.0.4) — confirm-and-close | **M8 beat H3.** **M9 (jointly with R3).** | Same as R3. §12.0.4 calls this settled and asks you to confirm it once. It is a ten-minute read, not a decision. | M8 beat H3 reshot (4 min) — but worse, a crew that believes a normal negative GD is an error starts inventing reference readings, which is the failure §12.0.4 exists to prevent. |
| **R5** | **Air-scrubber sizing authority** (§12.0.5) | **M11 outright.** | One lead-track module. | M11 reshot. Nothing in the every-tech track touches it. |
| **R6** | **The equipment billing unit** (§12.0.6) | **M12 outright.** | Closeout module. Largest open money question in the SOP. | M12 reshot. Nothing in the every-tech track touches it. |

**Ranked: R1 > R2 > R3+R4 > R6 > R5.**

R1 is the critical path for the entire rollout, not just for one module. R4 is a confirmation, not a decision. R3 is one sentence of staffing policy. So M9 — the module the whole every-tech course builds toward — is one evening away from clear.

### 2.2 The rule that keeps six modules CLEAR

Four of the six scripted modules run right alongside an open ruling and stay CLEAR only because of what the narration **does not say**. Those are written into each script as tripwires. The general form:

> **Every number a ruling could change is shot as its own separate insert — a held card, an on-screen graphic, or a tight crop — and is never spoken in continuous narration.**

A ruling change then costs a 20-second insert re-film instead of a re-shoot of a four-minute module. The specific applications:

| Ruling | The phrase that is banned on camera | The phrase that survives either outcome |
|---|---|---|
| R1 | Any prefixed tag, spoken or legible. No `AM-014`, no `DH-003`. | "the number that is physically on the machine" · "whatever a tag looks like, this handle grabs the digits on the end of it and counts up" |
| R2 | Where a correct dry goal comes from. No "control plus two." No "the table value." | "the number that was in that box" · "where that number comes from is a different module" |
| R3 | How often we visit. No "every day," no "daily." | "every visit" · "a missed day gets a reason, not a number" |
| R4 | Any judgement on the sign of a GD. | Name the mechanism only: "the app filled in a number for air nobody measured, and then subtracted it" |

**Two shooting rules that follow from R1 and cost you nothing:**

1. **Shoot M1's machine pass before the fleet is tagged.** An untagged machine is the cheapest possible insurance against R1.
2. **In every equipment-table screen recording, swipe the table left until the `Asset #` column is off the left edge before you roll.** The table lives in a horizontally scrolling wrapper. You lose nothing — those beats never discuss the asset column — and the shot survives any tag format. Do not plan to fix it in post; a 12px crop on a 1080-wide portrait frame is not recoverable.

### 2.3 Five things that are blocked but are not rulings

- **M7 is gated on weather, not on a ruling.** It is early September; forty below is December. The honest ladder is in the module. Best available now is a chest freezer (~0°F) or a restaurant walk-in (~−10°F). The module is cut so a twenty-second real-cold tail can be appended in January without recutting anything.
- **M8 is gated on weather too, and it was not on this list until now.** Beats A4, C and D are outdoors and need visible breath plus a real cab-to-outside delta — comfortably met at or below about **+25°F**, which is a late-September dawn here. That is 2:08 of a 5:42 module. **Pick a temperature and write it into §4.5's session 5b** (M8 open question 7); the same answer decides whether M8's cold half batches with M7's.
- **M7's beat 1:42 is blocked on a material-abbreviation table that does not exist.** §3.4 gives exactly one worked label, `GYP`, and there is no abbreviation for the other seven options in the app's Material dropdown. It is not one of the six rulings and it is not weather — it is one line of owner decision, an eight-row table, and it also gates assessment **A3**. Shoot the beat with the material line captured as a standalone insert so the ruling costs 5 seconds, not 18. See M7 open question 2.
- **M4's card stock, marker and tape are an unruled owner choice stated as company policy on camera.** §3.1 says "a card taped inside the electrical panel door" and stops; the ban on blue painter's tape for the *card* is an extension of §3.4's ban on it for *materials*, and Shot 5 says it aloud. Disagreeing reshoots M4 Shots 4 and 5 — in a jacket, with a real-time write. See M4 open question 3.
- **M13 (transcribing a paper card) is blocked on an artifact, not a ruling.** The Drying Visit Card template does not exist yet (SOP §10.1 says the app cannot print it and the office builds it in Word or Excel), and the office admin who transcribes is not yet named. See §6.

### 2.4 Do not shoot the laminated field card in close-up yet

§12.0 holds the card back from the laminator until R1–R4 land. Show it in the hand, at an angle, out of focus. **Shoot every card-face insert last, after the laminated version exists.** The one exception is M5's closing insert (shot 32, K-end), which is now framed on the card's **FILL DOWN** paragraph only — that paragraph carries no ruled value. The **NEVER** block four lines below it carries `goal = CONTROL + 2, BARE NUMBER ONLY`, which is R2, so it must stay out of frame or illegible. If you shoot K-end before the card is final, shoot it again after; it is one 10-second insert by design.

---

## 3. The course at a glance

Three tracks. Not everyone watches everything, and that is deliberate: seven techs, but not seven job set-ups. Teaching a helper the dry-goal derivation spends attention he needs for the four equipment strings.

**Assigned, not optional.** An optional module is an unwatched module.

### Every-tech track — all seven

**Twelve delivered files, not nine.** M5, M6 and M8 are split at their own seams per §3.1; the runtime column is the finished file, and the runtimes sum exactly.

| # | Title | Runtime | SOP | Status | Written? | After it, a tech can |
|---|---|---|---|---|---|---|
| **M1** | Why this changed: one tag, four machines | **3:05** | §1, §2 | **CLEAR** | **Full script** | Name the four things a carrier pays for, and say what a made-up row costs — the damage, not the rule |
| **M2** | The four strings, and the three columns you never fill | ~4:00 *(est)* | §6.2, §6.3, §6.4 | **CLEAR on the four strings · BLOCKED — R1 on the asset half.** Its stated objective includes "a hand-typed asset tag," which needs a tag format and a tagged fleet. | Outline only | Type an equipment row with one of the four exact strings; drag-fill Type/Room/Placed only; keep one row when a unit moves |
| **M3** | Fleet tags — every machine, permanently | ~2:00 *(est)* | §6.1 | **BLOCKED — R1** | Outline only | Read a tag off a machine instead of from memory; place a label where a headlamp hits it and never on a grille or filter door |
| **M4** | The panel-door card is the room list | **4:14** | §3.1, §8, §6.2 | **CLEAR of all six rulings.** ⚠ Card stock, marker and tape are unruled **owner choices, not SOP** (M4 open question 3); disagreeing reshoots Shots 4 and 5. | **Full script** | Write a room list to the seven-level grammar and copy one spelling into the three boxes that must match; refuse both room-inventing paths |
| **M5a** | Six taps that cost money — the moisture-map three | **3:44** *(3:52 with the tail card)* | §3.3, §7.1 | **CLEAR** | **Full script** | Name what `↺ Clear drawing`, `+ Add locations 14–26` and the row `✕` destroy; perform the Remove-locations repair |
| **M5b** | Six taps that cost money — the log four | **4:21** *(4:33 with the 12s bridge)* | §4.8, §5.5, §6.2, §6.3 | **CLEAR.** ⚠ Its closing shot K-end holds the printed field card, four lines above `goal = CONTROL + 2` — **R2 within frame.** Crop to the FILL DOWN paragraph, or shoot it after the card is laminated (§2.4). | **Full script** | Name what `+ New`, the fill handle, Material and a blank psychro pair destroy; re-type a dry goal as a bare number |
| **M6a** | Plan first — how many maps, the title, arming the tool | **3:34** | §3.2 | **CLEAR** | **Full script** | Build a map: title it to the card, import the plan before any marker, arm the tool |
| **M6b** | Loc 1 is the control, thirteen and no more | **2:30** | §3.3 | **CLEAR** | **Full script** | Stamp Loc 1 as the control, stop at thirteen, open a `(2)` map when thirteen is not enough |
| **M7** | A mark that survives a dehu and below freezing | **4:45** *(module's own ceiling is 5:00)* | §3.4, §3.5, §8 | **CLEAR of the six rulings · WEATHER-GATED · one beat blocked on an unruled abbreviation.** Beat 1:42–2:00 puts `GYP` on camera as the labelling format, and `GYP` is the only material abbreviation that exists anywhere in the SOP (M7 open question 2). **Shoot 3A with the material line also captured as a standalone insert.** | **Full script** | Label a reading point in freezing conditions the next tech can read by headlamp at arm's length; fall back to a punched tag plus a captioned photo |
| **M8a** | Outside, unaffected, affected — the three positions | **3:20** | §7.1, §5.1–§5.4 | **CLEAR of all six rulings · WEATHER-GATED.** Beats A4, C and D are outdoors in cold. | **Full script** | Walk the three positions in order and say which column group each one fills |
| **M8b** | The row, and typing it in with nothing blank | **2:22** | §7.1, §7.3 | **BLOCKED — R4** *(beat H3, 14s)*, **R1** *(inserts G3, G4)* | **Full script** | Take a full psychrometric round for one chamber with no cell left blank |
| **M9** | The monitoring visit, in order | ~4:00 *(est)* | §5, §7.1–§7.3 | **BLOCKED — R3 + R4** | Outline only | Run the front of the field card end to end |

**Every-tech total: 41:55 across twelve files**, plus about 30 seconds of split bridges and tail cards — call it **~42 minutes.** See §3.1: that number is a problem, and §3.1 now resolves it rather than only naming it.

### Lead / setup track — the leads who set jobs up

| # | Title | Runtime | SOP | Status | Written? |
|---|---|---|---|---|---|
| **M10** | Day 1: the control reading, Material, and the Dry Goal | ~4:00 *(est)* | §4.7, §4.8 | **BLOCKED — R2** | Outline only |
| **M11** | Day 1: sizing the equipment, once | ~3:30 *(est)* | §4.6, §4.13, §6.5 | **BLOCKED — R5** | Outline only |
| **M12** | Closeout and the Certificate of Drying | ~4:00 *(est)* | §9 | **BLOCKED — R6** | Outline only |

### Office track — the named transcriber, plus a backup lead

| # | Title | Runtime | SOP | Status | Written? |
|---|---|---|---|---|---|
| **M13** | Transcribing a paper card | ~5:00 *(est)* | §10.1–§10.3 | Clear of all six rulings; **blocked on an artifact and an unnamed person** | Outline only |

**M13's audience is not a technician, and it is the module with the highest consequence per viewer in the whole library.** The transcriber can make all six of M5's mistakes plus the QuickBooks one, on somebody else's job, with nobody watching. See §6.

### 3.1 The runtime problem — resolved

The instructional design that produced these modules set two ceilings: **4:30 per module** and **under 20 minutes** for the every-tech track. The reason given for both is the same one — one decision plus at most three supporting facts is what a working tradesperson holds before the fourth pushes out the first.

**The scripts as written come to 41:55, and M5 alone is 8:05.** I am not going to hide that inside a table, and I am not going to "solve" it by moving file boundaries and calling 42 minutes 42 minutes.

**Here is the honest position: only one of those two ceilings has a mechanism behind it.**

- **The per-module ceiling is real.** It is about what a person holds in one sitting, and it is measurable — a module that runs 8:05 is a module people stop halfway through. **Hold it absolutely.**
- **The 20-minute track total is not a ceiling, it is an aspiration that was never achievable.** Nine modules teach nine distinct decisions. There is no arrangement of nine decisions that fits in twenty minutes, and the only way to reach twenty is to cut content — which under time pressure means cutting the failure demonstrations, which are the part that makes the rules stick. **Cutting to reach that number would make the course worse, so the number goes, not the content.**

**What replaces it: a per-sitting budget, enforced by where the modules play.**

**1. Split at the seams the scripts already have — three splits, not two.** Every split point is a place a script already stops.

| Module | Splits into | Where the seam already is |
|---|---|---|
| **M5** (8:05) | **M5a 3:44** + **M5b 4:21** | The beat lettering already breaks there: A–F is the moisture map, G–K is the log. |
| **M6** (6:04) | **M6a 3:34** + **M6b 2:30** | The script already stops dead at 3:34 with a card telling the viewer to go build a map. |
| **M8** (5:42) | **M8a 3:20** + **M8b 2:22** | Beat E1 ends at 3:20 and F1 opens a new argument. **This split earns more than the other two: every blocked beat in M8 — G3 and G4 (R1) and H3 (R4) — lands in M8b, so M8a ships complete and unblocked today.** |

After the splits **no file exceeds 4:45**, and exactly two files sit over 4:30: **M7** at 4:45, whose own module grants itself a 5:00 ceiling, and **M5b**, which delivers at 4:21 and reaches **4:33 once its 12-second bridge is counted**. Splitting costs one extra edit and one bridge per split; it does not remove a second of content and it is not pretending to.

**2. Two modules leave the shop day and land at the point of use.** This is what actually fixes the sitting problem.

- **M8a + M8b (5:42) are watched in the truck, in the driveway, before the first monitoring visit.** M8 teaches three physical positions in a building. Watching it in a shop, three hours from the nearest chamber, is the weakest possible delivery of the one module the §9.3 index shows is most load-bearing per minute. Its own assessment is a screenshot of that visit's row, so the module and the check now sit in the same hour.
- **M9 (~4:00) was already there** — §8.5 calls it the highest-value repetition in the design.

**3. What is left plays at the shop day, in four blocks, none of them long.** M1, M2, M3, M4, M5a, M5b, M6a, M6b, M7 — **32:13 of screen across three paid hours**, arranged as **9:05 / 12:19 / 6:04 / 4:45** with physical work after every block and a stand-up stretch inside the second. That is the shape §8.0 already asked for and could not previously deliver.

**The rule that survives all of this, and the one that matters:**

> **If a module runs long, split it. Move it to where it is used. Never trim the consequence.**

The content most likely to get cut under time pressure is the failure demonstration, and the failure demonstration is why anyone remembers the rule. Nothing in this document has been shortened by removing one.

Everything else — the shot lists, the props, the assessments — is unchanged by the splits. **§8.0's agenda and §8.5's spaced-repetition table are both written to this arrangement**; if you reject it, both have to be rebuilt.

### 3.2 The one-hour version

If you only ever film one hour of this, film in this order and stop wherever you run out. **Three of the four carry a staging correction** — each was written against behaviour the app does not have, and in each case what the app actually does is the better shot. Item 1 is the exception and needs nothing.

1. **M1 Beat 6** — you, sync sound, no cutaway: *never write a reading, a date, or an hour for a visit that did not happen.* 45 seconds. It is the sentence the rest of the SOP rests on, it needs no app state, and it is the only one of the four that cannot rot when a code fix lands.
2. **M5's cold open and beats H1–H3** — the fill handle inventing seven asset tags. 90 seconds, and it is the mechanism behind §1's entire story. ⚠ **H3b has to be re-staged before you roll.** `recalcDays()` only recomputes hours when `row.placed && row.removed && !row._manualHrs` (`apps/field/js/forms.js:687`), and the props built rows 2–10 completely blank — so with no Placed, the Hrs cell would sit still whether or not the manual flag were set, and you would film a cell not moving and narrate a cause that is not operating. **The props now build rows 9–12 with a real Placed timestamp, and H3's A/B runs on rows 9 and 10.** Then the freeze is genuine and visible. *(§9.2 flags this as the beat most likely to be retired by a queued fix — film it anyway; see the 60-day test in §9.2.)*
3. **M6's cold open** — three markers stamped, a plan imported, the markers gone, the counter at 4. 32 seconds, one take, no words for the first twelve of them. ⚠ **It only fires if the three markers are stamped in the same screen session as the import.** `strokes` is captured once at `sketchPad` construction (`apps/field/js/core.js:381`) and `size()` repaints from that captured value (`core.js:413–419`) — so a pre-built three-marker map has a three-marker PNG in `strokes`, the import redraws 1, 2 and 3, and nothing vanishes. **Do not pre-build "State A." Build it inside the take:** Remove plan → Clear drawing → leave the screen → re-enter → stamp three → import.
4. **M4's cold open** — the `NO ROOM SET` header over a grid of roomless photos. 18 seconds. ⚠ **Two corrections.** Under `Sort: Room, then Before → After` the roomless photos **sink to the end** of the sorted array (`photoRoomCmp`, `apps/field/js/forms.js:2021–2025`), so that section is the *last* one on the page — a recording that is "already running when the frame starts" has to open already scrolled to the bottom of the list. And **the production counts are gone from the beat entirely.** M1's own hard production rule bans counts in narration, SOP §2 says a rule that needs a statistic is not a rule, and §4.7 burns captions in so a lower-third could not be corrected later. **The beat works on the header and the length of the scroll** — and it is stronger without a number the crew can date.

That is under four minutes of finished video and it carries the four most expensive facts in the document.

---

## 4. Before you shoot

### 4.1 Kit

Prices are marked **[q]** where a researcher quoted a figure and **[est]** where I am estimating. Nothing here is a purchase you have to make blind; the two that matter are the lav and the stylus.

| Item | Price | Why | Needed for |
|---|---|---|---|
| **Wireless lavalier, two transmitters** | **$79–99 [q]** | The only sync-sound beats in the library are you talking to camera in the shop, and a phone mic six feet away in a shop is useless for a beat that has to hold. Clip it on the collar **outside** the coat — under a Carhartt the fabric rustle is worse than the room. | M1 Beat 6 (the one beat that justifies it on its own), M1 Shots 3/4/5/8, M4 Shot 15, M5 beats C and K |
| **Flexible tripod + phone clamp** | $25–35 [q] | You are alone and on camera in five of M1's nine shots. | Every module with a to-camera beat |
| **Overhead gooseneck phone stand** | $25–30 [q] | Card and label inserts shot from directly above. | M1 Shots 1/9, M4 Shots 6/7, M7 Shots 3A/3B, M5 (not needed — all screen capture) |
| **White foam board, 20×30** | ~$4 [q] | Bounce for tabletop inserts. Not a light — a reflector. | All overhead inserts |
| **Rechargeable COB work light** | $25–40 [est] | Freezer beats only, plus one arm's-length read test. **Do not add fill to the headlamp read test** — the headlamp *is* the light, and adding fill proves nothing. | M7 beats 5A/5B/6A |
| **Tethered capacitive stylus** | already buying [SOP §12.1] | A fingertip covers the 13px fill handle and the drag reads as a smear. The stylus tip leaves it visible. §12.1 already calls this the highest-value purchase in the rollout. | **Fill-handle drags only.** Everywhere else the taps are a bare thumb so the landing point is visible on camera — see M5's props. Using the stylus for taps hides the thing those beats exist to show. |
| **Thin liner gloves** | already buying [SOP §12.1] | Every hand in M7 and in M6's tapping beats wears them, warm shop included. A bare hand teaching a cold-weather rule is how a crew learns the trainer has never done it. | M6, M7 |
| **Rite-in-the-Rain index cards or field-card stock** | $10–15 [est] | M4's room card and M1's hero prop. Buy a stack — you rewrite it for every retake. | M1, M4 |
| **Fine-tip oil-based paint pens ×3** | already buying [SOP §12.1] | One for the jacket-prime beat, one cold-soaked overnight, one spare. **Name the exact brand and tip on screen** — the same brand makes a permanent marker and that is how a crew restocks the wrong thing. | M7 |
| **Gaffer or duct tape** | shop stock | Explicitly **not** blue painter's tape — §3.4 bans it for humidity release and M4 Shot 5 says so on camera. Having a roll of blue tape visible in frame would undercut the line. | M4 |
| **Aluminum flashing offcuts, nail set, tie wire, plastic tags, zip ties** | shop stock | M7's fallback demo. | M7 |
| **Sealed ziplock bag** | shop stock | Carry the phone out of the freezer inside it and let it warm in the bag, or the lens fogs and you lose three setups. | M7 |

**The conflict you should know about:** one researcher recommended a **$29 wired** lav ×2 instead, on the grounds that a wireless battery dies at −20°F and pairing in gloves fails. That is true, and it does not change the recommendation — because **none of the cold beats in this library are sync sound.** M7 is shot MOS end to end and voiced in the truck. The wireless kit only ever works in a warm shop, where it is better. Buy the wireless, and do not take it outside.

**Do not buy a lighting kit.** Use the shop's work lights, one trouble light for tag close-ups, and a headlamp for the label shots — the headlamp is what the tech actually uses and it makes the shot honest about what a label has to survive. You also cannot get a usable wide shot in a crawlspace with a phone. Shoot crawlspace content as tight headlamp inserts and do the explaining above ground.

### 4.2 The tablet — set these once, check two of them every take

Every module below assumes an iPad. The SOP and the repo both say the crew carries a company iPad.

**Set once, before the first take:**

- **Install from the Home Screen icon, never a Safari tab.** The manifest sets `display: standalone`, so from the Home Screen there is no URL bar and no toolbar and it looks like a native app. A tab take and a standalone take will not intercut.
- **Auto-Lock → Never.** A lock mid-take kills the take, and on the sketch pad it can kill a stamped-but-uncommitted stroke.
- **Focus / Do Not Disturb ON.** Every banner lands in the recording.
- **Keyboard clicks OFF.**
- **Screen Recording added to Control Center** (Settings → Control Center → Included Controls; it is not there by default).
- **Charge above 60%.** The status bar is in every frame and cannot be hidden. A 4% battery in the corner of a training video is its own small argument against the app.
- **Set the clock to the shoot date and leave it.** Several beats print today's date on screen; a date that jumps between beats reads as sloppy.

**Check every single take:**

- **Long-press the ⏺ record button → Microphone.** For this library it goes **OFF** — all narration is recorded separately. It is the most-missed step in either direction, so look at it every time.
- **Airplane Mode ON.**

### 4.3 Airplane Mode is not a preference, and shoot day is a deploy freeze

This is the one production hazard that can ruin a whole session, and it is worth understanding rather than just obeying.

The service worker (cache `roybal-field-v166`) calls `skipWaiting()` on install and `clients.claim()` on activate. The app then listens for `controllerchange` and calls **`location.reload()` — with no dialog, no toast, and no user choice.** It defers only while a text input is focused, and even then fires on the next navigation. `reg.update()` runs on load **and every hour the app stays open.**

So: a push to `main` during the shoot, or the tablet simply sitting open for an hour and picking up a build from earlier that day, **will blank and reload the screen in the middle of a take.**

**The rule:** open the app online, sign in, pull the training job, then **Airplane Mode for every take**. The app is offline-first; nothing in the six scripted modules needs signal except two deliberate offline-failure beats, which are *supposed* to fail. And **freeze deploys to `main` for the whole shoot day.**

### 4.4 The throwaway job — build it once, and know the trap

**Customer name: `TRAINING - DO NOT BILL`.** Fake address. No claim number.

**Never film a real customer's job.** Address, claim number, carrier and customer name print on nearly every screen in this app, and these files land on seven personal phones and stay there. A single frame of a real job in a module that gets AirDropped around is not retractable.

> **⚠ `+ New Job` does not reliably make a new job.** `createProject()` scans the store and **reuses any existing blank unarchived job of the current mode**, re-stamping who created it. On take 3 you can land back in take 1's half-filled job. **Build the training job once, deliberately, and never reach for `+ New Job` again during the shoot.**

**When the shoot is over: archive that job. Do not delete it.** This shop has already hit the bug where a board tile pointing at a deleted job file re-spawns a lead forever; the repair is repointing, not deleting. A training artifact that generates a ghost lead on the board would be an unusually stupid way to lose trust in the rollout.

Each module's props list says exactly what state its job needs, and several modules need states that fight each other: M4 needs **ten permanently roomless photos plus two roomed ones spelled a space apart**, M5 needs one map with a plan imported *first* and **twelve equipment rows** (2–8 blank, 9–12 carrying a Placed time), M6 needs four map states plus a list of three unnamed wood maps and builds State A **on camera**, and M8 needs a **four-row psychrometric page printed and then deleted** before its virgin cold-open row exists — on a job carrying **exactly one Drying Log with no Outside or Affected value on any row of it.** ⚠ **Two of those states are left broken by the session before.** M5's beat G1 permanently adds a **second Drying Log**, and M5's props fill a psychrometric row with Affected `78`/`31` and Outside `-22`/`60`; between them they falsify M8's F1 narration and destroy M8's B2 "before" state, because those four gates read any row on any log (`anyInstanceRow`, `completeness.js:31`). **Session 8 therefore opens with a two-minute teardown — M8 props step 0 — and it is not optional.** M1 Shot 2's own four-row equipment state has the same problem from the other end (M5 leaves twelve rows on the first log); shoot it on the second log's empty equipment table before the teardown deletes that log. **No module needs a green completeness panel — that beat was re-staged in both M4 and M5, because a green panel has no checklist to film.** **Read all six props lists before you build anything**, and build one job that can serve them in the shoot order below.

### 4.5 The order to shoot in

Eleven sessions. **Every shot in every module's shot list has a session below**, and the sessions sum to the **716 minutes** §1 budgets. Sessions do not have to be separate days except where a note says so: **sessions 0 and 3 are fixed 48 hours apart**, **sessions 6, 7 and 8 are three separate days on purpose**, and **session 9 cannot start until rough cuts exist.**

**One session needs a second pair of hands** and is marked **[2P]** — session 5b, whose 66-second unbroken walking take cannot be shot by the person carrying the gear. Everything else is one person on a tripod.

| # | Session | Time | Every shot in it — this is the complete list | Notes that decide the day |
|---|---|---|---|---|
| **0** | **Prep + Day 0. Camera required.** −48h | **35 min** *(plus ~4h prop and job build, budgeted separately in §1)* | **M7 2A, 2B, 2C** — the four marks going onto Panel A in one locked take, the pump-sprayer soak in real time, the dehu wheeled in and switched on. Build **Panel B** (same four marks) and **Panel C** (clean, unmarked) and put both in the freezer or outside. Build the throwaway job to §4.4's reconciled state. Run **M4's headlamp legibility test** on the room card — a look, not a take. | **The old §4.5 scheduled no camera here and three of M7's nineteen shots exist only on Day 0.** 2B is the argument-winning shot of the module and it cannot be re-created 48 hours later. Shoot the slate card with the date in frame. The legibility test decides whether M4's central prop changes before anything else is filmed. |
| **1** | **Shop, fleet staged, UNTAGGED** | **15 min** | **M1 Shots 1 and 9** (the index card, overhead gooseneck, back to back — same setup, two minutes) and **M1 Shot 5** (the machine pass, including the tag-free housing close-up). | Shooting the machine pass before any tag goes on permanently solves R1 for M1. Do it while the fleet is out and bare. |
| **2** | **Shop, machines off, lav on** | **15 min** | **M1 Shots 3, 4, 5-tail, 6, 8**, back to back, same frame, same lighting state, one mic setup. **Beat 6 third or fourth**, while you are warmed up but not tired of the camera. **Three takes minimum on Beat 6.** | The only sync-sound block in M1. |
| **3** | **M7 reveal, +48h from session 0. One take forever.** | **25 min** | **M7 1A, 1B, 1C, 2D, 2E, 8A.** Shoot the whole reveal — the cold-open slide across all four marks, the tape lift, the A/B, and the closing macro — **before anyone touches the panel.** | 2D is a one-take shot forever and 8A reuses the same undisturbed panel. Panel A is built oversized with two spare sets of marks; if a take is soft, move to a spare set, never to the shot set. **Shoot the reveal before a word of VO is written** — M7's narration is written to what the panel actually shows. **Check the dehu's tag is out of frame or facing away before you leave** — it is the module's only R1 exposure. |
| **4** | **Shop, warm. One overhead rig, one lights-out setup.** | **42 min** | **M7 3A ⛔, 3A-insert ⛔, 3B, 3C** (the overhead label, the material-line insert, the pin holes, the `12" AFF` insert), **M7 5C(b)** (the warm-wall heater cutaway), **M7 4A** (lights out, headlamp, arm's length — **no fill light**). Then **M4's camera block: Shots 3, 4, 5, 5B, 6, 7, 8, 11, 15.** | One overhead gooseneck build serves M7's three label beats and M4's two tailgate beats; the lights-out setup for 4A is thirty seconds from the one for M4 Shot 5B. **Shot 4 gets shot in a jacket in the unheated bay or outside the roll-up — not at a desk.** Shot 15 is the one lav'd sync take in M4. ⛔ **M7 3A and its material-line insert are blocked** until the material-abbreviation ruling lands (M7 open question 2) — they put `GYP` on camera as the format. Shoot everything else and leave them; 3A is one continuous overhead take and drops in later as one setup. |
| **5a** | **Cold — chest freezer or restaurant walk-in. Any day.** | **13 min** | **M7 5A, 5B, 5C(a), 6A** — the pen skipping and failing on Panel B, the jacket prime, **the jacket-warm pen writing on the cold-soaked Panel C**, the punched flashing fallback. Thermometer or truck gauge in frame at the head of 5A. | **This half of the cold work is not weather-gated and must not be made to wait for one.** A freezer (~0°F) or a walk-in (~−10°F) is repeatable, indoors, at any hour. **5C(a) must be shot here, before you leave the cold** — you do not get a second cold-soaked board that day. Phone out of the freezer inside a sealed bag; wipe the lens every take. **Record no VO here** — every temperature in M7's script is a blank you fill from the frame. |
| **5b** | **Outdoor cold + the staged chamber. WEATHER-GATED. [2P]** | **80 min** | **M1 Shot 7** (tailgate reason code, daylight, whatever the temperature — keep the fumbled take). **M8 A4, C1–C3, D1, D2, D3, D4, E1, F2, G1**, and **G3 ⛔R1**. C1–C3 is the 66-second unbroken walking take. | ⚠ **Three things have to be settled before this day is booked.**<br>**(1) The weather gate.** M8's *Format and audio* section now sets the real requirement — visible breath and a genuine cab-to-outside delta, comfortably met at or below about **+25°F** — and recommends shooting in the next few weeks rather than holding for December. Confirm which, and write the answer into this row (M8 open question 7).<br>**(2) The walking take needs two people.** One person cannot hold the camera while hanging the hygrometer on the mirror, carrying gear through an exterior door, setting the tablet down in a dry room and walking into a running chamber. **Book a lead tech.** Rehearse the walk once; do not cut it.<br>**(3) The location has to exist before the day.** One building with an exterior door, a dry interior room, a running chamber, **and a second doorway with a second machine set visible** for F2. Nothing in the props list names one. Walk it and confirm before the truck is loaded. **Mask or turn away every asset label in that chamber** — a legible tag in C3 puts C3, C4 and J1 behind R1.<br>G3 is a ten-minute pickup — **do not hold the session for R1.** |
| **6** | **Tablet A — M5, alone. One device, one desk, a full half-day.** | **135 min** | **All 32 items of M5's shot list, in script order:** A, A-insert, B, C, C-card, D1, D2, D3, D3-split, E1, E2, E2-print, E3, F1, F2, **G1, G2, G2-print, G2-panel** *(these four LAST — see the module's retake table)*, H1, H2, H3a, H3b, I1, I2, I3a, I3b, I3c, J, K, K-card, K-end. **Items 5 (C-card), 9 (D3-split), 27 (I3b) and 31 (K-card) are post cards, not takes** — they are listed so the count reconciles, not so you look for a setup. | **The beat order is forced by the damage; shoot in script order.** §1 and §5 both say do not schedule this as a 90-minute afternoon — **do not schedule it as half of a five-hour one either**, which is what the previous version of this table did.<br>⚠ **Four beats were re-staged against the app's real behaviour and the module now carries the corrected versions** — E3 (the confirm only fires on columns that hold data), H3b (rows 9 and 10, both carrying a Placed timestamp), I3a/I3c (typing in front of the goal turns the cells RED, not green) and G2 (nothing is sized; the second log prints a dated row of zeros). Read those beats before you roll; each one changes what the job state has to be.<br>⚠ **K-end is R2-contaminated** — the printed card's NEVER block carries `goal = CONTROL + 2, BARE NUMBER ONLY` four lines from the paragraph you want. Crop to the FILL DOWN paragraph, or shoot it again after the card is laminated (§2.4).<br>B, C, K and K-end are camera, not screen: rig the tripod once at the end of the session and shoot all four together. |
| **7** | **Tablet B — M6, alone, a different day.** | **120 min** | **All 26 items of M6's shot list.** Camera items **4, 5, 12, 18, 20** and the optional B-roll **26** batch at the end of the session on the tripod and the overhead rig. Items **15** and **25** are post cards, not takes. | Four beats are destructive and each take costs a rebuild; budget **5 minutes to rebuild State A** and **8 for State C**. If you get two clean takes of the cold open, stop.<br>⚠ **The cold open's bug only fires on markers stamped in the same screen session as the import.** `strokes` is captured once at `sketchPad` construction (`core.js:381`) and repainted by `size()` (`core.js:413–419`) — a pre-built three-marker State A survives the import and nothing vanishes. **Build State A on camera, in the take:** Remove plan → Clear drawing → leave the screen → re-enter → stamp three → import. Rehearse the revert once off camera first (M6 open question 3).<br>Do the first PDF import off-camera — `pdf.js` lazy-loads on the first import of a session and can pause. |
| **8** | **Tablet C — the screen work nobody scheduled. A third day.** | **150 min** | **M1 Shot 2** (the four-row Asset drag — its own job state, four rows with all four Type strings). **M4's screen block: Shots 1, 2, 9, 10, 12A, 12B, 12C, 13, 14A, 14B, 14C, 14D** — in that forced order, 14A–D last. **M8's screen and desk block: A1, A2, A3, B1, B2, F1, F3, G2, H1, H2, I1**, plus **G4 ⛔R1** and **H3 ⛔R4** as standalone crops. **M7 7A, 7B** (Job Photos — the punched-tag photo and its caption). | **This is the session the old table did not have, and it holds roughly a third of the library's shots.**<br>⚠ **The session opens with a teardown, and after it the order is forced four times.**<br>**(0) M5's leftovers come off the job before anything is shot.** Session 6 left a **second Drying Log** and a psychrometric row carrying Affected and Outside values. Until both are gone, M8's **F1** narrates *"there is always one"* over a two-row list and M8's **B2** has no "before" state to shoot (`anyInstanceRow`, `completeness.js:31`). Delete the second log from inside its editor (`app.js:1939`, confirm `:1946`) and `✕` every psychrometric row on the survivor. **Two minutes. M8 props step 0. ⚠ Shoot M1 Shot 2 on that second log's empty equipment table *before* you delete it** — it is the only clean four-row equipment table on the job.<br>**(1) M8's printed packet page gets built and printed**, then **A1–A3**, because the virgin `0/0/0` psychro row is consumed the moment you type into it. **(2) M8 B2's "before" state must precede H2** — one filled row anywhere on the job silences those four panel lines for good. **(3) M4 14A–D come last** — `+ Add item` writes a contents item immediately and the room it invents is permanent. **(4) Inside 14B, the panel line is filmed before the `➕ New room…` prompt is completed** — completing it fills `item.room` (`app.js:1998`, `:1979`→`:1992`) and the line the shot exists for is gone.<br>⚠ **Five beats here were re-staged: M4 14A, M4 14B, M4 14C, M4 14D and M8 B2.** 14D now requires a **force-quit and relaunch of the PWA under Airplane Mode immediately before the take** — `likelyOffline()` is *offline flag AND nothing succeeded in five minutes* (`core.js:53–56`), and without the relaunch the tap opens the photo picker and starts a real AI call. The completeness panel builds its checklist **only from missing items** (`apps/field/js/completeness.js:252–258`), so a job whose header reads `Complete — ready to bill.` has zero groups and nothing to unfold — `foldable()` is only wired when `m.groups.length` (`apps/field/js/app.js:682–685`). And every panel line renders as `${g.formLabel}: ${g.label}` (`completeness.js:255`), so the on-screen string is `Contents: Room on each contents item`, never the bare label — every burned-in reproduction of a panel line has to be re-set.<br>M1 Shot 2 and M5's beat A use the same control on different job states; **shoot M1's four-row state here, not in session 6 — on the second Drying Log's empty equipment table, before step (0) deletes that log.** |
| **9** | **Truck cab, VO. Later days, after each rough cut exists.** | **86 min** *(M1 10 · M4 6 · M5 25 · M6 8 · M7 12 · M8 25)* | **All narration**, module by module. Engine off, **heater fan off**, windows up, doors shut, coat on, phone 8–10 inches off-axis, **ten seconds of silence at the head of every file.** | The words have to land on the taps, so a rough cut has to exist first.<br>⚠ **M7's VO cannot be recorded until sessions 3 and 5a are shot** — every temperature in that script is a blank you fill in from the frame, and three of its beats are written to whatever the 48-hour panel actually did.<br>⚠ **M4's Shot 9 VO no longer waits on a ruling** (the beat now films the trimming rather than asserting a mechanism), but **whether SOP §3.1 gets corrected to match still has to be decided before the cab session** — M4 open question 1. |

**Sessions sum to 716 minutes**, which is §1's twelve hours. **Minimum seven calendar days:**

| Day | Sessions |
|---|---|
| **1** | 0 (prep + Day 0), then 1 and 2 |
| **2** | 6 — M5, alone, nothing else |
| **3** | 3 (fixed at +48h from session 0), then 4 |
| **4** | 7 — M6, alone |
| **5** | 8 — Tablet C |
| **6** | 5a (freezer, any day) and 5b **if the weather is there** — otherwise 5b moves to winter |
| **7+** | 9 — VO, one cab sitting per module, after that module's rough cut |

**Shots that are post, not takes — do not look for a session for them:** M1's four on-screen text builds; M5's C-card, D3-split, I3b and K-card; M6's cards 15 and 25; M8's C4 and J1 (both freezes of C3's last frame). Every lower third and burn-in in the library is post.

### 4.6 Audio, once, for the whole library

**Record every screen capture silent.** Record almost every narration line separately, in the truck cab, on a later day: **engine off, heater fan off**, windows up, doors shut, phone 8–10 inches off-axis, coat on, **ten seconds of silence at the head of every file** for the noise print.

This is the single largest quality gain in the production and it costs nothing. It also means a wrong word costs one sentence, not a 90-second screen take you have to rebuild the job state to redo.

**The exceptions — sync sound, lav, on camera:** M1 Shots 3/4/6/8, M4 Shot 15, M5 beats C and K. That is it. Everything else is cab VO.

On location in a chamber, grab **ten seconds of room tone with the machines running** at the top of every take, so a cut is not audible. Wear the lav on the walking beats even though the air movers will bury it — keep that track as **ambience** under the VO. Boots on snow, breath, the machines. That texture is free and it is what makes a walk read as real.

### 4.7 Format and file naming

**1080×1920 portrait, H.264, .mp4, 30fps, open captions burned in.**

Portrait because the tablet is held in portrait, the sketch canvas sizes itself to its container width so on a portrait iPad the map fills the screen, and the phone the tech watches on is held in portrait. Filming a portrait tablet into a landscape frame throws away most of the pixels and makes a 13-column reading grid unreadable.

For anything shot on a tablet screen: **record at native resolution and crop into the region of interest in post.** A 13-pixel fill handle or a 34-pixel marker letterboxed inside a full tablet capture on a phone is invisible — and those are the exact things the modules exist to point at.

**Captions burned in, not a sidecar `.srt`.** A separate subtitle file does not survive being AirDropped and played out of the Files app, and half of these get watched with a truck heater running.

**File names — the filename is the sort order:**

```
M1-why-changed.mp4
M2-four-strings.mp4
M3-fleet-tags.mp4
M4-room-card.mp4
M5-six-taps.mp4
M6-map-markers.mp4
M7-paint-pen.mp4
M8-three-places.mp4
M9-visit-order.mp4
```

Lead track `L10-`…`L12-`, office `O13-`. Nothing else in the folder.

### 4.8 Ten things that will go wrong, collected

Every one of these is in a module below. They are here too because you will not re-read the modules on the day.

1. **A deploy mid-take blanks the app.** Airplane Mode, deploy freeze. (§4.3)
2. **`+ New Job` reuses a blank job.** Build the training job once. (§4.4)
3. **Fill-down has no undo.** Every fill-handle take is one-way; budget 90 seconds per manual reset and expect three resets.
4. **Typing into — or clearing — an `Hrs` cell sets `_manualHrs` permanently on that row** (`forms.js:705`), and dragging into it does the same. You get one clean take of that demonstration per row, and M5's A/B burns two rows per take. **Build twelve rows, not eight, and give rows 9–12 a Placed timestamp** — the hours only auto-compute when Placed and Removed are both set (`forms.js:687`), so a blank row cannot demonstrate the freeze at all.
5. **The only way to delete a form instance is the editor's red Delete** — it is inside the instance, not on the list, which is why it looks missing (`app.js:1939`, confirm at `:1946`). M5's beat G1 creates a second Drying Log; removing it is a 40-second job, not an afternoon. **Never sign out and back in to undo it** — that re-pulls the server copy and discards every unpushed change in the session. Still shoot G1 and G2 after the moisture-map beats.
6. **`↩ Undo` on the sketch pad is memory-only, capped at 30, and empty the moment you leave the screen and come back.** There is no reset on a map. Rebuilding a four-marker state is four minutes.
7. **The PDF importer renders page 1 only, silently.** Do one throwaway import off-camera before you roll — `pdf.js` lazy-loads on the first import of a session and can pause.
8. **The `DRYING LOG` letterhead is print-only and invisible on the packet page on screen.** Every "here is what the carrier gets" beat has to be shot in the **iOS print preview** (`⬇ Save packet as PDF` → the AirPrint sheet). Rehearse the pinch-to-full-page on a thumbnail once before rolling.
9. **iOS autocorrect and autocapitalize are on** — nothing in the app disables them on any of these fields. Watch what the keyboard did to `Crawl North Bay` before you move on. If it visibly happens on camera, keep it and say one line about it; it is a real field hazard and free footage.
10. **Cold kills phone batteries fast.** Phone inside the jacket between takes, out for 60–90 seconds, back in. Carry it out of a freezer in a sealed bag. Wipe the lens every take.

---

## 5. The modules

Six are written out in full below. Three every-tech modules, three lead-track modules and the office module are outlines — enough to know what they cover and what blocks them, not enough to shoot. **Five of those seven are blocked by rulings anyway** (M3 by R1, M9 by R3+R4, M10 by R2, M11 by R5, M12 by R6).

**Reading the tables:** TIME is finished runtime, not shoot time. VISUAL says SCREEN (a screen recording) or CAMERA (the phone pointed at something) at the top of each cell. AUDIO in italics is a stage direction, not a line to read.

---

### M1 — "Why this changed: one tag, four machines"

**Track:** every tech (all seven) · **Runtime:** 3:05 · **Position:** first module, shop day (§12.1), watched before anyone touches a tablet
**SOP sources:** §1 in full · §2 the asset-`101` anecdote only · §5's two rules-above-every-step
**Status: CLEAR TO FILM** — see the two no-go phrases before you roll.

**Shoot time:** M1's shots are spread across five of §4.5's sessions, not three of its own — **session 1** (Shots 1, 9 and 5, shop, fleet bare and untagged, 15 min), **session 2** (Shots 3, 4, 5-tail, 6, 8, one lav setup, three takes of Beat 6, 15 min), **session 5b** (Shot 7, the tailgate reason code, weather-gated), **session 8** (Shot 2, the four-row Asset drag, shot on the second Drying Log's empty table before it is deleted) and **session 9** (VO, 10 min). Edit 60–75 min, most of it the two punch-ins. Its four on-screen text builds are post, not takes.

**Blocking note.** No beat waits on a ruling. But two rulings run close enough to touch it, and both are avoided by wording, not by waiting.

- **R1 (asset-tag format).** Never say `AM-014` and never let a legible tag into frame. The script says *"the number that is physically on the machine"* and specifies a tag-free machine close-up. If you improvise a format on camera and the ruling changes, Beats 2, 4 and 5 reshoot.
- **R3 (daily-visit commitment).** Never say how often we visit. The rule that survives either ruling is *"a missed day gets a reason, not a number"* — that is what Beat 7 says, and it says nothing about cadence. If you ad-lib "we go every day" and the reason-code path turns out to be the real rule, Beat 7 reshoots, and Beat 7's neighbours are the lav'd setup, so it is the expensive end of the module.

**After this module a tech can:** state the four things a carrier pays for — which spot, which machine, which day, which number — and say why an invented or carried-forward row is the one defect that turns a reduction into a denial.

**This module's job is authority, not information.** Everything in it is on the field card already. What the card cannot do is be your face saying *never write a reading for a visit that did not happen.* Beat 6 is the module. Everything else is the run-up to it and the landing after it. If you have one hour and a lav, shoot Beat 6.

#### Two hard production rules for this module

1. **No production counts on screen or in the narration.** §2 says outright that a rule needing a statistic is not a rule, and three passes of the SOP got a different subset of the counts wrong. Counts move; this video does not. The one *specific* thing that goes on screen is the four type strings from the asset-`101` collision, because those are a defect, not a metric, and they will still be true in a year.
2. **No customer name, address, claim number, or interior anywhere in this module.** These files land on seven personal phones forever. The four `101` rows are re-typed onto a card and onto a training job. Do not screenshot the live jobs.

#### The shooting script

| TIME | VISUAL | AUDIO |
|---|---|---|
| **0:00–0:12**<br>**COLD OPEN A**<br>*the damage* | **Shot 1.** Tight overhead, tabletop, foam board bouncing the shop light. A single white index card lying on a scarred workbench. Four lines hand-printed on it, nothing else:<br><br>`101   Air mover`<br>`101   Air mover  `<br>`101   Axial Air Mover`<br>`101   Dehumidifier Dry-Eaze Xi7000`<br><br>Your bare finger comes into frame and taps down the `101` column, once per line. Four taps. No cut.<br><br>**No title card. No logo. No music. The first frame is the card.** | *(VO, cab-recorded)*<br>"Four machines. One number."<br><br>*(beat — let the fourth tap land)*<br><br>"Four different jobs. Same tag on all four. Three of them are air movers. One of them is a dehumidifier." |
| **0:12–0:30**<br>**COLD OPEN B**<br>*the mechanism* | **Shot 2.** Screen recording, iPad portrait, Airplane Mode, standalone PWA off the Home Screen icon. Training job open at Drying Log → section heading **Equipment Deployment & Runtime**. Four rows in the table. Row 1's **Asset #** cell holds `101`. Rows 2, 3, 4 have Asset empty and Type filled.<br><br>The stylus takes the small orange square at the bottom-right corner of the `101` cell and drags it down through rows 2, 3 and 4. The rows tint as they arm. Release.<br><br>`102`, `103`, `104` appear. Toast, bottom of screen: **Filled 3 rows.** It holds 2.2 seconds — freeze the last frame for another second in the edit.<br><br>**PUNCH IN 250% on the Asset column for this whole shot.** The handle is 13 pixels and half-transparent. It is unreadable at full frame on a phone. | *(VO)*<br>"That is where the four came from. Nobody read a hundred and one off a machine."<br><br>*(the drag)*<br><br>"Watch it invent them."<br><br>*(the numbers land)*<br><br>"A hundred and two. A hundred and three. A hundred and four. Three machines that don't exist, on a job, in ten seconds, and nothing on that screen tells you it happened." |
| **0:30–0:42**<br>**the promise** | **Shot 3.** You, waist up, standing in the shop. Machines behind you, **switched off**. Talking to the room, not the lens barrel. Lav on collar, outside the coat.<br><br>Static frame. No zoom, no move. Everything from here to 2:55 with you in it is this same setup — shoot them back to back and cut between them. | *(sync sound)*<br>"That is not a field problem. The work was done. The paperwork is what leaks.<br><br>Three minutes, and then we go tag machines." |
| **0:42–1:12**<br>**what a carrier pays for** | **Shot 4.** Same setup. You count four on your fingers, one at a time, holding each long enough to read.<br><br>**On-screen text, one line at a time, bottom third, orange on navy, appearing on your beat and staying:**<br>`WHICH SPOT`<br>`WHICH MACHINE`<br>`WHICH DAY`<br>`WHICH NUMBER`<br><br>All four on screen together by 1:08 and holding to the cut. | *(sync sound)*<br>"An adjuster sits at a desk and re-does our math. They never call us. If they can't rebuild the equipment days and the drying trend out of the file by themselves, they cut the invoice.<br><br>So there are four things they pay for. Which spot. Which machine. Which day. Which number.<br><br>That's it. Everything on the card comes off those four." |
| **1:12–1:35**<br>**the credit**<br>*(this beat is why a ten-winter tech keeps watching)* | **Shot 5.** Cut away. Handheld, moving slowly along a line of machines staged on the shop floor: one axial air mover, one LGR dehu, one air scrubber, one heater. Shot at machine height, no faces.<br><br>**One machine close-up — the housing where a tag will go. Frame it so no number is legible: either the fleet is not tagged yet when you shoot this, or shoot the bare panel above the tag.** Do not resolve a tag format on camera.<br><br>Cut back to you for the last sentence. | *(VO over the machine pass)*<br>"None of this is new work. You have been filling in the asset, the type, the room, placed, removed and hours on nearly every row for as long as we've had the log. The habit is already there. I'm not asking for it.<br><br>*(cut to camera, sync)*<br><br>Two things tighten. The number you write has to be a number you read off the machine. And the type has to be one of four spellings, every time. That's the next video." |
| **1:35–2:20**<br>**THE RULE**<br>*the whole module* | **Shot 6.** You. Same frame. **No cutaway anywhere in this beat. No B-roll, no on-screen text, no music.** Everything else in the library has something moving in it; this one does not, and that is the point.<br><br>Do not read it. Say it.<br><br>If the take is clean but the delivery is soft, do it again. This is the sentence the rest of the SOP rests on and it gets three takes minimum. | *(sync sound, unhurried, one pause where marked)*<br>"Here's the one I want you to walk out of here with.<br><br>Never write a reading, a date, or an hour for a visit that did not happen.<br><br>*(pause — hold it)*<br><br>Not a carried-forward number. Not an estimate. Not 'it was probably about the same as yesterday.'<br><br>One made-up row makes every other row in that file arguable. Every one. The adjuster doesn't have to prove the rest is wrong — they just have to find the one, and then everything is a question.<br><br>A reduction, we can argue. That's a denial. It is the only defect in this whole document that does that." |
| **2:20–2:40**<br>**the way out** | **Shot 7.** Cut to a tight insert: a gloved hand printing a reason code on a field card in ballpoint, in daylight, tailgate of the truck. Legible, unhurried.<br><br>**On-screen text, the written line only, held:**<br>`NO ACCESS 09/08 - homeowner away, texted 0830`<br><br>**Say nothing about how often we visit.** R3 is open. This beat is about what a missed day gets, not how many days there are. | *(VO)*<br>"You cannot go back and take Sunday's reading. Nobody expects you to.<br><br>A day you missed gets a reason. Not a number.<br><br>Where it goes is on the card and it's in the visit video. What matters right now is that a documented skip is defensible and a silent gap is not — and a *filled-in* gap is worse than either." |
| **2:40–2:55**<br>**the honest limit** | **Shot 8.** You. Same frame. Slightly lighter delivery — this is levelling with them, not instructing.<br><br>**No on-screen text.** | *(sync sound)*<br>"One straight thing. This does not make the file bulletproof yet. The app still stores a reading spot as a bare column number with no name on it. Two sheets in the same packet still count equipment two different ways. I know.<br><br>What this buys us today is that we catch our own billing errors before the adjuster does. That's worth doing on its own, and when the app gets fixed, everything you wrote carries over instead of starting again." |
| **2:55–3:05**<br>**close + assessment** | **Shot 9.** Cut back to Shot 1's index card on the bench, same overhead frame, bookending the open. Your hand slides it out of frame.<br><br>**Final on-screen text, held four seconds to the last frame, and the only text that is not in your voice:**<br>`WHICH SPOT · WHICH MACHINE · WHICH DAY · WHICH NUMBER`<br>`Never write a reading for a visit that didn't happen.` | *(VO)*<br>"Four things. Which spot, which machine, which day, which number.<br><br>Before we break today, I'm going to ask one of you for those four and what a made-up row costs us. Not the rule. What it costs." |

#### Shot list

1. **Shot 1** — INSERT, overhead tabletop. White index card, four hand-printed lines all reading `101` (Air mover / Air mover with two trailing spaces / Axial Air Mover / Dehumidifier Dry-Eaze Xi7000). Finger taps down the `101` column, four taps. Punch in to fill frame in post. **12s**
2. **Shot 2** — SCREEN, iPad portrait, standalone PWA, Airplane Mode. Drying Log, Equipment Deployment & Runtime, 4 rows. Stylus drags the orange fill handle from the Asset cell holding `101` down through rows 2–4; rows tint; `102/103/104` land; toast reads `Filled 3 rows`. Punch in 250% on the Asset column. One-way take, budget 3 resets. **18s**
3. **Shot 3** — MCU, waist up, shop, machines off behind, lav on collar. Static. The promise and the runtime. **12s**
4. **Shot 4** — MCU, same setup. Count four on fingers; on-screen text `WHICH SPOT` / `WHICH MACHINE` / `WHICH DAY` / `WHICH NUMBER` builds line by line and holds. **30s**
5. **Shot 5** — HANDHELD, slow pass along four staged machines at machine height (axial air mover, LGR dehu, air scrubber, heater), no faces. Includes one machine close-up framed so **no tag number is legible** — shoot before the fleet is tagged. Tail returns to the Shot 3 frame. **23s**
6. **Shot 6** — MCU, same setup, sync sound, **no cutaway, no text, no music**. *"Never write a reading, a date, or an hour for a visit that did not happen."* Three takes minimum. **45s**
7. **Shot 7** — INSERT, outdoors, tailgate, daylight, actual temperature. Gloved hand printing a reason code in ballpoint on a field card. On-screen text: `NO ACCESS 09/08 - homeowner away, texted 0830`. **Keep the fumbled take.** **20s**
8. **Shot 8** — MCU, same setup. The honest limit: the app still stores a reading spot as a bare column number. **15s**
9. **Shot 9** — INSERT, Shot 1's overhead frame again; your hand slides the card out. Final on-screen text held 4s to black. **10s**

#### Props and setup

- **ONE white index card**, hand-printed, four lines: `101 Air mover` / `101 Air mover` (two trailing spaces) / `101 Axial Air Mover` / `101 Dehumidifier Dry-Eaze Xi7000`. This is the module's hero prop **and** the entire teaching aid for the in-person Leonard version. **Keep it after the shoot.**
- **iPad** with the field app installed from the Home Screen icon (standalone PWA — never a Safari tab). Auto-Lock Never, DND on, keyboard clicks off, battery above 60%, Screen Recording in Control Center with **Microphone OFF**.
- **The training job** `TRAINING - DO NOT BILL`, opened online and synced, then Airplane Mode. Drying Log created with **four** equipment rows (tap `+ Add equipment` three times). Row 1 Asset `101`; rows 2–4 Asset empty. **All four Type cells pre-filled** with the four strings above, including the invisible trailing-space one. **Reset script for retakes:** retype `101` in row 1, clear `102/103/104` from rows 2–4 by hand. Fill-down has no undo.
- **Tethered capacitive stylus** for Shot 2 — a fingertip covers the 13px handle and the drag reads as a smear.
- **Wireless lav** — justified by Shot 6 alone, which is sync sound with lip-sync visible and cannot be VO'd. Collar, **outside** the coat.
- **Flexible tripod and phone clamp** — you are alone and on camera in five of nine shots.
- **Overhead gooseneck stand and white foam board bounce** for Shots 1 and 9.
- **Four staged machines**, one of each class: axial air mover, LGR dehumidifier, air scrubber, heater. **Shoot Shot 5 before the fleet is tagged.**
- **A blank printed field card and a ballpoint** for Shot 7. Outdoors, gloved, at whatever the actual temperature is.
- **A quiet shop with the machines switched OFF** for Shots 3–6 and 8.
- **Truck** for the VO pass, a later day, after the rough cut. Engine off **and heater fan off**. Ten seconds of silence at the head of the file.

#### Filming notes and traps

**Shot 2 is the fragile one. Everything here is verified in the shipped code.**

- **The handle is 13×13 px, orange, at 50% opacity, in the bottom-right corner of the cell** (`.fillh`, `app.css:415–420`). On an iPad there is no hover, so it never brightens — the `:hover` rule at `app.css:421` never fires. It sits faint. Use the **stylus**, not a finger.
- **You need four rows.** The drag has to travel through three rows below the source or you get one number, not three. Tap `+ Add equipment` three times before you roll.
- **Fill down through rows that are otherwise filled in.** Put the four type strings in first, by hand, so the table looks like a real log and not an empty grid. The invisible one — `Air mover` with two trailing spaces — types the same as the clean one on camera, and you should say so in the VO for Beat 1: *"one of those has two spaces on the end you can't see."* That single sentence does more for M2 later than any amount of explaining.
- **Rows tint while the drag is armed** (`tr.fill-target`). That tint is the best frame in the shot. Do not drag fast; take two full seconds crossing the three rows.
- **The toast reads `Filled 3 rows` and lives 2.2 seconds.** Hold a freeze on the final frame in the edit or nobody reads it on a phone.
- **This is a one-way take.** Fill-down has no undo. Budget 90 seconds per reset and expect three resets.
- **Airplane Mode, and freeze deploys.** See §4.3.
- Record the screen **silent**.

**Shot 6 is the one place in the library a microphone is worth buying.** Lip-sync is visible and it is the sentence the crew will quote back at each other. Buy the wireless lav for this beat, collar, outside the coat, machines off. It pays for itself on the first take you don't have to redo.

**Shot order for the day:**

1. Shots 1 and 9 (the index card) — same setup, back to back, two minutes total.
2. Shot 5's machine pass — while the fleet is staged and **before any tags go on**.
3. Shots 3, 4, 5-tail, 6, 8 — all you, same frame, machines off, lav on, in that order. Do Shot 6 while you are warmed up but before you are tired of the camera: third or fourth thing said, not tenth.
4. Shot 2 on the tablet, alone, unhurried, with resets.
5. Shot 7's tailgate insert whenever you are next outside with a card in hand.
6. VO for Shots 1, 2, 5 and 7 in the truck, after the rough cut.

**In the edit:** the two punch-ins (Shot 2's Asset column at 250%, Shot 1's card filling frame) are the only technical work. Portrait throughout. **No music anywhere in this module** — Beat 6 is the reason.

#### Cold, wet, gloved — what this module honestly does not show

This module is shot warm, dry and indoors, and it should be. Nothing in it is a field procedure — it is four facts and one rule, and a rule does not get more true at −22°F.

- **It must not show a labeled point, a meter, a crawlspace or a paint pen.** Every one of those belongs to a later module and has to be shot in the conditions it happens in. Borrowing a warm clean shot of a labeled stud into this module to make it look richer will read as fake to a crew that labels studs in the dark, and it will cost the whole library credibility in the first three minutes.
- **Shot 7's reason-code insert is the one outdoor frame**, and it is daylight at a tailgate, not a crawlspace. That is honest: writing a reason code is a thing you do at the truck. Shoot it at whatever the actual temperature is, gloved, in the light you have. **If the ink drags or the glove fumbles the card, keep that take.**

#### Assessment

Runs at the shop day, in the room, immediately after the module. Costs about ninety seconds, and it is why the last line of narration exists.

**Pick one tech — not a volunteer — and ask two questions:**

1. "Name the four things a carrier pays for."
2. "What does a carried-forward number cost us?"

**Pass on Q1** = all four in any order, in his own words. *"Where it was, what machine, what day, what it read"* is a pass. Reciting the four verbatim is also a pass but tells you less.

**Pass on Q2** = names the **damage**, not the rule. *"It gets denied"* / *"then they can argue the whole file"* is a pass. *"You're not supposed to do that"* is a fail — **restate the beat to the room and move on. Do not re-ask the same question of a second tech in front of the first** (§7.3a rule 2): that turns a teaching moment into a comparison, which is a scoreboard with no paper. Saying the damage aloud to peers is what makes it stick, and the room hearing the point made again is worth more than the room hearing who missed it.

Do not write it down. Do not score it. **If a tech fails Q2 twice in the same session, ride with that tech first in Week 1** (§12.2).

#### The Leonard lane for this module

Leonard does not open apps, links, or anything an app sent him. A file on a phone does not reach him and neither does a QR code on a card. **Do not put him in the every-tech video block and mark him complete.**

His counterpart to this module is **two minutes, in person, at the shop, with the index card from Shot 1 in your hand.** Not a screen. Two things transfer:

> "Four machines had the same number on them because a spreadsheet made the numbers up. From here the number you write is the number that's on the machine."
>
> "And never write a reading, a date, or an hour for a visit that didn't happen. A day you missed gets a reason, not a number. One made-up row and the whole file is arguable."

That is the entire module for him. He does not need Beat 2 — he never touches the fill handle, because he never touches the tablet. He needs Beat 6, and Beat 6 was always going to be a person saying it to a person; the video is just how the other six get the same delivery.

**Keep the index card.** It is the prop for the video and the entire teaching aid for the in-person version, and it is the only artifact in this module that works with no battery.

#### Open questions — M1

1. **Can the four `101` rows be shown as a screen capture of the LIVE jobs with the customer column cropped, or must they stay a re-typed index card?** The card is what I scripted, because these files sit on seven personal phones forever and §2 itself warns that counts date — and the card doubles as Leonard's teaching aid. But the live rows are stronger evidence. Only you can decide whether a cropped screenshot of real equipment rows is acceptable to put on a tech's personal phone. If yes, it replaces Shot 1 and nothing else changes.
2. **R1 confirmation before Shot 5:** is it agreed that no tag format is spoken or shown in this module? If you ad-lib `AM-014` on camera and later rule differently, Beats 2, 4 and 5 reshoot.
3. **R3 confirmation before Shot 7:** is it agreed that this module says nothing about visit cadence?
4. **Does the honest-limit beat (2:40–2:55) stay in?** I recommend keeping it: §1 says read it before you believe the rest of the document, and a crew that hears the tool's limits admitted in the first three minutes will believe the next thirty. But it is fifteen seconds of a three-minute module and it is your own credibility being spent. Cutting it costs nothing structurally.
5. **Should Shot 6 be re-cut on its own as a standalone 45-second clip?** It costs one edit off footage already shot and it is the piece most worth re-sending in week two. I did not scope it as a separate deliverable because the instructional design puts M1 explicitly on the do-not-repeat list — re-selling the reason after the crew has accepted it reads as distrust. Worth a decision rather than a default.

---

### M2 — "The four strings, and the three columns you never fill" *(OUTLINE — not yet scripted)*

**Track:** every tech · **Runtime target:** ~4:00 *(estimate)* · **SOP:** §6.2, §6.3, §6.4 · **Status: CLEAR on the four strings · BLOCKED — R1 on the asset half**

**After it, a tech can:** type an equipment row using one of the four exact strings, a room copied off the panel card, and **⛔ R1 — a hand-typed asset tag**; drag-fill Type, Room and Placed only; and keep one row when a unit moves rooms.

**Why it is second in the running order, and why that matters.** This is the module where the crew is already 97% right. §2's own evidence block says per-unit equipment logging is not new and the habit is already there — only two things tighten. **Open on the credit, not the correction.** The first *doing* module a ten-winter tech watches should be the one that tells him he has been doing it right.

**What it has to contain, in order:**

1. The four strings, on screen, as text, held: `Air mover` · `Dehumidifier` · `Air scrubber` · `Heater`. No capital M. No trailing space. No "Axial."
2. **Why**, in one demonstration, not one sentence: the packet's two equipment counters normalise the type string differently — the narrative groups on the trimmed string as typed, the sizing table lowercases and pattern-matches — so `Air mover` and `Axial Air Mover` print as **two line items in the narrative and one combined total in the sizing table.** Two documents in the same packet disagreeing. That is the whole argument and it needs the print preview, not a claim.
3. Make, model and **rating** go in Notes: `Dri-Eaz LGR 7000XLi - 130 AHAM pt` · `Phoenix Guardian - 700 CFM`. Without the rating, the unit price on the invoice line has no basis in the file.
4. The fill handle: **Type, Room, Placed — drag those all day.** Never Asset, never Removed, never Hrs. (This beat exists in full in M5 already — see the note below.)
5. **A unit that moves rooms keeps its row.** Move eight air movers once each with close-and-reopen and the packet's opening narrative reports 16 air movers against a worksheet recommending 8. Easiest reduction on the page, entirely self-inflicted.

**Overlap warning, and my recommendation.** Beats H1–H3 of M5 already demonstrate the three fill-handle columns in full, and M1's cold open already shows the Asset drag. **Do not shoot the fill-handle demonstration three times.** Either (a) M2 states the three-column rule in ten seconds and points at M5, or (b) M2 absorbs M5's H beats and M5 drops to five taps. I recommend (a): M5's beat H is written to land as the payoff of M5's own cold open, and moving it breaks that module's structure.

**⛔ Blocked by R1 on the asset half, and only on that half.** The four strings, the Notes rating, the fill-handle rule and the moved-unit beat are all clear and can be shot today with the `Asset #` column swiped off the left edge (§2.2 rule 2). What is blocked is this module's stated objective of a **hand-typed asset tag**: there is no tag to type until R1 rules the format and §12.1's exercise tags the fleet. **Shoot the clear four-fifths, leave a 20-second hole for the tag beat, and drop it in the week R1 lands** — the same treatment §7.2's A2 gets, where the type-string half runs and the asset half waits.

---

### M3 — "Fleet tags — every machine, permanently" *(OUTLINE — BLOCKED)*

**Track:** every tech · **Runtime target:** ~2:00 *(estimate)* · **SOP:** §6.1 · **Status: BLOCKED — R1**

**After it, a tech can:** read a tag off a machine rather than from memory; place a label where a headlamp hits it and never on a grille or filter door; apply the paint-pen backup and the cord mark.

**This is the ruling that blocks the shop day, not just this module.** §12.1's fleet-tagging exercise *is* the shop day's spine — everyone handles every machine, reads out the number, applies the label — and it produces the master asset list as a by-product. Tag to a format that later changes and the whole fleet is re-tagged for nothing, in front of the crew, in week one. That costs more credibility than the delay costs time.

**What it has to contain:** the prefix table and why a prefix is self-checking (an `AM-` can never be a dehu); label placement on the top or handle-side face where a headlamp hits it, **never on a grille or a filter door** because those get swapped between machines and the identity corrupts silently; the 2-inch paint-pen backup somewhere else on the housing; the cord mark near the plug, because in a stack of eight air movers in a crawlspace the cord is often the only part you can reach; and the adhesive rule — above 50°F, cure 24–72 hours, which is why tagging in a cold shop is the main reason tags fall off.

**Why it is video and not a paragraph:** physical placement. Where on the housing, and why not the filter door, is shown in three seconds and described badly in three sentences.

**Do not film any part of this until R1 lands.**

---

### M4 — "The panel-door card is the room list"

**Track:** every tech · **Runtime:** 4:14 *(hard ceiling 4:15 — one second of headroom; if Shot 14B runs long, cut "and one of them the app already answered for you" from the VO and carry it as a post caption instead)* · **SOP:** §3.1, with verified touch-points in §3.2, §6.2, §8, §12.5, §13
**Position:** after M3 (fleet tags), before M5 (the six destructive taps). Follows the shop-day tagging exercise, so this is the first module they watch sitting down after physical work.
**Status: CLEAR of all six rulings — film it now.** Two of them (R1, R2) leak into frames and are handled by the framing rules in the status block below; the card stock, marker and tape are an unruled owner choice recorded in §2.3.

**Shoot time:** 55 min screen-record block (§4.5 session 8) + 20 min prop/camera block (§4.5 session 4) + 6 min VO (§4.5 session 9).

#### Status block — read before you roll

**Blocked by no ruling — but two things are not "nothing", and both have a named cost.** None of the six rulings appear in this module's *content*: no dry goal, no asset-tag format, no visit cadence, no grain depression, no scrubber authority, no billing unit is spoken or taught here. **But two rulings leak into frames, and one unruled owner decision sits inside the dialogue:**

- **R1 leaks into every equipment-table shot** (Shots 9, 12B) — see the swipe-left rule below.
- **R2 leaks into every moisture-map header shot** (Shots 10, 12C). `Dry Goal (MC%)` is one `.grid2` row below `Room / Area (titles this map)` (`forms.js:465–470`) and `.grid2` is two columns at every width an iPad can render (`app.css:170`; its only breakpoint, `app.css:617–618`, needs a viewport under 360px), so any frame holding the Room/Area box and the live caption also holds a dry-goal value. **The framing rule is in Shot 10's cell; it is not optional.**
- **The card stock, the fine-tip permanent marker and the tape are the author's call, not the SOP's** (open question 3), and Shot 5 states the tape ban aloud as company policy. Disagreeing reshoots Shots 4 and 5 — on camera, in a jacket, with a real-time write. **It is now recorded in §2.3 with M7's weather gate and M8's, rather than only inside a module banner that reads CLEAR.**

**But one ruling leaks into a frame, and there is a shooting workaround.** Rule 3 of §3.1 sends the room string into the **equipment row's Room / Location** cell, which sits three columns right of **Asset #**. If a legible asset tag is in that frame and R1 goes a different way, this module gets reshot for a reason that has nothing to do with rooms.

> **Shooting rule for every equipment-table shot in this module:** the `Equipment Deployment & Runtime` table lives in a horizontally scrolling wrapper (`.tablewrap { overflow-x: auto }`). **Before you start the take, swipe the table left until the `Asset #` column is off the left edge of the screen and the frame starts at `Equipment Type / Make / Model`.** You lose nothing — this module never talks about the asset column — and the shot survives any tag-format ruling. Do not fix it in post; a 12px crop on a 1080-wide portrait frame is not recoverable.

**Two honesty corrections this module must carry.** Both are already acknowledged in the SOP's own change log (§14), and both are verified in the code:

1. **§3.1 gives the wrong reason for the no-trailing-space rule.** It says the packet counts `Attic ` and `Attic` as two rooms. It does not. `narrative.js:69` calls `.trim()` on every equipment location before grouping; the moisture-map area name is trimmed at **`narrative.js:47`** (`area: (m.label || m.material || "Affected area").trim()`); the map's own on-screen caption is trimmed before it paints (`forms.js:427`); the photo gallery trims, collapses runs of whitespace *and* compares case-insensitively (`forms.js:2015`, `2021–2025`); the invoice groups on a trimmed room key (`forms.js:1266`). **Nothing in the app today splits a room on a trailing space.** §14 says the rule is right and the stated consequence is wrong, and left it unchanged pending a decision. The narration below keeps the rule and gives the true reason. **Do not let anyone ad-lib the old reason on camera** — a rule defended with a reason the crew can disprove is a rule they route around, and one of them will check.
   > ⚠ **And do not substitute the *type* column as the replacement reason.** An earlier draft of Shot 9 blamed forty-five untrimmed type strings for the packet's two equipment counters disagreeing. They do not disagree over whitespace either: the narrative trims the type before it groups (`narrative.js:62`) and the sizing table lowercases and pattern-matches it (`dryingcalc.js:155–160`). Only a genuinely different string — `Axial Air Mover` against `Air mover` — actually diverges the two counters, which is **M2 and SOP §6.2's material, not this module's**, and §14 already records it correctly. Trading one disprovable reason for another, in the beat that dares the crew to check, is the single most expensive thing this module could do.
2. **This is a rule the crew already keeps.** §2's evidence block: *no* equipment row in the production file has an untrimmed room/location value. Forty-five rows have an untrimmed **type** string. Open the beat with the credit, not the correction.

**Offline:** every beat except Shot 14 films fully in Airplane Mode. Shot 14 has two options; **Option A needs no signal and is the recommended one.**

**Split point (§3.1):** this module does not need splitting. 4:14 is inside the ceiling.

#### The shooting script

| TIME | VISUAL | AUDIO |
|---|---|---|
| **0:00–0:08**<br>*Shot 1 — SCREEN* | **Cold open. No title card, no logo, no music.** Screen recording, already running when the frame starts. Job Photos screen, **`Sort:` already set to `Room, then Before → After`, and the page already scrolled to the BOTTOM before you hit record.** Roomless photos sink to the *end* of that sort (`photoRoomCmp` returns `ra ? -1 : 1` for a room-vs-no-room pair, `forms.js:2021–2025`), so `NO ROOM SET` is the last section on the page — you cannot arrive at it by scrolling down from the top of a job. Camera holds on one thing: the uppercase group header **`NO ROOM SET`** — bold, letter-spaced, orange rule under it (`.photogroup`, `app.css:284–288`) — with the grid of roomless photos running below. Slow scroll: the header holds at the top of frame, the photos keep coming. | *(cold, flat, no wind-up)*<br>"Every photo under this header is a real photo of real damage. One of us took it, standing in a room." |
| **0:08–0:18**<br>*Shot 2 — SCREEN* | Same recording, same slow scroll, no cut. Keep scrolling until the grid runs out, then stop and hold two full seconds on the empty space under the last row. **No lower-third. No count. No percentage.** | "And the file can't say which room. Not one of them. They go to the adjuster in one pile called *no room set*, and by then nobody remembers." |
| **0:18–0:27**<br>*Shot 3 — CAMERA* | You, waist-up, shop, holding a blank index card and a Sharpie. No desk, no whiteboard. Just you and the card. Lock exposure before you roll. | "By the end of this you'll write a room list on a card, tape it in the panel door, and copy one room name into the three boxes that have to match. That's the whole job." |
| **0:27–0:31**<br>*Shot 3 cont.* | Same. You tap the card twice against your hand. | "Four minutes." |
| **0:31–0:45**<br>*Shot 4 — CAMERA* | Over-the-shoulder, the staged panel door open. You write on the card, on camera, in real time — five lines, block caps, fine Sharpie. We see the pen move:<br>`Main Kitchen`<br>`Main Living`<br>`Upper Bedroom 2`<br>`Basement Utility`<br>`Crawl North Bay`<br>**Do not cut away from the writing.** The crew has to see it take twenty seconds, not appear finished. | "The app has no room list. There's no room manager, no picker, no dropdown. Four separate free-text boxes and nothing joins them. So the list has to live somewhere, and the somewhere is a card taped inside the panel door. Lead tech writes it on the first visit. Nobody invents a room after that." |
| **0:45–1:00**<br>*Shot 5 — CAMERA* | Tight, hands. You tape the card to the inside of the panel door — **gaffer or duct tape, two strips, top and bottom.** Then close the door, pause, open it again. The card is there. Rack focus from door to card. | "Tape it with duct or gaffer. Not blue painter's tape — we already ban that on materials because it lets go in humidity, and a panel door on a job with a dehu running is humidity. If the card falls off behind the panel, the list is gone and there's no second copy anywhere." |
| **1:00–1:16**<br>*Shot 6 — CAMERA* | Overhead gooseneck, card flat on the tailgate. **In post, one static graphic beside it** — no motion, no build:<br>`<Level> <Room> <number if repeated>`<br>and under it, one line:<br>`Basement · Crawl · Main · Upper · Attic · Garage · Exterior` | "The format is level, room, number if it repeats. And *level* is one of seven words. Basement. Crawl. Main. Upper. Attic. Garage. Exterior. Not 'downstairs.' Not 'first floor.' Not 'the back one.' Seven words, and none of us gets to add an eighth, because the whole point is that the tech who wasn't here today can read the card and know where you were." |
| **1:16–1:28**<br>*Shot 7 — CAMERA* | Same overhead. Your finger traces a circle clockwise above the card. **Post graphic: a crude plan outline with a front door marked and three bedrooms numbered 1, 2, 3 going clockwise.** Keep it ugly and hand-drawn-looking; a polished floor plan reads as somebody else's house. | "Rooms that repeat get numbered clockwise from the front door. Not by size, not by who sleeps there. Clockwise from the front door, so two techs standing in the same house come up with the same number two." |
| **1:28–1:38**<br>*Shot 8 — CAMERA* | You to camera. Card in hand. | "Three rules on top of that. The first one is a rule you're already keeping, and I want to say that out loud before I say the rule." |
| **1:38–2:02**<br>*Shot 9 — SCREEN* | **⚠ Pre-scroll the table right first — `Asset #` must be off the left edge.** Frame starts at `Equipment Type / Make / Model` with `Room / Location` beside it (`forms.js:809`). ⚠ **Select all and delete row 1's `Room / Location` before you roll** — M5 leaves it reading `Basement Utility`, and typing into it as-is yields `Basement UtilityBasement Utility ` (the cell is an auto-growing textarea, `forms.js:720`). This shot's own production note already classes it as reversible. Then tap into `Room / Location` on row 1, type `Basement Utility`, then tap **space once**, deliberately, and hold. The caret sits one space past the `y`. Nothing on screen changes. Zoom in post on the caret. **Then cut — same continuous recording — to Job Photos, `Sort: Room, then Before → After`.** Two photos were roomed in the pre-build, not on camera: one reads `Basement Utility`, the other `Basement Utility ` with a trailing space. **They are under ONE header.** Hold three seconds on that single header. | "Rule one: no trailing space. And here's the honest version of why, because the written SOP overstates it and one of you would've caught that. Watch — two photos, one of them typed with a space on the end. One header. It trimmed it, and it trims it everywhere I looked. So the rule isn't that the app splits your rooms. It's that there's no room record in this app at all. The spelling *is* the only link, and nothing checks it but a person." |
| **2:02–2:20**<br>*Shot 10 — SCREEN* | **⚠ R2 FRAMING RULE — read this before you roll.** `Room / Area (titles this map)` and `Meter / Setting` are one `.grid2` row; **`Material` and `Dry Goal (MC%)` are the very next `.grid2` row**, roughly 60px below (`forms.js:465–470`, `.grid2` is `1fr 1fr` — `app.css:170`. There **is** one breakpoint, `@media (max-width: 360px)` at `app.css:617–618`, which stacks the pair — it cannot fire on a ≥768px iPad, so the two boxes are side by side in every frame you will shoot and the framing rule below stands). Selecting a Material auto-writes a real goal string into that box (`forms.js:381–387`). **A single frame containing both the Room/Area box and the sketch caption necessarily contains the Dry Goal box, and R2 is unruled.** Shoot this as two frames on one continuous recording, and scroll between them — which is what a tech actually does. **Frame A (top of form, Dry Goal below the bottom of frame):** the `Room / Area (titles this map)` box, empty, placeholder `e.g. Living Room`. Type `Basement Drywall`. **Scroll down past the Material row to the sketch canvas — Frame B (Dry Goal above the top of frame):** the bold caption reads `Basement Drywall`, and the Equipment Placement caption below it reads **`Basement Drywall — Equipment`** (`forms.js:430`) — one typed string, two captions. Scroll back to Frame A, select-all, delete, type `Basement Utility - Drywall`. Scroll down: both captions repainted. | "Second rule: never put a material in a room name. `Basement Drywall` is not a room. And look what one box is driving — it titles the area map *and* the equipment map. The material belongs to the map, not the room, and a map titled with one material while its Material dropdown says another is the kind of thing an adjuster spots without trying. Room name, plain hyphen, material. The part in front of the hyphen matches the card exactly." |
| **2:20–2:26**<br>*Shot 11 — CAMERA* | You, direct, three fingers up. | "Third rule, and this is the one the app can't help you with. One spelling, three boxes." |
| **2:26–2:40**<br>*Shot 12A — SCREEN* | **The montage. Three cuts, hard cuts, no transitions. In post, one persistent white chip in the top-left corner of all three cuts reading `Basement Utility` — it does not move, does not animate, and does not leave until Shot 13.**<br>**Cut 1 — Job Photos.** Tap a photo card. The room box is the bare input directly under the tools row — **it has no label, only the grey placeholder `Room / location`.** Type `Basement Utility`. The **`✓ Saved`** pill flickers top-right. | "Box one. Job Photos, on the photo card. It doesn't even have a label — it's the grey box that says *Room slash location*. Every photo. Not the good ones. Every one." |
| **2:40–2:50**<br>*Shot 12B — SCREEN* | **Cut 2 — Drying Log equipment table.** Same pre-scrolled frame (Asset # off-screen left). Tap the `Room / Location` cell on a second equipment row. Type `Basement Utility`. The cell is an auto-growing textarea — it grows as you type. | "Box two. The Drying Log, `Room / Location` on the equipment row. A room off the card — not a machine name, not 'upstairs,' not blank. If the machine's in Basement Utility, that's what goes there." |
| **2:50–2:58**<br>*Shot 12C — SCREEN* | **Cut 3 — moisture map. ⚠ Same R2 framing rule as Shot 10: use Frame A only.** Back to `Room / Area (titles this map)`, already reading `Basement Utility - Drywall`, framed so the `Material` / `Dry Goal (MC%)` row is below the bottom of frame. **In post: highlight only the characters before the hyphen.** | "And the front of the map title. Everything before the hyphen. Same eleven characters, three screens — and I'm going to show you what joins them." |
| **2:58–3:14**<br>*Shot 13 — SCREEN* | `📄 Full job packet (PDF)` at the bottom of job home → the packet route. Scroll through at reading speed. Three separate sheets go by, each carrying `Basement Utility` in a different place. **The white chip is still in the corner. On the last sheet, it drops off.** Then hold two seconds on a still packet page. | "Nothing. That's the answer. Nothing joins them. There's no room record in the app, no ID, no link — the spelling *is* the link, and the only thing checking it is whoever reads the packet. Which is us, if we're lucky, and the adjuster if we're not." |
| **3:14–3:24**<br>*Shot 14A — SCREEN* | Job home. The completeness panel at the top. **It is RED, and that is correct — do not try to make it green.** A green panel means zero hard gaps *and* zero soft gaps (`summaryLine`, `completeness.js:235–239`), and a panel in that state has **no checklist at all**: `panelModel` builds `groups` only from `hardGaps` and `softGaps` (`completeness.js:252–258`) and `completenessPanel` wires `foldable()` only when `m.groups.length` (`app.js:682–685`). There is nothing to unfold on a complete job. The training job reads **`Not yet billable — N required item(s) missing.`** with the `x/y` count on the right, and the checklist under `Required — blocks billing` is **already open** — `foldable(head, body, "completeness", false)` defaults to expanded (`app.js:684`, `isFolded` at `:637`). **Check it is expanded before you roll**; the fold state is remembered per device in `localStorage`, so a previous session may have collapsed it. Hold three seconds on the panel with the count legible. **Take a screenshot here — this is the baseline for the A/B and you get one clean pass.** | "Two controls in this app will invent a room behind your back. This panel is the job's own scorecard. Read the count on the right, and remember it." |
| **3:24–3:41**<br>*Shot 14B — SCREEN* | **Two halves, and the order is the shot.**<br>**Half 1 — the panel line.** `📦 Contents` tile → tap **`+ Add item`**. It writes the item and jumps straight into it. **Touch nothing in the editor.** Tap **← Back**, then **← Back** again to job home. The `x/y` denominator has gone **up by two**, the header's missing count has gone **up by one**, and exactly **ONE** new line has appeared under `Required — blocks billing`: **`Contents: Room on each contents item`**. Hold on it. **Burn that string in exactly as shown, with the `Contents: ` prefix** — the panel renders every row as `${g.formLabel}: ${g.label}` (`completeness.js:255`, `FORM_LABELS.contents = "Contents"` at `:188`). **There is no `Disposition` line**, because `newContentsItem()` pre-fills `disposition: "salvageable"` (`model.js:277`) and the gate only checks that the field is filled (`completeness.js:125–126`).<br>**Half 2 — the invented room, which 14C needs.** Back into the item → scroll to **`Room`** — the select. Open it. The last option is **`➕ New room…`**. Tap it. The iOS prompt appears: *"Room name (e.g. Kitchen, Master Bedroom)"*. **Type `Utilty Rm` — a deliberate misspelling, off-card — and tap OK.** *(Do NOT cancel: cancelling writes nothing at all — `if (!name) return null;` sits before the push, `app.js:1995–1997` — and leaves 14C with nothing to reveal.)*<br>⚠ **Do not merge the halves, and do not shoot half 2 first.** Completing that prompt **answers `ct_room` for you**: it sets `item.room = name` (`app.js:1998`) and `addableSelect` then calls `onPick(added)`, which sets it again (`app.js:1979` → `:1992`). The `Contents: Room on each contents item` line disappears the moment you tap OK, the missing count drops back, and there is nothing left to burn in. **Film the line, then invent the room.** | "Contents. To reach that `➕ New room…` you had to tap `+ Add item` — and that wrote a nameless contents item the second you touched it. Watch the count. Two new billing requirements, on a job with no contents — and one of them the app already answered for you. It decided this thing is salvageable. Nobody looked at it.<br><br>*(No narration over half 2. The prompt and the typing carry themselves, and 14C's first line lands on the name.)*" |
| **3:41–3:51**<br>*Shot 14C — SCREEN* | Back into the item → red **`Delete`** in the sticky bar → confirm **"Delete this item?"** → **`Item deleted`** toast. **Cut to job home: the panel is back to the exact baseline from 14A — same lines, same `x/y`, same missing count.** Cut the 14A screenshot in beside it for two seconds if you want the compare to land. **Then back to the Contents screen and open the `All rooms` filter dropdown. `Utilty Rm` is still in the list.** Hold on it four seconds. | "Delete it, confirm — and the panel goes back exactly where it started. The app says you undid it. Now open the room filter. You didn't. That name is on this job forever." |
| **3:51–4:01**<br>*Shot 14D — SCREEN* | Contents screen, the button row. Hold on **`✨ Scan room photo`**. Tap it once. The toast fires: *"No connection — AI needs internet. Your typed entries are saved."* Hold on the toast. **See production note — this is Option A.**<br>⚠ **FORCE-QUIT THE PWA FROM THE APP SWITCHER AND RELAUNCH IT FROM THE HOME SCREEN ICON, WITH AIRPLANE MODE ALREADY ON, IMMEDIATELY BEFORE YOU ROLL THIS SHOT.** Airplane Mode alone does **not** guarantee the toast. `✨ Scan room photo` runs `if (aiAvailable()) scanInput.click();` (`app.js:2061`), and `aiAvailable()` only toasts when `likelyOffline()` is true (`officeai.js:31`) — which means *the flag says offline **and** nothing has succeeded in the last five minutes* (`core.js:53–56`; `NET_PROOF_MS` is 5 minutes and `lastNetOk` is a module-level variable reset **only on page load**). This session signs in and pulls the job online at the top of the day, so inside that five-minute window the gate passes, **the OS photo picker opens and a real AI call starts** — Option B's outcome, uninvited, with real contents items to delete and permanent invented rooms that break 14C. The relaunch resets the clock to zero and makes the toast deterministic. **This is the same trap and the same fix as M8 beat H1**, which sits behind the identical gate in `voice.js:109`. | "Second one. `✨ Scan room photo`. It reads a photo, lists what it sees, and there's a room box on that panel — whatever you put there gets pushed onto the job's room list and turned into contents items. Anything it names is something to correct, not something to adopt. The card is the list." |
| **4:01–4:14**<br>*Shot 15 — CAMERA* | Back at the panel door, card taped inside, door open, wide. You point at it once. No hands in pockets, no smiling wrap-up. Cut hard to black on the last word. **No end card, no logo.** | "One thing out of this: **the card in the panel door is the room list, and the spelling is the only thing linking your photos to your machines to your map.** Day one of your next job — write the card, tape it in the door, and text me a picture of it. That's the check. Then whoever runs visit two has to find every room off your card without calling you. If they call you, we fix the card, not the tech." |


**Why the cold open carries no number.** It used to open on `729 photos · 67 with a room · 9%`, spoken and burned in. M1's hard production rule 1 binds every module in this course — *no production counts on screen or in the narration* — and §4.7 burns captions in, so a lower-third cannot be corrected later without a re-edit. Worse, the number is self-defeating: the first job where this rule works makes it wrong. The header and the length of the scroll carry the beat, and they will still be true in a year. **If anyone asks for the figure back, the answer is the SOP's §2 evidence block, in writing, not on camera.**

#### Shot list
1. **Shot 1** — SCREEN, iPad portrait. Job Photos sorted `Room, then Before → After`, **page pre-scrolled to the BOTTOM** (roomless photos sink to the end), held on the uppercase `NO ROOM SET` group header, slow scroll. **8s**
2. **Shot 2** — SCREEN (same take continues). Scroll until the grid runs out, hold two seconds on the empty space. **No lower-third, no count.** **10s**
3. **Shot 3** — CAMERA, waist-up, shop. You holding a blank index card and a Sharpie, direct to lens, stating the deliverable and the runtime. **13s**
4. **Shot 4** — CAMERA, over-the-shoulder, panel door, jacket on, unheated bay. You write the five-line room list on the card in real time, no cutaway. **14s**
5. **Shot 5** — CAMERA, tight on hands. Card taped inside the panel door with two strips of gaffer/duct tape; door closed, reopened; rack focus door→card. **15s**
6. **Shot 5B** — CAMERA, insert, **optional but shoot it**. Shop lights off, headlamp only, open panel door, card legible; doubles as the §12.1 legibility test. **4s**
7. **Shot 6** — CAMERA, overhead gooseneck. Card flat on the tailgate with a static post graphic of the grammar and the seven Level words. **16s**
8. **Shot 7** — CAMERA, overhead continues. Finger tracing clockwise over a crude hand-drawn plan graphic with bedrooms 1/2/3. **12s**
9. **Shot 8** — CAMERA, direct, card in hand. The "you already keep this one" turn. **10s**
10. **Shot 9** — SCREEN, two parts on one recording. (a) Drying Log equipment table, **pre-scrolled so `Asset #` is off the left edge**: type `Basement Utility` into `Room / Location`, then one deliberate space; post zoom on the caret. (b) Cut to Job Photos: the two pre-built photos, one spelled with a trailing space, sitting under **one** header. Hold three seconds. **24s**
11. **Shot 10** — SCREEN, moisture map, **two frames, R2 framing rule**. Frame A (Dry Goal below frame): `Room / Area (titles this map)`, type `Basement Drywall`. Scroll to Frame B (Dry Goal above frame): both captions painted, the second reading `Basement Drywall — Equipment`. Scroll back, retype `Basement Utility - Drywall`, scroll down, both repaint. **18s**
12. **Shot 11** — CAMERA, direct, three fingers up. **6s**
13. **Shot 12A** — SCREEN, montage cut 1. Job Photos card, the unlabeled grey `Room / location` input, type `Basement Utility`, `✓ Saved` pill flickers; persistent white chip added in post. **14s**
14. **Shot 12B** — SCREEN, montage cut 2. Equipment table (Asset # still off-frame), Room / Location cell on row 2, textarea grows as it fills. **10s**
15. **Shot 12C** — SCREEN, montage cut 3. Back to the map title, **Frame A only (R2 framing rule)**, post-highlight only the characters before the hyphen. **8s**
16. **Shot 13** — SCREEN, `📄 Full job packet (PDF)` → packet route, scroll three sheets at reading speed; the corner chip drops off on the last sheet. **16s**
17. **Shot 14A** — SCREEN, job home completeness panel, **RED — `Not yet billable — N required item(s) missing.` with the checklist already expanded** (a green panel has no checklist to unfold). Confirm it is expanded before the take. Take a still screenshot here, **one clean pass only**. **10s**
18. **Shot 14B** — SCREEN, **two halves in this order and no other**. (a) `📦 Contents` → `+ Add item` → the editor opens — **touch nothing** → Back, Back → job home: denominator **+2**, missing count **+1**, and **one** new line under `Required — blocks billing` reading **`Contents: Room on each contents item`**; hold on it. (b) Back into the item → `Room` select → `➕ New room…` → iOS prompt → **type `Utilty Rm` and tap OK (do NOT cancel)**. ⚠ **(b) satisfies `ct_room` and deletes the line (a) exists to film** (`app.js:1998`, `:1979`→`:1992`) — never shoot them the other way round. **17s**
19. **Shot 14C** — SCREEN. Item `Delete` → `Delete this item?` confirm → `Item deleted` toast → job home, panel back to the 14A baseline exactly → Contents → open the `All rooms` filter, **`Utilty Rm` is still there**, hold. **10s**
20. **Shot 14D** — SCREEN. Hold on `✨ Scan room photo`, tap once, offline toast. ⚠ **Force-quit and relaunch the PWA from the Home Screen icon with Airplane Mode already on, immediately before rolling** — Airplane Mode alone does not fire the toast inside five minutes of the last successful request, and a tap that gets past the gate opens the photo picker and starts a real AI call. **10s**
21. **Shot 15** — CAMERA, wide, panel door open with the card taped inside. The close and the assessment; hard cut to black, no end card. **13s**

#### Props and setup

- **THE THROWAWAY JOB** — `TRAINING — DO NOT BILL`, built once before §4.5 session 8 (the screen block). It must carry: **at least 14 photos, of which 10 stay permanently roomless** (Shots 1–2 need a scroll that runs out on camera, and Shot 12A consumes one); **two of the roomed photos spelled `Basement Utility` and `Basement Utility ` — the second one with a trailing space, typed in the build, not on camera** (Shot 9b); one moisture map with a Material set; one Drying Log with at least 3 equipment rows already typed; **zero contents items** (this is the 14A baseline — an empty `contents` array is what keeps `ct_room`/`ct_disp` out of the matrix, `completeness.js:43`). ⚠ **Do NOT try to make the completeness panel green.** Green requires clearing every hard gate *and* every soft one — Work Authorization signature, owner name and date; a before, an after and a during photo; a caption on every photo; Labor Log crew member and hours; the full water block (floor plan, material, dry goal, a dated reading, four psychrometric values, equipment type/location/placed/removed, grain depression); and all three Certificate of Drying gates — and a job in that state has **no checklist to film** (`completeness.js:252–258`). The module is scripted on the RED panel and the A/B is a count, not a colour. ⚠ `+ New Job` does not always create a new job — see §4.4.
- **STAGED PANEL DOOR** — a real electrical panel door, or any hinged metal door or plywood stand-in that can be opened and closed on camera and photographs like a panel.
- **ROOM CARDS — a stack of them, not one.** Rite-in-the-Rain index cards or offcuts of the field-card stock. You rewrite the card for every retake of Shot 4, and the whole module hinges on this prop being legible by headlamp (**test it in Shot 5B before §4.5 session 4, the prop/camera block**).
- **FINE-TIP PERMANENT MARKER** for the card. Not an oil-based paint pen — that is the material-marking tool from §3.4 and it bleeds on card stock. Not a fat Sharpie — five lines will not fit legibly.
- **GAFFER OR DUCT TAPE.** Explicitly **not** blue painter's tape — §3.4 bans it for humidity release and the script calls that out on camera. A visible roll of blue tape in frame would undercut the line.
- **iPad** — standalone PWA from the Home Screen icon, signed in and the training job pulled **before** Airplane Mode goes on. Airplane Mode on for every take. Auto-Lock Never, DND on, keyboard clicks off, battery >60%, Screen Recording with microphone **ON**-check per take (this module records silent, so confirm it is **OFF**).
- **DEPLOY FREEZE** on `main` for the whole shoot day.
- **PHONE + FLEXIBLE TRIPOD** for Shots 3, 8, 11, 15 — you cannot hold the camera and write the card at the same time. Locked exposure and focus on every take; wipe the lens after every cold-to-warm move.
- **OVERHEAD GOOSENECK PHONE STAND** for Shots 6 and 7.
- **HEADLAMP** for Shot 5B — the crew's own, not a fresh one.
- **WHITE FOAM BOARD** as a bounce for the tailgate inserts.
- **JACKET for Shot 4** — the card gets written cold, on site, and the shot has to look like it. Shoot in the unheated bay or just outside the roll-up.
- **NO EQUIPMENT NEEDED.** This is the only every-tech module that requires no air mover, no dehu, no meter and no wet panel. It can be shot on a day the fleet is out.
- **POST GRAPHICS (3, all static, no animation):** the grammar line + seven Level words (Shot 6); the crude hand-drawn clockwise plan (Shot 7); the persistent white `Basement Utility` corner chip spanning Shots 12A–13. **The `729 · 67 · 9%` lower-third is deleted** — M1's hard rule 1 bans production counts on screen, §4.7 burns captions in so it could not be fixed later, and the cold open is stronger without it.
- **ONE BURNED-IN PANEL LINE (Shot 14B half 1), and it must be character-exact:** `Contents: Room on each contents item`. The panel renders `${g.formLabel}: ${g.label}` (`completeness.js:255`), so the `Contents: ` prefix is on screen. Do not reproduce it as a bare label, and do not add a `Disposition` line — it does not appear. ⚠ **That line is on screen only in the window between `+ Add item` and the `➕ New room…` prompt.** Completing the prompt fills `item.room` and the line goes; shoot half 1 before half 2.

#### Production notes

**Shot 14 — the one beat with an online/offline choice.** `✨ Scan room photo` calls `aiAvailable()` (`officeai.js:28–36`), which needs the cloud backend configured, a signed-in session, **and** a connection the app believes is down. ⚠ **That last condition is not "Airplane Mode is on."** `aiAvailable()` asks `likelyOffline()` (`officeai.js:31`), which is *the flag says offline **and** nothing has succeeded in the last five minutes* (`core.js:53–56`, `NET_PROOF_MS` = 5 min, `lastNetOk` reset only on page load). **Option A is only Option A after a force-quit and relaunch under Airplane Mode** — without it, a tap inside that five-minute window falls through to `scanInput.click()` (`app.js:2061`) and you are in Option B whether you chose it or not.

- **Option A (recommended, scripted above).** Film in Airplane Mode, **after force-quitting and relaunching the PWA from the Home Screen icon**. You get the button, the tap, and the toast. 10 seconds, zero risk, no AI spend, no contents items created, and it doubles as an honest offline beat. The narration describes the panel without showing it, which is enough — the module's job is "here is the button, don't tap it," and a picture of the button is a picture.
- **Option B (only if you want the panel on screen).** Wi-Fi on, signed in, one staged photo of a shelf of junk. Costs a real AI call, produces real contents items you must then delete one at a time (each with its own confirm), and leaves invented rooms permanently on the throwaway job's room list — which breaks Shot 14C's clean reveal if you shoot 14D first. **If you shoot Option B it must come after 14C, and the throwaway job is burnt for this module afterward.** Budget 25 seconds of screen time and 15 minutes of cleanup.

**Shot order is forced, and Shot 14 is a one-way ratchet.**

1. **Shots 1–2 (cold open) first**, while the throwaway job still has roomless photos. Once you type `Basement Utility` into a photo in Shot 12A, that photo leaves the `NO ROOM SET` group and you cannot get it back without clearing the field. **Keep at least ten photos permanently roomless and never touch them** — the same ten the props list calls for, so the scroll in Shots 1–2 runs long enough to run out on camera.
2. **Shots 9, 10, 12A–C, 13** in the middle. These are reversible — you can clear a text box.
3. **Shots 14A–D last, and 14B is the one-way write.** `+ Add item` writes a contents item and saves it immediately (`app.js:2185–2191`), which pulls `ct_room` and `ct_disp` into the matrix (`completeness.js:43`, `:123–126`). **The panel does not flip colour — it is red before and red after.** What changes is countable: the `x/y` denominator goes **up by 2**, the header's missing count goes **up by 1**, and one line appears. **Screenshot the panel in 14A before you tap anything; that still IS the A/B.** ⚠ **The +1 and the line exist only while the fresh item's `room` is still `""`** (`newContentsItem()` sets `room: ""`, `model.js:275`, while `disposition` is pre-filled `"salvageable"` at `:277`). Completing the `➕ New room…` prompt writes `item.room` twice over — `item.room = name` at `app.js:1998`, then `addableSelect`'s `onPick` at `app.js:1979`→`:1992` — so `ct_room` passes and the line is gone. **14B is therefore two halves: cut to job home and film the line first, then go back in and invent the room for 14C.** A retake of 14B is cheap for the panel (delete the item, confirm, and the panel returns to the exact baseline) and **not cheap for the room list**: every take of 14B adds another permanent name to `project.rooms`, because `deleteItem` tombstones the item and splices it out of `contents` but never touches `rooms` (`app.js:2293–2300`). **Use a different misspelling on each take** (`Utilty Rm`, `Utility Room 2`, …) so the take you keep has an unambiguous target to point at, and expect the filter list in 14C to grow with every retake. Nothing in the app removes them, so once this module wraps, that job's room list is scrap — which is exactly why it is the throwaway job.

**Autocorrect.** iOS autocorrect and autocapitalize are on — nothing in the app sets `autocapitalize` or `autocorrect` on any of these fields (verified: zero occurrences across `apps/field/js`). Watch what the keyboard did to `Crawl North Bay` before you move on. Worth one improvised line if it visibly happens on camera — it is a real field hazard and free footage.

**Audio.** Screen record silent. All narration in the truck cab, one file: `M4-room-card-VO.m4a`. Shots 3, 8, 11 and 15 are you on camera, and your lips are only readable in 15. **If you want lip-sync on Shot 15 only, that is the one place the lav earns itself in this module; everywhere else the cab VO is better.**

#### Cold, wet, gloved — what this module honestly needs

Almost nothing. Room naming is a warm-hands, dry-card job by design, and pretending otherwise would be dishonest in the other direction. **Two things are genuinely cold and should not be filmed in a clean warm shop as though they weren't:**

- **The card gets written in the house, on the first visit, often before the heat is on.** Shoot Shot 4 in a jacket, breath visible if you can get it, in the unheated part of the shop or just outside the roll-up with the door open. Twenty seconds of discomfort on camera buys the rule its credibility. **Do not shoot it at a desk.**
- **The card gets read by headlamp.** Shoot Shot 5B: shop lights off, headlamp only, open panel door, card legible. That is the actual viewing condition, and it is also the five-minute legibility test §12.1 already calls for. **If block caps in fine Sharpie are not readable in that frame, the card stock or the pen is wrong and this module's central prop needs changing before you film anything else.** Run this test before §4.5 session 4, not during it.

#### What would force a reshoot

Not the six rulings — none of them touch this module. Three other things would:

1. **The trailing-space reason — now settled in the script, still open in the SOP.** Shot 9's narration no longer blames the type column (that was also false — `narrative.js:62` trims the type and `dryingcalc.js:155–160` lowercases and pattern-matches it). It now demonstrates the app forgiving a trailing space on camera and gives the real reason: there is no room record, so the spelling is the only link. **That version is defensible and needs no ruling to film.** What still needs a decision is whether **§3.1 of the SOP gets corrected to match** — the video and the SOP giving different reasons for the same rule is worse than either alone, and a tech who reads both will trust neither. **This is not a 22-second VO preference decided in post. Decide it before §4.5 session 9 (VO), and if the answer is "correct the SOP", the SOP edit ships with the video.**
2. **A ruling that the room card gets photographed into the job** (see open questions). That adds a 12-second insert after Shot 5 and one line of VO. Additive, not a reshoot.
3. **The room manager shipping** (§12.6 — "A room list on the job, with a picker on map Room/Area, photo Room and equipment Location", Medium). **That retires this module outright**, along with roughly half of what §3.1 asks a human to enforce by spelling. Do not treat this video as a long-lived asset; treat it as the thing that holds the line until that ships.

#### Assessment

Two checks, both riding on work that already had to happen, neither costing more than fifteen seconds.

**CHECK 1 — THE CARD PHOTO** *(stated on camera in Shot 15)*. On day 1 of the tech's next job, they text you one photo of the room card taped inside the panel door, door open. **Pass** = the card exists, it is taped in the door (not in a truck, not in a notebook), every line starts with one of the seven Level words, no line contains a material, no line has a trailing character, and repeated rooms are numbered. **Fail** = any of those, and the fix is a two-minute phone call on day 1 when a rename is still free — never on day 5, when §3.1's *never rename a room after day 1* has already bitten. Judging it takes fifteen seconds and it proves the physical act, the grammar and the placement in one frame.

**CHECK 2 — THE BUDDY CHECK.** This is the real assessment, and it is §12.3's ride-along given a pass/fail. Whoever set the job up does not do visit 2. Visit 2's tech must find every room and fill every Room box from the card alone. **Pass** = they never call the setup tech. **Fail** = one phone call, and the card gets rewritten on the spot by the person who found it wrong. This is the only honest test of the module, because what is being tested is whether the spelling is readable **by someone else**, and no self-check can measure that. Costs you zero time.

**What is not a check:** do not quiz the seven Level words, and do not have anyone recite the three rules. Both produce recognition, which feels like learning and is not. The room card either exists in the panel door or it does not, and the second tech either found the rooms or phoned a friend.

#### Open questions — M4

1. **Does §3.1 get corrected in the SOP to match the video?** §14 already flags that §3.1's stated consequence is wrong, and I re-confirmed it in code: `narrative.js:69` trims equipment locations, **`narrative.js:47`** trims the map area name (`narrative.js:26` is a `const FN_URL` assignment — an earlier draft cited it twice, and it was wrong both times), `forms.js:427` trims the label before the caption paints, `forms.js:2015` and `2021–2025` trim, collapse whitespace and case-fold photo rooms, `forms.js:1266` trims the invoice room key. **Nothing splits on a trailing space today, in any column — including the type column** (`narrative.js:62`, `dryingcalc.js:155–160`). Shot 9 now films that fact rather than asserting a mechanism, so the module is not blocked on this. **What is open is the document:** if §3.1 keeps its current wording, the SOP and the video contradict each other on a rule the crew is being asked to keep on faith. Decide before §4.5 session 9 (VO).
2. **Does the room card get photographed into the job?** §8's shot list does not include it. But the card is the only copy of the room list, it lives on a piece of paper inside a panel door in a house we hand back, and the app has no room record at all — so when the card comes down, the list is gone and the packet has no artifact of what the rooms were called. A day-1 photo (Room = the first room off the card, Stage = Before, caption in the §8 format) would put the list inside the packet permanently for the cost of one shot. **I did not script this as a rule because it is not in the SOP and I will not put an invented rule on camera.** If you rule yes, it is a 12-second insert after Shot 5 plus one VO line, shootable in the same session — say so before §4.5 session 4.
3. **The card medium and the tape are unspecified.** §3.1 says "a card taped inside the electrical panel door" and stops. §3.4 bans blue painter's tape on materials because it releases in high humidity and cold — and a panel door on a job with a dehu running is exactly that environment. I extended the ban to the card tape (gaffer/duct) and specified card stock and a fine-tip permanent marker, because the module cannot be filmed without deciding, and a card that falls behind the panel loses the job's only room list. **All three are my call, not the SOP's.** If you disagree on any of them, Shots 4 and 5 reshoot — 30 seconds of screen time and about 20 minutes of §4.5 session 4, so it is cheap, but it is cheaper to rule before the day.
4. **Leonard is not covered by this module and it should not pretend he is.** Everything after Shot 8 is a screen recording of a tablet app. The half he does need — the card, the seven Level words, the clockwise numbering, no material in a room name — is Shots 3 through 8, which is **68 seconds and contains no screen at all**. Recommend cutting exactly that span as a standalone in-person talking point for the shop day, plus a printed room-card exemplar at actual size, and **not** sending him a link. His room names still have to reach the tablet, which means the transcriber types them off his paper — so **§10.2's transcriber is the person who actually needs the app half of this module, and they are not currently in the every-tech track.** That is a course-design gap, not a script gap, but it surfaced here and someone should own it. See §6.
5. **How many rooms can a card hold?** §3.1 gives the grammar but no cap, and §3.2 needs one map per room **and** per material — so an eight-room job with two materials in three of them is eleven maps, and §13 notes there is no way to add today's date to every map at once. The card is not the constraint; the map count is. Nothing in this module breaks, but a tech who writes a fourteen-room card on day 1 has committed to a monitoring visit this SOP has not time-budgeted. Worth a sentence somewhere in the course — probably M9, not here.
6. **The permanent invented room — now the spine of Shot 14C, and it belongs in §13's gap table.** Deleting a contents item (`app.js:2293–2300`) tombstones it and splices it out of `project.contents` but **nothing anywhere removes the name from `project.rooms`**. An invented room is permanent on that job. The earlier draft of 14C tried to reveal this after *cancelling* the `➕ New room…` prompt, which writes nothing at all (`app.js:1995–1997`) — there was no room to reveal, and the beat would have died on camera. It now completes the prompt, which both makes the reveal real and demonstrates the actual hazard rather than a hypothetical one. **`project.rooms` currently has exactly two writers** — the `➕ New room…` prompt (`app.js:1997`) and the AI room scan (`app.js:2090`) — **two readers, both dropdowns** (the item's Room select at `app.js:1991`, the `All rooms` filter at `app.js:2148`), **no reader that prints, and no delete path.** So the damage is not to the packet; it is that the app's only room list is fed exclusively by the two mechanisms this module tells the crew not to use, and it cannot be cleaned. **Add it to §13's gap table, and hand it to whoever builds the room manager (§12.6) — a room manager that ships without a delete path inherits every phantom room in the file.**

---

### M5 — "Six taps that cost money"

**Track:** every tech · **Runtime:** 8:05 · **SOP:** §3.3, §4.8, §5.5, §6.2, §6.3, §7.1
**Position:** fifth in the every-tech track — after M1, after the equipment strings, after the room card. Hazards are learned by watching damage, and damage only means something once the viewer knows what an intact job looks like.
**Status: CLEAR TO FILM — every screen beat; one paper insert is R2-contaminated.**

All twenty-seven screen and camera beats are clear of all six rulings and can be shot in the first session. (The shot list has thirty-two items: four of them — 5, 9, 27 and 31 — are cards built at edit, not takes, and §4.5 session 6 names them as such.) **The one exception is the closing paper insert, shot 32 (K-end)**, which puts the printed field card on camera. The card's **NEVER** block carries the line `Material FIRST, goal = CONTROL + 2, BARE NUMBER ONLY` — that is **R2** (SOP §12.0.2), it is not ruled, and SOP §12.0 holds the card back from the laminator until R1–R4 land. K-end is therefore framed off that line, shot as a **separate insert** under §2.2, and cut in at edit. The module publishes without it. See beat **K** and shot **32**.

**Shoot time:** 2h15m for the tablet session (screen recording, one iPad, one desk), plus 25 min of voice-over in the truck on a later day. Editing 3–4 hours. **Retakes are expensive on this module specifically** — see the retake economics table. Budget the 2h15m as a real 2h15m, not an optimistic 90 minutes.

> **⚠ SPLIT POINT (see §3.1).** At 8:05 this is nearly double the design ceiling. It splits cleanly at its own beat lettering:
> - **M5a — the moisture-map three** (beats A–F, plus the closing card): `↺ Clear drawing`, `+ Add locations 14–26`, the row `✕`. **3:44.**
> - **M5b — the log four** (beats G–K): the second Drying Log, the fill handle, Material, and the seventh — the blank psychrometric pair. **4:21.**
>
> Splitting costs one extra edit and one extra 12-second bridge. **Recommended.** Everything below is unchanged by it.

#### Status block

**No owner ruling blocks any beat that happens on the tablet**, and that is deliberate: every beat was chosen or re-staged so it demonstrates **app behaviour** rather than **company policy**. But it runs directly alongside three open rulings and the narration crosses into them if a single sentence drifts.

> **⚠ ONE EXCEPTION, AND IT IS THE LAST FRAME OF THE MODULE.** Shot 32 (K-end) is the printed field card. Its **NEVER** block contains `Material FIRST, goal = CONTROL + 2, BARE NUMBER ONLY` — **R2**, unruled (SOP §12.0.2). Tripwire T2 below bans that sentence from the voice-over; putting it on screen in legible type is the same leak with a longer shelf life. **K-end is framed on the card's FILL DOWN paragraph only** (see beat K), shot as a standalone insert, and cut in at edit. If R2 goes the other way and the card is reprinted, **only that insert reshoots — not the module.**

**Three narration tripwires. If you ad-lib past any of these on the day, that beat has to be reshot after the §12.0 evening.**

| # | Ruling at risk | Banned on camera | Say this instead |
|---|---|---|---|
| **T1** | **R1** asset-tag format | Any prefixed tag on screen or in the voice-over — no `AM-014`, no `DH-003`, no "our new tag format." | The demo drags from a bare **`101`**, a real historical value out of §1. Narration: *"whatever a tag looks like, this handle grabs the digits on the end of it and counts up."* True of any format — verified in `bumpAsset()`, `forms.js:643`, regex `^(.*?)(\d+)(\D*)$`. |
| **T2** | **R2** the dry-goal rule | Anything about where a correct dry goal comes from. No "control plus two." No "the table value." No "9.5 is the right number because…" | The number is **"the number that was in that box."** Say it out loud once: *"where that number comes from is the next module. This one is only about the app throwing it away."* |
| **T3** | **R4** grain depression | Any judgement on a negative GD. No "negative is fine," no "negative means trouble." | Name only the mechanism: *"the app filled in a number for air nobody measured, and then subtracted it."* Point at the **`0`** in the GPP column, not at the minus sign. |

#### Rig and settings — the six that kill takes

1. **Launch from the Home Screen icon, never a Safari tab.** A tab take and a standalone take will not intercut.
2. **Auto-Lock → Never.** A lock mid-take kills the take and can kill a stamped-but-uncommitted sketch stroke.
3. **Focus / DND ON.** Charge above 60% — a low battery on screen undercuts every other module.
4. **AIRPLANE MODE for every take in this module.** Non-negotiable here. See §4.3. **Freeze deploys on shoot day.**
5. **Screen Recording microphone OFF.** All narration is recorded separately. Recording silent means a wrong word costs a sentence, not a 90-second screen take.
6. **Set the iPad clock to the shoot date and leave it.** Three beats print today's date on screen.

#### The demo job — build it ONCE, then protect it

Customer name **`TRAINING - DO NOT BILL`**. Never a real customer's name, address, claim number or interior.

> ⚠ **`createProject()` does not always make a new job** — it reuses any existing blank unarchived job of the current mode. Build the training job once and never tap `+ New Job` again during the shoot.

**State to build before the camera rolls:**

| Where | Set it to |
|---|---|
| Moisture Map — one map | Room / Area: `Basement Utility - Drywall` · Meter / Setting: any preset · **Material: `Other / Generic (≤ 16%)`** · **Dry Goal (MC%): `9.5`** (typed by hand, bare number) |
| That map's sketch | Floor plan imported FIRST, then markers **1, 2, 3, 4** stamped with `①  Number`. Counter therefore sits at 5. |
| That map's grid, row 1 (dated 09/02) | Notes: `BR. 1=CONTROL unaff Main Hall gyp; 2=N wall 12in AFF; 3=N wall 48in AFF; 4=E wall 12in AFF; cols 5-13 unused` — values `8.2 / 14.1 / 17.6 / 12.4` |
| That map's grid, row 2 (dated 09/04) | Values `8.0 / 13.4 / 16.9 / 11.8`, Notes `BR.` |
| Drying Log — ONE log | Edit its first psychro row's **Date** to **09/02** so the list row reads `Drying log — Sep 2, 2026` |
| That log's equipment table | Row 1: Asset `101`, Type `Air mover`, Room `Basement Utility`, Placed `09/02 14:30`, Removed **blank**, Hrs blank. **Rows 2–8 added and left entirely blank** (the beat A / H2 crop). **Rows 9–12 added with Placed `09/02 14:30` only** — Removed and Hrs blank. That is eleven taps of `+ Add equipment`, and rows 9–12 are what beat H3's A/B needs |
| That log's psychro table, row 2 (dated 09/04) | Affected `78` / `31` typed. **Unaffected T and RH left blank.** Outside `-22` / `60`. Notes `Basement Utility` |

**Verified numbers you will see on screen** (computed from `gpp()`, `core.js:705`): 78°F/31% = **44** GPP · 70°F/34% = **37** GPP · −22°F/60% = **1** GPP · blank/blank = **0** GPP. GD with the reference filled = **−7**. GD with it blank = **−44**.

#### The production discovery that shapes three beats

**The `DRYING LOG` letterhead is `print-only`.** `letterhead()` (`formkit.js:290`) carries class `print-only`, and `app.css:599` sets `.print-only { display: none }` on screen. The job packet page is not wrapped in `.packet-preview`, so **the two split DRYING LOG title blocks are invisible on the packet page on screen.**

Every "here is what the carrier gets" beat therefore has to be filmed in the **iOS print preview** — tap `⬇ Save packet as PDF`, let `window.print()` open the AirPrint sheet, and shoot the paginated thumbnails. This works offline. Rehearse the pinch-to-full-page gesture on a thumbnail once before rolling; it is the only awkward gesture in the module.

#### The shooting script

Lower-third cards: navy `#0f1b2d` bar, bottom-left, white condensed caps, tall enough to read on a phone at arm's length. **Burned in** — this is watched offline, there are no captions to fall back on.

| # | TIME | VISUAL | AUDIO |
|---|---|---|---|
| **A** | **0:00–0:12** | **COLD OPEN. No title, no logo, no music.**<br>SCREEN, tight crop on the equipment table, rows 1–8 filling frame. Row 1 reads `101 · Air mover · Basement Utility · 09/02 14:30`. Rows 2–8 blank.<br>A thumb comes in from frame right, catches the small orange square at the bottom-right corner of the **Asset # cell** (`.fillh`, 13×13px, `app.css:415`) and drags straight down through row 8.<br>Rows highlight as they arm (`tr.fill-target`). Release.<br>Cut to a **200% zoom** on the Asset column: `101 102 103 104 105 106 107 108`. Toast: **"Filled 7 rows."**<br>Hold two full seconds on the eight numbers. | *(nothing under the drag — let the toast land first)*<br><br>Seven machines just got a tag.<br><br>Nobody read any of them off anything. |
| **B** | **0:12–0:32** | Cut to a **laptop screen**, desk lamp, over your shoulder. Four rows lifted out of four different job files, all showing asset `101`, typed four ways: `Air mover` · `Air mover  ` · `Axial Air Mover` · `Dehumidifier Dry-Eaze Xi7000`.<br>Your finger walks the column. Push in slowly.<br>**LOWER THIRD:** `4 JOBS · 1 ASSET NUMBER · 3 AIR MOVERS AND A DEHU` | That is where these came from. Four jobs, same number, and one of them is a dehumidifier.<br><br>Nobody did anything wrong in the field. A drag handle made four machines look like one machine, and now if an adjuster asks us which one `101` was, we cannot answer. Neither can I. |
| **C** | **0:32–0:52** | You to camera, shop, standing, iPad in one hand. Mid-shot, vertical.<br>Cut to a plain navy card, six lines, one per control, animated in as you name them:<br>`↺ Clear drawing`<br>`+ Add locations 14–26`<br>`✕ row delete`<br>`+ New`<br>`the fill handle`<br>`Material`<br>**LOWER THIRD:** `NONE OF THESE ASK "ARE YOU SURE?"` | Six controls in this app do damage the second your thumb lands. None of them asks you anything first. Five of them can't be undone.<br><br>You are not going to remember six warnings. You are going to remember what they look like — so I'm going to break something with each one, on camera, and you watch what happens.<br><br>Eight minutes. Two of them you can repair, and I'll show you how. |
| **D1** | **0:52–1:12** | **TAP 1.** SCREEN, moisture map editor, scrolled so the sketch canvas and the tool row are both in frame.<br>Camera reads the tool row left to right: `✋ Move` │ ■navy │ ■orange │ ■red │ ■green │ `①  Number` │ `↩ Undo` │ `↺ Clear drawing`.<br>Canvas shows the floor plan with orange markers **1 2 3 4**.<br>Freeze. A soft orange ring animates onto `↩ Undo`, then slides one button right onto `↺ Clear drawing`. Same size, same white ghost button, 38px tall.<br>**LOWER THIRD:** `TAP 1 — ↺ Clear drawing` | Undo, and next to it, Clear drawing. Same size, same colour, one gloved thumb apart, at the end of a row where your hand is already going.<br><br>Undo is the one you want. It's raster, it only holds thirty steps, and it's gone the second you leave this screen and come back — so it's not much of a safety net either. |
| **D2** | **1:12–1:36** | Freeze releases. Thumb enters, lands on **`↺ Clear drawing`**. **No dialog.**<br>Markers 1, 2, 3, 4 vanish in one frame. The floor plan stays. The reading grid stays. The Notes legend stays.<br>Hold three seconds on the empty plan — resist cutting.<br>Thumb taps **`↩ Undo`**. Nothing. Again. Nothing.<br>**LOWER THIRD:** `NO CONFIRM · NO UNDO · THE COUNTER WENT BACK TO 1` | *(silence over the tap — two full seconds)*<br><br>Gone. No dialog, no "are you sure," and it saved itself immediately.<br><br>Undo won't bring them back — clearing empties the undo stack too.<br><br>And it did one more thing you can't see. The number counter went back to one. |
| **D3** | **1:36–1:52** | Thumb taps **`①  Number`** — the button turns solid orange with white text. Thumb taps the canvas.<br>A marker appears reading **`1`**.<br>Cut to a split: left, the reading grid still carrying columns 1, 2, 3, 4 with numbers in them; right, the canvas with a single new marker `1`.<br>**LOWER THIRD:** `TWO POINT 1s. ONE OF THEM IS A LIE.` | Your next stamp is a **one**. There's already a one in that grid with a reading against it, and now there are two of them, in the same room, on the same material, and there is no way to tell them apart later.<br><br>A misplaced marker gets a paint-pen X on the material and a retire note in that day's Notes. It never gets cleared. |
| **E1** | **1:52–2:14** | **TAP 2.** SCREEN, same map, scrolled to the bottom of the reading grid.<br>The three-button row fills the frame: **`+ Add reading date`** and **`+ Add locations 14–26`** — identical white buttons, side by side, same height, same weight — and then **nothing** — the third button is not greyed out, it is absent: `[hidden] { display: none !important; }` (`app.css:603`) takes it out of the flex row entirely, so there is no gap to point at. `✕ Remove locations 14–26` is currently **hidden**.<br>Slow zoom until the two white buttons fill the frame.<br>**LOWER THIRD:** `THE ONE YOU TAP EVERY VISIT · THE ONE YOU MUST NEVER TAP` | These two live in the same row. Same size, same colour, same everything.<br><br>The left one you tap on every single visit, on every map. The right one you must never tap.<br><br>That's the design. I'm not going to pretend it's your fault when it goes wrong. |
| **E2** | **2:14–2:34** | Thumb taps **`+ Add locations 14–26`**. **No dialog.**<br>A second stacked table paints in below: thirteen more navy numbered headers, **14** through **26**, every cell empty. The date echoes as read-only text; no Notes column and no ✕ on this block.<br>The button row repaints: left button now reads `+ Add locations 27–39`, and a new red-text button appears — **`✕ Remove locations 14–26`**.<br>Cut to **iOS PRINT PREVIEW**. Pinch a Moisture Map page to full screen: thirteen filled navy headers, thirteen empty bordered boxes, on **every visit row**.<br>**LOWER THIRD:** `THIS IS THE CARRIER'S COPY` | Thirteen more columns. Empty.<br><br>Here's what the adjuster gets. Filled navy header, empty bordered box, on every row, on every date, for the life of the job.<br><br>He doesn't read that as a column we didn't need. He reads it as thirteen readings we didn't take. |
| **E3** | **2:34–2:56**<br>**REPAIR** | Back to the app. Thumb taps the red **`✕ Remove locations 14–26`**. **No dialog.** The thirteen columns vanish in one frame and the button row drops back to two.<br>Thumb taps **`+ Add locations 14–26`** again — the block returns, and the red button with it.<br>Thumb taps into **row 1, column 14** and types **`18.9`**. The cell flags **pink-red**.<br>Thumb taps **`✕ Remove locations 14–26`** a second time. **Now** an **iOS system alert** appears — centred, the site's domain in the header — reading: *"Locations 14–26 have readings — remove them anyway?"*<br>Thumb taps **OK**. Second table gone, and the `18.9` with it.<br>**LOWER THIRD (green):** `REPAIRABLE — DO IT BEFORE THE PACKET PRINTS` | This is the one that repairs. Red button, right next to the one that made the mess — **Remove locations 14 to 26.**<br><br>Empty, it just goes. No question.<br><br>Watch what it takes to make it ask. One number, in one of those thirteen columns — *now* it warns me. That's backwards from how you'd want it. The warning doesn't show up when you make the mistake. It shows up when you're fixing it, and what it's warning you about is that you're deleting your own readings.<br><br>Tap it the second you notice. It is only a repair while nothing has printed. |
| **F1** | **2:56–3:20** | **TAP 3.** SCREEN, moisture grid, two reading rows visible.<br>Camera pushes right along row 2 — past the date, past columns 1 through 13 — to the **✕** at the far right end (`.rowdel`, red, 36px cell).<br>Thumb lands. **No dialog.** The entire row — date, four readings, Notes — disappears in one frame.<br>Hold. One row left.<br>**LOWER THIRD:** `TAP 3 — THE ROW ✕ · NO CONFIRM` | A whole visit. Date, every number, the notes. One tap, no question asked.<br><br>Notice the difference: the button that deletes *columns* warns you. The button that deletes a *row* doesn't. Same screen. |
| **F2** | **3:20–3:44** | Camera slides up to **row 1** and stops on its **✕**. A red box draws around it. **The thumb does not touch it.**<br>Camera slides left along row 1 to its **Notes** cell — a horizontal scroll of the `.tablewrap`, deliberately slow, showing the swipe you have to make — revealing `BR. 1=CONTROL unaff Main Hall gyp; 2=N wall 12in AFF; … ; cols 5-13 unused; goal from control Loc 1 = 5.9 on 2026-09-06`. ⚠ **Build the props legend in SOP §3.5's full slot order** — initials, points, unused-columns note, dry-goal source — because slot 4 is mandatory on every map and this is the only frame in the library that shows a real one<br>**LOWER THIRD:** `ROW 1 NOTES = THE ONLY THING THAT NAMES YOUR POINTS` | I'm not tapping that one on camera, and you already know why.<br><br>Row one's Notes is the legend. It is the only place in this app where point two is a north wall at twelve inches instead of just the number two. That ✕ takes the legend with the readings, and nothing in the file remembers what any of those numbers meant.<br><br>The same ✕, with the same no-confirm, is on the equipment table and the psychrometric table. Slow hands near the right edge of a row. |
| **G1** | **3:44–4:08** | **TAP 4.** SCREEN. Job home → tile **`💧 Drying Log`** → the log list.<br>Header: `💧 Drying Log`, blue **`+ New`** button top-right — visibly the most prominent thing on screen. One row: **`Drying log — Sep 2, 2026`**, subtitle `Created Sep 2, 2026`.<br>Thumb hovers over the row, then moves up and taps **`+ New`**.<br>The app navigates straight into a fresh, empty editor. Back out to the list.<br>Two rows now: **`Drying log — Sep 2, 2026`** and **`Drying log — Sep 6, 2026`**.<br>**LOWER THIRD:** `TAP 4 — "+ New" · BOTH OF THESE LOOK RIGHT` | The brightest button on the screen, top right, and it is the wrong one every single time.<br><br>You want the row that's already there. Tap the row.<br><br>Now look at what you get. Two logs. The second one carries today's date, which is exactly the date you were looking for, so it looks like the right one. Nothing warns you. |
| **G2** | **4:08–4:32** | Cut to the **job packet page**. The `Include in this packet:` checklist is visible; the `💧 Drying Log` line now carries the count note **`2`**.<br>Tap **`⬇ Save packet as PDF`** → **iOS PRINT PREVIEW**.<br>Scrub the thumbnails: **two separate DRYING LOG sheets.** Pinch sheet 1 to full page — equipment rows, psychrometric rows, all the real work.<br>Pinch **sheet 2** to full page and hold. It is not blank. Its equipment table is one empty ruled row. Its psychrometric table is **one row carrying today's date**, every T and RH cell empty, and **`0` printed in all three GPP columns with `0` in the GD column**.<br>Push in on that row of zeros. Hold three seconds.<br>Cut back to job home: the **completeness panel**, red left border, `⚠️`, header beginning **`Not yet billable —`** (read the exact string off the screen). Pan the checklist slowly. Every line is prefixed with a form name — `Photo Log: …`, `Work Authorization: …`, `Labor Log: …`. **Nothing anywhere on it mentions a second Drying Log.**<br>**LOWER THIRD:** `TWO SHEETS · ONE IS A VISIT THAT NEVER HAPPENED` | And here it is on paper. Two DRYING LOG sheets for one job. Your equipment is on the first one; the second one carries a date.<br><br>Look at what it prints. Today's date. Zero grains outside, zero unaffected, zero affected, grain depression zero. Nobody took a reading. Nobody was in the building. The app wrote that the moment the log was created, and the packet prints it as a monitoring visit.<br><br>Now the completeness panel. It's red — but read what it's actually asking for. Photos. A signature. Hours. Not one line on there says you have two drying logs, and there never will be, because it goes green on *any* row in *any* log. It cannot see this.<br><br>One log per job. Every visit adds rows to it. Tap the row. |
> **Shooting notes for G2.** ① **Do not tap `🧮 Size the equipment` anywhere on this job.** The Recommended-vs-Deployed table only exists in the DOM when `d.equipCalc` is set (`forms.js:507–510`), the build never sets it, and a sizing table would put an unruled air-scrubber row (**R5**) on the carrier's copy. ② Before rolling the panel shot, check the chevron beside the header reads `▾`. The checklist is expanded by default (`app.js:684`) but the fold state persists in `localStorage` — if it reads `▸`, tap the header once. ③ The zeros on sheet 2 are computed at render, not stored, so they appear on the printout whether or not the log has ever been opened.

| # | TIME | VISUAL | AUDIO |
|---|---|---|---|
| **H1** | **4:32–4:50** | **TAP 5 — the payoff of the cold open.** SCREEN, equipment table. Reset to row 1 = `101 · Air mover · Basement Utility · 09/02 14:30`, rows 2–8 blank.<br>**200% ZOOM** on one cell's bottom-right corner: the orange `.fillh` square, 13 pixels, half-opacity. Hold it, then pull back to normal scale so the viewer sees how small it is in context.<br>**LOWER THIRD:** `TAP 5 — THE FILL HANDLE · 13 PIXELS` | That's it. Thirteen pixels, bottom right corner of every cell in this table.<br><br>You need it. Twenty air movers with gloves on and no fill handle is not a job anybody finishes. **Type, Room and Placed — drag those all day.**<br><br>Three columns you never touch it on. |
| **H2** | **4:50–5:16** | Repeat the cold-open drag, full width and unhurried: thumb catches row 1's **Asset** handle, drags to row 8, rows arm, release. Toast **"Filled 7 rows."**<br>Zoom: `101 102 103 104 105 106 107 108`.<br>**LOWER THIRD:** `NEVER FILL ASSET — IT COUNTS UP` | **Never Asset.** It doesn't copy the number, it counts up from it. One drag, seven tags that were never on a machine — and the next job's drag starts at the same numbers and makes seven more just like them.<br><br>Whatever a tag looks like, this handle grabs the digits on the end of it and adds one. Type every asset by hand. Every time. |
| **H3** | **5:16–5:44** | Type `09/06 09:15` into **row 2's** `Removed` — **not row 1's** — then drag its handle down to row 8. Rows 3–8 all stamp `09/06 09:15`. **Nothing else in the frame moves:** rows 2–8 carry no Placed, so every Hrs and Days cell in that crop stays empty, and row 1 is not touched at all.<br>Cut. Clear rows 2–8 by hand off camera.<br>**Now the A/B — rows 9 and 10**, framed together. Identical rows: both already carry Placed `09/02 14:30`, both have **Removed** and **Hrs** empty.<br>Type **`40`** into **row 9's Hrs**. Nothing else. Do not drag.<br>Type **`09/06 09:15`** into **row 9's Removed**. Its **Days** cell fills `4d`. Its **Hrs** cell **stays `40`.**<br>Type the same **`09/06 09:15`** into **row 10's Removed**. Its **Days** fills `4d` and its **Hrs** fills itself: **`91`**.<br>Hold four seconds on the two rows stacked — same Placed, same Removed, same `4d`, and `40` against `91`.<br>**LOWER THIRD:** `NEVER REMOVED · NEVER HRS · HRS IS FROZEN FOREVER` | **Never Removed.** That stamps a pickup time on machines that are still running in somebody's basement.<br><br>**Never Hrs.** Two rows, same machine, same two dates. I haven't dragged anything — I just *typed* forty into the top one.<br><br>Now the real pickup time goes on both. The bottom one works it out for itself: ninety-one hours. The top one sits at forty and will never move again. Days column says four days on both, right beside it, and the sheet prints both numbers.<br><br>Touch that cell once — type it, clear it, or drag it — and the app stops calculating that row for the life of the job. No undo, and no way to switch it back on. |
> **Shooting notes for H3.** ① The A/B rows must be **9 and 10**, not 3 and 4: rows 1–8 are the beat A / H2 crop and must stay blank, and the hours only auto-compute when **Placed and Removed are both set** (`forms.js:687`). Rows 9–12 in the props exist for exactly this. Part 1's drag stamps Removed onto rows 3–8, which have no Placed — so their Hrs and Days stay empty. That is correct and is not a missed take.
> ② **Part 1 starts on row 2, and row 1 is never touched.** Row 1 is the only row in the crop that carries a Placed (`09/02 14:30`), so typing a Removed into it fires `recalcDays()` on the spot (`forms.js:685–696`) and its **Hrs cell silently fills with `91` and its Days with `4d`** — a number appearing in frame that the narration does not explain, in the beat immediately before the A/B whose entire point is which Hrs cells move. Worse, it is not reversible on camera: clearing row 1's Removed leaves `hours: 91` sitting in the row (the recalc only writes when both timestamps are set), and clearing the Hrs cell to fix it sets `_manualHrs` and burns the module's hero row for good (`forms.js:705`). **Start the drag on row 2.**

| # | TIME | VISUAL | AUDIO |
|---|---|---|---|
| **I1** | **5:44–6:08** | **TAP 6.** SCREEN, moisture map, scrolled to the **reading grid**. The Material / Dry Goal pair is **not** in this frame and cannot be: two full sketch canvases and the whole Equipment Placement section sit between them (`forms.js:463–483`). Do not try to stage them together — the distance *is* the beat.<br>Grid row 1: `8.2` mint-green, `14.1` pink-red, `17.6` pink-red, `12.4` pink-red. Hold three seconds so the colours register.<br>Then one slow, unbroken **scroll up** — past the flag legend, past the equipment canvas, past the floor-plan canvas — landing on **Material `Other / Generic (≤ 16%)`** beside **Dry Goal (MC%) `9.5`**. Let the scroll run its full length. **Do not cut it.**<br>**LOWER THIRD:** `TAP 6 — Material · THREE WET POINTS` | Three points on this map are wet. One is dry. The app is doing that colouring off one number — and the number is not on this screen.<br><br>*(let the scroll run)*<br><br>It's up here. Two drawings and an entire equipment section away from the cells it controls. On a real visit you will never have both of these in front of you at once.<br><br>Nine point five. Where a correct goal number comes from is the next module. This one is only about the app throwing it away. |
| **I2** | **6:08–6:32** | Thumb taps the **Material** dropdown. On iPadOS this opens as a **popover list**, not the iPhone wheel — eight options, each carrying its goal in parentheses. Select **`Framing / Wood / Subfloor (≤ 19%)`**. Popover closes.<br>In the same frame, **without any dialog**: the **Dry Goal (MC%)** box flips from `9.5` to `≤ 19%`. Top-right pill flicks `Saving…` → `✓ Saved`.<br>**Do not cut.** Scroll back down — same two canvases, same distance — to the reading grid. **All four cells are now mint-green.** Hold four seconds.<br>Scroll one screen further to **Drying Trend**. The dashed green goal line has climbed the plot; its label now reads **`Dry goal 19%`**; and the y-axis top tick has gone from **20** to **25**, so the **four plotted points** sit lower in the frame than they did ten seconds ago. *(Four points, not four lines — see the shooting note under I3.)*<br>**LOWER THIRD:** `NO WARNING · NO CONFIRM · NO HISTORY` | *(silence through the flip — let the pill land)*<br><br>That box just rewrote itself. No warning, no confirm, and no record that there was ever another number in it. It saved on the spot — look at the pill, top right. There is no Save button in this app; it saves everything you do, including this.<br><br>*(scroll)*<br><br>All four points just went dry. Nothing moved in that building.<br><br>And look at the chart. It redrew its own scale to fit the new goal — the axis went from twenty to twenty-five and every point on it dropped. Even the picture now looks like a job that's further along than it is. |
| **I3** | **6:32–7:02**<br>**REPAIR** | Scroll back up to the **Dry Goal (MC%)** box. Thumb lands at the **left edge of the text**; the caret sits in front of `≤ 19%`. Type `9.5` **without clearing** → box reads **`9.5≤ 19%`**.<br>Scroll down to the grid: `8.2` mint, `14.1` / `17.6` / `12.4` **pink-red again.** It looks exactly like a repair that worked.<br>Cut to a **zoom on the Drying Trend goal-line label** — the only place on screen the real number appears. It reads **`Dry goal 9.519%`**. Overlay the parsed value as a graphic: `9.519`.<br>Cut back. **Do not clear the box — tap `Material` again and pick `Other / Generic (≤ 16%)`.** The dropdown rewrites the whole box on its own, exactly as it did in I2 (`forms.js:381–387`), so it now reads **`≤ 16%`** — the goal string is back in front of you without a single keystroke. **Now land the thumb at the *right* end of it** and type `9.5` → box reads **`≤ 16%9.5`**. Grid: **all four cells green.** Chart: y-axis top tick jumps from **20** to **190**, the four plotted points collapse onto the baseline, label reads **`Dry goal 169.5%`**.<br>Finally: select all, delete, type **`9.5`** — bare number, nothing else. Chart label back to **`Dry goal 9.5%`**, axis top back to **20**, three cells pink-red.<br>**LOWER THIRD (green):** `REPAIRABLE — CLEAR THE BOX. BARE NUMBER ONLY.` | This one repairs, and it repairs badly if you rush it.<br><br>Don't type in front of what's already in there. That box throws away everything that isn't a digit or a dot and reads whatever's left — so this is nine point five one *nine*.<br><br>And look at the map. Red, red, red. It looks fixed. There is nothing on that screen that tells you it isn't. The only place the real number shows up is the label on the trend line, and nobody scrolls down to that.<br><br>Change the material again and it hands you the string back. Land your thumb at the other end of it and it's worse, but at least you can see it: a hundred and sixty-nine point five, every cell green, and your four points squashed flat on the floor of the chart.<br><br>Clear the box. Bare number, nothing else. No percent sign, no less-than, no note. Then re-check every flagged cell before you leave the screen. |
> **Shooting notes for I3.** ① While the box is momentarily **empty** between select-all and the first digit, the app falls back to the material's own table value and all four cells go green for those frames (`forms.js:284–288`). That is expected — it is not a bad take, and it is not something to narrate here (**T2**). Type through it.
> ② **The second half is a Material re-pick, not a select-all-and-retype, and the difference is the whole beat.** Select-all + delete leaves the box **empty**, so typing `9.5` into an empty box gives you `9.5` and nothing else — there is no `≤ 16%` left to land behind. The dropdown is the only control that puts a goal *string* back in the box — its `onchange` assigns `m.dryGoal = "≤ <g>%"` and writes it straight into the input (`forms.js:384–386`) — and it does it unconditionally, so you do **not** need to clear first. **Pick a material you are not already on** — a select fires no `change` event when you re-choose the option it is already showing, and I2 left this map on `Framing / Wood / Subfloor`. Picking `Other / Generic (≤ 16%)` fires, and it also puts the map back on its build material, so this beat now walks itself to the retake table's own rebuild state.
> ③ **Every number in the second half, recomputed for `≤ 16%9.5`:** `goalNum()` strips everything that is not a digit or a dot (`forms.js:284–286`) → `169.5`. `moistureChartSvg` folds the goal into `yMax` and rounds up (`forms.js:70–72`) → `Math.ceil((169.5 × 1.1) / 5) × 5` = **190**. The label renders literally as `` `Dry goal ${goal}%` `` (`forms.js:92`) → **`Dry goal 169.5%`**. All four readings are below 169.5, so all four cells flag mint-green.
> ④ **There are no lines on this chart, and that is correct.** Beat **F1** deleted reading row 2, so the map holds **one** dated row from F1 onward. `moistureChartSvg` emits a `<path>` only when a location has more than one reading (`forms.js:103`); with one row it draws a **circle per location at `xOf(0) = padL + plotW/2`** (`forms.js:74`) — four coloured dots in a single column at the centre of the plot, under the dashed green goal line, with the legend chips `1 2 3 4` below. **Say "points," never "lines," in the VO for I2 and I3.** What moves on camera is the goal line, the axis labels and the height of those four dots — which is the beat, and it reads cleanly on a phone. If you want lines instead, you have to rebuild reading row 2 first (the F1 rebuild in the retake table, 3 minutes) — **not recommended**, because the viewer just watched you delete that row.

| # | TIME | VISUAL | AUDIO |
|---|---|---|---|
| **J** | **7:02–7:32**<br>**THE SEVENTH** | SCREEN, Drying Log, psychrometric table, scrolled so the **Outside / Ambient**, **Unaffected (Ref.)** and **Affected** column groups are all in frame, in that order left to right.<br>Row 2: Affected `78` `31` → GPP cell (**pale-orange `.calc`**, `--brand-tint` `#fff3ec`, `app.css:218` — the blue version of that cell exists only on the printout, `print.css:130`) reads **`44`**. Outside `-22` `60` → **`1`**. **Unaffected T and RH are empty — and the Unaffected GPP cell reads `0`.** GD cell reads **`−44`**.<br>Slow push onto the `0`. Hold three seconds.<br>Thumb types `70` and `34` into the empty Unaffected pair. Ref GPP recomputes to **`37`**. GD recomputes to **`−7`**.<br>**LOWER THIRD:** `NO TAP AT ALL · A BLANK PRINTS AS ZERO` | Last one, and this one isn't a tap. It's the thing you *didn't* type.<br><br>Unaffected temperature and humidity are empty on this row. Look at what the app put in the column: **zero.** Not blank — zero. It reads an empty box as zero degrees at zero percent humidity, and it does it the moment the log opens, before anybody touches anything. You saw it do exactly that on the second drying log a few minutes ago.<br><br>Then it subtracts that zero from your affected air and prints the result on the sheet the adjuster reads.<br><br>Fill it in and the number changes by thirty-seven points. Same building, same minute, nothing moved.<br><br>What that final number is supposed to look like is another module. **No psychrometric cell ever goes out blank. That's the whole rule.** |
| **K** | **7:32–8:05** | You to camera, shop, same setup as beat C.<br>Cut to the navy six-line card from beat C, now with a green tick beside two lines: `+ Add locations 14–26` and `Material`.<br>**⚠ R2 — DO NOT FRAME THE NEVER BLOCK.** The paper insert is a **tight crop on the field card's FILL DOWN paragraph alone**, held in a gloved hand: `FILL DOWN Type, Room, Placed ONLY - no undo on a fill. NEVER Asset (it INVENTS numbers), NEVER Removed, NEVER Hrs.` Nothing above or below it may be legible — four lines down sits `Material FIRST, goal = CONTROL + 2, BARE NUMBER ONLY`, which is **R2** and is not ruled (SOP §12.0.2). That paragraph is this module's own content and carries no ruled value.<br>Final frame: the crop, held still, three seconds. No music sting.<br>**If the card is not printed yet, close on the navy six-line card instead** and cut the paper insert in later. It is a standalone insert by design (§2.2) and it is the only thing in this module a ruling can reshoot.<br>**LOWER THIRD:** `TEACH ONE OF THESE BACK TO THE ROOM` | Six controls, and none of them ask you anything. If you remember one sentence out of this: **in this app, a tap that looks small is the tap that costs money, and the only warning you get is the one on your card.**<br><br>Two of them repair. Remove locations fourteen to twenty-six, and re-typing a dry goal as a bare number after a material change. Both only work if you do it before the packet prints.<br><br>Here's what you'll be asked. Back at the shop, you get one of these six. You stand up and tell the room **what it destroys** — not what the rule is. What it destroys. Forty-five seconds. Pick your favourite. |

#### Retake economics — read this before you roll

Every destructive demo consumes the state it needs. This module is six demolitions on one job, and the rebuild costs are not symmetric. **Shoot in script order** — the order above was built so each beat's damage does not block the next.

| Beat | What it destroys | Rebuild before a retake | Cost |
|---|---|---|---|
| A / H2 | Asset column rows 2–8 | Clear seven cells by hand | 1 min |
| D2 | Markers 1–4 **and the marker counter** | Re-stamp four markers. Counter is at 1 again, so it comes out right — but if you have already re-stamped once, clear the map's strokes and start clean. | **4 min** |
| E2 | Adds 13 columns | Tap `✕ Remove locations 14–26` | 20 sec |
| F1 | Reading row 2, entirely | Re-add via `+ Add reading date`, re-type date and four values | **3 min** |
| G1 | Creates a second Drying Log | **Open the second log**, scroll to the sticky action bar at the bottom of the editor, tap the red **`Delete`** and confirm *"Delete this Drying Log? This cannot be undone."* (`app.js:1939`, `app.js:1946`). There is no delete on the **list** screen — the delete lives inside the instance editor, which is why it looks missing. | **40 sec** |
| H3 | Rows 2–8 Removed (row 1 is not touched); **rows 9 and 10 burned** — row 9 by the typed Hrs, row 10 by clearing its auto-filled Hrs (typing *anything* into an Hrs cell, including a delete, sets `_manualHrs` — `forms.js:705`) | Clear rows 2–8 by hand. Use the clean pair **rows 11 + 12** for the retake. A burned row can be rebuilt: tap its `✕` (no confirm), tap `+ Add equipment`, retype Placed `09/02 14:30`. | 2 min per take, **40 sec per row to rebuild** |
| I2 | Dry Goal value **and the map's Material** | Re-pick Material **`Other / Generic (≤ 16%)`** — which rewrites the box to `≤ 16%` (`forms.js:385`) — then select all in **Dry Goal (MC%)**, delete, and type the bare `9.5`. Re-typing the goal alone leaves the map on the wrong material and beat I2 will not read the same on the retake. ⚠ **A select fires no `change` when you re-choose the option it is already showing** — if the map already reads `Other / Generic`, pick any other material first and come back. *(A clean run of I3 now ends in exactly this state on its own: its second half re-picks `Other / Generic` and its third types the bare `9.5`.)* | 30 sec |
| J | Nothing | Clear the Unaffected pair | 15 sec |

> ⚠ **G1 is cheap to retake — and the instruction that said otherwise was expensive.** Do **not** sign out and back in to remove the second log. Signing out re-pulls the server copy and discards every unpushed change made in the session, which on a shoot day is the whole session. The editor's red **`Delete`** (`app.js:1939`) works, confirms, and is a recorded delete, so it stays deleted if the job ever re-syncs. **Still shoot G1 and G2 after the moisture-map beats** — not because the retake is costly, but because G2's packet print wants the map beats already in the can.

> ⚠ **`_manualHrs` is permanent per row, and *typing* sets it — not only dragging** (`forms.js:705`). Beat H3's A/B burns **two** rows per take: the row you type into, and the row whose auto-filled Hrs you clear afterwards. **That is why the props list says twelve equipment rows, not eight** — rows 9 + 10 for the take, rows 11 + 12 for the retake. Past that, rebuild a row with `✕` then `+ Add equipment` and retype its Placed time.

#### Shot list

1. **A** — SCREEN, tight crop, equipment table rows 1–8: thumb drags the Asset fill handle from row 1 to row 8, rows arm, release, toast `Filled 7 rows`. **12s**
2. **A-insert** — SCREEN, 200% zoom on the Asset column showing `101 102 103 104 105 106 107 108`. **4s** *(cut inside A)*
3. **B** — CAMERA, over-the-shoulder on a laptop screen, desk lamp: four **re-typed** rows all reading asset `101`, typed four ways; your finger walks the column; slow push in. **20s**
4. **C** — CAMERA, mid-shot vertical, you to camera in the shop, iPad in hand. **12s**
5. **C-card** — GRAPHIC, navy card, six control names animating in one at a time. **8s**
6. **D1** — SCREEN, moisture map: tool row and canvas with markers 1–4 both in frame; animated ring moves from `↩ Undo` to `↺ Clear drawing`. **20s**
7. **D2** — SCREEN, same framing: tap `↺ Clear drawing`, markers vanish, hold 3s on the empty plan, two dead taps on `↩ Undo`. **24s**
8. **D3** — SCREEN: tap `①  Number` (turns orange), tap canvas, a marker reading `1` appears. **10s**
9. **D3-split** — GRAPHIC, split screen: reading grid columns 1–4 with values, beside the canvas showing the new marker `1`. **6s**
10. **E1** — SCREEN, bottom of the reading grid: slow zoom onto the two identical white buttons. **22s**
11. **E2** — SCREEN: tap `+ Add locations 14–26`, second stacked table paints in with navy headers 14–26, button row repaints, red-lettered `✕ Remove` appears. **12s**
12. **E2-print** — iOS PRINT PREVIEW, Moisture Map page pinched to full screen: 13 filled navy headers over 13 empty bordered boxes on every visit row. **8s**
13. **E3** — SCREEN: tap red-lettered `✕ Remove locations 14–26` → columns vanish **with no dialog**; re-tap `+ Add locations 14–26`; type `18.9` into row 1, column 14 (cell flags pink-red); tap `✕ Remove locations 14–26` again → iOS system alert *"Locations 14–26 have readings — remove them anyway?"* → tap OK. **22s**
14. **F1** — SCREEN, moisture grid: camera pushes right along row 2 to the `✕`, thumb lands, entire row vanishes with no dialog, hold. **24s**
15. **F2** — SCREEN: red box drawn around row 1's `✕` (untouched), then a slow horizontal `.tablewrap` scroll left along row 1 to its Notes cell, revealing the legend string. **24s**
16. **G1** — SCREEN: job home → `💧 Drying Log` tile → list with one row and the blue `+ New`; thumb hovers the row then taps `+ New`; back out to a list showing two rows. **24s**
17. **G2** — SCREEN, job packet page: `Include in this packet` checklist with the `💧 Drying Log` line carrying the count note `2`. **4s**
18. **G2-print** — iOS PRINT PREVIEW: scrub thumbnails showing two separate DRYING LOG sheets; pinch sheet 1 to full page (real equipment + psychro rows), then **sheet 2** — one empty ruled equipment row, and one psychrometric row dated today printing `0` in all three GPP columns and `0` GD. Push in on the zeros, hold 3s. **14s**
19. **G2-panel** — SCREEN, job home: the completeness panel, red left border, `⚠️`, header beginning `Not yet billable —`; slow pan down the checklist showing every line prefixed with its form name and **nothing about a second Drying Log**. **6s**
20. **H1** — SCREEN, 200% zoom on one equipment cell's bottom-right corner showing the 13px orange fill handle, then pull back to normal scale. **18s**
21. **H2** — SCREEN, full width, unhurried: the Asset drag repeated from row 1 to row 8; toast; zoom on 101–108. **26s**
22. **H3a** — SCREEN: type a Removed timestamp into **row 2 — never row 1** — drag its handle to row 8, rows 3–8 stamp the same pickup time (every Hrs and Days cell in frame stays empty; rows 2–8 have no Placed, and row 1, which does, is not touched). **10s**
23. **H3b** — SCREEN, rows 9 and 10 framed together, both pre-loaded with Placed `09/02 14:30`: type `40` into row 9's Hrs; type `09/06 09:15` into row 9's Removed → Days `4d`, Hrs stays `40`; type the same Removed into row 10 → Days `4d`, Hrs auto-fills `91`. Push in on the two rows, hold 4s. **18s**
24. **I1** — SCREEN, moisture map: hold 3s on the reading grid (one mint cell, three pink), then one unbroken scroll up past both sketch canvases and the Equipment Placement section to `Material` + `Dry Goal (MC%) 9.5`. **24s**
25. **I2** — SCREEN, unbroken: tap Material, iPadOS **popover list**, select `Framing / Wood / Subfloor (≤ 19%)`; Dry Goal flips to `≤ 19%`, `✓ Saved` pill flicks; scroll back down to the grid — four green cells, hold 4s; scroll on to Drying Trend — goal label `Dry goal 19%`, y-axis top `20` → `25`, and the four plotted points sit lower against it. *(One reading row after F1, so the chart is four dots in one column, not four lines — see I3's shooting note ④.)* **24s**
26. **I3a** — SCREEN, two parts: caret at the **front** → `9.5≤ 19%` → three cells pink-red, screen looks repaired; then **re-pick Material `Other / Generic (≤ 16%)`** (do not clear the box — the dropdown rewrites it to `≤ 16%`), caret at the **end** → `≤ 16%9.5` → all four cells green, axis top jumps `20` → `190`, the four plotted points collapse onto the baseline. **13s**
27. **I3b** — GRAPHIC over a zoom of the chart's goal-line label reading `Dry goal 9.519%`, with the parsed value `9.519` overlaid. **5s**
28. **I3c** — SCREEN: select all, delete, type bare `9.5`; chart label returns to `Dry goal 9.5%`, axis top returns to `20`, three cells pink-red and one mint. **The map is now back on its build state — Material `Other / Generic (≤ 16%)`, goal `9.5` — so a clean take of I3 costs no rebuild.** **12s**
29. **J** — SCREEN, psychrometric table with Outside / Unaffected / Affected groups in frame: Affected GPP 44, Outside GPP 1, Unaffected pair blank with GPP 0, GD −44; slow push onto the `0`, hold 3s; type `70` and `34`, ref GPP recomputes to 37, GD to −7. **30s**
30. **K** — CAMERA, you to camera, shop, matching beat C. **15s**
31. **K-card** — GRAPHIC, the six-line navy card with green ticks beside `+ Add locations 14–26` and `Material`. **8s**
32. **K-end** — CAMERA, tight, gloved hand holding the printed field card, **framed on the FILL DOWN paragraph alone**; the `Material FIRST, goal = CONTROL + 2, BARE NUMBER ONLY` line four rows below must be out of frame or illegible. Hold still 3s, no music sting. **⚠ R2 INSERT — shoot last, cut in at edit, reshoot only this if the card changes at print. If the card is not yet printed, close on shot 31 instead.** **10s**

#### Props and setup

- **Company iPad — ideally a SPARE**, or a fresh signed-out install carrying only the training job. Home Screen icon installed; Auto-Lock Never; Focus/DND on; charged above 60%; clock set to the shoot date; keyboard clicks off.
- **AIRPLANE MODE on for every take**, and a **deploy freeze on `main`** for the shoot day.
- **Screen Recording in Control Center, microphone toggled OFF.**
- **Tethered capacitive stylus and thin liner gloves** — on the desk, in shot at the edge of frame. Not used for the taps; the taps are a bare thumb so the landing is visible.
- **The training job**, built once, never rebuilt with `+ New Job`: customer `TRAINING - DO NOT BILL`. **No real customer name, address, claim number, or interior anywhere in this module.**
- **One moisture map** titled `Basement Utility - Drywall`, any Meter / Setting preset, Material `Other / Generic (≤ 16%)`, Dry Goal typed by hand as the bare number `9.5`.
- **A floor plan imported into that map FIRST**, then markers 1 2 3 4 stamped with `①  Number`. Any plan will do — a hand-drawn rectangle photographed and imported is fine and avoids any real address.
- **Reading row 1** dated 09/02 with values `8.2 / 14.1 / 17.6 / 12.4` and the full legend string in Notes. **Row 2** dated 09/04, values `8.0 / 13.4 / 16.9 / 11.8`, Notes `BR.`
- **ONE Drying Log**, first psychrometric row's Date edited to 09/02 so the list row reads `Drying log — Sep 2, 2026`.
- **TWELVE equipment rows** (not eight, not ten): row 1 = Asset `101`, Type `Air mover`, Room `Basement Utility`, Placed `09/02 14:30`, Removed blank, Hrs blank. **Nothing in this module ever types into row 1's Removed or Hrs** — it is the only row in the A/H2 crop carrying a Placed, and a Removed on it auto-fills `91` hours that no narration explains and that cannot be cleared without burning the row (H3 shooting note ②). **Rows 2–8 completely blank** — they are the beat A / H2 crop and must stay empty. **Rows 9–12 blank except Placed `09/02 14:30`** on each. Those four exist for beat H3's A/B, which needs two rows that already carry a Placed time: hours only auto-compute when **Placed and Removed are both set and the row has never been touched** (`forms.js:687`). **Rows 9–12 must sit below the beat A / H2 crop**, so do not let them into that frame. The spare pair is there because typing into *or* clearing an Hrs cell sets `_manualHrs` permanently (`forms.js:705`) and burns that row for good; H3 burns two rows per take.
- **Psychrometric row 2** dated 09/04: Affected `78` / `31`, Outside `-22` / `60`, **Unaffected T and RH deliberately blank**, Notes `Basement Utility`.
- **A laptop or desktop for beat B**, showing **four re-typed rows in a blank spreadsheet** — not a screenshot of the live database. Same four strings as §1.
- **Phone on a flexible tripod** for the two to-camera beats and the laptop over-shoulder. **No overhead gooseneck needed** — every tablet beat here is a screen recording, not a filmed screen.
- **One printed field card**, open to the NEVER block on the back, plus a work glove, for the closing shot.
- **A desk lamp or one work light** for beat B and the closing card shot. **No lighting kit** — this is an entirely indoor, warm, well-lit module.
- **Voice-over later, in the truck cab**: engine off, **heater fan off**, windows up, phone 8–10 inches off-axis, 10 seconds of silence at the head, one file `M5-six-taps-VO`.

#### Where this module sits, and what it does not cover

- **It teaches recognition, not procedure.** How to number points, how to set a goal, how to run a monitoring visit — none of that is here. Say so on camera (beats I1 and J both do) so nobody leaves thinking they got the rule.
- **It deliberately omits two hazards from §5 and §10.2:** two tablets on one job, and `⤓ Sync labor from QuickBooks`. Neither is a tap on these screens, both need signal to demonstrate honestly, and the QuickBooks one is aimed at the office. They belong in M9 and in M13.
- **Week 2 recut:** the six taps back to back, no explanation, cut from this module's own footage. **60 seconds.** Costs one edit and it is the single most re-sendable thing in the library.
- **If this ships before M1**, add eight words at the top of beat C acknowledging the **🎙️ Transcribe** widget that sits in a dashed box above both the Moisture Map and the Drying Log — *"That mic button at the top: never for readings."* It is the most prominent thing on the two screens this module lives on, and §5.6 bans it. Silence about it is worse than either cropping it out or naming it.
- **Nothing in this module is cold, wet or gloved.** It is entirely a warm-shop tablet module and it should be honest about that. The gloved-thumb reality of the `+ Add reading date` / `+ Add locations 14–26` adjacency and the 13-pixel fill handle is **asserted in narration, not staged** — do not shoot a fake cold hand in a warm shop. The real cold-hands footage belongs in M7 and M8, shot in the conditions.

#### Leonard

**This module does not reach him, and it is not supposed to.** All six controls are in an app he does not open. His lane is §10, and the paper lane's hazards are different hazards, owned by the transcriber.

**What he needs from this content is one printed page, handed over in person, not a link:** the NEVER block already on the back of the field card. He does not need the demonstrations, because he cannot make any of these six mistakes.

**The person who genuinely needs this module and is not a technician is the office admin**, who transcribes his cards into the app on the office device and **can make all six.** Assign it to the transcriber by name.

#### Assessment

**Teach-back, on the shop floor, in the room.** §12.1's paid 3-hour day already has everyone standing there, so this costs nothing but the six minutes it runs — the block §8.0 gives it at 1:38–1:44, and §7.2's A5 budgets the same six.

Each tech is handed **one** of the six controls and stands up and tells the room **what it destroys**, not what the rule is. Seven techs, six controls, ~45 seconds each.

**Pass** = names the damage in concrete terms: *"it wipes every marker and the counter goes back to one, so my next stamp is a two that's already in the grid."*
**Fail** = recites the prohibition: *"you're not supposed to tap Clear drawing."*

A person who can only recite the rule will route around it the first time it is inconvenient; a person who can name the damage will not. Two things make this the right check rather than a quiz: saying it aloud to peers is what fixes it, and it surfaces the misunderstanding in the shop instead of on a job. Your total effort is listening and re-assigning one control if somebody's answer is thin. **No form, no score sheet, no sign-off.**

**The second check is free and asynchronous.** On the first real job after the shop day, the two repairable ones get verified in the wild. If any tech reports *"I tapped + Add locations and took it back out with the red button"* or *"I changed Material and re-typed the goal as a bare number,"* that is a **pass on the whole module**, and it is worth saying so out loud on the shop wall — a self-reported near-miss is the outcome this module is actually for. **A silent shop is not evidence of a clean shop**; the office check in §12.4.5 (map Material vs its Dry Goal, checked for contradiction) is the backstop that catches a missed repair before a packet prints.

#### Open questions — M5

1. **Which tablet is the demo device?** If it is the live company iPad, an accidental edit to a real job during a retake is a real risk — and beat G1's second Drying Log must not land on anything real. Strong preference for a spare device or a fresh signed-out install carrying only the training job.
2. **Is the shoot day a deploy-freeze day on `main`?** A merge during the session reloads the app mid-take with no prompt. This needs a yes **before the session is scheduled**, not on the morning.
3. **Beat B shows four rows all reading asset `101`. Are those real production rows on a real screen?** If so, every surrounding job name, customer and claim number has to be redacted. **Recommendation: re-type the four rows into a blank spreadsheet** — the point is the four type-strings, not the provenance.
4. **Beat G1 creates a second Drying Log on the training job — ANSWERED, and the answer is scheduled.** It stays for the rest of session 6 (G1 is retaken by deleting it from inside its own editor, 40 seconds — see the retake table), and it is **deleted at the top of session 8**, along with every psychrometric row M5 leaves filled. It has to be: M8's F1 narrates *"there is one drying log on this job and there is always one"* over that list, and M8's B2 "before" panel state cannot exist while any row on any log carries an Outside or Affected value (`anyInstanceRow`, `completeness.js:31`). The teardown is **M8 props step 0** and it is written into §4.4 and §4.5's session 8. **Nothing about M5 changes; do not rebuild the job after this session.**
5. **Do you want the fill-handle demo reshot with a prefixed tag once R1 lands?** The module works permanently without it — the bare `101` is honest and format-agnostic — but a 6-second insert would sharpen it. Purely additive; can wait indefinitely.
6. **§12.6 queues a confirm dialog on `↺ Clear drawing`, removal of the fill handle from Asset/Removed/Hrs, and `gpp()` returning null on a blank. Four of this module's beats retire when those ship.** Is there a target date? **If any of them lands inside 60 days it may be worth cutting that beat from the first edit rather than filming it and cutting it in a month.** See §9.

---

### M6 — "Plan first, Loc 1 is the control, thirteen and no more"

**Track:** every tech · **Runtime:** 6:04 with a hands-on pause at 3:34 · **SOP:** §3.2, §3.3
**Position:** watched immediately before the mock-room exercise in §12.1.
**Status: CLEAR** — no owner ruling gates this module. One contamination hazard, handled by framing.

**Shoot time:** 95–120 min of tablet session (four beats are destructive and must be rebuilt between takes), plus 8 min of voice-over in the truck.

> **⚠ SPLIT POINT (see §3.1).** The script already stops dead at **3:34** with a card telling the viewer to go build a map. That is the split.
> - **M6a — how many maps, the title, plan first, arming the tool.** 3:34.
> - **M6b — Loc 1 is the control, thirteen, the `(2)` map.** 2:30.
>
> The hands-on pause works better as a hard stop between two files than as a card inside one. **Recommended.**

#### Status block

**No open owner ruling blocks this module.** Everything it teaches — how many maps a room needs, how the map is titled, plan-before-markers, arming the tool, Loc 1 as the control, the thirteen-point ceiling, the `(2)` overflow map — is settled in v1.3 and verified against the shipped code.

**One contamination hazard, two shots — R2.**

| Shot | What leaks | The rule on the day |
|---|---|---|
| **Beat 3**, Material dropdown | Picking a Material auto-writes a value into the **Dry Goal (MC%)** box beside it (`forms.js:381–387`; the write is `m.dryGoal = "≤ <g>%"` at `forms.js:385`). Whether that table value or a control sets the goal is **R2**. | Material and Dry Goal sit side by side in a two-up grid. **Crop in edit so only the Material half is legible.** Narration names the box, never a number. |
| **Beat 8**, first-row Notes cell | The canonical legend string (§3.5) carries a dry-goal source clause — `goal from control Loc 1 = 5.9 on 2026-09-06` — which is **R2**. | **Type the string with the dry-goal clause omitted, and only that clause.** The beat defines points 1 and 2, so the token is **`cols 3-13 unused`** — the first number is the one right after your last defined point (SOP §3.3, §3.5). The overflow flag **is** typed, after the token, because SOP §3.2 requires it and it is the point of the beat. Narration hands off the missing clause: *"the rest of this cell is the dry-goal line — different module."* |

Respect those two framings and no ruling can force a reshoot of this module. Ignore them and R2 going the other way reshoots beats 3 and 8.

**Also: no equipment, no asset tags and no meters in any frame of this module.** Keeping tags out of shot is what keeps it clear of R1.

#### Verified against code — every control this script taps

Read out of `apps/field/js`, not out of the SOP. **Do not paraphrase these labels on screen or in narration.**

- **`+ New`** — blue, top-right of the Moisture Map list (`app.js:1835`). Creating an instance navigates **straight into the editor**; it does not stay on the list.
- **Room / Area (titles this map)**, placeholder `e.g. Living Room` (`forms.js:433`, labelled at `forms.js:466`). Typing paints a bold caption above the sketch canvas and a second above the equipment canvas reading `<name> — Equipment` (`paintTitles`, `forms.js:426–432`).
- **Material** — a `<select>`, placeholder `Select material…`, eight options rendered `<name> (≤ <goal>%)` (`forms.js:381–387`, `core.js:724–733`). Stored value is the bare name.
- **The on-screen instruction line already printed above the boxes:** *"Import a floor plan (or draw freehand), then tap “① Number” and place a numbered marker at each moisture-reading location."* (`forms.js:464`). **Film it. The app already states the order.** Note the two spellings and do not "correct" either on screen: the instruction line uses **curly quotes and one space** — `“① Number”` — while the button itself is `①  Number` with **two** spaces (`core.js:511`).
- **`📄 Import floor plan (PDF / image)`** → becomes `🔄 Replace floor plan` once a plan exists; then `✂️ Crop / zoom` and `Remove plan` (red, **no confirm**) appear (`forms.js:404–421`).
- Import always routes through the crop modal: header **Crop & zoom**, subtitle *"Drag to move · scroll, pinch, or slider to zoom"*, zoom row `－` / slider / `＋`, footer **Cancel** / **Apply** (`forms.js:198–203`).
- Toasts: `Importing floor plan…` (6s, `forms.js:393`) then `Floor plan added — draw on top` (`forms.js:399`). **A third toast exists and you do not want it on camera:** any file the importer can't read produces `Sorry — couldn't read that file` (`forms.js:400`). Prove the training plan imports cleanly off-camera before you roll.
- Sketch tool row, left to right: `✋ Move` · navy · orange · red · green swatches · `①  Number` (**two spaces after the ①**) · `↩ Undo` · `↺ Clear drawing` (buttons `core.js:509–516`, row `core.js:518–519`). **Undo sits between Number and Clear drawing — they are adjacent, same size, same colour.**
- The pad opens in `mode="off"` (`core.js:390`). Hint overlay reads **`✋ Scroll mode — tap a color to draw`** (`core.js:385`); `touch-action: pan-y` on both the wrapper and the canvas while it is off, so a finger drag scrolls the page and draws nothing (`core.js:505–506`).
- A stamp is a filled orange circle r=17, white 2px ring, white bold 18px number; counter is `m.markerNext`, seeded 1 on every new map, **no way to set a start** (`stamp()`, `core.js:463–472`; `model.js:329`).
- Under the grid, one flex row: `+ Add reading date` (ghost) · `+ Add locations 14–26` (ghost, **identical style**) · `✕ Remove locations 14–26` (red, `hidden` until a block exists) — handlers `forms.js:355–376`, row appended at `forms.js:484`. **Both location labels are generated from the current column count** (`paintColBtns`, `forms.js:371–376`): add a second block and they become `+ Add locations 27–39` / `✕ Remove locations 14–26`. Do not let a second block exist while you are shooting this row.
- **A brand-new map already carries one reading row dated today** (`model.js:335`). Do not tap `+ Add reading date` on day 1.
- Packet route `#/p/<id>/packet`; bottom button `⬇ Save packet as PDF`, which calls `window.print()` (`app.js:1552`).
- **The packet page is not a preview — it is the live forms.** `packetGroups` calls each form's own renderer and appends the resulting sheets (`app.js:1437–1494`, `:1547`), and `setCtx(project, null)` is still in force (`app.js:1506`), so **the sketch tool row, `+ Add reading date`, `+ Add locations 14–26` and the red-lettered `✕ Remove locations 14–26` are all visible AND still functional on that page, and anything you tap there saves to the job.**
- **`.app-only` is a print rule and nothing else.** It appears in exactly one place in the codebase — `print.css:9` — so the tool row and the Add/Remove buttons disappear **only inside the print sheet**, where the stacked 14–26 table prints with navy numbered headers over empty bordered cells (`app.css:185–186`). **What is on the packet page is not what the carrier gets. The only place the carrier's copy exists on this device is behind `⬇ Save packet as PDF`.**

**THE BUG THIS MODULE EXISTS TO SHOW — and the one condition that makes it fire.** The moisture map builds its pad with `strokes: m.strokes` (`forms.js:258`). Inside `sketchPad`, `strokes` is captured **once, at construction, and never reassigned** (`core.js:381`). `size()` repaints the canvas from that captured value (`core.js:413–417`) and is wired to the background image's `load` event (`core.js:419`) and to `setBackground(null)` (`core.js:527`). So **importing, cropping, replacing or removing a plan repaints the canvas from the state the screen was in when you opened it** — while `nextNum` keeps climbing (`core.js:390`, `:469`).

> **⚠ THE BUG ONLY FIRES ON MARKERS STAMPED SINCE YOU OPENED THE SCREEN.** Leave the map and come back and `strokes` is re-captured from the saved PNG — so a plan import repaints those markers right back and **nothing vanishes on camera.** On a map you opened with an empty canvas, the captured value is empty, so every marker you stamp in that sitting is erased and the next stamp comes out one higher than the last one you can see.
>
> **This is what the cold open is: one unbroken sitting.** Enter the map, stamp, import — no back arrow anywhere in the middle. Build the state in advance and the shot is dead.

#### The shooting script

Screen material: iPad **portrait**, standalone PWA, **Airplane Mode**, Auto-Lock Never, Focus on, screen recording with **Microphone OFF**. Camera inserts: phone portrait, 1080p30, AE/AF locked.

| TIME | VISUAL | AUDIO |
|---|---|---|
| **0:00–0:12**<br>*COLD OPEN*<br>**⚠ ONE SITTING — NO CUT, NO BACK ARROW** | **SCREEN.** Already mid-action, no title card. A moisture map titled `Basement Utility - Drywall` with a **blank white canvas you have not touched this sitting** — enter the map at the head of the recording and do not leave it again until the shot is over. `①  Number` is orange/armed. Three taps: markers **1**, **2**, **3** land in a row. Hold one beat. | *(no narration — let the taps land)* |
| **0:12–0:22** | **SCREEN, same unbroken recording, no cut and no back arrow.** Tap `📄 Import floor plan (PDF / image)` → Photos → the training plan → toast `Importing floor plan…` → **Crop & zoom** modal → tap **Apply**. Plan fills the canvas. **The three markers are gone.** Hold on the empty plan for two full seconds. | "Watch the numbers." |
| **0:22–0:32** | **SCREEN.** Tap once on the plan. The marker that appears reads **4**. Freeze. Push in on the 4 in post. Burn-in, bottom third, plain type: `1, 2 and 3 are gone. The counter isn't.` | "One, two and three are gone. The counter isn't. That's four — with nothing in front of it. Nothing warned me, and nothing here is broken. That's just what happens when you stamp before you import." |
| **0:32–0:46** | **CAMERA.** You, shop, holding the iPad, plan on screen. Not to camera — looking at the tablet, then up. | "So the order matters, and there are four things in the order. How many maps this room needs. What the map is called. Plan in first. Then points — starting with the control, stopping at thirteen. Six minutes. Halfway through I'm going to stop and you're going to do it." |
| **0:46–1:04**<br>*Beat 1 — how many maps* | **CAMERA.** The wet panel prop, wide. Drywall face on one side, exposed studs on the other. Your hand touches the wet drywall, then the wet bottom plate. | "One room. Wet drywall here. Wet framing right behind it. Those two do not dry to the same number and they do not dry at the same speed — so they cannot live on the same map. Material lives on the map, not on the point." |
| **1:04–1:28** | **SCREEN.** From job home: tap tile **🗺️ Moisture Map** → tap `+ New` (blue, top-right). Lands in the editor. Then back arrow → `+ New` again. Cut to the list showing **two** rows. | "Two materials in one room means two maps. Not two points on one map — two maps. Make them both on day one and you never make another one on this job. Every visit after this adds a *date* to a map that already exists. A new visit is never a reason for a new map." |
| **1:28–1:52**<br>*Beat 2 — the title* | **SCREEN, tight on the Affected Area block.** Type into **Room / Area (titles this map)**: `Basement Utility - Drywall`. As it types, the bold caption paints above the canvas and `Basement Utility - Drywall — Equipment` paints above the second one. Zoom on the hyphen in post. | "Room name off the panel-door card — exactly how it's written on the card — then a space, a plain hyphen, a space, then the material. Plain hyphen. The one next to the zero. Not a dash you had to hunt for, because half of us will type a different one and then the two maps don't match. Type it and it names both drawings for you." |
| **1:52–2:12** | **SCREEN.** Cut to the Moisture Map list, pre-built for this shot with **three unnamed wood maps**: all three rows read the identical `Framing / Wood / Subfloor`. Hold. Then cut to the same list with all three named. | "This is what an unnamed map looks like in the list. Three of them. Same string. On the next visit you cannot tell which one you're supposed to be in, and neither can the office. Name it when you make it. It takes four seconds." |
| **2:12–2:30**<br>*Beat 3 — Material*<br>**⚠ R2 FRAMING** | **SCREEN, CROPPED IN EDIT to the LEFT half of the two-up row.** Tap **Material** → pick `Drywall / Gypsum (≤ 1%)`. **The Dry Goal (MC%) box must not be legible in the delivered frame.** | "Set Material to the same thing you just typed in the title. If your title says drywall and this says wood, an adjuster catches that on sight and it costs us the map. There is no LVP on this list, no tile, no insulation — if yours isn't there, pick Other / Generic and name the real material in the title. And yes, setting this writes something into the box beside it. Leave that box alone for now. It gets its own module." |
| **2:30–2:58**<br>*Beat 4 — plan first* | **SCREEN.** Push in on the printed instruction line above the boxes. Then play the full import: `📄 Import floor plan (PDF / image)` → OS picker → toast → **Crop & zoom** → drag, pinch, **Apply** → toast `Floor plan added — draw on top`. | "The app already tells you the order, right there on the screen. Plan first, then numbers. You just watched what happens when you do it backwards. Two things about that picker. It only reads page one of a PDF — if your plan is on page three you will import page one and not be told. And if the plan has the customer's name or address printed on it, crop it out here, in this box, before you hit Apply." |
| **2:58–3:22**<br>*Beat 5 — arm the tool* | **CAMERA, overhead, tabletop, one work light.** A **gloved** hand (thin liner glove) drags a finger across the canvas. The page scrolls. Nothing draws. Drag again. Nothing. Cut to **SCREEN**, push in on the hint pill: `✋ Scroll mode — tap a color to draw`. | "This one gets called in as a broken app about once a month. It isn't. The pad opens in scroll mode on purpose, so that when you're scrolling past the map with a wet glove you don't draw a line across it. It tells you, right there on the drawing: scroll mode." |
| **3:22–3:34** | **SCREEN.** Tap `①  Number`. Button turns **orange with white text**, hint pill disappears. Tap the plan — marker **1** lands. Then tap `①  Number` again — it goes back to white, `✋ Move` goes orange. Tap the plan — **nothing happens**, page scrolls. | "Tap Number. It goes orange. Now it draws. Tap it twice and you've turned it back off — and your next stamp does nothing. Orange means armed. Check the button, not the screen." |
| **3:34–3:42**<br>*HANDS PAUSE* | **CARD.** Plain navy, orange text, no music: `STOP. Build one map now. Title it. Import the plan. Arm the tool.` Held 8 seconds. | "Stop it there. Make one map on the training job. Title it, import the plan, arm the tool. Come back when the plan's on the screen and the Number button is orange." |
| **3:42–4:06**<br>*Beat 6 — Loc 1* | **SCREEN.** Fresh map, plan imported, tool armed. First tap goes into the **margin of the plan** — a corner clear of any room. Marker **1** lands. Then taps 2, 3, 4 land on the actual wet wall locations. | "First stamp on every map is the control. Every map. Because you stamp it first, the app hands you number one for free — and the app numbers from one on every single map, and there is nowhere to change that. So a four-map job has four number ones. That's correct. That is not a mistake." |
| **4:06–4:24** | **SCREEN, static on the plan** with 1 in the margin and 2, 3, 4 on the wall. Zoom on the lonely 1. Then **CAMERA**: you at the panel, tapping the wall of a *different* room with the back of your hand. | "Here's the part people get wrong. The control is not in this room. It's the same material read somewhere unaffected, same meter. And where you put that dot does not say any of that — the plan is stretched to fill the whole canvas, there's no empty room to put it in, and there is no text tool on this drawing. Four pen colours, a number stamp, undo, clear. That's all of it. So the dot means nothing on its own. The words in the Notes cell are what an adjuster actually reads." |
| **4:24–4:38**<br>*Beat 7 — thirteen* | **SCREEN.** Scroll to the button row under the reading grid. Push in tight on `+ Add reading date` and `+ Add locations 14–26` sitting **shoulder to shoulder, same grey, same size**. **CAMERA insert:** a gloved thumb hovering over both. | "These two live next to each other. Same size, same colour. The left one you tap every single visit. The right one you never tap. Ever. In a glove, in the dark, that is a coin flip — so slow down at this row." |
| **4:38–4:56** | **SCREEN.** Tap `+ Add locations 14–26`. A second stacked table appears instantly: navy headers **14** through **26**, every cell empty, **no Notes column on this one**. `✕ Remove locations 14–26` appears in **red** beside it. Hold. | "Watch what that does. Thirteen more columns. All empty. And they don't stay in the app." |
| **4:56–5:18** | **SCREEN.** Back arrow → job home → tap `📄 Full job packet (PDF)` → scroll to this map's grid. **The tool row and the Add/Remove buttons are still sitting there** — push in on them for one beat. Then scroll to the bottom, tap `⬇ Save packet as PDF`. The iOS print sheet opens on the page preview: **the tool row and the buttons are gone, and the 14–26 table is not** — navy numbered headers over thirteen empty bordered boxes, on **every visit row**. Hold three seconds. Pan across them. Tap **Cancel**. | "This page still looks like your form, because it is your form — those buttons are live right here. This is the page the carrier gets.<br>Thirteen numbered boxes, bordered, empty, on every row of every visit. An adjuster does not read a blank numbered box as a box you didn't need. They read it as a reading you were supposed to take and didn't. That's the whole reason the ceiling is thirteen." |
| **5:18–5:32** | **SCREEN.** Back to the map. Tap the red-lettered `✕ Remove locations 14–26`. Columns vanish (no dialog — they were empty). Then re-tap Add, type a value into column 14, tap Remove again → the confirm appears: *"Locations 14–26 have readings — remove them anyway?"* | "If you've already tapped it, the red one takes them back out. It'll warn you if anything's in there. Do it the moment you notice — before the packet prints." |
| **5:32–5:50**<br>*Beat 8 — the (2) map*<br>**⚠ R2 FRAMING** | **SCREEN.** `+ New` → type into Room / Area: `Basement Utility - Drywall (2)`. Stamp **two** markers — they come out **1** and **2**. Then into the **first row's Notes** cell type **and stop**: `BR. 1=CONTROL unaff Main Hall gyp; 2=N wall 12in AFF; cols 3-13 unused; overflow map - continues Basement Utility - Drywall`. **Do not type a dry-goal clause. Do not let one be legible.** *(Two markers, two `n=` entries, and the token starts at 3 — the three have to agree, and that agreement is what the module's own assessment check counts.)* | "So what if thirteen genuinely isn't enough? One move, and only one. Second map, same room, same material, parenthesis two. Numbered one to thirteen like any other map — and Loc 1 on that map is a control again. Then say so in the first row's notes, so nobody thinks it's a duplicate. Count your points, and the unused-columns number is just the next one after your last — two points, so it starts at three. There's another line that belongs in this same cell — the dry goal line. That's a different module, and it isn't settled yet." |
| **5:50–6:04**<br>*CLOSE* | **CARD**, held, then a slow push on the earlier freeze of the marker reading **4** with nothing before it. Card text: `PLAN IN. THEN ARM. THEN STAMP.` / `Loc 1 is the control.` / `Thirteen. Then a (2) map.` | "One thing out of all of that: plan in, then arm the tool, then stamp — and never the other way round, because the app will quietly throw your markers away and keep counting. Loc 1 is the control on every map. Thirteen points, then a parenthesis-two map. On your first real job you're going to text me one picture: your map on the screen, showing the title, the markers and the notes line. I'll count the markers against your legend. That's the whole test." |

#### Shot list

1. SCREEN, **one unbroken sitting — enter the map on camera and do not leave it** — map titled `Basement Utility - Drywall`, canvas untouched this sitting, `①  Number` armed, three markers stamped 1/2/3. **12s** *(COLD OPEN, State A. The markers MUST be stamped in this recording; pre-stamped markers survive the import and there is no shot.)*
2. SCREEN, same unbroken take — Import floor plan, OS picker, toast, Crop & zoom, Apply, markers gone, hold on empty plan. **10s**
3. SCREEN — single tap producing marker 4, freeze + post push-in, lower-third burn-in. **10s**
4. CAMERA, medium, shop — you holding the iPad, looking at it then up. **14s**
5. CAMERA, wide then hand insert — the wet panel prop, drywall face and exposed studs, hand touching each. **18s**
6. SCREEN — job home tile `🗺️ Moisture Map`, `+ New`, back, `+ New` again, cut to a two-row list. **24s**
7. SCREEN, tight on the Affected Area block — typing `Basement Utility - Drywall` into Room / Area, both captions painting live, post zoom on the hyphen. **24s**
8. SCREEN — Moisture Map list pre-built with three unnamed wood maps all reading `Framing / Wood / Subfloor`, then the same list named. **20s**
9. SCREEN, **CROPPED IN EDIT to the left half** of the two-up row — Material dropdown, pick `Drywall / Gypsum (≤ 1%)`. **Dry Goal box must not be legible.** **18s** *(R2 framing)*
10. SCREEN — post push-in on the printed instruction line above the boxes. **6s**
11. SCREEN — full import sequence with a drag and a pinch in Crop & zoom. **22s** *(State B build)*
12. CAMERA, overhead tabletop, one work light — gloved finger dragging the canvas, page scrolls, nothing draws, twice. **14s**
13. SCREEN — post push-in on the hint pill `✋ Scroll mode — tap a color to draw`. **10s**
14. SCREEN — tap `①  Number` to orange, stamp marker 1, tap again to disarm, tap plan, nothing happens. **12s**
15. CARD — navy/orange STOP card. **8s**
16. SCREEN — fresh armed map: stamp Loc 1 into a clear plan margin, then 2/3/4 on wall positions. **24s**
17. SCREEN static with post zoom on the lone marker 1. **8s**
18. CAMERA — you at the panel wall of a different room, back of hand on the wall. **10s**
19. SCREEN — tight two-shot of `+ Add reading date` beside `+ Add locations 14–26`, identical styling. **8s**
20. CAMERA insert — gloved thumb hovering between the two buttons. **6s**
21. SCREEN — tap `+ Add locations 14–26`, second stacked table with navy 14–26 headers appears (no Notes column), red-lettered `✕ Remove` appears. **18s**
22. SCREEN — `📄 Full job packet (PDF)`, scroll to the map grid, push in on the tool row and Add/Remove buttons **still present on that page**, then `⬇ Save packet as PDF` → iOS print sheet → slow pan across the thirteen empty bordered boxes with the chrome gone → **Cancel**. **22s** *(State C. If the print sheet's own chrome is a problem, shoot the second half as a desktop screen-recording of the exported PDF — see open question 6.)*
23. SCREEN — tap red-lettered `✕ Remove locations 14–26` (silent), then re-add, type a value in col 14, Remove again to trigger the confirm dialog. **14s**
24. SCREEN — `+ New`, type `Basement Utility - Drywall (2)`, stamp **two** markers showing 1 and 2, type the **truncated** legend (`… cols 3-13 unused; overflow map - continues …`) into the first-row Notes and STOP before any dry-goal clause. **18s** *(R2 framing, State D)*
25. CARD — three-line close card, then slow push on the earlier marker-4 freeze. **14s**
26. B-ROLL, optional, handheld, no audio — a gloved hand on the tablet on a real job, nobody identifiable. **10s**

#### Props and setup

- **iPad**, charged above 60% (battery is in every frame), installed from the Home Screen icon as a standalone PWA — never a Safari tab.
- **iPad settings, set once:** Auto-Lock Never; Focus/DND on; Screen Recording in Control Center; keyboard clicks off; **Screen Recording microphone OFF**.
- **Airplane Mode ON for every take.** Sign in and pull the training job first, then switch it on. **Freeze deploys to `main` for the whole shoot day.**
- **Training job** named `TRAINING — DO NOT BILL`, fake address, no claim number.
- **A floor plan file with NO customer name, address or claim number** — single page, or page 1 is the page you want (the importer silently renders page 1 only).
- **Pre-built map states:**
  - **State A** (titled, **no plan, NO markers, counter at 1**) — for the cold open. **The three markers are stamped on camera, inside the take.** A State A carrying pre-stamped markers repaints them straight back after the import and there is no cold open. Consumed by the import.
  - **State B** (titled, plan imported, no markers) — for the arming beats.
  - **State C** (plan imported, 4 stamped points, **at least three reading dates**, grid values in each) — for the packet shot. A brand-new map ships with **one** reading row (`model.js:335`), and one row does not read as "every visit row" — tap `+ Add reading date` twice and put values in all three before you add the 14–26 block.
  - **State D** (empty new map) — for the `(2)` demo. **Two markers get stamped on it, not one** (see beat 8).
- **A pre-built Moisture Map list carrying three UNNAMED maps** with Material = `Framing / Wood / Subfloor`, for the 1:52 shot.
- **The wet panel prop:** 4×4 ft, two 2×4 bays, ½ in drywall on one face, studs exposed on the other, bottom 12–24 in wetted with a pump sprayer, standing in a mortar tub. **Doubles as the §12.1 mock room.**
- **Thin liner glove** (one, for the tapping inserts) and a **tethered capacitive stylus**.
- **Phone on a flexible tripod** for the two camera beats; **overhead gooseneck stand** for the gloved-thumb tabletop inserts; white foam board bounce.
- **One rechargeable COB work light**, plus the ability to kill the shop lights down to one source for the gloved beat.
- **Truck-cab voice-over:** engine off, heater fan off, doors shut, 10s of room tone at the head of each file.
- **The panel-door room card** taped inside a panel door or a stand-in hinged door, with `Basement Utility` on it, for continuity with M4.
- **NO equipment, NO asset tags and NO meters in any frame of this module.**

#### Production notes — the things that will go wrong

1. **Four beats are destructive and each take costs a rebuild.** The cold open, beat 4, beat 7 and beat 8 all leave the map in a state you cannot undo. `↩ Undo` is memory-only, capped at 30, and **empty the moment you leave the screen and come back** (history stack `core.js:452–453`, `undo()` `core.js:454–461`). There is no reset.

   **State B, C and D you build in advance. State A you cannot** — a pre-built State A carrying markers repaints them straight back after the import (see THE BUG, above). **The cold open is one unbroken sitting: enter the map, stamp, import.** Rebuild it between takes in this order and no other:

   1. Tap the red **`Remove plan`** first — no confirm (`forms.js:416–417`). `setBackground(null)` repaints the canvas from the value captured when you opened the screen (`core.js:527`), so **do this before you clear**: if you clear first and remove second, the removal can repaint the markers you just wiped and save them again.
   2. Then tap **`↺ Clear drawing`** — no confirm; it wipes the canvas, resets the counter to 1, kills undo and saves immediately (`core.js:513–514`).
   3. **Back out to the Moisture Map list and re-enter the map.** This is the step that re-captures an empty `strokes`. Skip it and the next take shows nothing.
   4. Confirm on the screen: canvas empty, no plan. Stamp once — it must read **1** — then `↩ Undo` to take it back off. Undo restores the counter as well as the canvas (`core.js:453`, `:457`), so this check costs you nothing.

   **Budget 5 minutes to rebuild State A** and **8 minutes for State C** (four points plus three reading dates of values). **If you get two clean takes of the cold open, stop** — it is the shot that costs the most to reload.
2. **Rehearse the revert once, off-camera, and confirm it sticks.** Stamp 3 → import → markers vanish → **back out to the list and come back into the map.** What we expect from the code is that the blank canvas is what got saved and the counter is still at 4. **Confirm that with your own eyes before you record the cold open.** If the markers come *back* when you re-open, cut the burn-in card at 0:22 and change the narration to *"gone off the screen, and the counter kept going"* — the teaching point survives either way, the claim about permanence does not.
3. **Do the first PDF import off-camera.** `pdf.js` lazy-loads from `assets/vendor/pdfjs/` on the first import of the session and can pause for a beat. Burn that pause on a throwaway before you roll.
4. **Airplane Mode for every take, and freeze deploys that day.** See §4.3. Nothing in this module needs signal.
5. **The 🎙️ Transcribe widget mounts above the sheet on every moisture map** — `moistureMaps` is in `AI_FORM_KEYS` (`ai.js:24–27`) and the widget is appended before the form renderer runs (`app.js:1893–1895`) — and the SOP bans dictating readings. It is **not** this module's job to explain it. Frame below it, or start every screen segment already scrolled to the Affected Area block. **Do not let it appear and go unremarked.**
6. **Cold and gloves — what to fake and what not to.** The tapping beats (5 and 7) are the only ones where cold matters, and what matters is the **glove and the button size**, not the temperature. Shoot them in the shop with a thin liner glove and the shop lights down to one work light. **Do not stage a fake crawlspace.** If you want the honest version, grab 10 seconds of handheld B-roll of an actual gloved hand on the tablet on a real job and cut it under 2:58 — no audio, nobody identifiable, no customer interior.
7. **Narration is recorded separately**, after the rough cut exists so the words land on the taps.
8. **Privacy.** The training job's name prints in the sheet header above the Affected Area block. Name it `TRAINING — DO NOT BILL`. The floor plan must carry no real customer name, address or claim number — and if the one you have does, **crop it out inside Crop & zoom on camera**, which is a teaching beat anyway (scripted at 2:30).
9. **Leonard.** This is a tablet module end to end and none of it reaches him. His version of §3.2/§3.3 is the paper Drying Visit Card and a person standing next to him at the panel door — the map title, the point numbers and the legend get written on paper and a transcriber types them in. **Do not send him a link. Do not let the shop-day agenda imply that watching this covers him.**

#### Assessment

Two checks, both riding on work that has to happen anyway.

**1. SHOP DAY, LIVE, 60 seconds per tech.** Hand the tech an iPad on the training job and say *"make me a map of the mock room's drywall and put four points on it."*
**Pass** = they title it before they draw, import the plan before they stamp anything, and arm the tool without being told.
**Fail** = they drag on the canvas and say the app isn't working, or they stamp first and import after.
**The failure is the diagnostic** — it means they watched the module and did not act on the cold open, and it gets fixed on the spot with the iPad in their hands. **Do not coach until they have had ten seconds to be stuck.**

**2. FIRST REAL JOB, ASYNC, 15 seconds of your time.** The tech texts one screenshot of their own map — the title caption, the markers on the plan, and the first-row Notes cell all in one frame. Check four things and nothing else:

- the title reads `<Room> - <Material>` with a plain hyphen, and the room half matches the panel-door card exactly;
- there is a marker labelled **1**;
- the highest marker number is **13 or lower**;
- **the count of markers on the plan equals the count of `n=` entries in the legend.**

Any mismatch between marker count and legend entries means a marker was stamped after a plan import and reverted, or a legend line was never written — and either way the reply is one line: *"count your markers and re-open the map."* **This same screenshot is the evidence for the legend half of M7, so it is one text, not two.**

#### Open questions — M6

1. **Runtime vs. the course ceiling.** This script is 6:04 with a hands-on pause at 3:34. Confirm you want it as one 6-minute file with the pause card, or as **two files** (A: how many maps / title / plan in — 3:34; B: Loc 1 / thirteen / the `(2)` map — 2:30). Two files also make the spaced re-watch cheaper. **I recommend two.**
2. **Which floor plan file is safe to use as the training plan?** It needs no customer name, address or claim number anywhere on it, and it needs to be a single page or have the useful content on page 1 — the importer renders page 1 only and says nothing about the rest.
3. **The revert's permanence needs one rehearsal confirmation before the cold open is recorded.** The code says the blank canvas is what gets saved. Verify on the actual iPad by leaving the map and coming back. If the markers reappear, the burn-in card at 0:22 has to change — the teaching point survives, the permanence claim does not.
4. **R2 handling:** is the 5:32 narration line — *"there's another line that belongs in this same cell, the dry goal line, that's a different module and it isn't settled yet"* — the framing you want? The alternative is cutting the Notes cell out of this module entirely and letting M7 own it, which costs the `(2)` map its "say so in the notes" requirement.
5. **Has a `(2)` overflow map ever actually been created on a real job?** There is no production example to point at, so beat 8 creates the first one on the training job. Confirm you are fine with the training job carrying `Basement Utility - Drywall (2)` permanently, or say whether it should be deleted after the shoot.
6. **ANSWERED — the packet shot at 4:56 now needs both pages.** The on-screen packet page renders the live form sheets, so the tool row and the Add/Remove buttons are still on it (`app.js:1547`); `.app-only` only hides them at print time (`print.css:9`). The beat therefore shows the packet page **and then** the print sheet behind `⬇ Save packet as PDF`, which is the only place on the device where the carrier's copy actually exists. **The one thing still to confirm: does the iPadOS print sheet show anything you don't want on screen** (device name, printer list, origin)? If it does, shoot the second half of the beat as a desktop screen-recording of an exported PDF — budget 10 minutes for that, and it is the same footage M5's E2/G2 already need.

---

### M7 — "A mark that survives a dehu and below freezing"

> *(Retitled from "…and forty below." The SOP's rule is stated as **below freezing** — 05-CREW-CAPTURE-SOP.md:160 — which is what this module films and what the January tail will still be. The new title is propagated to §3's course table, the §8 shop-day agenda and the card index; nothing inside the module changes, and the filename `M7-paint-pen.mp4` is unaffected.)*

**Track:** every tech · **Runtime:** 4:45 *(hard ceiling 5:00)* · **SOP:** §3.4, with §3.5's second anchor, §8's caption format, and the `COLD:` line on the field card back
**Status: none of the six §12.0 rulings touches this module — but ONE BEAT IS BLOCKED and the module is weather-gated.** It is still the physical-marking module that is furthest from R1.

**BLOCKED — beat 1:42–2:00, on an undecided material abbreviation (not one of the six; see open question 2).** The beat writes `GYP` as the third line of the label. `GYP` is the only material abbreviation that exists anywhere in the SOP (05-CREW-CAPTURE-SOP.md:172), and the app's Material dropdown carries **eight** options with no abbreviation for the other seven (`core.js:724–733`). Seven techs will independently invent seven sets. **This needs the eight-row table before the beat is delivered. It is recorded in §2.3 beside M7's weather gate and M13's missing artifact, not in the six.**

**How to shoot it anyway, today, for the price of one insert:** shoot 3A as scripted — all three lines, one continuous take — and then, on a clean patch of the same panel, **shoot the material line on its own as a separate 5-second insert** (§2.2). If the ruling changes `GYP`, you re-shoot the insert and the cut absorbs it. If you shoot only the continuous take, a ruling change costs the whole 18-second setup.

**Also gated on weather, not on a ruling.** See Scheduling truth below.

**Shoot time:** 35 min of setup **48 hours ahead**, 70 min principal photography across two locations, 12 min of VO in the truck. **Two separate calendar days minimum**, because the destructive test has to soak.

**After this module a tech can:** label a reading point in freezing conditions so the next tech reads it by headlamp at arm's length — prime the pen in the jacket, mark while the space is still warm, and fall back to a punched flashing strip plus a captioned photo when the pen will not flow.

#### R1 is avoided by framing, not by waiting

Nothing here depends on the tag format. Every number on camera is a **reading-point number (1–13)** or the worked label `7 / 12" AFF / GYP` from §3.4, and neither is a ruling. The one shot where a dehumidifier appears (the 48-hour soak) is framed on the panel with the machine's housing out of focus behind it and **its tag out of frame or facing away.** Check that on the monitor before you walk away from the panel — it is the only thing in this module that can force a reshoot.

#### Scheduling truth — read this before you book a day

**1. Three panels have to be planted 48 hours before you roll a frame.** The destructive test is the whole reason this module exists as video and it cannot be faked in an afternoon.

- **Panel A (the dehu panel).** Half sheet of ½" drywall on two stud bays, standing in a mortar tub. Write the label `7 / 12" AFF / GYP` **four times** across it at 12" spacing, one per medium, left to right: **(1) oil-based paint pen, (2) regular permanent marker, (3) blue painter's tape written on with the same permanent marker, (4) a punched aluminum flashing strip wired to the stud.** Shoot the Day-0 frame the moment the fourth one is on. Then soak the bottom band with the pump sprayer and stand an LGR dehu four feet away, running, pointed at it, for 48 hours. Re-wet it once a day.
- **Panel B (the cold panel).** A 12"×12" drywall offcut with the same four marks. Outside, or in a chest freezer, for the same 48 hours.
- **Panel C (the cold wall).** A second 12"×12" drywall offcut, **clean and unmarked**, cold-soaking beside Panel B. Beat 3:28 writes on it with a jacket-warm pen, so the only variable between that frame and the warm-shop cutaway is the wall. Cut two.

**2. The 48-hour result is not written yet, and this script does not pretend it is.** The cold open, beat 0:50–1:04 and beat 1:18–1:32 all sit on what Panel A looks like at hour 48 — and Panel A has not been shot. **Apply the paint pen's own standard to the whole panel: shoot the reveal first, MOS, then write the VO to what is on it.** The AUDIO column below gives the line for the expected result and points at the branch section for the other one.

- **The two bans do not depend on the test.** SOP §3.4 bans the Sharpie and the painter's tape outright (05-CREW-CAPTURE-SOP.md:155–156). The burn-in `Banned: permanent marker. Banned: painter's tape.` is company policy and it goes on screen either way.
- **What depends on the test is the sentence "you just watched the reason for it."** If a medium holds for 48 hours, you did not watch the reason, and you say something else. See *If the panel does not fail* below.
- **Shoot the reveal before a hand touches the panel and before a word of VO is recorded.** Once the tape has been lifted, that frame is gone.

**3. You cannot film forty below in September.** Nights are dipping to freezing; forty below is December. **Neither the title nor the script claims it** — the title now reads *below freezing*, which is the rule the SOP actually states. The honest ladder, best to worst:

- **Best available now:** a chest freezer (~0°F) or a restaurant walk-in (~−10°F). Genuinely below the pen's failure point, repeatable, indoors, at any hour, with a door you can prop for light. **Shoot the cold beats in the freezer.**
- **Also fine:** dawn in late September, 20–28°F. **Below freezing is the rule the SOP actually states** — it says "below freezing," not "below forty."
- **The tail you add in January:** twenty seconds of a real labeling attempt at real cold, shot on a phone by whoever is on that job, appended as a coda. **Cut the module so a tail can be dropped on the end without recutting anything.** Beat 8A is built as that seam.

**4. This is not only a video shoot. It is §12.1's own test.** §12.1 says: *try the paint pen outside, at whatever the temperature is, before seven people are told to rely on it.* You are running that test with a camera on it. **Film the honest result.** If the pen writes fine at 15°F, the narration says so and names the temperature where yours actually quit. **Every temperature in the VO script below is written as a blank you fill in after the shoot. Do not record VO first.**

**5. Gloves and hands.** Every hand in this module wears the thin liner gloves from §12.1's handout. A bare hand in a warm shop, teaching a cold-weather rule, is how a crew learns that the trainer has never done it.

#### The shooting script

| Time | VISUAL | AUDIO |
|---|---|---|
| **0:00–0:12**<br>*COLD OPEN*<br>**SHOOT FIRST — WRITE AFTER** | **COLD OPEN — no title, no logo, no music.** Macro, tripod, locked AE/AF. Panel A at hour 48. One slow left-to-right slide across all four marks in the order they were written: **permanent marker · painter's tape · oil paint pen · punched flashing strip.** **Shoot this before anyone touches the panel and before a line of VO is written.** Cut the burn-in to what the panel shows.<br>BURN-IN, bottom left, 11pt: `48 hours. One dehu. One soak.` | *(nothing for the first four seconds — let the panel land)*<br>**Written after the reveal, to what is actually on it.** If the marker bled and the tape released: **"Four ways to write a seven. Two of them are gone."**<br>If either held, take the line from *If the panel does not fail* below. **Do not speak a failure you did not film.** |
| **0:12–0:26** | Cut wide: your gloved hand at the panel, the dehu audible and visible behind, **out of focus, tag not legible**. You touch each of the four marks in turn, ending on the paint-pen mark. | **"That number on the wall is one of three things holding a reading point together. The paint-pen mark, the label, and a day-one photo. Lose two and the point's gone — and nobody can rebuild it later, because the app does not store a name for a reading point. The number in the column is all there is."** |
| **0:26–0:38** | Macro insert: the paint-pen label filling frame. BURN-IN: `oil-based paint pen` | **"By the end of this you'll put a label on a wall below freezing that the next guy reads by headlamp, at arm's length, without calling you. Four and a half minutes."** *(Below freezing is the rule the SOP states — 05-CREW-CAPTURE-SOP.md:160 — and it is what this shoot can actually produce. Do not promise a temperature you are not going to show.)* |
| **0:38–0:50**<br>**THE TEST, FROM THE TOP** | Cut to the Day-0 footage. Four marks going on, sped up 4×, in one continuous locked-off frame. BURN-IN: `Day 0`, plus a slate card in shot with the date. | **"Here's how we got there. Same panel, same label, four different pens, forty-eight hours ago."** |
| **0:50–1:04** | Day-0 continues: the pump sprayer soaks the bottom band. **Real time, no speed ramp — this beat is the argument.** Water sheets down. Hold on the permanent marker as it starts to bleed **within seconds**. | **"Water first. That's the part you don't have to wait for. Regular permanent marker on wet gypsum lets go immediately — it's a dye, and the water takes it."** |
| **1:04–1:18** | Day-0: the dehu wheeled in, four feet off, switched on. Then a dissolve to the Day-2 reveal frame from the cold open — **same lens, same distance**, so the two frames register. | **"Then the dehu, pointed at it, for two days. That's what a real drying chamber does to a mark: soaks it, then bakes it. Both."** |
| **1:18–1:32** | Macro: the painter's tape **as you find it at hour 48**. A gloved fingertip tests the edge on camera. **Film what it does — one take, and do not test it before the roll.** | **Written after the frame exists.** If it releases: **"Painter's tape is worse, and it fails the other direction. It doesn't run — it lets go. High humidity, then cold, and the adhesive quits."** Then state where ours ended up, from the frame. If it held, take the line from *If the panel does not fail*. |
| **1:32–1:42** | Two-shot side by side, split screen or a quick A/B cut: **the two banned media against the paint-pen mark, as they came off the panel.** BURN-IN: `Banned: permanent marker. Banned: painter's tape.` | **"So that's the rule. Oil-based paint pen. Nothing else touches a reading point."** — and, **only if both media actually failed on camera**, add: *"and you just watched the reason for it."* The ban is the SOP's either way (§3.4); the *reason* is only yours to claim if it is in the frame. |
| **1:42–2:00**<br>**THE LABEL ITSELF**<br>**⚠ BLOCKED — material abbreviation, see the status block** | Overhead gooseneck rig, clean drywall, gloved hand. **Real time, no speed-up.** Three lines going on: `7`, then `12" AFF`, then `GYP`. BURN-IN as each line lands: `the point number` / `the height` / `the material`.<br>**Then, without moving the rig, shoot the third line AGAIN as its own 5-second insert on a clean patch** — same lens, same light, same hand. That insert is the only thing that reshoots if the abbreviation table lands differently. | **"Three lines, in this order. The number. The height. The material. That's it — it fits in a headlamp beam and it survives a glove."**<br>*(Narration names the three slots and never says that `GYP` is the standard abbreviation, because there isn't one yet. If open question 2 is ruled before the edit, the wording can tighten; if it is ruled after delivery, you swap the insert.)* |
| **2:00–2:18** | Same overhead. Pull out to show two pin holes about two inches to the right of the label. Hand places a pin meter into the same holes. | **"Write it about two inches to the left of your pin holes, not on top of them. Leave the holes showing. That's how the next tech puts the pins in the same spot — and if he doesn't, the trend line is measuring two different places and calling it one."** |
| **2:18–2:34** | Insert, held: `12" AFF`. BURN-IN: `24" is a different point.` | **"Height is part of the point, not a description of it. Twelve inches AFF is the standard wall point — under the flood cut, over the base plate. Something at twenty-four inches on the same stud bay is a different number. Never 'same wall, about the same height.' That drift is invisible in review and it wrecks the trend."** |
| **2:34–2:50**<br>**THE READ TEST** | Lights out. Handheld, arm's length, headlamp on the operator's head so the beam and the lens agree. The label reads clean. Then a second label written smaller and tighter — deliberately — and it does **not** read. BURN-IN: `arm's length. headlamp. that's the test.` | **"Here's the standard, and it's the only one that matters. Arm's length. Headlamp. If you have to lean in, it's too small. Write it bigger than feels necessary — you're writing it for a guy in a crawlspace in six days, not for yourself right now."** |
| **2:50–3:10**<br>**THE COLD LANE** | Hard cut. Freezer or exterior, real cold, handheld, short burst. A thermometer or the truck gauge in frame **at the top of the shot** so the temperature is on the record. Gloved hand tries the paint pen on Panel B. The nib skips, drags, leaves nothing or a broken grey line. **Hold on the failure for a full three seconds.** BURN-IN: `___ °F` *(fill from the frame)* | **"Now the part nobody tells you until you're standing in it. Below freezing, an oil paint pen stops working. The nib won't prime and the paint won't lay down. This is at ______ degrees. That's not a technique problem and it's not you being cold and clumsy — the pen is out of spec."** |
| **3:10–3:28** | Same location. You open your coat, drop the pen into an inside chest pocket **nib down**, zip up. Cut. BURN-IN: `nib down. two minutes.` Then pull it out and write the same label — it flows. | **"So the pen lives inside your jacket, against your body, nib down. Two minutes is usually enough. Not the outside pocket, not the truck cup holder — the truck's cold too. Inside the coat, all day, every time."** |
| **3:28–3:42**<br>**THE ONE VARIABLE THE PEN DOESN'T FIX** | **Freezer/exterior, same trip as 5A and 5B.** Bring out **Panel C** — a clean drywall offcut that cold-soaked the full 48 hours beside Panel B. Thermometer in frame. Take the **same pen you just warmed in your jacket, the one that wrote clean 20 seconds ago in the previous beat**, and write the label on the cold board. **Film what it does. Hold on the result for three seconds.** Then cut to the shop: heater on a demo'd wall, steam off the studs, **that same pen** writing on warm gypsum. Two boards, one pen. | **"Now the other half, and this one isn't the pen. Same pen, straight out of my jacket, both times — the only thing I changed is the wall."** *(Then say what the two frames showed, from the frames. If the cold board took the mark, say so and say the rule anyway:)* **"Mark while the room is still warm — right after demo, or while the heaters are still on it, not at the end of the visit on your way out. It's a warm pen AND a warm wall, and only one of those lives in your coat."** |
| **3:42–4:00**<br>**THE FALLBACK** | Freezer/exterior. Strip of aluminum flashing, gloved hand, nail set and a hammer: punch a `7`. Then wire it to the stud. Alternative shown in a two-second insert: a plastic tag on a short zip tie. BURN-IN: `won't write → punch it and hang it` | **"When it still won't write — and some days it won't — you don't skip the point. Punch the number into a strip of flashing with a nail set and wire it to the stud, or write it on a plastic tag and zip-tie it. Cold doesn't care about either one."** |
| **4:00–4:14** | **SCREEN RECORDING — iPad, portrait, standalone PWA, Airplane Mode.** From job home, tap the **📷 Job Photos** tile. It opens straight into the editor — there's no list, one photo log per job. Header shows **📷 Job Photos** and the **✓ Saved** pill. Tap **📷 Add photos** (blue). iOS sheet → **Take Photo** → shoot the punched tag with the meter in frame → **Use Photo**. | **"Then the photo, and this is the part that makes the tag count. The photo is the label. If it isn't on the job, the tag on that stud means nothing to anybody but you."** |
| **4:14–4:32** | Screen recording continues, cropped tight on the new photo card. The three controls, top to bottom under the tools row: the **Room / location** box, the **Stage** dropdown reading **During**, the **Caption** box. Type Room: `Main Hall`. Leave Stage on **During**. Type Caption: `Punched tag, pen would not flow - Main Hall - Loc 7`. Insert: the **✓ Saved** pill flicking to *Saving…* and back.<br>*(In frame and NOT to be tapped: the dashed 🎙️ Transcribe box at the top, and ✨ Analyze on the card.)* | **"Room off the panel card. Caption is what it is, then the room, then the point — plain hyphens, same as every other photo on the job. Leave the Stage alone; During is the default and this isn't one of your first-visit wides. There's no save button, it saves every keystroke — watch the pill. And ignore the microphone box up top. It needs signal, and we never dictate readings anyway."** |
| **4:32–4:45**<br>**CLOSE** | Back to the Day-2 macro: the smear and the crisp mark, side by side, held. BURN-IN, three lines: `oil paint pen only` / `pen lives in your jacket` / `won't write → tag it + photo` | **"One thing out of this. The pen lives inside your jacket and you mark while the wall is still warm. If it won't write, you tag it and you photograph it — you never leave the point unmarked. That's the COLD line on the back of your card, and now you've seen why it's there."** |
| **4:45** | *(Seam for the January tail. **Cut ends clean here on a held frame with no music tail and no end card**, so twenty seconds of real-cold footage can be appended in winter without recutting.)* | — |

#### If the panel does not fail — the branches you must be ready for

Three things in this module are destructive tests, and a destructive test can decline to be destructive. **Do not reshoot until it fails, and do not narrate a failure you did not film.** The rule survives every one of these passing; the *demonstration* does not, and you must not stage one.

**A. The paint pen writes in the cold.** That happens; brands and formulations differ, and a pen out of a warm truck carries its own heat for a while.

- Keep rolling and keep going colder — freezer, then longer soak time for the pen itself, then a pen that has been outside overnight. **Find the temperature where yours actually quits and put that number on screen.**
- If it never quits at any temperature you can produce, **change the 2:50–3:28 narration to this**: *"Ours wrote at ______ degrees, cold-soaked overnight. Good — that's better than the manufacturer promises. But the rule doesn't change, because the day it does quit you'll be forty minutes into a crawlspace with no second option. Pen inside the jacket, mark while it's warm, and know the fallback before you need it."* **The rule survives the pen passing. The demonstration of the failure does not, and you must not stage one.**
- Either way, **report the result to the §12.0 evening.** §12.1 asked for this test specifically so seven people aren't told to rely on something untested.

**B. The permanent marker survives 48 hours.** Then the cold open's first line is not "two of them are gone." Slide across the four marks, land on whatever actually degraded, and say: *"Four ways to write a seven, forty-eight hours in a running chamber. Here's what's left of each one."* Then, at 1:32, state the ban as what it is — **the SOP's rule, §3.4** — and give the reason the SOP gives: it is a dye, and it runs when wet and fades under a dehu. **You are allowed to state the company rule. You are not allowed to claim the panel proved it when it didn't.** Note the result and send it to the §12.0 evening: a marker that survives ours is worth knowing before seven people are told it won't.

**C. The painter's tape is still stuck.** Same move. Do not pull harder for the camera. Film the fingertip test once, at whatever resistance it actually has, and take 1:18's line to: *"Tape fails the other direction — it lets go instead of running. Ours held two days in the chamber; the rule is still no tape, because the failure we care about is the one on a job we don't get to re-run."*

#### What to reshoot if something changes

- **None of the six rulings.** Nothing here depends on the tag format, the dry goal, visit cadence, grain depression, scrubber sizing or the billing unit. That is deliberate and it is why this module can go early.
- **The one R1 contamination risk:** if any frame shows a legible machine tag, R1 owns that frame. Check it on the monitor before you leave the panel.
- **The material abbreviation (open question 2) is the module's one real block, and it is priced at one insert.** Shoot 3A as the continuous three-line take **and** shoot the material line separately (see the status block). If the eight-row table changes `GYP`, you reshoot a 5-second insert. If you skipped the insert, you reshoot the whole 18-second overhead.
- **If §3.4's "two inches to the left" number moves**, reshoot 2:00–2:18 only.
- **If the 48-hour panel comes out differently than expected**, nothing is reshot — the VO is written to the frames in the first place. See *If the panel does not fail*.
- **If a pen is chosen by brand and part number (open question 5) after the shoot**, the pen has to be the one in every frame. That is a full reshoot of 5A, 5B, 5C and the Day-0 footage, so **answer open question 5 before you plant Panel A**, not after.
- **The title.** It reads "below freezing" because that is the SOP's rule and what this shoot produces. Appending the January cold tail at 4:45 does not change it.

#### Shot list

1. **1A** — MACRO, tripod, locked AE/AF. Slow slide across Panel A's four marks after 48h (marker smear → curled tape → crisp paint pen → punched flashing). **12s. THE COLD OPEN — shoot before anyone touches the panel.**
2. **1B** — WIDE, handheld. Gloved hand at Panel A, dehu running out of focus behind, **tag not legible**. Taps smear, then paint pen. **14s**
3. **1C** — MACRO INSERT. Paint-pen label filling frame, held. **12s**
4. **2A** — LOCKED WIDE, Day 0 (48h earlier). Four marks going onto Panel A in one continuous take, cut 4×. **12s**
5. **2B** — MACRO, Day 0, **real time**. Pump sprayer soaks the band; hold on the permanent marker bleeding. **14s. The argument-winning shot.**
6. **2C** — WIDE, Day 0. Dehu wheeled in, four feet off, switched on. Dissolves to 1A's frame. **14s**
7. **2D** — MACRO. Painter's tape curled; fingertip lifts it away with no resistance. **14s. ONE TAKE ONLY.**
8. **2E** — A/B cut or split screen: smear vs crisp mark. **10s**
9. **3A** — OVERHEAD gooseneck, clean drywall, gloved hand. Writing `7 / 12" AFF / GYP` in three lines, real time, one continuous take. **18s**
9b. **3A-insert** — SAME RIG, SAME LIGHT, do not move anything. A clean patch; the **material line alone** going on. **5s. Shoot it every time you shoot 3A — it is the only frame an abbreviation ruling can force you to redo.**
10. **3B** — OVERHEAD, pull out. Two pin holes 2" right of label; pin meter set into the same holes. **18s**
11. **3C** — MACRO INSERT, held: `12" AFF`. **16s**
12. **4A** — HANDHELD, lights out, arm's length, headlamp on operator's head. Good label reads; a deliberately small second label does not. **16s. No fill light.**
13. **5A** — FREEZER or exterior, handheld burst. Thermometer/truck gauge in frame at head of shot. Gloved hand; paint pen skips and fails on Panel B. Hold failure 3s. **20s**
14. **5B** — SAME LOCATION. Pen into inside chest pocket nib down, coat zipped; cut; pen out, writes clean. **18s**
15. **5C** — TWO FRAMES, ONE PEN. (a) FREEZER/EXTERIOR, same trip as 5A/5B: **Panel C**, a clean drywall offcut cold-soaked 48h, thermometer in frame; the jacket-warmed pen from 5B writes on it; hold the result 3s. (b) CUTAWAY, shop: heater on a demo'd wall, that same pen on warm gypsum. **14s combined. Shoot (a) before you leave the cold — you do not get a second cold-soaked board that day.**
16. **6A** — FREEZER/exterior. Nail set and hammer punching `7` into aluminum flashing; strip wired to stud. Plus a 2s insert of a plastic tag on a zip tie. **18s**
17. **7A** — SCREEN, iPad portrait, standalone PWA, Airplane Mode. Job home → `📷 Job Photos` tile → editor → `📷 Add photos` → iOS sheet → Take Photo → shoot the punched tag with meter in frame → Use Photo. **14s**
18. **7B** — SCREEN, cropped tight on the new photo card. Type Room `Main Hall`; leave Stage on `During`; type caption `Punched tag, pen would not flow - Main Hall - Loc 7`. Insert of `✓ Saved` pill flicking to `Saving…` and back. **18s**
19. **8A** — CLOSING MACRO. Smear and crisp mark side by side, held, three-line burn-in. **Clean cut out, no music tail, no end card. 13s.** *(Seam for the January cold tail.)*

#### Props and setup

- **PANEL A (plant 48h ahead):** half sheet ½" drywall on two 2×4 stud bays, standing in a mortar tub. Marked with `7 / 12" AFF / GYP` four times at 12" spacing — one per medium. **Build it oversized with two spare sets of four marks** so a soft take is recoverable.
- **PANEL B (plant 48h ahead):** 12"×12" drywall offcut, same four marks, living outside or in a chest freezer for the same 48 hours.
- **PANEL C (plant 48h ahead, beside Panel B):** a **clean, unmarked** 12"×12" drywall offcut, cold-soaked the same 48 hours. This is the cold *wall*, as opposed to Panel B's cold *pen* — beat 3:28 writes on it with a jacket-warm pen to isolate the substrate. **Cut two, so a soft take is recoverable; once a mark is on it, the board is spent.**
- **Oil-based paint pen, medium point — at least three** (one for the jacket-prime beat, one cold-soaked overnight, one spare). **Note on camera and in the VO that this is the OIL PAINT PEN, not the permanent marker** — the same brand makes both and that is exactly how a crew buys the wrong one.
- **Regular permanent marker** (the banned one) — one, for the destructive test only.
- **Blue painter's tape** (the other banned one) — one roll.
- **Aluminum flashing** cut into 1"×4" strips; **nail set or center punch**; **hammer**; **tie wire**.
- **Plastic tags and short zip ties.**
- **LGR dehumidifier**, running, for the 48-hour soak. **ITS ASSET TAG MUST NOT BE LEGIBLE IN ANY FRAME** — face it away or keep it out of frame. This is the single reshoot risk in the module.
- **Pump sprayer**, filled.
- **Pin moisture meter** (for the pin-holes beat and the fallback photo).
- **Thin liner gloves** — worn by every hand in every shot, warm shop included.
- **Headlamp** (the crew's own, not a light stand) for the read test.
- **Thermometer or the truck gauge**, framed at the head of the cold shot so the temperature is on the record.
- **Chest freezer or restaurant walk-in access — OR a 20–28°F dawn.** See open questions; this is the gating dependency.
- **Portable heater and a demo'd or mock wall** for the mark-while-warm cutaway.
- **Company iPad:** Auto-Lock Never, Focus ON, keyboard clicks OFF, Screen Recording with **microphone OFF**, launched from the Home Screen icon, signed in and pulled, then **Airplane Mode** for all takes.
- **A throwaway job** named `TRAINING — DO NOT BILL`. No real customer name, address, claim number or interior appears anywhere in this module.
- **Phone on a flexible tripod**; **overhead gooseneck stand** for the three overhead beats; **white foam board bounce**; **one rechargeable COB panel** (freezer beats only); **sealed ziplock** for the cold-to-warm transition.
- **FREEZE DEPLOYS ON SHOOT DAY.**

#### Camera and sound notes specific to this module

- **Record no narration on location.** The dehu beats are unusable for voice and the freezer is a metal box. Shoot everything MOS against the shot list, then record the whole VO in the truck cab afterward — engine off, **heater fan off**, windows up, coat on, phone 8–10 inches off-axis, ten seconds of silence at the head of the file.
- **Cold camera:** phone inside the jacket between takes, out for 60–90 seconds, back in. Carry it out of the freezer in a **sealed ziplock** and let it warm inside the bag or the lens fogs and you lose the next three setups. Wipe the lens every take.
- **Lock exposure and focus on every macro.** The paint-pen mark against white gypsum will hunt every time a gloved hand enters frame.
- **The 48-hour reveal is one take.** Once a hand has lifted the painter's tape, that shot is gone. **Shoot the whole reveal — cold-open slide, the tape lift, the A/B — before anyone touches the panel.** Build Panel A oversized so you have two more reveals if a take is soft.
- **The one light you need** is the rechargeable COB panel, and only for the freezer beats and the arm's-length read test. Everything else uses the shop's work lights. **The read test is the exception where the headlamp *is* the light — do not add fill to it, or you'll have proved nothing.**

#### Assessment

The check runs inside §12.1's shop day and costs about **ten seconds per tech**, because it is a thing that has to happen anyway.

Right after the module plays, every tech drops their own paint pen into their own inside jacket pocket, **nib down**, and goes to the freezer (or outside) with the mock-room panel. Two minutes later each writes **one three-line label** — their own point number, a height, a material — on the panel. Then the lights go out. You stand at arm's length with a headlamp and read each label aloud.

**PASS:** you read all three lines without stepping in and without asking whose it is.
**FAIL:** you lean in, or a line is illegible, or the mark skips — and the fix is immediate and public, on the panel, in front of everyone, which is worth more than the pass.

**Two secondary tells to watch for and correct on the spot:** a tech who marks **on top of** the pin holes instead of two inches left, and a tech who pulled the pen from a **pants pocket or the truck** instead of the inside of the coat.

**Then the deferred half, on their first real job:** each tech texts you **one photo** — their own paint-pen label with the meter in frame. Fifteen seconds to judge, and it proves the physical mark, the height discipline, the label format and the day-1 photo anchor in a single frame. **That photo is a shot §8's list already requires, so it costs the tech nothing extra.**

**Leonard gets this module in person at the panel, with the printed field card, and never as a link.** The destructive test is watchable standing next to it, and it is **the one training moment in the whole library that needs no app, no screen and no account.**

#### Open questions — M7

1. **Weather — the gating question.** Does the company have access to a chest freezer or a restaurant walk-in for the cold beats? If not, the only honest option is a 20–28°F dawn in late September, and the module ships with a seam for a twenty-second real-cold tail in January. **Answer this before a day is booked**, because it decides whether the module can be shot at all this month.
2. **Material abbreviations are undefined — and this now blocks a beat, not just a card.** §3.4 gives exactly one worked label, `GYP`, and the string appears exactly once in the entire SOP (05-CREW-CAPTURE-SOP.md:172). There is **no abbreviation for the other seven options in the app's Material dropdown** (`core.js:724–733`: Plaster, Concrete / Slab, Hardwood Flooring, Carpet / Pad, Framing / Wood / Subfloor, OSB / Particle Board, Other / Generic). Seven techs will independently invent `FRM`, `FRAM`, `WD`, `SUBFL`, `OSB`, `CONC`, `SLAB` and `CPT`, and none of them will match. **This needs a one-line ruling — an eight-row table, one per dropdown option — BEFORE the field card is laminated.**
   **Decided for the shoot:** beat 1:42 is filmed now, with the material line also shot as a standalone insert, so a ruling change costs one 5-second setup instead of the whole overhead (see the status block). **Still owed by the owner:** the eight rows. **Recorded in §2.3**, beside M7's weather gate and M13's missing artifact.
3. **Two spellings of the same height.** The wall label uses `12" AFF` (§3.4). The app's legend Notes cell uses `12in AFF` (§3.5's canonical string, and again in §10.1's paper-card layout). Same measurement, two spellings, one job — and **this module teaches the wall half while M6 teaches the app half.** Intentional (the inch mark is fine on a wall, awkward in a Notes cell) or drift? If intentional, it should be stated once so a tech who notices does not "correct" one to match the other.
4. **Does a day-1 labeled-point photo need Stage = Before?** §8's shot list marks Stage = Before only on *"Source of loss, every affected room, wide"* and Stage = After only on the final-visit matching shots. The labeled-reading-point photo — which §3.4 calls the third anchor of every point — is unstated, so it lands on the app's `During` capture default and prints in the middle of the packet, away from the before section. **The script leaves it on During because that is what the SOP actually says.** If it should be Before, beat 4:14 needs one tap changed.
5. **Which oil paint pen, by name and part number?** The SOP says "oil-based paint pen" and the shop day hands them out. The whole cold-weather lane rests on one product's low-temperature behavior, and the destructive test only proves the pen that was in the shot. **Whatever brand and tip size gets handed out on shop day is the one that must be in front of the camera, and the module should name it on screen** so a tech restocking at the hardware store buys the same thing and not the permanent marker of the same brand.

---

### M8 — "Outside, unaffected, affected — where you actually stand"

**Track:** every tech (six of seven — see *Leonard* below) · **SOP:** §7.1, §7.3, §5.1–§5.4
**Runtime: 5:42 as the beat table below actually sums.** The original estimate said 5:20 and §3's course table carried it until now; **the table below is the authority, and §3 has been corrected to match.** It trims to **4:57** by cutting the walking shot (C1–C3) from 66s to 45s and beat D (D1–D4, which runs **48s** — 2:14 to 3:02 — not the 36s an earlier draft claimed) from 48s to 24s. That is 21 seconds plus 24 seconds off 5:42. Do that trim only if you need it.
**Shoot time:** about 2h15m across two sessions, plus 25 minutes of voice-over on a later day.
**Status: BLOCKED on two beats out of ten — both scriptable around — and 2:08 of it is outdoors in cold.** See the status block for the ruling gates and *Format and audio* for the temperature decision.

> **⚠ SPLIT POINT (see §3.1).** Beat **E1 ends at 3:20** and F1 opens a new argument, so the module splits there and nothing has to be re-cut:
> - **M8a — the three positions** (beats A–E): the cold open, the three column groups, the walking take, the drift, the warm station. **3:20.**
> - **M8b — the row, and typing it in with nothing blank** (beats F–J): no room field, the dehu outlet, typing it, the one look before you close. **2:22.**
>
> **This split earns more than M5's or M6's: every blocked beat — G3 and G4 (R1) and H3 (R4) — lands in M8b, so M8a ships complete and unblocked today.** **Recommended.**

**After this module a tech can:** take a full psychrometric round for one chamber — hang the hygrometer outside for three to five minutes, read the warm station, read one affected chamber (not an average), take the dehu outlet T/RH — and enter it with no cell left blank.

#### Status block

- **R4 (grain depression) blocks beat H3, about 14 seconds.** The module cannot dodge the GD cell — it fills itself on screen the moment the third pair is typed — and §12.0.4 warns that a tech who believes a normal negative reading is an error will start inventing reference readings, which is the exact failure this module exists to prevent. **Do not film beat H3 until R4 is confirmed.**
- **R4 also reaches beat I1 if H3 is cut.** I1 shows a GD of `−44` and calls it a lie. With H3 in place, H3 has already explained that `−7` is a working chamber and I1 lands correctly. With H3 pulled, the viewer sees `−7`, then `−44` called wrong, and concludes *negative = wrong* — §12.0.4's failure, arrived at from the opposite direction. **I1's narration below is written R4-safe** (it names the zero as the tell, not the minus sign, which is §7.2's own wording), so it ships in either cut — **but do not let anyone re-word it toward the sign.**
- **R1 (asset-tag format) blocks part of beat G, 16 seconds — G3 and G4, 8s each on the beat table.** §7.3's dehu-outlet Notes string carries a tag (`dehu DH-003 outlet 96/14`). Scripted around: the tag is never spoken in narration and appears only in two tight inserts (G3, G4) that can be **re-shot in ten minutes at a desk.** ⚠ **R1 also threatens the 66-second one-take:** C3 stops beside running machines. If any existing asset label on those machines is legible in frame, C3 — and C4 and J1, which are freezes of it — die with the ruling. **Mask or turn away every label in the staged chamber before you rehearse the walk.**
- **R2 (dry-goal rule) is AVOIDED by framing, not blocked.** The Drying Log sheet's second element is `Dry Goal (MC%)`, and its placeholder text reads `≤ 16%` — a table-derived value, which is the half of §12.0.2 the owner has not ruled on. It renders in grey even when the box is empty. **Beat H1 is the only beat whose frame can reach it. Cut the frame at the bottom of the dashed navy box.** Nothing else in this module scrolls the top of that sheet into shot.
- **R3 (daily-visit commitment) is AVOIDED by word choice, not blocked.** The words *"every day"* and *"daily"* are banned from this module's narration; say **"every visit."** M9 owns R3.
- **R5 and R6 do not touch this module.**

**Everything except beats G3, G4 and H3 can be filmed in one shop day — indoors. That is 5:12 of the 5:42.**

⚠ **But 2:08 of that 5:12 is not a shop day at all.** Beats **A4** (8s), **C1–C4** (72s) and **D1–D4** (48s) are outdoors in cold, and the drift beat needs a real cab-to-outside delta. *Format and audio* below sets the actual requirement — visible breath and a genuine delta, met at or below about +25°F — and recommends shooting in the next few weeks rather than waiting for December. **The indoor 3:04 — A1–A3, B, E, F, G1/G2, H1/H2, I, J — can be shot today, and should be, because it is the half that owns the tablet and it does not care what month it is.** Cut the module in two sessions on purpose: a screen-and-shop session now (§4.5 session 8), a cold session batched with M7's (§4.5 session 5b).

#### Why this is a video and not a paragraph

The three column groups are a **spatial fact** — three physical positions in a building. Text has been failing to teach it, which is why rows go out with the Unaffected pair blank. One continuous walking shot, truck → warm station → chamber, does in sixty-six seconds what §7.1's table has not done. The hygrometer drift is also only convincing when you watch the number move.

#### The finding that changes this module — verified in code, and it is a credit to the crew

`apps/field/js/completeness.js:75–84`. The completeness panel **hard-gates** `dl_outT`, `dl_outRH`, `dl_affT`, `dl_affRH`. It gates `dl_gd` **soft**. **There is no requirement on `refT` or `refRH` anywhere in the file.** The one column group the app never asks for is the one that goes out empty. **That is a mechanism, not carelessness, and the narration says so out loud in beat B.** It is also why §12.5 proposes `dl_ref` as a Wave-0 rule that *"does not exist in code today."*

Two more code facts the script is built on, both verified:

- `core.js:705` — `gpp("","")` returns **0**, not null, because `Number("")` is 0 and 0 is finite. `forms.js` calls `recalc()` while building every row, so **a brand-new psychrometric row shows GPP 0 / 0 / 0 and GD 0 before anything is typed.** That is the cold open, and it is real.
- `anyInstanceRow` (`completeness.js:31`) — the hard gates pass if **any one row on any one log** holds the field. **A twelve-visit job passes on visit 1 alone.** The panel cannot tell you today's row is complete.

#### Pre-flight — do these or lose takes

1. **Settle R4 before shoot day.** Beat H3 is unfilmable until it is confirmed.
2. **iPad:** Auto-Lock Never. Focus ON. Keyboard clicks OFF. Screen Recording in Control Center. Launch **from the Home Screen icon**.
3. **Sign in and pull the `TRAINING - DO NOT BILL` job online, then Airplane Mode for every take.** See §4.3. **Freeze deploys.**
4. **Build the throwaway job once.** `+ New Job` reuses any existing blank job of the current mode, so it will not reliably give you a clean one on take 3.
5. **Shoot the cold open FIRST**, on a genuinely untouched row. Once you type into it you cannot get the virgin `0/0/0/0` state back without deleting the row (`✕`, no confirm) and tapping `+ Add reading` again.
6. **Test the hygrometer at the temperature you plan to shoot.** §5.1 says most field units are not rated below freezing. If yours blanks at −10°F, shoot the drift beat at +10 to +25°F. Pedagogically identical; you just need to know **before the truck is running.**
7. **Phone and a battery pack live inside the jacket between takes.** An iPhone reads full and drops to zero in minutes at −20°F. **The drift beat is scripted as three short bursts with a clock in frame, not one four-minute locked take**, specifically because the four-minute take is the one that dies.

#### Format and audio

1080×1920 portrait, H.264, 30fps. Lock exposure and focus on every take. Wipe the lens every take; carry the phone out in a sealed bag and let it warm inside the bag before opening.

**All narration is voice-over**, recorded in the truck cab on a later day — engine off, **heater fan off**, windows up, phone 8–10 inches off-axis, ten seconds of silence at the head of each file. Beats C and F have air movers running at 65–75 dBA; no lav survives that. **Wear the lav anyway on C and D and keep the track as ambience** — boots on snow, breath, the machines — mixed low under the VO.

**Cold is not faked, and here is exactly how cold it has to be.** Beats **A4, C and D** are shot outdoors, in the actual gear, with real breath and real gloves. What those beats actually need is two things, and neither of them is a specific number: **visible breath in frame**, and **a real delta between a 70°F cab and the air outside** so the drift in D2 is a drift and not a rounding error. Both are comfortably satisfied anywhere at or below about **+25°F**, which in Fairbanks is a late-September dawn.

**So pick one, before a day is booked:**

- **Shoot at +10 to +25°F in the next few weeks.** You get the module. The drift is real, the breath is real, the gloves are real, and pre-flight item 6 is already written for this case because most field hygrometers are not rated below freezing anyway (§5.1). **This is the recommendation.**
- **Hold for a genuine −20°F day.** The footage is better and it is unarguable. It costs you the module until November, and it puts a 66-second one-take and a four-minute drift shot on a day when the phone battery is the constraint.

**What is not on the menu is faking it.** No breath in post, no colour grade standing in for weather, and **no shooting D2 in a warm shop with the number walking the wrong way.** If you shoot warm-side, say nothing about the temperature in narration — the burn-in `SPED UP — REAL TIME 4 MIN` is the only claim the beat makes, and it stays true at any temperature.

**Beat H is warm, clean and gloves-off because that is what the warm station is** — the module's own structure is the acknowledgment, and the narration names it.

#### The shooting script

| TIME | VISUAL | AUDIO |
|---|---|---|
| **A — COLD OPEN** | | |
| 0:00–0:05 | **A1.** Tight overhead, desk, no lighting kit — bounce the shop's work light off white foam board. A printed Drying Log page from the `TRAINING - DO NOT BILL` packet. Your thumb tracks down the **Unaffected (Ref.) GPP** column: `0` `0` `0` `0`. No titles, no logo, no music. | "Nobody typed that zero." |
| 0:05–0:12 | **A2.** Thumb slides right to the **GD** column: `−44`. Hold two seconds. Hard cut to the iPad: the psychrometric table, a **brand-new row**, nothing entered — three pale-orange GPP cells reading `0`, the GD cell reading `0`. | "The app did. Brand new drying log, nothing entered, and the grain columns already say zero. Grain depression already says zero." |
| 0:12–0:22 | **A3.** Cut back to the printed page. Slow push in on that `−44`. | "Leave the middle pair blank and it just stays zero. On the page the adjuster reads, that doesn't look like a gap. It looks like a reading we took." |
| 0:22–0:30 | **A4.** Cut to you, outdoors at the truck, hygrometer in hand, breath visible. First and only card: **navy plate, orange numeral, white text — "5 MINUTES"** bottom third. | "Five minutes. At the end of it you can take a full round for one chamber with nothing left blank." |
| **B — THREE GROUPS ARE THREE PLACES** | | |
| 0:30–0:44 | **B1.** SCREEN, iPad portrait. The psychrometric table, scrolled so the header stack fills frame. Push in on the top header row. In post, isolate each group with a 0.5s orange underline as it is named: **`Outside / Ambient`** … **`Unaffected (Ref.)`** … **`Affected`**. | "Look at the header. Outside slash Ambient. Unaffected — Ref. Affected. That's not three ways of saying the room. That's three places you stand." |
| 0:44–1:02 | **B2.** Cut to the **completeness panel** at the top of job home — red left border, ⚠️, header reading **`Not yet billable — N required item(s) missing.`** with the count `x/y` at the right, chevron **▾** (expanded). Under **`Required — blocks billing`**, insert-crop these four lines, exactly as the app writes them, form name and all **and in this order** — **`Drying Log: Affected-area temp (psychrometric)`** · **`Drying Log: Affected-area RH (psychrometric)`** · **`Drying Log: Outside temp (psychrometric)`** · **`Drying Log: Outside RH (psychrometric)`**. *(`evaluateProject` pushes gaps in `REQUIREMENTS` order and the matrix runs `dl_affT`, `dl_affRH`, `dl_outT`, `dl_outRH` — `completeness.js:213–221`, `:75–81` — so that is the order on screen. Do not reproduce them outside-first.)* **Hard cut to the same panel after those four have been typed in — the four lines are gone, the list is four items shorter, and the Unaffected pair is still blank on the row.** Hold three seconds on the shorter list.<br>⚠ **The "before" state is reachable only in the window the props build.** These four gates read **any** row on **any** drying log (`anyInstanceRow`, `completeness.js:31`), so the lines exist only while **no** psychrometric row anywhere on the job holds an Outside or Affected value. That is true after **props step 0** (M5's leftovers torn down) and **props step 2** (the printed page's four rows deleted), and it stops being true the moment H2 types. **Shoot B2's before state between step 2 and step 3, and never after H2.** | "Here's why it's always the middle one that's blank. This panel only lists what's *missing*. Right now: affected temp, affected RH, outside temp, outside RH. Type those four in — and the panel goes quiet. It never asked for the Unaffected pair. Not soft, not at all. The group nobody gets prompted for is the group that goes out empty. That's the app. That's not you." |
| **C — THE WALKING SHOT (one continuous take)** | | |
| 1:02–1:20 | **C1.** *One shot, no cuts, 66 seconds, handheld, portrait, shot MOS.* Start at the truck, outdoors, engine running, real cold. Your hand hangs the thermo-hygrometer on the mirror, then the camera holds three seconds on it swinging. **Lower third: `1 — OUTSIDE, AT THE TRUCK`** (navy plate, orange numeral). | "Same visit. Watch where I go. One. Outside, at the truck, before you go in. The hygrometer's already hanging — I put it there when I parked." |
| 1:20–1:42 | **C2.** *Same unbroken take.* Camera follows through the exterior door into the building. Fog on the lens for a beat is fine — **leave it in.** Into the first dry interior room. Rest the tablet on a surface. **Lower third: `2 — UNAFFECTED, THE WARM STATION`.** | "Two. First unaffected room inside the door. Not the wet one. This is the warm station. The tablet lives here, and it stays here." |
| 1:42–2:08 | **C3.** *Same unbroken take.* Camera leaves the tablet behind, walks through the doorway into the staged chamber — air movers running, plastic moving, dehu droning. Stops beside the wet panel. **Lower third: `3 — AFFECTED, ONE CHAMBER`.** Hold four seconds on the running machines, no narration. | "Three. Into the chamber. One chamber. And this is where the readings actually get taken — standing in it." |
| 2:08–2:14 | **C4.** Freeze the last frame; the three lower-third plates stack up the right edge as 1, 2, 3. Dissolve to the header stack from B1, the three groups underlining in the same order. | "Three positions. Three column groups. Same order, left to right, every visit you make." |
| **D — POSITION 1: THE DRIFT** | | |
| 2:14–2:22 | **D1.** Locked tripod, hygrometer hanging on the truck mirror, a cheap analog clock or a phone stopwatch in the same frame. Tight enough to read the display. Cold. | "Why it hangs there first. That came straight out of a seventy-degree cab. Watch it." |
| 2:22–2:36 | **D2. The money shot.** Three bursts from the locked position — 0:00, ~2:00, ~4:30 by the in-frame clock — cut together as a speed ramp so the number visibly walks down. **Burn-in bottom left: `SPED UP — REAL TIME 4 MIN`.** Honest, and it removes the "is this a trick" question. | "That's four minutes, sped up. Read that on the way out of the truck and you've written down the inside of your cab and called it outside air." |
| 2:36–2:50 | **D3.** You walking away from the hanging hygrometer toward the house, gear in hand. Then back to it later, reading it. | "Three to five minutes. Hang it when you park, do your gear, come back to it — it costs you nothing." |
| 2:50–3:02 | **D4.** Insert: a hygrometer display that is blank / dashed / obviously wrong (**stage this by pulling the battery — do not fake a number**). Then the truck's own dash temperature gauge. | "If it blanks or stalls or reads something impossible — most field hygrometers aren't rated below freezing — put the truck's temperature in and write it in the notes: outside instrument out of range, estimated from truck gauge. Never invent an RH." |
| **E — POSITION 2: THE WARM STATION** | | |
| 3:02–3:20 | **E1.** Interior, dry room. Wide, then a hand pulling a glove off and picking up the stylus. Hygrometer sitting on a surface, not held. | "Second position. Unaffected interior room, same building, dry side. This is where the tablet lives, where the gloves come off, and where everything that isn't a bare number gets typed. Read T and RH standing here. Not remembered from the hallway." |
| **F — POSITION 3, AND THE ROW THAT CAN'T NAME A ROOM** | | |
| 3:20–3:32 | **F1.** SCREEN. Jobs list → tap the `TRAINING - DO NOT BILL` card → job home → scroll the tile grid → the **💧 Drying Log** tile (badge reads `1 saved`) → tap it. Form list appears: header **`💧 Drying Log`**, blue **`+ New`** top right, **exactly one row**, titled **`Drying log — <shoot date>`** (the title is the log's first psychrometric row's date, `app.js:1858` — props step 0 cleared M5's rows, so it now reads the date you rebuilt on). **Hover the stylus over `+ New` and pull away.** Tap the row. ⚠ **If two rows are in that list, props step 0 was skipped — stop and delete the second log before you roll**; the narration under this shot says there is only ever one. | "Getting there: job, then the blue drop tile, Drying Log. There's one drying log on this job and there is always one. Don't tap plus New. Tap the row." |
| 3:32–3:42 | **F2.** In the chamber, camera on the running units. You read the hygrometer at chest height in the middle of the chamber. Then a second doorway with a second set of machines behind it. | "Third position. Inside the chamber. One chamber — the one you're standing in. Not an average of the house. Two wet chambers is two rows on the same date. Plus Add reading, not a second log." |
| 3:42–4:00 | **F3.** SCREEN. Swipe the psychrometric table **horizontally**, slowly, left to right, naming the columns as they pass: Date, Time, T RH GPP ×3, GD, Dehu, AM, Scrb, Tech, Notes. Land on the Notes textarea, far right. **Show the swipe explicitly** — you cannot see Notes without it. | "And there's no room field on this row. Watch the whole thing go past — date, time, three T-RH-GPP groups, GD, three counts, tech, notes. That's everything there is. So the first thing in that Notes cell is the chamber name, copied off the panel card. Two rows on the same date with nothing in Notes are the same row to anybody reading the printed page." |
| **G — THE DEHU OUTLET · ⚠ R1** | | |
| 4:00–4:10 | **G1.** In the chamber. Hand holding the hygrometer probe into the dehumidifier's **discharge**. Then into the intake. Real machine, real noise. | "One more reading while you're at the machines. The carrier wants to know the dehu is actually doing something — air coming out should be a lot warmer and a lot drier than the air going in." |
| 4:10–4:18 | **G2.** SCREEN: slow scroll down the psychrometric header stack, looking for a column that isn't there. Land back on Notes. | "There's no column for it. Not in this app, and not in the one that's planned. So it goes in the Notes, after the chamber name." |
| 4:18–4:26 | **G3. ⚠ BLOCKED — R1.** Tight insert, 8s: a lead tech's gloved hand on the dehu housing, wiping frost off the **asset label** and reading it. **Frame so the label fills less than a third of frame and is legible for two seconds only.** | "Read the tag off the machine. Not one you remember." |
| 4:26–4:34 | **G4. ⚠ BLOCKED — R1.** Tight insert, 8s: the Notes cell, stylus typing `Basement Utility - dehu DH-003 outlet 96/14`. **Shoot as a standalone crop, not inside a longer take.** | "Chamber name, then dehu, then the tag, then outlet, then temperature slash RH. One entry per machine. Nothing computes it — it's a string a human reads later, so type it the same way every time." |
| **H — TYPE IT IN · ⚠ R4** | | |
| 4:34–4:42 | **H1.** SCREEN, top of the Drying Log editor. **Cut the frame at the bottom of the dashed box — do not let the sheet below it into shot (R2: the `Dry Goal (MC%)` placeholder reads `≤ 16%` even when empty).** In frame: **`💧 Drying Log`**, the **`✓ Saved`** pill top right, and the dashed navy box with the **`🎙️ Transcribe`** button and the hint *"Speak your log — tap to confirm the values."* Tap it once. The toast reads, in full: **"No connection — voice needs internet. Your typed entries are saved."** Hold until it clears on its own (2.2s). ⚠ **Relaunch the PWA from the Home Screen icon AFTER Airplane Mode is on and before you roll** — the offline gate needs the network-proof clock reset, and without it the tap starts a real recording or opens the tech picker instead of toasting. | "That mic button at the top — leave it. Readings get typed. Dictation drops the number into the next empty column no matter which location you said, and out here it usually just fails anyway. Which is what it just did — and read the rest of that line. *Your typed entries are saved.* Typing is the half that works out here. The microphone isn't." |
| 4:42–4:58 | **H2.** Warm station, gloves off, tablet flat. SCREEN, one continuous take. Type Outside `22` / `68` — the orange GPP cell snaps to **12**. Unaffected `70` / `34` — snaps to **37**. Affected `78` / `31` — snaps to **44**. GD fills **−7**. Insert-crop the pill going grey **`Saving…`** then green **`✓ Saved`**. | "Now type it. You didn't touch a single orange cell. Grains filled itself three times, grain depression filled itself. Never do either one by hand. And there's no save button on this thing — the pill top right is the save." |
| 4:58–5:12 | **H3. ⚠ BLOCKED — R4.** Hold on the GD cell reading `−7`. In post, an orange bracket around the Unaffected GPP `37` and the Affected GPP `44`. | "That GD came out minus seven, and that is a working chamber, not a mistake. A drying chamber is deliberately warm, and warm air holds more grains at the same RH — so the affected side normally reads higher than your dry reference. It climbs toward zero and through it as the job dries. The big positive number people quote is the dehu's own inlet-minus-outlet, and that's the string you just put in the Notes." |
| **I — ONE LOOK BEFORE YOU CLOSE** | | |
| 5:12–5:30 | **I1.** SCREEN, the finished H2 row. Stylus traces it left to right, cell by cell. Then, **on that same row, backspace the Unaffected RH cell empty** and hold tight on the two pale-orange calc cells as the digits go: Unaffected GPP walks **`37` → `3` → `0`**, GD walks **`−7` → `−41` → `−44`**. No dialog, no colour change, no warning, no save prompt — the pill just goes `Saving…` then `✓ Saved`. Hold two seconds on **`−44`**: the same number as the printed page in A3. Then retype `70` (nothing moves) and `34` (GD snaps back to `−7`). **This beat consumes and then repairs the H2 row — shoot it after H2 is in the can, and leave the row correct.** | "Before you close it — one look along your own row. Now watch. I'm not deleting a reading. I'm deleting one number. Unaffected grains: zero. Depression: minus forty-four — that's the page from the start of this. Nothing warned me. That number didn't come from a reading, it came from an empty box. The tell isn't the minus sign. It's the zero above it. Type both back in — one won't do it." |
| **J — THE ONE THING, AND THE CHECK** | | |
| 5:30–5:42 | **J1.** Back to the frozen three-position stack from C4. Hold to the last frame. **No end card, no logo, no music tail.** | "One thing out of this: **three positions, three column groups, and no cell ever goes out blank** — because a blank doesn't print blank, it prints zero, and a zero reads like a measurement.<br><br>On your next visit, do a full round on one chamber and text me the row. I'm going to look at one thing: whether the middle pair has numbers in it." |

> **⚠ NOTE ON THIS BEAT.** J1's narration, and the shot list, props, assessment and open questions below, were **reconstructed** — the source material for this module was cut off mid-sentence at J1.
>
> **Re-derived and stood behind, 2026-09-07.** Every clause of J1 traces to something this module or the SOP already establishes: *three positions / three column groups* is §7.1's table and beats C1–C4; *no cell ever goes out blank* is §7.1's own sentence verbatim; *a blank doesn't print blank, it prints zero* is `gpp("","")` computing through to 0 (`core.js:705–715`) landing on a printed page that renders input values (`print.css:112`); *a zero reads like a measurement* is §7.1's phrasing. **It is R4-safe** — it makes no claim about the sign of a grain depression — and **R3-safe**: it says *"your next visit,"* never *daily.* It carries no production statistic. **Record it as written.**
>
> **One thing it does that needed checking and passes:** the closing ask (text me one row) looks at first like an eighth check bolted onto §7.2's seven, and §7.1's design rule is absolute — *every check is something that already had to happen anyway.* It survives on the same logic as **A3**: the psychrometric round already had to happen on the next visit; the screenshot is the *observation* step, exactly as A3's photo is one §8's shot list already required. **The ongoing check is still A6**, and the Assessment section below now says so in that order rather than the reverse.
>
> **What did not survive re-derivation is beat I1's `NaN` insert and the Assessment's `NaN` line — both were correctly reconstructed from SOP §7.2, and §7.2 is wrong.** See open question 6.

#### Shot list

1. **A1** — INSERT, overhead, desk, foam-board bounce. Printed Drying Log page; thumb tracks down the Unaffected GPP column reading `0 0 0 0`. **5s. Shoot before anything is typed.**
2. **A2** — INSERT continues to the GD column `−44`, hold 2s; hard cut to SCREEN, a brand-new psychro row showing GPP `0/0/0` and GD `0` untouched. **7s. One-way — the virgin row is consumed the moment you type.**
3. **A3** — INSERT, slow push on the printed `−44`. **10s**
4. **A4** — CAMERA, outdoors at the truck, hygrometer in hand, breath visible. "5 MINUTES" card. **8s**
5. **B1** — SCREEN, psychrometric header stack, push in; three post underlines. **14s**
6. **B2** — SCREEN, completeness panel at the top of job home, expanded (chevron **▾**). Insert-crop the four `Drying Log: …` lines under **`Required — blocks billing`** — **in matrix order: affected temp, affected RH, outside temp, outside RH**; hard cut to the same panel after those four fields have been typed, with the four lines gone. **Two states, one cut. The "before" state only exists while NO psychrometric row on ANY log holds an Outside or Affected value — so it exists between props step 2 and step 3, and only if props step 0 has cleared M5's leftovers. Shoot it there, and never after H2.** **18s**
7. **C1–C3** — **ONE CONTINUOUS HANDHELD TAKE, 66s, MOS.** Truck → exterior door → dry interior room (set the tablet down) → doorway → staged chamber with machines running. Three lower thirds added in post. **Rehearse the walk once; do not cut it.** ⚠ **Mask or turn away every existing asset label in the staged chamber first** — a legible tag in C3 puts this take, C4 and J1 behind R1.
8. **C4** — Freeze of C3's last frame; three plates stack; dissolve to B1's header stack. **6s**
9. **D1** — CAMERA, locked tripod. Hygrometer on the truck mirror with a clock or stopwatch in frame. **8s**
10. **D2** — Three bursts from the same locked position at 0:00 / ~2:00 / ~4:30, cut as a speed ramp. Burn-in `SPED UP — REAL TIME 4 MIN`. **14s. The money shot.**
11. **D3** — CAMERA, you walking away from the hanging hygrometer, then returning to read it. **14s**
12. **D4** — INSERT, a hygrometer display blank or dashed (**pull the battery — do not fake a number**), then the truck's dash gauge. **12s**
13. **E1** — CAMERA, dry interior room, wide then hands: glove off, stylus picked up, hygrometer resting on a surface. **18s**
14. **F1** — SCREEN: Jobs list → job card → job home → `💧 Drying Log` tile → form list; stylus hovers `+ New` and pulls away; taps the row. ⚠ **The list must show exactly ONE row** — the narration says so out loud, and M5's beat G1 left a second log on this job. Props **step 0** deletes it; confirm the list before you roll. **12s**
15. **F2** — CAMERA, in the chamber: reading the hygrometer at chest height mid-chamber; then a second doorway with a second machine set behind it. **10s**
16. **F3** — SCREEN: slow horizontal swipe across the whole psychrometric table, landing on the Notes textarea at the far right. **18s**
17. **G1** — CAMERA, chamber: probe into the dehu discharge, then the intake. Real noise. **10s**
18. **G2** — SCREEN: slow scroll down the header stack, back to Notes. **8s**
19. **G3 — ⚠ R1.** INSERT, tight, 8s: gloved hand wiping frost off the dehu's asset label. **Label under one-third of frame, legible 2s only. Do not shoot until R1 lands.**
20. **G4 — ⚠ R1.** INSERT, tight, 8s: stylus typing `Basement Utility - dehu DH-003 outlet 96/14` into the Notes cell. **Standalone crop. Do not shoot until R1 lands.**
21. **H1** — SCREEN, top of the Drying Log editor, **frame cut at the bottom of the dashed box (R2)**: `🎙️ Transcribe` in its dashed navy box; tap once; the toast reads **"No connection — voice needs internet. Your typed entries are saved."** **Relaunch the PWA after Airplane Mode and before rolling, or the toast will not fire.** **8s**
22. **H2** — SCREEN, one continuous take, warm station, gloves off: type Outside `22`/`68` → GPP 12; Unaffected `70`/`34` → 37; Affected `78`/`31` → 44; GD fills `−7`. Insert-crop the `Saving…` → `✓ Saved` pill. **16s**
23. **H3 — ⚠ R4.** SCREEN, hold on GD `−7` with a post bracket around `37` and `44`. **14s. Do not shoot until R4 is confirmed.**
24. **I1** — SCREEN: stylus traces the finished H2 row left to right; then backspace the Unaffected RH cell empty on camera — Unaffected GPP `37`→`3`→`0`, GD `−7`→`−41`→`−44`, no dialog — hold on `−44`; retype `70` then `34` to restore `−7`. **18s. Shoot after H2. Leave the row repaired.**
25. **J1** — Freeze of C4's three-position stack, held to the last frame. **12s. Clean out, no end card.**

#### Props and setup

- **Company iPad**, standalone PWA from the Home Screen icon, Auto-Lock Never, Focus ON, keyboard clicks OFF, Screen Recording with **microphone OFF**, signed in and the training job pulled, then **Airplane Mode for every take**. **Deploy freeze.**
- ⚠ **STEP 0 — TEAR DOWN WHAT SESSION 6 LEFT. Do this before step 1 of the build, and before anything else on tablet-C day.** This module is the fourth to run on the shared training job (§4.4) and **M5 leaves two things on it that make three of M8's beats false on camera**:
  - **A second Drying Log.** M5's beat G1 creates one deliberately and never removes it. **F1 narrates *"There's one drying log on this job and there is always one"* over a list that would show two rows**, and step 1 below says *the job's one Drying Log.*
  - **A filled psychrometric row.** M5's props put Affected `78`/`31` and Outside `-22`/`60` on that log's row 2, and M5's beat J then fills the Unaffected pair as well. **The four hard gates behind B2's "before" panel state read *any* row on *any* log** (`anyInstanceRow`, `completeness.js:31`; the gates at `:75–82`), **so B2's before state does not exist while that row does.**

  **The teardown, about two minutes:** open the **second** log, scroll to the sticky action bar at the bottom of the editor, tap the red **`Delete`** and confirm *"Delete this Drying Log? This cannot be undone."* (`app.js:1939`, `app.js:1946`). Then open the surviving log and tap the **`✕`** on **every** psychrometric row (`.rowdel`, no confirm) until the table is empty. **Do not sign out to reset the job** (§4.8) — signing out re-pulls the server copy and discards every unpushed change made that day. ⚠ **If you are also shooting M1 Shot 2 in this session, shoot it on that second log's empty equipment table *before* you delete the log** — M1 Shot 2 needs its own four-row state with all four Type strings, M5 left twelve rows on the first log, and the second log is the only clean equipment table on the job.
- **The training job** `TRAINING - DO NOT BILL`, built in this order and no other, **starting from the state step 0 leaves**:
  1. **The printed page for A1 and A3, first.** On the job's one Drying Log, make **four psychrometric rows** (tap `+ Add reading` until the table holds four — step 0 emptied it). On each row fill **Outside T/RH** and **Affected T/RH** and **leave the Unaffected pair empty**. Use `78`/`31` on the first row so its GD prints exactly **`−44`**, and vary the other three so the column is not four identical numbers. The Unaffected GPP column will read `0 0 0 0` on its own. Then job home → **`📄 Full job packet (PDF)`** → **`⬇ Save packet as PDF`** → the AirPrint sheet (§4.8 item 8 — the `DRYING LOG` letterhead is print-only and does not exist on screen). **Print it on paper.** That sheet is the prop for A1 and A3 and it is the only thing on this list that leaves the building.
  2. **Then delete all four rows** (`✕` on each — no confirm, they are gone) and tap **`+ Add reading`** once. That row is the **untouched row for the cold open**: `0` / `0` / `0` in the three pale-orange GPP cells and `0` in the GD cell, before anything is typed. **Do not type into it before A2 is in the can.** It cannot be recovered except by deleting the row and adding another.
  3. **Then `+ Add reading` for a second row — this is B2's row and H2's row, in that order.** Shoot **B2's "before" panel state now**, while no row on the job holds an Outside or Affected value; the four hard gates read any row on any log, so the moment one row is filled the panel is quiet for the rest of the shoot. Then type Outside `22`/`68` and Affected `78`/`31` into it, leaving Unaffected blank, and shoot **B2's "after" state**. Type Unaffected `70`/`34` last — the row is now H2's finished row, and I1 breaks and repairs it.
  4. **Leave `Dry Goal (MC%)` empty and shoot nothing that frames it** — the placeholder reads `≤ 16%`, which is the unruled half of R2.
  5. **There is no `NaN` row.** The GD cell is a number input; it renders `NaN` as blank and cannot be made to show the letters. See open question 6.
  6. **Check the completeness panel's chevron reads `▾` before rolling B2.** The fold state is remembered per device.
- **A printed packet page** from step 1 above — Unaffected GPP column `0 0 0 0`, GD `−44` — for beats A1 and A3. **Print it before you fix anything, and print it from the training job**: see open question 4.
- **The staged chamber's machines with every asset label masked or turned away**, so C1–C3, C4 and J1 do not depend on R1.
- **Thermo-hygrometer** — the crew's actual field unit, not a lab instrument. **Test it at the shoot temperature first** (§5.1: most field units are not rated below freezing).
- **A spare battery or a way to pull the hygrometer's battery**, for D4's honest failure display.
- **A cheap analog clock or a phone stopwatch** that reads clearly in frame, for D1/D2.
- **The truck**, with a working dash temperature gauge, engine running for C1's exterior beat and **off** for the VO session.
- **A staged chamber** — the wet panel prop plus at least two air movers and one LGR dehu, running, behind plastic if you have it. It also needs **a second doorway with a second machine set visible** for F2's two-chamber line.
- **A dry interior room** that can serve as the warm station, with a surface to set the tablet on.
- **Tethered capacitive stylus** and **thin liner gloves**.
- **Phone on a flexible tripod** for D1/D2; handheld for C1–C3; **overhead gooseneck stand and white foam board** for A1/A3.
- **Sealed ziplock** and a jacket pocket for the phone between cold takes.
- **No lav needed for delivery** — everything is VO. Wear one on C and D for ambience only.

#### Cold, wet, gloved — what this module gets right and what it admits

This is the module where the conditions matter most, and it is honest about the split:

- **Beats C, D, F, G are cold, gloved, loud and handheld.** Shoot them that way, at whatever the actual temperature is. Fogged lens on the way in, breath, boots on snow — keep all of it.
- **Beat H is warm, dry, clean and gloves-off, and the narration says why: that is what the warm station is.** The SOP's whole glove-economy argument (§5.2, §5.3) is that everything which is not a bare number gets typed in a warm room. Filming H in a warm room is not a cheat; it is the rule being demonstrated.
- **Beat E is the hinge** — the shot of a glove coming off and a stylus being picked up is the visual definition of the warm station, and it is eighteen seconds well spent.

#### Assessment

**One check on the first round, and then a standing one that costs nothing.**

On the tech's next monitoring visit, they do a full psychrometric round on **one** chamber and text you a screenshot of that row. Fifteen seconds to judge. This is §7.2's **A3** logic applied to a row instead of a photo: the round already had to happen; the screenshot is only the observation step. Look at exactly four things:

1. **The Unaffected pair has numbers in it.** This is the whole module. Blank here is a fail, full stop.
2. **No GPP cell in the Unaffected or Affected column reads `0`.** Those are warm interior readings and cannot compute to zero. **Do not apply this to the Outside column** — outside air at −40°F and 40% RH genuinely rounds to `0`, and at −20°F to `2`. A single-digit Outside GPP in January is a correct reading, not a gap.
3. **The GD is not exactly the Affected GPP with a minus in front.** `GD = Unaffected GPP − Affected GPP`, so a blank Unaffected pair makes Unaffected GPP `0` and GD exactly `−(Affected GPP)`. That equality is the fingerprint of a blank, and it is the only one you can spot without opening the job. **A negative GD on its own is normal (§7.2) — the equality is the tell, not the sign.**
4. **The Notes cell starts with a chamber name.**

**Pass** = all four. **Fail on 1** = phone call the same day, because a blank Unaffected pair on a row already saved is a false negative GD sitting in a live file, and it takes twenty seconds to fix while the tech still remembers the reading.

**Do not quiz the three positions.** They are either walked or they are not, and the row shows which.

**The standing check is §7.2's A6, and it is the one that keeps running after the first round.** §12.4's Friday office check opens every job anyway. Ten seconds per job: *does every psychro row have a number in the Unaffected pair, and does every Notes cell start with a chamber name?* That measures exactly what this module taught, on real billable work, on a day you are already at the screen — and the row's own **Tech** column and the initials in the moisture Notes tell you whose it is (§5.6). **The texted row is the one-time confirmation; A6 is the program.**

#### Leonard

**This module reaches six of seven techs.** Leonard's psychrometric readings land on the paper Drying Visit Card's psychrometrics block (§10.1), which already carries `Chamber | Date | Time | Out T/RH | Unaffected T/RH | Affected T/RH | Dehu # | AM # | Scrb # | Tech | Notes` — **and the card's columns are printed, so he cannot leave the Unaffected pair blank without leaving a visible empty box that the transcriber will phone him about.** The paper lane is structurally better at this than the app is.

**What he needs in person:** the three positions, walked, on a real job, once. That is §12.2's ride-along and it costs nothing extra. **Do not send him a link.**

**The person who needs the app half of this module is the transcriber**, who types his card into the app and can leave the Unaffected pair blank exactly as easily as anybody else. See §6.

#### Open questions — M8

1. **R4 must be confirmed before beat H3 is filmed.** §12.0.4 calls it "settled — confirm it once." Until you do, the module ships at 5:28 with a hole where its explanation of the GD cell should be, and a crew that sees `−7` with no explanation is exactly the crew §12.0.4 warns about.
2. **R1 must land before beats G3 and G4.** These are ten minutes of pickup at a desk, so they can be shot after the rest of the module is cut. **Do not hold the whole module for them** — cut it with a two-second gap and drop them in.
3. **Where does the dehu-outlet reading actually go when there are two dehus in one chamber?** §7.3 says "one entry per dehu" and the Notes order (§4.2) gives the outlet a single slot. Two dehus means two strings in one slot, and the SOP does not say whether they are comma-separated, semicolon-separated, or on separate rows. The script shows one. **Rule it, or the seven techs will invent three conventions.**
4. **Is the printed `0 0 0 0` page in beats A1/A3 from a real job or the training job?** The script says training job, printed before you fix anything. **If you want the real page for its weight, the customer name, address and claim number have to be cropped or redacted before it goes in front of a lens** — and it will be on seven personal phones afterward. My recommendation is the training job; the argument does not get stronger with a real name on it.
5. **The runtime discrepancy — settled.** The estimate that came with this module said 5:20; the beat table sums to 5:42, and §3's course table has been corrected to match. **The table is the authority.** If you want it under 5:00, the two named trims (walking shot 66s→45s, beat D **48s**→24s — beat D runs 2:14 to 3:02, and an earlier draft called it 36s, which is why the old arithmetic did not reach 4:55) get you to **4:57** without cutting a beat. Decide before the edit, not during.
6. **SOP §7.2's `NaN` grain-depression paragraph is wrong, and it needs an owner correction — not a beat.** §7.2 says *"the reference grain value can be missing and the cell fills with `NaN` instead,"* and the v1.3 change log lists it as one of four §13 gaps that were given an instruction. **The app cannot produce it.** The GD cell is `<input type="number">` (`forms.js:767`), which renders any non-numeric value — `NaN` included — as an empty box; `gpp()` returns `0` rather than `null` for a blank pair (`core.js:705–715`), so the reference grain value is never actually missing; and `recalc()`'s guard (`forms.js:759`) will not write a GD unless both grain values are non-empty. The instruction it produced — *"glance at the GD cell, it has to be a number"* — sends a tech looking for a string that cannot appear, and it is on the field card's back. **Correct §7.2 to the real failure, which is the one this module now films:** a blank Unaffected pair makes Unaffected GPP `0` and drags GD to exactly minus the Affected GPP. §7.2 already states that mechanism two paragraphs earlier; the `NaN` paragraph contradicts its own better sentence. **Do this before the field card is laminated (§2.4).**
7. **The weather decision has to be written down somewhere.** 2:08 of this module (A4, C, D) is outdoors. *Format and audio* above now gives two options and recommends +10 to +25°F this month. **Pick one and write it into §4.5's shoot order**, because the same answer decides whether M7's cold shots batch with it (§4.5, row 5) and whether this module ships in September or November. It is the single largest scheduling fact in the module and it was not on this list.

---

### M9 — "The monitoring visit, in order" *(OUTLINE — BLOCKED)*

**Track:** every tech · **Runtime target:** ~4:00 *(estimate)* · **SOP:** §5 (all nine steps), §7.1, §7.2, §7.3 · **Status: BLOCKED — R3 and R4**

**After it, a tech can:** run the front of the field card end to end — sync at the shop, outside T/RH after 3–5 minutes, warm station, equipment round **before** readings, one psychro row per chamber with the Notes in §4.2's order, today's date on every map in date order, the moisture route off the labels, and a written reason code for a missed day.

**This is a chaining module.** It teaches nothing new; it sequences everything above. That is why it goes last in the every-tech track — chaining only works on parts already learned — and it is why it is the module worth re-watching **in the truck in the driveway** before the week's first monitoring visit. That is not an extra sitting; it replaces the pre-visit fumble, and it is the highest-value repetition in the whole design (§8).

**Two things it must carry that no other module does:**

1. **§5's appeal-channel sentence, on camera, verbatim:** *"If a step is costing you more than the table says, tell the lead — with the number. We cut steps on evidence, not on grumbling."* A veteran who is told the process has a channel will use the channel; one who isn't will quietly not comply, and quiet non-compliance is invisible until a packet is short.
2. **The time-budget table, stated as estimates, in §5's own words.** §5 labels those numbers estimates and says to measure them on the reference job. **If the module states them as facts and the reference job shows they are low, the module becomes the thing the crew cites when they push back.** Say "estimates, being measured on the reference job" on camera.

**Why it is blocked:** R3 decides whether the rule is "a visit every equipment day" or "the reason-code path is the real rule," and step 8 of the card prints the reason codes. R4 decides whether the GD line in step 4 can be spoken at all. **Both are cheap to settle. This module is one evening away from clear, and it is the module the whole track builds toward.**

---

### Lead / setup track and the office module *(OUTLINES)*

#### M10 — "Day 1: the control reading, Material, and the Dry Goal" — **BLOCKED, R2**

**§4.7, §4.8. ~4:00.** After it, a lead can: take a control on unaffected material of the same class with the same meter; **set Material FIRST, then type a bare-number Dry Goal** on the moisture map; record the goal source in the first-row Notes; name the meter and mode in Meter / Setting; and leave the Drying Log's second Dry Goal box alone.

**The cold open is already the strongest 15 seconds available anywhere in this course**, and M5 beats I1–I3 have already filmed it: Material changed, `9.5` becomes `≤ 19%`, three red cells go green. **M10 does not re-film it — it re-uses M5's footage and adds the rule on top.** That is why M10 is only 4 minutes despite covering the most consequential decision on day 1.

**Blocked because the rule itself is R2**, and the rule is printed on the field card's Material line. Filming before the ruling risks both the module and the laminate.

#### M11 — "Day 1: sizing the equipment, once" — **BLOCKED, R5**

**§4.6, §4.13, §6.5. ~3:30.** After it, a lead can: set ceiling height, dehu type and AHAM pints **before** tapping `🧮 Size the equipment`; run it once on day 1 and never again; and write a date-stamped Deviation line carrying the real room count and the real scrubber arithmetic.

**Two demonstrations carry it, and neither reads on paper:** (1) the three silent defaults — ceiling 8 ft, 70 AHAM pints, and an air-scrubber CFM **hardcoded to 500 with no input at all** — printing an honest deployment as a shortfall; (2) running the worksheet cold (basis reads *"below the 70–90°F optimal drying range; add auxiliary heat"*), adding a warm psychro row, re-running, and watching it flip to *"no auxiliary heat needed"* — **the heater justification for every billed heater day destroyed in one tap.**

⚠ **Filming blocker inside the module:** the Recommended-vs-Deployed table, and therefore every Deviation box, is **not in the DOM at all** until `d.equipCalc` exists — `paintResults()` (`forms.js:507–538`) returns at `const c = d.equipCalc; if (!c) return;` (`forms.js:509–510`). **You cannot film the Deviation boxes until you have tapped `🧮 Size the equipment` once, successfully, on that log.** And the re-run demo **cannot be reset** except by hand-editing the psychro rows back.

**Blocked on R5** because the scrubber row is where the whole Deviation-box lesson lives, so it cannot simply be cut.

#### M12 — "Closeout and the Certificate of Drying" — **BLOCKED, R6**

**§9, all ten steps. ~4:00.** After it, a lead can: read every point including Loc 1; set Removed on every row; fill the Certificate's **own three date boxes**; copy Goal and Ref off the map rather than from memory; write the equipment-day arithmetic out longhand; and set the photo Sort before printing.

**Why video:** the Certificate's independent hand-typed dates and the photo **Sort** control are two places where a tech who does not know where the control is will simply skip it. **Location on screen is exactly what video carries** — and §9.7 notes that all the room discipline in §8 does not appear in the packet unless somebody changes that one picker.

**Blocked on R6** — §9.3 and §9.6 both turn on the billing unit, and it is the largest open money question in the SOP.

#### M13 — "Transcribing a paper card" — **CLEAR of rulings, BLOCKED on an artifact and a person**

**§10.1–§10.3. ~5:00. Audience: the named office admin, plus a backup lead. Not the crew.**

After it, the transcriber can: transcribe a card into **the job's own device** the same day before 6pm; add the `[paper - <tech>]` stamp **last** in the Notes; put the **tech's** name in the Tech field; enter the hours via the **hidden `+ Add labor row`** that only appears after tapping `✎ Edit`; scan the original into Supporting Docs; and **never tap `⤓ Sync labor from QuickBooks` on that job.**

**Why this is genuinely video-shaped and the office checklist in §12.4 is not:** two location-and-consequence problems in one screen. The `+ Add labor row` control is **invisible until `✎ Edit` is tapped**, and `⤓ Sync labor from QuickBooks` is **the most prominent control on that screen and it replaces the entire entries list, then reports success.** Leonard is not in QuickBooks Time by design, so on his jobs one tap of the brightest button deletes every hour anyone transcribed, with no warning and no undo.

**Frame it as the fallback for everyone, never as one person's lane.** §10 says so in its own first line. On camera: *"your tablet dies at −35°F — here's what happens."* That framing is both true and the only one that does not isolate Leonard in front of six colleagues. **Never film Leonard, and never use his lane as the example of what not to do.**

**Two blockers, neither of them a ruling:**

1. **The Drying Visit Card template does not exist yet.** §10.1 says the app cannot print it and the office keeps a Word or Excel one-pager. **There is nothing to film a transcription *from*.**
2. **The office admin is not named.** §10.2 requires a named person with the lead as backup, and says outright that *the owner is the fallback, never the default — if the owner is the transcriber it slips, every time.* **No video fixes an unnamed transcriber.** And the Labor Log gates (`ll_emp`, `ll_hours`, `completeness.js:117–120`) are **hard**, so an unstaffed paper lane means Leonard's jobs never clear billing — and that failure will be read as a training failure when it is a staffing one.

---

## 6. The paper lane

### 6.1 Leonard Sheldon gets no video, and this document is not going to pretend otherwise

Not a link. Not a QR code on a card. Not "we'll play it for you on the shop TV" as his version of the every-tech track. **A video that only exists on a phone he will not use is a training plan with a hole in it, and marking him complete because he was in the room while it played is the failure, not the fix.**

So: **do not put him in the every-tech video block on the shop-day agenda.** Give him his own line.

### 6.2 What he actually gets

**1. The shop day, in person — the same one everyone else attends.**
He is there anyway, and **the fleet-tagging exercise is the part of the rollout most likely to land with him**: physical work, on real machines, reading numbers off housings and applying labels. That is training, and it is the same training the others get. §12.1 already schedules it and it takes an hour of the three. ⛔ **R1 — that exercise is the 58-minute block §8.0 gates on the asset-tag ruling.** If R1 has not landed, his best lane that day is the destructive-panel session §8.0's fallback moves into that hour, which needs no tag, no app and no account.

**2. A printed packet.** Three things, on paper, in his hand:
- the field card (§11), on a reel — ⚠ **held back until R1–R4 land** (§2.4); until then he gets the unlaminated working copy, not the reel;
- a **Drying Visit Card pre-filled for a sample job** (§10.1) — which is also the artifact that does not exist yet;
- **a one-page "what changed" sheet lifted straight from §2's Before/Now table.** No statistics on it. Seven rows.

**3. A 90-minute in-person session with you, working the card by hand on one real job's numbers.**
Not a demonstration of the app. The card, a pencil, and a real set of readings. **This is the module equivalent for his lane and it should be scheduled and named on the agenda**, not left to happen.

**4. Four in-person conversations, one per module that has content he can act on.** These are lifted directly out of the modules and each is already written above:

| Module | His version | Where it is written |
|---|---|---|
| M1 | Two minutes with the index card in your hand. Four machines, one number; never a reading for a visit that didn't happen. | M1 → *The Leonard lane for this module* |
| M4 | 68 seconds of content, no screen at all — the card, the seven Level words, clockwise numbering, no material in a room name. Plus a printed room-card exemplar at actual size. | M4 → open question 4 |
| M7 | **In person at the panel, standing next to the destructive test.** This is the one training moment in the whole library that needs no app, no screen and no account. | M7 → *Assessment* |
| M8 | The three positions, walked, on a real job, once — inside §12.2's ride-along, at no extra cost. His card's printed Unaffected column already makes a blank pair visible. | M8 → *Leonard* |

**5. His compliance runs through the transcriber, not through him.**
§10.3's three checks — range check → phone call, point count, Friday reconcile — **are already the assessment for his lane.** The office admin who transcribes his cards is the person positioned to notice drift, and the fix is a thirty-second phone call that catches the transposition (47 typed as 74) that is the dominant paper error.

**6. No automated message, digest, schedule text, or AI-generated anything. Ever.** §10.2 is explicit. The training reminder for Leonard is a phone call from you, or a text typed by a human. **This constraint has to survive into whatever reminder mechanism the rollout ends up using** — including any that gets built later.

### 6.3 Two things this document has to say bluntly

**§10's paper lane depends on a named office admin existing.** §10.2: *"a named person, not 'the office'"* and *"the owner is the fallback, never the default — if the owner is the transcriber it slips, every time."* **No video fixes an unnamed transcriber.** The Labor Log gates in `completeness.js:117–120` are **hard**, so if that person is not named before the rollout, Leonard's jobs stall at "not yet billable" with nobody owning the reason — and it will be read as a training failure when it is a staffing one.

**The transcriber is the highest-consequence viewer in the whole library, and they are not currently in any track.** They can make all six of M5's mistakes, plus the QuickBooks one, on somebody else's job, with nobody watching. **M13 exists for one or two people and is worth filming for that alone.** Right now it is blocked on an artifact and a person, both of which are yours.

### 6.4 Never film Leonard, and never use his lane as the counter-example

The paper lane is §10's *"fallback for everyone, not one person's exception."* **Frame M13 that way on camera:** your tablet dies at −35°F, here is what happens. That framing is true and it is the only one that does not isolate him in front of six colleagues.

More generally, across the whole library: **never film a person doing it wrong.** Show the wrong way as a screen recording, or as your own hands. Nobody should be able to freeze a frame and say *"that's how Dave does it."*

---

## 7. Assessment — how you know each tech can do it

### 7.1 The design rule

**Every check is something that already had to happen anyway, observed once.**

No quizzes, no LMS, no scoring sheet, no sign-off form, no completion checkbox in the app. An owner with seven techs and no training department will run a check that costs fifteen seconds and will not run one that costs fifteen minutes. This is not a compromise — it is the only design that survives week three.

### 7.2 The eight checks

**Read the Blocked column before you plan the shop day.** Two of these cannot run on a day when R1 has not landed — A1 outright and A2's asset half — and one depends on an abbreviation table that does not exist yet.

| # | Check | Tests | When | Your time | Blocked? |
|---|---|---|---|---|---|
| **A0** | **The two questions.** Immediately after M1 plays, in the room. **Pick one tech — not a volunteer** — and ask: *"Name the four things a carrier pays for"* and *"What does a carried-forward number cost us?"* **Pass on Q1** = all four in any order, in his own words. **Pass on Q2** = names the **damage**, not the rule — *"then they can argue the whole file"* passes; *"you're not supposed to do that"* does not. On a fail, **restate the beat to the room and move on** — do not re-ask a second tech in front of the first (§7.3a). Two fails in one session means ride with that tech first in week 1. | M1 | Shop day, 0:07–0:09 | **90 sec** | Clear |
| **A1** | **Fleet-tag read-back.** During the tagging exercise, you point at a machine from across the shop. The tech walks to it, reads the tag off the housing, and says which prefix it is and why an `AM-` can never be a dehu. **Pass = walks over and reads it. Fail = says a number from memory.** | M3 | Shop day, inside work already happening | **Zero** | ⛔ **R1.** There is no tag to read until the format is ruled and the fleet is tagged. |
| **A2** | **One typed row each.** On the training job, each tech types one equipment row: asset, type, room off the card, placed with a time. You look at the **type string only**. **Pass = one of the four exact strings, and the asset was typed, not dragged.** | M2 | Shop day, inside the tagging block | ~90 sec/tech | ⛔ **R1.** The asset half requires a tagged machine to read a number off. The type-string half runs unblocked; run that half if R1 has not landed. |
| **A3** | **A photograph of your own labeled point.** On their first real job, the tech texts you **one photo**: their own paint-pen mark, the `7 / 12" AFF / GYP` label, meter in frame. **This is the single best check in the program** — it is a photo §8's shot list and §3.4's third anchor already require, it proves the physical mark, the height discipline and the label format in one frame, and judging it takes 15 seconds. | M7, M4 | First real job, async | **15 sec** | ⚠ **Blocked on the material-abbreviation ruling**, not on one of the six. `GYP` is the only abbreviation that exists anywhere in the SOP and there is none for the other seven Material options — so today this check has one correct answer for gypsum and no defined answer for anything else. **Rule the eight-row table** (M7 open question 2) or score the number and the height only. |
| **A4** | **The buddy check — §12.3's, given a pass/fail.** Whoever sets a job up does not do visit 2. Visit 2's tech must find every point and every room from the labels, the legend and the card alone. **Pass = they never call the setup tech. Fail = one phone call, and the labeling gets fixed on the spot by the person who found it wrong.** This is the only real assessment of M4 and M6, because the thing being tested is whether the work is readable **by someone else**, which no self-check can measure. | M4, M6, M7 | First two weeks | **Zero** | Clear |
| **A5** | **Teach-back on the six taps.** Not you to the tech. Each tech takes one of M5's six controls and tells the room **what it destroys**. Seven techs, six controls, ~45 sec each. **Pass = names the damage. Fail = recites the rule.** | M5a, M5b | Shop day | **6 min total** | Clear |
| **A6** | **The Notes-order glance, run off the data.** Your Friday office check (§12.4) already opens every job. Add one 10-second look per job: *does every psychro row's Notes start with a chamber name and carry a number in the Unaffected pair, and does every map's first-row Notes start with initials?* **This is the answer to "assessment without a training department"** — it measures exactly what M6, M8 and M9 taught, on real billable work, on a day you are already at the screen, and it names the tech (the initials are the chain of custody, §5.6). | M6a/b, M8a/b, M9 | Friday, inside an existing task | **~10 sec/job** | Clear |
| **A7** | **The reference-job packet read-through** (§12.3). One sitting at the table with the tech who ran it, going through the finished packet page by page. **This is the summative assessment for the whole course and the SOP already schedules it.** It is also the second durable training asset (§9.4). | Everything | Weeks 2–4, once | ~45 min | Clear |

**Two module-specific checks live inside their modules rather than in this table**, because they are performances rather than observations: **M6's live "make me a map" test** (60 sec/tech at the shop day, and the failure is the diagnostic) and **M7's headlamp read test** (run on the mock panel with the lights out). Both are written out in full in their modules. ⚠ **M7's read test does not cost ten seconds per tech.** Each tech has to pocket a pen nib-down, let it warm about two minutes, get to the cold with the panel, write a three-line label, and only then have it read. **Budget twelve minutes for seven techs**, and get the pens into coats *before* M7 plays so the warm-up runs under the module — the rebuilt §8.0 does exactly that.

### 7.3 Three methods explicitly rejected, and why

- **A written quiz.** Measures reading, insults the audience, produces a paper artifact nobody reads.
- **A completion checkbox in the app.** §12.4 says *"do not build a nag."* A watch-tracker is a nag with a database behind it. It also measures viewing, and viewing is not the thing.
- **Individual compliance scoreboards.** §12.4 already bans them: **team number on the shop wall, individual correction in person and privately, and only for repeats.** The assessment design must not smuggle a scoreboard back in through the training side door.

### 7.3a The line between a public check and a public correction

**This has to be resolved on paper, because otherwise it gets resolved badly in a room.** Five of the checks are performed in front of the crew, and three of them are designed so that failure is visible: A0's two questions, A5's teach-back, M6's live *"make me a map"* (*"do not coach until they have had ten seconds to be stuck"*), and M7's headlamp read (*"the fix is immediate and public, on the panel, in front of everyone"*). SOP §12.4's rule is: *"Never an individual scoreboard. Individual correction happens in person, privately, and only for repeats"* (`05-CREW-CAPTURE-SOP.md:728`). Those two things pull against each other, and pretending they do not is how a crew quietly stops cooperating.

**The resolution: the performance is public. The correction is not.**

1. **Performing in front of peers is the mechanism, not the penalty — keep it.** A5 works *because* the damage is said aloud to colleagues; a person who tells six peers *"it wipes every marker and the counter goes back to one"* has committed to it in a way no written answer reaches. M7's read test works because a label either reads at arm's length or it does not, and a re-write that is bigger, done on the panel, is a demonstration everybody learns from. Neither of those is a ranking.
2. **On a fail, the room hears the beat again — not the tech's name.** Restate the point to the room and move on. **Do not re-ask the same question of a second tech in front of the first.** That converts a teaching moment into a comparison, which is a scoreboard with no paper. An earlier draft of M1's assessment in §5 instructed exactly that (*"ask a different tech, out loud, in front of everyone"*); **that line is corrected in M1 and now matches A0's wording above.** If you find the old sentence anywhere, it is stale.
3. **Read M7's labels without saying whose they are.** The fix is public; the authorship is not. Nobody has to know which label was theirs except the person who wrote it.
4. **Nothing is written down, scored, tallied, or carried to the wall.** §8.4's sheet records that the material was *delivered*. It has no pass column and must never grow one.
5. **A repeat gets §12.4's treatment: in person, privately, later.** Two fails in one session is a ride-along in week 1 (§12.2), not a second public turn.
6. **Cap it at five public performances in one day, and never two inside the same block.** The rebuilt agenda in §8.0 spaces A0, A1/A2, A5, M6's live check and M7's read test across three hours with physical work between every one of them. A sixth would make the day feel like an exam — and an exam is the shape a crew reads as a scoreboard whether or not anyone is keeping score.

**The test of whether you got this right:** at the end of the day, could any tech name who did worst? If yes, it was a scoreboard.

### 7.4 What "clean" does not mean

§12.4 lists three things the drying flags will not tell you, and they apply to assessment too. **A clean list is not a clean shop.** The flags never fire on an archived job, never fire on a job already marked certified, and **never fire on a job with no readings and no equipment logged at all — so a job nobody documented shows clean, not red.** A blank job is invisible.

The practical consequence for training: **do not use the flag list as evidence that the course worked.** A6 — actually opening a job and reading a Notes cell — is the measurement. The flags are the alarm.

---

## 8. Distribution

**Use what the company already has. Do not invent infrastructure for this.**

### 8.0 The shop day, with the video timed into it

§12.1 gives you three paid hours, all hands, indoors, and **the fleet tagging is the best training in the plan** — it must not get displaced by screen time. This agenda fits the video inside the day that already exists, **and it closes: the blocks below sum to exactly 180 minutes.**

**Two things it assumes, both from §3.1.** M5, M6 and M8 are split at their own seams. And **M8 and M9 do not play here** — M8 teaches three physical positions in a building and is watched in the truck before the first monitoring visit (§8.5), M9 is the driveway module and is blocked on R3+R4 anyway. Putting either in this room is the version of this agenda that does not close.

> ⛔ **READ THIS BEFORE PRINTING THE AGENDA. Sixty of these 180 minutes are gated on R1** — M3 (2 min) and the whole FLEET TAGGING block (58 min), plus A1 and A2 which run inside it. That is a third of the day, and it is the spine of it. **If R1 has not landed, this is not a delayed module, it is a different day**; the fallback is at the bottom of this section.

| Time | Min | What |
|---|---|---|
| 0:00–0:03 | 3 | Room settles. No preamble. |
| 0:03–0:07 | 4 | **M1 — why this changed** (3:05) |
| 0:07–0:09 | 2 | **A0 assessment** — the two questions, one tech. **Ninety seconds, and it needs ninety** (§7.2). |
| 0:09–0:13 | 4 | **M2 — four strings, three columns** (~4:00) |
| 0:13–0:15 | 2 | **M3 — fleet tags** (~2:00) ⛔ **R1** |
| **0:15–1:13** | **58** | ⛔ **R1 · FLEET TAGGING, ALL HANDS.** Everyone handles every machine, reads out the number, applies the label, paint-pens the backup. **A1's read-back and A2's one-typed-row-each run inside this block.** Labels cure over the weekend. **This block produces the master asset list as a by-product and it is the best hour of the day.** |
| 1:13–1:23 | 10 | **Break — and this is where the files get copied.** Phones out, transfer started over shop wi-fi, everyone in the room, **watch it finish before the break ends.** §8.1 says ten minutes for seven phones; ten minutes of wall clock costs almost no attention *here* and cannot fit in the last block *there*. |
| 1:23–1:28 | 5 | **M4 — the panel-door card is the room list** (4:14) |
| 1:28–1:32 | 4 | **M5a — the moisture-map three** (3:44) |
| 1:32–1:33 | 1 | **Stand up. Stretch.** Not optional — it is what keeps the second block under the attention ceiling. |
| 1:33–1:38 | 5 | **M5b — the log four** (4:21) |
| 1:38–1:44 | 6 | **A5 assessment** — teach-back on the six controls. *(The hardest module followed by hands inside 60 seconds — zero gap.)* |
| 1:44–1:54 | 10 | §12.1's two five-minute tests: **the backlit meter photo**, and **the paint pen outside**. **Both are also M7 material — film them.** ⚠ **Hand out the paint pens at the top of this block and have every tech pocket theirs nib-down now.** That is the two-minute warm-up for the read test at 2:46, spent on time that is already committed. |
| 1:54–2:04 | 10 | **Break** |
| 2:04–2:08 | 4 | **M6a — how many maps, the title, plan first, arming the tool** (3:34) |
| 2:08–2:11 | 3 | **M6b — Loc 1 is the control, thirteen, the `(2)` map** (2:30) |
| **2:11–2:41** | **30** | **MOCK ROOM, HANDS, IMMEDIATELY.** §12.1's own thirty minutes: name it, four markers with Loc 1 as the control, label them, control reading, enter it. **M6's live "make me a map" check runs here** — 60 sec/tech, and do not coach until they have had ten seconds to be stuck. |
| 2:41–2:46 | 5 | **M7 — a mark that survives a dehu and below freezing** (4:45), watched **standing at the destructive-test panel.** The pens have been in coats since 1:44. |
| 2:46–2:58 | 12 | **M7's headlamp read test.** Each tech takes the panel to the cold, writes one three-line label, and the lights go out. **Seven techs cannot clear this in two minutes and the pen-warm alone is two** — the warm-up is why the pens went into coats an hour ago. **Read the labels without saying whose they are** (§7.3a). |
| 2:58–3:00 | 2 | **Hand-out and close.** Field cards on reels, **tethered capacitive styluses** (§12.1 calls this the highest-value purchase in the rollout), liner gloves. **§5's appeal-channel sentence said out loud.** The buddy-check calendar for weeks 1–2. *(The file copy already finished at 1:23 — that is what makes two minutes enough here.)* |
| | **180** | **Closes at 3:00.** |

**Screen time per block: 9:05 / 12:19 / 6:04 / 4:45** — with physical work after every one and a stand-up inside the second. **Never more than 12 minutes of screen before hands** is the shape rule, and the second block clears it only because of the stretch at 1:32; do not cut that minute.

**M8 and M9 do not play at the shop day.** M8 is watched in a truck before the first monitoring visit and M9 before the week's first (§8.5). **The lead track (M10–M12) and the office module (M13) are separate sittings** with two people and one person respectively; do not hold five techs in a room for them.

**The shape to preserve if you have to rearrange:** never more than 12 minutes of screen before hands, three modules maximum per block, physical work between M4 and M6a (the two typing-convention modules), and **the hardest module followed by hands inside 60 seconds.**

> ⛔ **THE R1 FALLBACK — what this day is if the ruling has not landed.** 0:13–1:13 is gone, and with it M3, A1 and A2. **Do not fill it with more screen.** Move M7 and its read test forward into that hour and run the destructive-panel session as the physical work of the morning — it needs no app, no account and no tag, it is the one training moment Leonard's lane and everyone else's share, and it is 58 minutes of exactly the kind of work the tagging block was going to be. **Then reschedule fleet tagging as its own paid hour the week R1 lands**, with A1 and A2 riding inside it as designed. Tagging the fleet to a format that later changes costs more credibility than the delay costs time (§2.1).

### 8.1 Where the files live

**Never in this repo.** `.github/workflows/deploy-field.yml` runs `cp -r apps/field/. _site/` on every push to `main` touching `apps/field/**`, and force-pushes the result to `gh-pages`. **Video committed anywhere under `apps/field/` is cloned by CI on every deploy, published to `app.roybalconstruction.com`, and lives in git history permanently.** Do not put it in `docs/` either — same repo, same clone, and a 400 MB repo is a slow repo for everyone forever.

| Copy | Where | Why |
|---|---|---|
| **Primary** | **On each tech's phone, in the Files app**, copied on shop day over shop wi-fi | Offline by construction. It is the only copy that works in a truck on Chena Hot Springs Rd, which is the actual viewing condition. |
| **Backup** | **The shop laptop**, plus one shared folder — Drive, or a signed link out of the existing Supabase `field-media` bucket (`MEDIA_BUCKET`, `apps/field/js/supa.js:208`) | For re-download when a phone is replaced. **Not for viewing.** |
| **Never** | This git repo | See above. |

**Copying takes about ten minutes for seven phones over shop wi-fi, so it happens at the FIRST break — §8.0, 1:13–1:23 — not in the last block.** Ten minutes of wall clock costs almost no attention there: phones out, transfer started, everybody already in the room, and it finishes before the break does. **Do it in the room, watch it finish, and do not send anyone away to do it later.** A file that has to be downloaded later is a file that is not on the phone.

> The earlier version of this agenda put the copy in the closing block alongside the card handout, the stylus handout, the appeal-channel sentence and the buddy-check calendar, and gave the whole thing six minutes. That is the arithmetic that stopped the three hours closing. **The close is two minutes because the copy already happened.**

### 8.2 How a tech watches it

Files app → the folder → tap. That is the whole flow. It requires no account, no app, no signal, and it survives a phone being in airplane mode in a truck at −20°F.

**Captions are burned in** (§4.7) because a sidecar `.srt` does not survive an AirDrop and half of these get watched with a heater running.

**Filenames sort into course order** (§4.7) because the Files app sorts alphabetically and a tech looking for "the one about rooms" should find `M4-room-card.mp4` sitting between M3 and M5, not hunting.

### 8.3 How a correction gets pushed

A corrected module is a new file with the **same filename**, AirDropped or copied at the next time seven people are in the same room — which is the weekly shop morning, not a special event.

**Two rules that make this work rather than rot:**

1. **Same filename, always.** `M5-six-taps.mp4` is `M5-six-taps.mp4` forever. A phone with `M5-six-taps-v2-FINAL.mp4` next to the old one has two files and no way to tell which is current.
2. **A three-second version stamp on the END card of every module** (not the opening — the first 30 seconds are spoken for): `SOP v1.3 · §6.1–§6.3 · filmed 2026-10`. Without it, modules rot silently and a new hire is confidently trained to a superseded rule. **The SOP went v1.0 → v1.3 in a single day.** This content moves, and the stamp is what makes drift visible.

### 8.4 How you track who has watched what

**Not in the app.** §12.4 says do not build a nag, and a watch-tracker is a nag with a database.

**On paper, on the shop wall.** One page, seven names down the side, module numbers across the top, ticked by hand at the shop day. It doubles as the assignment sheet — it shows at a glance that all seven have M1–M9, that two leads also have M10–M12, that the transcriber has M13, and **that Leonard's row is ticked against the in-person sessions in §6.2 rather than against video files.**

That sheet is the whole tracking system. It costs one printout, it is visible to everyone, and it is the same shop wall §12.4 already uses for the weekly team number.

**What it deliberately does not do is measure viewing.** Viewing is not the thing; the eight checks in §7 are. The sheet records that the material was delivered. **A6 records whether it took.**

### 8.5 Spaced repetition — tied to how fast each thing decays

Not everything decays at the same rate, so the schedule follows the decay rather than re-watching evenly.

- **Slowest:** physical habits. *Write the tag and the clock time on your hand at the machine.* *Keep the paint pen inside your jacket.* Taught once, performed once, done.
- **Medium:** single rules with a visible consequence. The four type strings, the fill-handle bans. These survive on the card alone once the damage has been seen once.
- **Fastest by a wide margin:** arbitrary ordered conventions. **The psychrometric Notes order (§4.2, five slots) and the map first-row Notes order (§3.5, five slots).** There is no logic a tech can reconstruct from first principles. **These two are the only content that genuinely needs spaced repetition — and both are printed on the card, which is the real mitigation.**

| When | What | Where |
|---|---|---|
| Shop day | **The nine shop-day files — M1, M2, M3, M4, M5a, M5b, M6a, M6b, M7** — in the room, with hands between every block | §12.1 · §8.0 |
| **Before the first monitoring visit ever** | **M8a + M8b (5:42), in the truck in the driveway, before walking in** | **M8 does not play at the shop day** (§3.1). It teaches three physical positions in a building; it lands where the building is, and its own assessment is a screenshot of that visit's row — so the module and the check happen in the same hour. **M8b ships when R1 and R4 land; M8a ships today.** |
| **Before the first monitoring visit of the week** | **M9 re-watched, 4 minutes, in the truck in the driveway** | **The highest-value repetition in the design.** It is not an extra sitting — it replaces the pre-visit fumble, at the point of use, where retrieval actually has to happen. |
| Day 3, first real job | **M6a + M6b** only — points, plan order, the control | Highest decay, highest consequence. A mid-job renumber cannot be repaired later (§13). **Split, this is a 3:34 re-send instead of 6:04.** |
| Day 10 | **M5a + M5b** only — the six taps | Hazard salience decays fast once nothing has gone wrong yet. **Send M5b first; it carries four of the five card lines M5 owns.** |
| Week 2 | **A 60-second recut of M5** — the six taps back to back, no explanation | Cut from M5's own footage. **One edit, and it is the single most re-sendable thing in the library.** |
| On any SOP version bump | Only the modules §9's index flags | See §9. |

**The one thing that is never re-sent: M1.** The "why" is watched once. **Re-selling the reason after the crew has accepted it reads as distrust.**

### 8.6 Where the card wins, and the rule that keeps it that way

> **The card carries every rule a tech needs with cold hands and no signal. The video carries only what a still page cannot show: motion, consequence, and where a control physically is on the screen. NO RULE MAY LIVE ONLY IN A VIDEO.**

This is not stylistic. There is no cell signal in crawlspaces or on Chena Hot Springs Rd (§5's own reason codes name it), there are gloves, there is a phone in a bag inside a coat, and there is a 3-minute video against a 2-second line of text. **The video is a one-time explanation of the card; the card is the field reference.** A tech who cannot remember a rule reaches for the reel on their tool bag, not for a phone.

**Two mechanisms make that real rather than aspirational:**

1. **The Card-line ⇄ Module index** (§9.3). For each line on the laminated card, name the module that explains it. Two payoffs: a tech who reads a terse card line and doesn't get it knows exactly which three minutes to re-watch, and when the card is re-cut, the index says which modules are now stale.
2. **The reciprocal of §11's own rule.** §11 says *"if a card line ever has no body section behind it, the card is wrong, not the body."* Extend it upward: **if a module teaches a rule with no §3–§11 section behind it, the module is wrong.** That one sentence prevents the failure where a rule quietly migrates into a video and the SOP stops being the source of truth.

### 8.7 One cheap improvement worth making at the same time

The field app already ships an **offline Help page** (`apps/field/js/help.js`, precached in `sw.js`'s `CORE` list, cache `roybal-field-v166`). It works with no signal, it is already on every tablet, and it currently describes the app rather than the SOP.

**Recommendation: do not put video there.** But **add a short "Capture rules" section** carrying the two Notes orders (§4.2 and §3.5), the four equipment strings, and the room grammar. That gives a tech who left the card in the truck a searchable offline copy on the device already in their hand. It is roughly 40 lines of the same `sec()` / `ul()` prose already in that file, and it is **the cheapest retrieval improvement available anywhere in this rollout.**

---

## 9. Keeping it true

The SOP moved v1.0 → v1.4 in two days, and §12.6 lists eleven code fixes queued, each of which retires a rule from the field card. **This document will rot unless the rot is planned for.**

### 9.1 The re-shoot policy

> **A module is RE-SHOT only when a rule inside it changes.**
> **A module is RE-INSERTED — 20 seconds — when only a number inside it changes.**
> **A module is CUT SHORTER, never re-filmed, when a code fix removes the defect it demonstrated.**

The volatile-facts-as-inserts technique (§2.2) is what makes the first two distinct, and it is the reason to adopt it now rather than after the first ruling lands.

### 9.2 What each queued code fix does to this library

Straight off §12.6, in that table's own order of value.

| §12.6 fix | Size | What it does to the video |
|---|---|---|
| **Remove the fill handle from Asset, Removed and Hrs** | Small | **Kills M5 beats A, H1, H2, H3** — 1:12 of screen time — and **kills M1's cold-open Shot 2.** Also removes M2's central rule. **This is the single most destructive fix to this library, and it is the one most worth shipping.** M5 drops from 8:05 to ~6:50; M1 needs a new cold open (recommend: hold on the index card longer and let the four `101`s carry it alone). |
| **`gpp()` returns null when T or RH is blank** | One line | **Kills M8's entire cold open (beats A1–A3) and beat J of M5.** M8 loses its spine — it would need a new opening argument, most likely the completeness-panel finding in beat B2, which is strong enough to carry it. **Plan for M8 to be re-cut, not re-filmed.** |
| **Confirm dialog on `↺ Clear drawing`** | Small | **Kills M5 beats D1–D3** (1:00). The rule survives — a confirm you tap through is still a marker set gone — but the *"no confirm"* line and the lower third both become false. **Cut the beat, keep the retire-note line.** |
| **De-duplicate narrative and sizing counts on asset tag** | Small | Weakens **M2**'s "one row per machine" argument. The billing rule still stands (§6.4's move-keeps-the-row), but the double-count demonstration goes. |
| **Warn before Material overwrites a non-empty Dry Goal** | Small | **Changes M5 beats I1–I3 and M10's whole cold open.** They survive as *"here is the warning — read it, and re-type the goal"*, which is arguably a better beat. **Re-record VO, keep the footage.** |
| **`⤓ Sync labor from QuickBooks` merges instead of replacing** | Small | Retires the most consequential line in **M13** and one item from the §12.4 office checklist. |
| **Re-read the strokes layer on resize** | Small | **Kills M6's cold open and the premise of beat 4** (0:32 of the module's strongest footage). M6 loses its hook. The *"plan first"* rule survives on the counter-drift alone but it is much less vivid. **Re-cut, do not re-film.** |
| **Air-scrubber worksheet gets its own Unit CFM input** | Small | Changes **M11**, which is blocked on R5 anyway. |
| **1-day floor on the narrative's unit-days** | One line | Office only. No module. |
| **Port `dryingwatch` flags into the Job Board** | Medium | Office only. No module. Changes §7.4's caveat. |
| **A room list on the job, with a picker on map Room/Area, photo Room and equipment Location** | Medium | **Retires M4 outright**, and roughly half of what §3.1 asks a human to enforce by spelling. Also retires M6's title-spelling discipline. |

**The one decision §9.2 cannot leave open.** Three of these fixes kill footage that costs 2h15m to shoot, and **M5 open question 6 asks whether to film beats a fix may retire inside sixty days and then does not answer it.** That question has to be answered before session 6 is booked, not after — and it has to be answered with a date, not a preference.

> **The 60-day test.** For each of the three fixes that kill M5 footage — the fill handle coming off Asset/Removed/Hrs, the confirm dialog on `↺ Clear drawing`, and `gpp()` returning null on a blank — say out loud whether it lands inside sixty days.
>
> - **Yes, inside 60 days:** **film the beat anyway and cut it out of the first edit.** Filming costs twenty minutes inside a session that is happening regardless.
> - **No, or unknown:** film it and ship it. The rule holds the line until the fix does.
> - **Never leave the decision to the edit.** An editor with a 2h15m rush and no ruling keeps everything.

**In every case the answer is film it, and the reason is asymmetry, not optimism.** The shot costs twenty minutes inside a session that is already on the calendar, and cutting it later costs one edit. Not filming it costs the whole rebuild — the job state, the destroyed markers, the burned rows — the day the fix slips, and fixes slip.

**Read the pattern:** **five of the six scripted modules lose material to a queued fix, and two of them (M4, M6) lose their reason to exist.** That is not an argument against filming them. It is an argument for **treating this library as the thing that holds the line until the fixes ship**, and for cutting rather than re-filming when they do.

### 9.3 The two indexes that make maintenance possible

Both belong in this document and both should also exist as one printed page taped in the shop.

**A. Module ⇄ SOP section.** Already in the §3 table's "SOP" column. **When the SOP bumps a version, that column says which modules are suspect.** This is the single artifact that turns a set of video files into a maintainable asset.

**B. Card line ⇄ module.** For each line of §11's front (9 numbered steps) and back (8 rule blocks), the module that explains it:

| Card line | Module |
|---|---|
| FRONT 0 — SHOP: sync, open today's jobs, one tablet per job | M9 |
| FRONT 1 — OUTSIDE at the truck, hang it 3–5 min | **M8** |
| FRONT 2 — UNAFFECTED = WARM STATION | **M8** |
| FRONT 3 — EQUIPMENT ROUND before readings; tag + clock time now | M2, M9 |
| FRONT 4 — AFFECTED, one per chamber; dehu outlet; NOTES ORDER | **M8** |
| FRONT 5 — today's date to every map, in date order | M9 |
| FRONT 6 — moisture route, Loc 1 first, read the label, type it | **M6**, **M7** |
| FRONT 7 — photos, room + caption, set the Stage | **M4**, **M7** |
| FRONT 8 — warm station: at goal / not drying / 7+ days / reason line | M9, **M1** *(the reason line)* |
| FRONT 9 — driveway check, dot green, red is normal | M9 |
| BACK — POINTS (1–13 per map, Loc 1 = control, plan before markers, `(2)` map, legend) | **M6** |
| BACK — ROOMS (panel card, three boxes, map title, plain hyphens) | **M4** |
| BACK — EQUIP TYPE (four strings, rating in Notes, location is a room, tags) | M2, M3 |
| BACK — FILL DOWN (Type/Room/Placed only; never Asset/Removed/Hrs) | **M5**, M2 |
| BACK — COLD (paint pen won't flow, jacket, tag it + photo) | **M7** |
| BACK — GD (negative or zero is normal, climbs through zero) | **M8** *(blocked, R4)* |
| BACK — NEVER (7 lines: `+ New`, Clear drawing, blank psychro cell, Material, close+reopen a row, two devices, invented rows) | **M5** *(5 of 7)*, M2 *(close+reopen)*, M9 *(two devices)*, **M1** *(invented rows)* |
| BACK — no Save button / tablet dead → paper card | M13, M9 |

**Two things this index surfaces that are worth knowing before you film:**

- **M8 carries four card lines and is the only module for three of them.** It is the most load-bearing module in the library relative to its length — and it is the one with an open ruling in it.
- **The NEVER block is split across four modules.** M5 owns five of its seven lines. **Splitting M5 (§3.1) keeps all five covered**: `Clear drawing` lands in M5a; `+ New`, Material, the fill-down lines and the blank-psychro line land in M5b.
- **Three modules in this index are now two files each.** Read **M5** as M5a + M5b, **M6** as M6a + M6b, and **M8** as M8a + M8b. The card lines land as follows: FRONT 1 and FRONT 2 in **M8a**; FRONT 4 and the GD block in **M8b**; the BACK POINTS block across **M6a** (plan before markers) and **M6b** (1–13, Loc 1 = control, the legend, and the `(2)` overflow map — its beat runs 5:32–5:50, which is after the 3:34 split).

### 9.4 The second durable asset, and it may be the more valuable one

**The reference job's finished packet** (§12.3): *"Its finished packet is what you show everyone else. One example done right teaches more than the document."*

**Store it beside the videos.** A PDF, a few MB. A new hire reading one correct packet learns what the modules are *for*. **Re-cut it once a year from a better job** rather than keeping the first one forever.

### 9.5 Onboarding — what a new hire gets on day 2

One handoff, and if it takes more than five minutes it will not happen the third time:

1. The card on a reel.
2. A phone with the modules already copied on.
3. A named buddy.
4. The reference-job packet.
5. The one-page course sheet from §8.4, which tells them (and whoever is handing over) what to watch and in what order.

**That last item is the actual test of durability**: it is what lets someone other than you run the onboarding.

### 9.6 Two places paper beats video, permanently

- **§12.4's office check is a checklist, not a module.** Twelve numbered checks run at a screen on Friday, several of them arithmetic reconciliations across four documents. **A video of a checklist is a worse checklist. Print it. Do not film it.**
- **The two Notes orders (§4.2, §3.5).** Video can teach *why* chamber-first, once. It cannot be the place a tech looks up slot 4 at −20°F. Those live on the card and — per §8.7 — in the app's offline Help page. **The module's only job is to make the card's terse line mean something.**

---

## 10. Appendix — screen-capture inventory

Verified control paths, so you are not hunting for a control mid-take. Everything here was read out of `apps/field/js` and `apps/field/css`, not out of the SOP. File:line references are to `/Users/brandenroybal/roybal-restoration-app/apps/field/`. **Every line number, control label and quoted string in this appendix was re-verified against the working tree on 2026-09-07** — quoted strings character for character, including curly vs. straight quotes. If the app is edited, re-verify before the shoot: labels drift slower than line numbers.

### 10.1 The navigation spine

Learn these five routes and the whole document can use them as shorthand.

| Screen | Route | How you get there |
|---|---|---|
| Jobs list | `#/` | app launch; ← Back from a job |
| Job home (tiles + completeness) | `#/p/<jobId>` | tap a job card |
| Form list (multi-instance forms) | `#/p/<jobId>/f/<key>` | tap a tile |
| Form editor | `#/p/<jobId>/f/<key>/<instId>` | tap a row in the list |
| Job packet | `#/p/<jobId>/packet` | **📄 Full job packet (PDF)** at the bottom of job home |

Form keys used above: `moistureMaps`, `dryingLogs`, `photos`, `constructionLogs` (= Field Report), `laborLog`, `certDrying`.

**Job home layout, top to bottom** (`projectHome()`, `app.js:1304–1425`): job name → subtitle (address · Claim #) → badge line → `✎ Edit job details` / 📞 Call / 🚗 Text: on our way / 🗂 Archive → **completeness panel** (collapsible, coloured left border) → message log card → backups card → cloud-copy card → **the tile grid** (icon, name, blurb, and a count badge — `app.js:1403–1405` — whose noun changes per tile: `3 saved` on most, **`8 photos`** on 📷 Job Photos, **`12 items`** on 📦 Contents, and `None yet` when the count is zero) → **📄 Full job packet (PDF)** + **📝 Construction Narrative** (`app.js:1416–1425`).

**Tile names, verbatim** (`model.js:31–98`): 📏 Floor Plan · 📎 Supporting Docs · 🗺️ Moisture Map · 💧 Drying Log · 📷 Job Photos · 📦 Contents · ✍️ Work Authorization · 📋 Field Report · ⏱ Labor Log · ✅ Cert. of Drying · 🔁 Change Order · 🧾 Construction Invoice · 🏗️ Reconstruction Estimate · 🌐 Client Portal.

> **Free footage:** the Field Report tile's own on-screen blurb reads **"Crew → office: notes, issues, materials + photos (internal — not in packet)"**. That is the on-screen text §4.1 refers to, and pointing a camera at the tile is the cheapest possible way to teach that rule.

### 10.2 Two things that will be on screen and are not in the SOP

- **The 🎙️ Transcribe widget sits at the top of the Moisture Map, the Drying Log and the Photo Report**, in a dashed navy box (mounted at `app.js:1893–1895`, gated by the `AI_FORM_KEYS` list at `ai.js:24–27`, built by `transcribeWidget()` at `voice.js:82–101`). Button reads **"🎙️ Transcribe"**, hint *"Speak your log — tap to confirm the values."* **§5.6 bans dictating readings — so the most prominent thing at the top of the two screens the SOP cares most about is the thing the SOP bans.** Address it on camera in one sentence, or crop it out of every frame. **Silence is worse than either.** Offline it toasts, **in full**, *"No connection — voice needs internet. Your typed entries are saved."* (`voice.js:108–109`) — **both sentences are in the frame**, so M8 beat H1 must either read the second one out or crop it off.
- **The ✓ Saved pill**, top-right of every form editor (`app.js:1885`, `formkit.js:12–13`, `core.js:216–230`). Reads **"Saving…"** grey, then **"✓ Saved"** green, on a 350ms debounce. **This is the filmable proof of "there is no Save button — it saves every keystroke."** It is 12px text (`app.css:447`) — shoot it as a zoom/crop in post, never as a wide.

### 10.3 The sync dot is not filmable as described

§5.9 and the field card say *"Dot green = synced. RED IS NORMAL OFF-GRID."* The actual control is `<div class="topbar__status" id="netStatus" title="Connection status">●</div>` in the navy topbar (`index.html:31`), styled `font-size: 12px; color: #d8ffe4` with `.topbar__status.off { color: #ffd9d3 }` (`app.css:83–84`). **Those are pale mint and pale pink on a dark navy bar at 12px** — not green and red, and not readable on video at any realistic phone playback size.

**Film the text status instead.** On the **Jobs list only**, `accountRow()` (`app.js:316–332`) renders a line that literally says one of: **"All changes synced ✓"** / **"Synced ✓"** / **"Syncing…"** / **"Offline — will sync when back online"** / **"Sync issue: …"** (`syncLabel`, `app.js:269–278`), next to a **"↻ Sync"** button (`app.js:324`) and a **"Sign out"** link (`app.js:325`). Two more strings live in the same function and can appear in a frame: **"Working offline on this device"** when nobody is signed in (`app.js:271`) and **"Synced — ⚠ N job(s) too large to back up"** (`app.js:276`). That is legible and unambiguous. **Note it only exists on the Jobs list** — the tech has to back out of the form to see it, which is itself worth saying on camera. Relevant to M9.

### 10.4 Moisture map — every control this library touches

**Create:** tile **🗺️ Moisture Map** → form list → **`+ New`** (blue, top-right, `app.js:1835`). **Creating navigates straight into the editor**; it does not stay on the list.

**Title:** **"Room / Area (titles this map)"**, placeholder `e.g. Living Room` (`roomInp`, `forms.js:433`; the field label at `forms.js:466`). Typing paints a bold caption above the sketch canvas and a second above the equipment canvas reading `<name> — Equipment`, **live, per keystroke** (`paintTitles`, `forms.js:426–432`).

**List row title** comes from `instanceTitle()` (`app.js:1855–1868`; the moisture-map branch is `app.js:1857`): `inst.label || inst.material || "Moisture map — <date>"`. **So an unnamed map with Material set shows only the material string** — four unnamed wood maps all read `Framing / Wood / Subfloor`. Rows render newest-first (`arr.slice().reverse()`, `app.js:1844`); the subtitle is `Created <date>` (`app.js:1849`), not the reading date.

**Material:** `<select>`, placeholder `Select material…`, eight options rendered `<name> (≤ <goal>%)` (`forms.js:381–387`, options mapped at `forms.js:382`; the source list is `DRY_STANDARDS`, `core.js:724–733`):

`Drywall / Gypsum (≤ 1%)` · `Plaster (≤ 1.5%)` · `Concrete / Slab (≤ 4%)` · `Hardwood Flooring (≤ 12%)` · `Carpet / Pad (≤ 15%)` · `Framing / Wood / Subfloor (≤ 19%)` · `OSB / Particle Board (≤ 16%)` · `Other / Generic (≤ 16%)`

> **Label discrepancy with the SOP.** §3.2 lists the eight materials by bare name. **On screen each option carries its goal in parentheses.** Show the real strings; the SOP's list should probably be corrected.

**⚠ Material overwrites Dry Goal, no confirm** (`forms.js:381–387`, the overwrite at `forms.js:385`, verbatim):
```js
  const materialSel = sel(m, "material",
    DRY_STANDARDS.map((d) => ({ value: d.material, label: `${d.material} (≤ ${d.goal}%)` })),
    { placeholder: "Select material…", onchange: (v) => {
        const g = goalFor(v);
        if (g != null) { m.dryGoal = `≤ ${g}%`; dryGoalInput.value = m.dryGoal; }
        reflagAll(); redrawChart();
      } });
```
It writes the **string** `≤ 19%`, repaints the box in front of you, re-flags every cell and redraws the chart. **No confirm, no undo, no history.**

**Dry Goal (MC%):** plain text input, placeholder `≤ 16%` (`dryGoalInput`, `forms.js:380`). Parsed as `parseFloat(String(m.dryGoal || "").replace(/[^0-9.]/g, ""))` (`goalNum`, `forms.js:284–289`). So `≤ 19%` → 19 ✅, `9.5` → 9.5 ✅, **`≤ 19% (ctrl 12.4)` → 1912.4** ⚠ — and **`9.5≤ 19%` → 9.519** ⚠, because the strip removes the `≤` and the `%` and leaves the digits butted together. Every keystroke in this box re-flags the whole grid (`oninput` → `reflagAll()`, `forms.js:380`; `flagCell`, `forms.js:290–294`).

**Meter / Setting:** a `<select>`, not a text box (`meterSelect`, `forms.js:217–242`). Options: `—`, whatever is in `localStorage["roybal-meters"]` **on this device only** (`METERS_KEY`, `forms.js:215–216`), plus **`➕ New meter / setting…`** (`forms.js:226`) — which fires a `prompt()` reading *"Meter & setting (e.g. Protimeter Surveymaster — pin, WME scale)"* (`forms.js:229`). On iPadOS that renders as a system alert showing the site's origin. **The typed value never syncs.**

**Floor-plan import** (`renderFp`, `forms.js:404–420`; called at `forms.js:421`): **`📄 Import floor plan (PDF / image)`** → becomes **`🔄 Replace floor plan`**; then **`✂️ Crop / zoom`** and **`Remove plan`** (red, **no confirm**, `forms.js:416–417`) appear. Sequence: OS file picker (`accept="image/*,application/pdf"`, `forms.js:390`) → toast **"Importing floor plan…"** (6s, `forms.js:393`) → full-screen modal **"Crop & zoom"**, subtitle *"Drag to move · scroll, pinch, or slider to zoom"*, zoom row `－`/slider/`＋`, footer **Cancel** / **Apply** (`forms.js:198–203`) → plan fills the canvas, canvas re-locks to the plan's aspect ratio → toast **"Floor plan added — draw on top"** (`forms.js:399`). A file the importer cannot read toasts **"Sorry — couldn't read that file"** instead (`forms.js:400`).

> ⚠ **`fileToFloorPlan` renders page 1 only of a PDF** — it delegates to `pdfToImage()` (`fileToFloorPlan`, `pdf.js:36–40`; `pdfToImage`, `pdf.js:20–33`), which calls `doc.getPage(1)` and nothing else (`pdf.js:24`), silently, with no warning. Contrast: Supporting Docs uses `pdfToImages` and takes every page.

**Sketch tool row**, left to right (buttons `core.js:509–516`, order fixed by `toolsEl` at `core.js:518–519`): `✋ Move` (title: *"Scroll the page without drawing"*) │ ⬛navy `#10233f` │ 🟧orange `#f26a21` │ 🟥red `#d23b2e` │ 🟩green `#1f9d55` │ **`①  Number`** (**two spaces after the ①**) │ `↩ Undo` │ `↺ Clear drawing`. **There is no text tool. That is the complete list.** The row carries `class="sketch__tools app-only"` (`core.js:518`) — see §10.10 for what `app-only` does and does not hide.

**Starting state:** the pad opens in `mode="off"` (`core.js:390`). Hint overlay: **"✋ Scroll mode — tap a color to draw"** (`core.js:385`). `touch-action: pan-y` while off (`core.js:505–506`), so a finger drag scrolls the page and draws nothing; the hint hides the moment a tool is armed (`core.js:507`). **Tapping `①  Number` a second time toggles back to Move** (`core.js:512`).

**A stamp** (`stamp()`, `core.js:463–472`): filled orange circle, r=17 (34px across), white 2px ring, white bold 18px number. Counter is `m.markerNext`, seeded 1 on every new map (`model.js:329`), **no way to set a start.**

**`↩ Undo`** (history stack `core.js:452–453`, `undo()` `core.js:454–461`): raster snapshot stack, **capped at 30** (`core.js:453`), **memory only, empty the moment you leave the screen and return.**

**⚠ `↺ Clear drawing`** (`core.js:513–514`, verbatim — it is two lines in the source, not four):
```js
  const clearBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↺ Clear drawing");
  clearBtn.addEventListener("click", () => { history.length = 0; nextNum = 1; ctx.clearRect(0, 0, canvas.width, canvas.height); emit(); });
```
**No confirm. Wipes every stroke and marker. Resets the counter to 1. Empties the undo stack. Saves immediately.** Survives: the imported plan, the equipment-placement pad, the whole reading grid, the Notes legend, Room/Material/Dry Goal. Does not survive: your markers.

**⚠ The marker-revert bug.** In `sketchPad`, the `strokes` parameter is captured at construction and **never reassigned** (`core.js:381`). `size()` redraws from that original value (`core.js:413–417`) and is called by the `bgImg` `load` listener (`core.js:419`) and by `setBackground(null)` (`core.js:524–528`, the null branch calling `size()` at `core.js:527`). **So importing, cropping, replacing or removing a plan redraws the canvas from the state the screen opened in — silently erasing markers stamped since — while `nextNum` keeps climbing.**

**The reading grid** (`valueCell`/`rowEl`/`blockTable`/`paintRows`, `forms.js:309–354`): `Date │ 1 │ 2 │ … │ 13 │ Notes │ (✕)`. Sticky navy headers, white 11px (`app.css:186`). Wrapper scrolls horizontally (`.tablewrap { overflow-x: auto }`, `app.css:183`).

- **A brand-new map already has one reading row, dated today** (`model.js:335, 338–340`). **Do not tap `+ Add reading date` on day 1.**
- Value cells: `<input class="mc" inputmode="decimal" min-width:42px>` (`forms.js:311`) — **iOS raises the numeric keypad, not the full keyboard.**
- **Live flagging on every keystroke** (`flagCell`, `forms.js:290–294`; `app.css:220–221`): at/below goal → `#e3f6ec` mint background, green bold; above goal → `#fbe3e0` pink background, red bold. Legend line above the grid reads, exactly, *"Cells flag green = at/below dry goal · red = still wet automatically."* — **there are no ● bullet characters on screen**; "green = at/below dry goal" is set in green bold and "red = still wet" in red bold, and that colouring is the whole cue (`forms.js:482`; `.flagnote .dot`, `app.css:222–225`). A burned-in reproduction with bullets will not match the frame. Every keystroke also redraws the SVG trend chart.
- **Notes cell** (`taCell`, `formkit.js:215–228`): auto-growing textarea, min-width 120px, **no placeholder**, sitting at the far right **after column 13**. On a portrait iPad you must **scroll the table horizontally to reach it.**
- **⚠ The row ✕** (`forms.js:337`; `.rowdel`, red, 18px glyph in a 36px cell, `app.css:231`): **no confirm.** Same on the psychrometric (`forms.js:773`) and equipment (`forms.js:724`) tables. The photo card's **Delete** has no confirm either (`forms.js:2139`).
- **No reorder control exists.** The chart plots rows in array order (`moistureChartSvg`, `forms.js:64–110` — `xOf(i)` at `forms.js:74` indexes the array, not the date).

**The column buttons** (one flex row, appended at `forms.js:484`; the three buttons built at `forms.js:355–370`): **`+ Add reading date`** │ **`+ Add locations 14–26`** │ **`✕ Remove locations 14–26`**. Labels are rebuilt on every repaint (`paintColBtns`, `forms.js:371–376`). **`✕ Remove` is hidden until a block exists** (`delCols.hidden = total <= LOC_BLOCK`, `forms.js:375`) — so **to film it you must first tap the banned button.** Add paints 13 more columns as a second stacked table (`blockTable`, `forms.js:341–349`), navy headers 14–26, date echoed read-only, **no Notes column and no ✕ on the second block.** Remove is **gated on data**: `const hasData = m.readings.some(...)` (`forms.js:365`), and the confirm *"Locations 14–26 have readings — remove them anyway?"* only fires when `hasData` is true (`forms.js:366`). **Empty columns are removed silently — there is no dialog to shoot.** To film the alert you must type a value into one of columns 14–26 first. Note the styling: `✕ Remove locations 14–26` is `btn--danger`, which is a **white button with red text and a pale red border** (`app.css:110`), not a red-filled control.

> **⚠ The finding the SOP does not state and the video must:** the button tapped **every visit** and the button that is **banned** are **immediately adjacent, same size, same ghost style, both grey.** On a gloved thumb that is a coin flip. M5 beat E1 and M6 beat 7 both make it their own beat.

### 10.5 Drying Log

**Path:** tile **💧 Drying Log** → form list. Header: `💧 Drying Log` left, **`+ New`** (blue, `btn--primary`) right — **the only coloured control on the screen** (`app.js:1832–1835`). Row title is `"Drying log — " + fmtDate(inst.readings?.[0]?.date)` (`instanceTitle()` dryingLogs branch, `app.js:1858`).

> **⚠ A trap the SOP does not mention:** that title reads the **first psychrometric row's date**. If that row is ever deleted or its date cleared, the title degrades to **"Drying log — "** with nothing after it — which looks like a broken row rather than a duplicate, making the tech *more* likely to tap `+ New` again.

The editor's own red **Delete** does confirm: *"Delete this Drying Log? This cannot be undone."* (the button is `app.js:1939`; the confirm is `deleteInstance()`, `app.js:1945–1946`). **It works** — a duplicate log can be removed from the editor; nothing here requires signing out.

**Editor layout, top to bottom** (`dryingLog()`, `forms.js:611–829`; the returned sheet is `forms.js:794–828`):
1. Drying-day banner (app-only) — **"Drying Day 3 (started Sep 4, 2026)"**, or once finished **"Drying complete — 6 days (…)"**
2. **Drying System** (`Open` `Closed` `Hybrid`) │ **Dry Goal (MC%)** ← *the second, dead one; nothing reads `d.dryGoal`, but it prints*
3. **Water Category** (`Cat 1` `Cat 2` `Cat 3`) │ **Class** (`1` `2` `3` `4`)
4. **Equipment Sizing (IICRC WRT Worksheets)**
5. **Equipment Deployment & Runtime**
6. **Daily Psychrometric Readings**
7. Job Information / Carrier / Tech Supervisor
8. **Dry-out Start Date** │ **Dry-out Finish Date** ← *bottom of a long page*

> **⚠ Undocumented, and it bites:** `seg()` **toggles** (`formkit.js:80–86`; the toggle itself is `formkit.js:81`). **Tapping the already-active `Cat 2` deselects it back to empty, silently.** Same for Class and Drying System. A tech confirming their entry by re-tapping erases it — and Class is the divisor in the dehu math, Category drives the scrubber row. **Worth a line on camera and probably a line in the SOP.**

**Drying System is bound to `project`, not to the log** (`field("Drying System", seg(project, "dryingSystem", ["Open","Closed","Hybrid"]))`, `forms.js:797`) — one project-level setting with no date, exactly as §5.8 says. Same for **Water Category** and **Class** (`forms.js:800–801`).

### 10.6 The equipment table and the fill handle

**Header row** (the equipment `<thead>`, `forms.js:809`), verbatim: `Asset # │ Equipment Type / Make / Model │ Room / Location │ Placed │ Removed │ Days │ Hrs │ Notes │ (✕)`

Above it, the app's own hint (`forms.js:805`): *"Log each unit placed on site — placed/removed date & time. Days-on-site and total hours calculate automatically; units past 7 days are flagged."*

**A new log ships with one blank equipment row already present** (`model.js:346`). **`+ Add equipment`** (ghost) adds more.

**Cell types** (`eqRow`, `forms.js:682–727`; the `mk`/`mkTa` constructors at `forms.js:700–719`, columns assembled at `forms.js:720–723`): `Asset #` text 50px · `Equipment Type / Make / Model` auto-growing textarea 150px · `Room / Location` auto-growing textarea 110px · `Placed`/`Removed` **`<input type="datetime-local" step="60">`** 150px each — **on iPadOS this opens the native date+time wheel picker**, a multi-tap OS control and the single strongest argument for §6.4's write-it-on-your-hand rule · `Days` computed read-only (`3d`, class `calc`, `forms.js:684`) · `Hrs` number 56px · `Notes` textarea 120px.

**Days / Hrs math** (`recalcDays`, `forms.js:685–698`): hours auto = `(removed − placed)/3600000` **rounded** — but **only when `row.placed && row.removed && !row._manualHrs` are all true** (`forms.js:687`). **A row with no Placed value never recalculates its hours, manual flag or not**, so the freeze cannot be demonstrated on a blank row; the target row must already carry a real Placed timestamp before the beat starts. Days = `Math.max(1, daysBetween(...))` once removed, else `daysSince(placed)` (`forms.js:692–696`). **Floored at 1.** Not removed and days ≥ 7 → `class="flag7"` (`forms.js:697`) and the amber box: *"⚠ 7-day equipment check: N unit(s) on site 7+ days. Confirm continued need / document justification for the carrier."* (`refreshWarn`, `forms.js:633–640`; the string at `forms.js:637–638`).

**The fill handle** (`attachFill()`, `forms.js:650–680`, the handle element created at `forms.js:651`; `app.css:413–423`, verified):

> **A 13 × 13 px orange square with a white 1.5px border and a 3px radius, at the bottom-right corner of EVERY cell, at 50% opacity** (`.fillh`, `app.css:415–420`) — rising to full opacity on hover (`app.css:421`) or focus-within (`app.css:422`). `cursor: ns-resize`, `touch-action: none`, `z-index: 3`. **On an iPad there is no hover, so it never brightens.**

Press and drag straight down; rows between source and finger get `background: var(--brand-tint)` with an inset brand outline (`tr.fill-target`, `app.css:423`); release → toast **"Filled N rows"**.

**What it copies:** a literal copy for every key **except `asset`**, which calls `bumpAsset()` (`forms.js:643–647`, verified):
```js
function bumpAsset(src, n) {
  const m = String(src).match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return src;
  return m[1] + String(Number(m[2]) + n).padStart(m[2].length, "0") + m[3];
}
```
**It increments the trailing number, preserving zero-padding.** So under any tag format: `AM-014` filled down 6 rows → **`AM-015 … AM-020`**. Six tags nobody read off a machine, in the new format, looking perfectly legitimate. **This is the money shot of the equipment lane, and it is why M5's narration says "the digits on the end of it" rather than naming a format.**

For `hours`, the fill sets `d.equipment[idx]._manualHrs = true` (`forms.js:672`) — **permanently.** **And so does simply typing a number into the Hrs cell by hand** (`forms.js:705`): the same flag, the same permanence, no drag required. That row's hours will never auto-recalculate again. **There is no UI anywhere that shows or clears `_manualHrs`. This is invisible damage — you can film the cause, never the consequence.** The hand-typed path is the more common one on a real job, and it is named nowhere in the SOP or on the field card.

**⚠ No undo on a fill. There is no undo path at all.**

**Filming note:** a 13px handle at 50% opacity is **too small to read on video.** Every fill-handle shot must be a zoomed insert (crop ~3× in post) or a macro of the screen. **Never a wide.**

### 10.7 The sizing worksheet

Section **"Equipment Sizing (IICRC WRT Worksheets)"** (`equipSizingSection()`, `forms.js:500–609`; the section title at `forms.js:606` and its blurb at `forms.js:607`).

> **⚠ THE FILMING BLOCKER.** The Recommended-vs-Deployed table — and therefore **every Deviation box** — is **not in the DOM at all** until `d.equipCalc` exists (`paintResults()`, `forms.js:507–538`, returns immediately at `const c = d.equipCalc; if (!c) return;`, `forms.js:509–510`). **You cannot film the Deviation boxes until you have tapped `🧮 Size the equipment` once, successfully, on that log.** A second log created with `+ New` has no `equipCalc` of its own and prints no sizing table at all. This is why §4.6 and §4.13 of the SOP are separate steps.

**Inputs, in on-screen order** (`paintControls`, `forms.js:541–602`): room chips (`✓ Main Kitchen · 180 SF`, `forms.js:548–549`) if the AI takeoff has run, **or** the line *"No floor-plan takeoff yet (Floor Plan → ✨ Read dimensions) — enter the wet areas by hand:"* with exactly two boxes, **"Wet floor area (SF)"** (`e.g. 320`) and **"Affected wall perimeter (LF)"** (`e.g. 96`) (`forms.js:556–560`) — **this is the one-room path** · **"Wet wall & ceiling ABOVE 2 ft (SF, all rooms)"** (hint *"worksheet step 3 — ÷150 low / ÷100 high"*) · **"Wall insets / offsets > 18" (count)"** (hint *"worksheet step 4 — +1 airmover each"*) · a checkbox for lower-walls-only · a three-up row **"Ceiling height (ft)"** (placeholder `8`) │ **"Dehumidifier type"** (`LGR (refrigerant)` / `Conventional refrigerant` / `Desiccant`) │ **"Unit size (AHAM pints)"** (`70-pint` / `110-pint` / `130-pint`, from `DEHU_SIZES`, `dryingcalc.js:37`) · **`🧮 Size the equipment`** (blue, `forms.js:581`).

> **⚠ Verified:** the third box swaps to **"Unit CFM rating"** *only* when Dehumidifier type is Desiccant (`forms.js:577–579`). **There is no CFM input for the air scrubber**; `equipmentCalc` calls `scrubberCalc({ volume, waterCategory })` with **no `cfmRating` at all** (`dryingcalc.js:126`), so it falls back to the parameter default of **500** (`dryingcalc.js:102`, applied at `dryingcalc.js:108`).

**Failure toasts** (`forms.js:595`): *"Tap at least one affected room first."* / *"Enter the wet floor SF / wall LF first."* — the table stays absent.

**On success**, five columns (header row `forms.js:530`, data rows `forms.js:532–535`): `Equipment │ Recommended │ Deployed │ Basis (IICRC WRT worksheets) │ Deviation from worksheet`. Rows: Air movers · LGR dehumidifiers (label varies, `forms.js:522`) · Air scrubbers / AFDs · Auxiliary heat. **Deployed turns red bold with a `⚠` when under the recommendation** (`forms.js:515`). The **Deviation** cell is a `taCell`, placeholder `e.g. limited circuits — staged deployment` (`forms.js:517`), min-width 130px, **far right of a five-column horizontally-scrolling table** — same swipe problem as the moisture Notes cell.

**⚠ It overwrites on re-run.** `out.at = new Date().toISOString(); d.equipCalc = out; commit();` — a single stored snapshot, no history (`forms.js:596–598`). Heat basis is computed from the **latest** affected temperature in the log (`forms.js:586–587`). **This take cannot be reset except by hand-editing the psychro rows back.**

### 10.8 The psychrometric table

Section **"Daily Psychrometric Readings"** (`sectionTitle`, `forms.js:813`; the table at `forms.js:815–818`). Orange-tinted note box above it (`forms.js:814`): *"**Auto-calc:** Enter temperature (°F) and RH (%) — GPP fills automatically. Grain depression (GD) = Unaffected GPP − Affected GPP. Tap a GPP cell to override."*

**Two header rows** (`psHeadTop`, `forms.js:781–789`; `psHeadBot`, `forms.js:790–792`; mounted at `forms.js:817`). Top: `Date / Time │ Outside / Ambient │ Unaffected (Ref.) │ Affected │ GD │ Equip Count │ Tech / Notes`. Bottom: `Date │ Time │ T │ RH │ GPP │ T │ RH │ GPP │ T │ RH │ GPP │ GD │ Dehu │ AM │ Scrb │ Tech │ Notes`. **17 data columns plus a ✕ — this table always needs horizontal scrolling on an iPad.**

**Cells** (`psRow`, `forms.js:735–775`; the `mk` constructor at `forms.js:738–753`, columns assembled at `forms.js:770–773`): Date `type="date"`, Time `type="time"` (native iOS controls — on an iPad these render as popover menus, not the iPhone wheel), T/RH/GPP/GD/counts `type="number"`, Tech text, Notes auto-growing textarea 130px, far right.

**The auto-calc is instant** (`recalc`, `forms.js:754–760`) and computed cells carry `class="calc"` (`forms.js:768`). **⚠ `.calc` is pale ORANGE on screen** — `background: var(--brand-tint)` = `#fff3ec` (`app.css:218`, token at `app.css:11`). The pale-blue `#eef6ff` version exists **only in print** (`print.css:130–131`), so any screen-recorded beat must call these cells orange, and only a print-preview or packet-PDF frame may call them blue. **Use §7.2's own worked example so the video and the document agree number for number:** affected `78`/`31` → **44**; unaffected `70`/`34` → **37**; GD → **−7**.

**Typing directly into a GPP cell marks it manual** (`_outManual` / `_refManual` / `_affManual`, set at `forms.js:744–746`) and stops auto-calc for that group — **until you edit that group's T or RH again, which clears the flag and re-enables it** (`forms.js:747–749`). So a hand-set `refGPP` is wiped the moment anyone touches `refT` or `refRH`. Undocumented in the SOP; worth a sentence.

**The blank-pair defect, verified.** `gpp(tempF, rh)` (`core.js:705–715`) guards on `isFinite`. `Number("")` is `0`, and `isFinite(0)` is true — so **a blank pair computes through to 0 GPP, not null.** `recalc()` is called while each row is built (`forms.js:769`) and `paintPs()` builds every row on mount (`forms.js:776–777`), so **it fires on load, before anyone types.** §7.1 is verified exactly, including *"it fires the moment the log is opened."* Note also that the GD cell is `<input type="number">` (`forms.js:767`) — **it cannot display the text `NaN`; a non-numeric assignment renders as an empty cell.**

**⚠ Row ✕: no confirm** (`forms.js:773`).

### 10.9 Photos

**Path:** tile **📷 Job Photos** — single-instance, opens the editor directly, **no list.**

**Toolbar** (`forms.js:2466`), left to right: **`📷 Add photos`** (blue) │ **the AI button** │ **`⬇ Download all (.zip)`** (`forms.js:2403`) │ **`☁ Move photos to cloud`** (`forms.js:2424`) │ **`Sort:`** `<select>` (`forms.js:2400`) │ **`Photo size for email:`** `<select>` (`forms.js:2389`).

> **⚠ The AI button's label is not `✨ Analyze`.** `paintAiBtn()` (`forms.js:2285–2297`) writes one of **`✨ AI captions (N)`**, **`✨ Refresh AI captions (N)`** or **`✨ Redo AI captions (N)`**, and while a pass is running **`✨ Analyzing…`** (`forms.js:2302`) or **`✨ Analyzing 1–10 of 42…`** (`forms.js:2308`). It is **hidden outright when the job has no analyzable photo** (`aiBtn.hidden`, `forms.js:2287`). `✨ Analyze` / `✨ Redo` are the labels on the **per-photo card's** button (`forms.js:2175`), not the toolbar's — do not put the toolbar in a lower third that names the wrong one.

Below the toolbar: the share control (`forms.js:2467`), then stage filter chips `All (N)` `Before (N)` `During (N)` `After (N)` — screen-only, with the note *"print & email still include every photo"* when a filter is on (`filterRow` `forms.js:2206`, `paintFilter` `forms.js:2207–2223`).

**Adding photos** opens `<input type="file" accept="image/*" multiple>` (`forms.js:2365`) — on iPadOS the OS sheet with **Photo Library / Take Photo / Choose File**. **Every imported photo is re-encoded to ~1200px at quality 0.6 on capture** (`fileToDataURL(f, 1200, 0.6)`, `forms.js:2370`). **That downscale is exactly why §12.1's "photograph a backlit meter display and check it on the office desktop" test exists**, and it is a real risk for the offline fallback. Adding photos also clears any active stage filter (`forms.js:2373`).

**Per-photo card controls**, in DOM order (`forms.js:2196–2201`): the image (tap = full-screen lightbox) · a tools row (`◀` `▶` only in Manual sort with no filter, `forms.js:2135–2136`; **`✨ Analyze`** before a pass and **`✨ Redo`** after — the label flips at `forms.js:2175`; spacer; **Delete**, which has **no confirm**, `forms.js:2139`) · **the Room input — a bare input with no label, only the grey placeholder `Room / location`** (`forms.js:2117`) · the **Stage** dropdown (**defaults to `During`**; `newPhoto()` stamps `stage: "during"`, `model.js:210`) · the **Caption** box (placeholder `Caption`, `forms.js:2114`).

**The Sort options, word for word** (`PHOTO_SORTS`, `forms.js:2026–2035`), matter at closeout (§9.7): `Manual (◀ ▶ to arrange)` is the default; the two the SOP names are **`Room, then Before → After`** and **`Before → During → After`**; **the other two in the same menu are `Date taken — oldest first` and `Date taken — newest first`** — one mis-tap away from either. **The printed Photo Report follows whatever the sort is set to.** Under `Room, then Before → After`, photos with no room **sink to the bottom** of the report (`photoRoomCmp`, `forms.js:2021–2025`), under a group header reading `No room set` (`forms.js:2236`), uppercased with an orange rule by `.photogroup` (`app.css:284–288`).

### 10.10 The packet

Route `#/p/<id>/packet`, reached from **📄 Full job packet (PDF)** at the bottom of job home. Bottom button **`⬇ Save packet as PDF`** (`app.js:1552`) — this is your device's print-to-PDF; **there is no generated PDF file.**

> **⚠ The production discovery that shapes three beats across two modules.** `letterhead()` (`formkit.js:290–291`) carries class `print-only`, and `app.css:599` sets `.print-only { display: none }` on screen. The only thing that overrides that on screen is a `.packet-preview` wrapper (`app.css:478`), and that wrapper is used in exactly one place in the whole app — the narrative cover preview at `app.js:1685`. The packet page is **not** wrapped in it, so **the `DRYING LOG` title blocks are invisible on the packet page on screen.** Every "here is what the carrier gets" beat that depends on the letterhead must be filmed in the **iOS print preview** — tap `⬇ Save packet as PDF`, let `window.print()` open the AirPrint sheet, and shoot the paginated thumbnails. **This works offline.** M5 beats E2 and G2 do this — **and so does M6's re-staged 4:56 beat**, which deliberately films **both** pages: the packet page on screen (where the sketch tool row and the Add/Remove-locations buttons are still visible and still work) and then the print sheet (where they are gone and the empty numbered boxes stand alone). That contrast *is* the beat, and it exists because `.app-only` is a print rule only — see the next paragraph.

`.app-only` is hidden **at print time only** — it appears in exactly one rule in the whole codebase, the hide list at `print.css:9–11`, and there is **no screen rule for it anywhere**. So the sketch tool row (`class="sketch__tools app-only"`, `core.js:518`) and the `+ Add reading date` / `+ Add locations` / `✕ Remove locations` row (`class="app-only row-add"`, `forms.js:484`) **are still fully visible on the packet page on screen** — `packetPage()` appends the same sheet elements the form renderer built (`app.js:1547`). They vanish only in the print preview and on paper, where the stacked 14–26 table prints with navy numbered headers over empty bordered cells (`app.css:185–186`). **Any beat that claims the buttons are "gone" must be shot in the iOS print preview, not on the packet page.**

### 10.11 The completeness panel

`completeness.js`, rendered by `completenessPanel()` (`app.js:659–687`). A card with a coloured left border, a header line, and an `x/y` count on the right (`app.js:667–670`).

**Three states, three exact header strings** (`summaryLine`, `completeness.js:234–241`; tone and border colour, `app.js:661`):

| Condition | Header, verbatim | Border |
|---|---|---|
| any hard gap | `Not yet billable — N required item(s) missing.` | red `#b3261e` |
| no hard gaps, ≥1 soft gap | `Ready to bill — N optional item(s) still open.` | amber `#8a6d00` |
| no gaps at all | `Complete — ready to bill.` | green `#1b7a3d` |

**The four facts that matter for training:**

1. **The panel lists ONLY what is missing — there is no satisfied-items checklist anywhere in the app.** `panelModel()` builds `groups` from `hardGaps` and `softGaps` alone (`completeness.js:252–258`), and `completenessPanel()` appends a body and wires `foldable()` **only when `m.groups.length`** (`app.js:682–685`). So a job whose header reads `Complete — ready to bill.` has zero gaps → zero groups → **no body and nothing to unfold.** **Any beat that taps a green header to open a checklist is unfilmable.** The only header that is both near-green and foldable is the amber `Ready to bill — N optional item(s) still open.` one.
2. **Every listed item renders as `${g.formLabel}: ${g.label}`** (`completeness.js:255` and `:258`). The on-screen strings are **`Drying Log: Outside temp (psychrometric)`** and **`Contents: Room on each contents item`** — **never the bare label.** Group headings are `Required — blocks billing` (red, `completeness.js:254`) and `Recommended` (grey, `completeness.js:257`). The form half comes from `FORM_LABELS` (`completeness.js:184–192`), **not from the tile name** — the 📷 **Job Photos** tile prints in the panel as **`Photo Log:`**. Reproduce all of this exactly in any burned-in insert.
3. **`anyInstanceRow` (`completeness.js:31–32`) — the hard gates pass if any one row on any one instance holds the field.** A twelve-visit job passes on visit 1 alone. **It cannot tell you today's row is complete.** This is why §9.10 says the panel is a floor, not the check.
4. **The psychrometric gates are asymmetric** (`completeness.js:75–84`): `dl_outT`, `dl_outRH`, `dl_affT`, `dl_affRH` are **hard**; `dl_gd` is **soft**; **`refT` and `refRH` are not required anywhere in the file.** The one group nobody is ever prompted for is the one that goes out empty. M8 beat B2 is built on this.

Also relevant: **the Labor Log gates `ll_emp` and `ll_hours` are hard** (`ll_emp` `completeness.js:117–118`, `ll_hours` `:119–120`) — which is why §10.2's transcriber-enters-hours rule is load-bearing, and why the QuickBooks-sync landmine can strand a paper job at "not yet billable."

> **Cost note for anyone scripting a green panel.** Reaching `Complete — ready to bill.` on a water job clears, at minimum: Work Authorization signature + owner name + authorization date, one `before` and one `after` photo, a caption on **every** photo, Labor Log crew member + hours, Cert. of Drying final reading + goal + tech sign-off, and every moisture/drying/equipment gate — plus **all three soft gates** (`dl_gd`, `eq_removed`, `ph_during`), or the header reads the amber string instead (`completeness.js:51–130`). That is hours of build, not a props line.

### 10.12 Recording on iPadOS — the mechanics

*Platform steps, not repo facts.*

**Once, before the shoot:** Settings → Control Center → add **Screen Recording** (not there by default). Display & Brightness → **Auto-Lock → Never**. **Focus / DND on.** Sounds → **keyboard clicks off**.

**Per take:** swipe down from the top-right → **long-press the ⏺ record button** → set **Microphone** (this library: **OFF**) → **Start Recording** → **3-second countdown** → **swipe Control Center away before the countdown ends** or the first second of every clip is Control Center. Stop by tapping the **red pill / red status-bar indicator**. The file lands in Photos at native resolution and orientation.

**Five things being a PWA changes:**

1. **Standalone display, no browser chrome** (`manifest.webmanifest`, `"display": "standalone"`). **Film from the Home Screen icon, never a Safari tab** — the two will not intercut.
2. **The iOS status bar is in every frame**, carrying the red recording indicator during a capture. It cannot be hidden. **Be consistent** — never mix iPad-recorded and desktop-recorded footage in one module, because one has the red pill and one does not. Charge the tablet and set the clock.
3. **No install banner risk on iOS** — Safari does not implement `beforeinstallprompt`. (On an Android tablet it would; do not shoot B-roll on one.)
4. **⚠ The service worker can reload the page with no prompt, mid-take.** `sw.js:6` (cache `roybal-field-v166`) calls `self.skipWaiting()` (`sw.js:47`) and `clients.claim()` (`sw.js:55`); `app.js:2662–2672` answers `controllerchange` by calling `location.reload()` (`app.js:2661`) — **but only when no text field is focused.** If an `<input>`, `<textarea>` or contenteditable has focus it defers the reload to the next `hashchange` or to the tab going hidden (`app.js:2657–2669`). **So a typing take is safe and a hold-on-a-static-screen take is not**, and the deferred reload can fire the instant you navigate at the end of a shot. `reg.update()` runs on load and hourly while open (`app.js:2676–2677`). See §4.3.
5. **`prompt()` and `confirm()` render as iOS system alerts showing the origin.** The `➕ New meter / setting…` flow (the option at `forms.js:226`, the `prompt()` at `forms.js:229`), the `➕ New room…` flow (`app.js:1995`) and every destructive control do this. Slightly unpolished on camera and unavoidable — do not try to route around it.

---

## 11. Change log

| Version | Date | Change |
|---|---|---|
| **1.0** | **2026-09-06** | **First issue.** Production document for the training video version of `05-CREW-CAPTURE-SOP.md` v1.3. States plainly that video cannot be generated and that this is a shooting script and storyboard instead, with an honest ~28-hour cost estimate for the six scripted modules. **Six modules written out in full** — M1 (why this changed), M4 (the panel-door room card), M5 (six taps that cost money), M6 (plan first / Loc 1 / thirteen), M7 (the paint pen and the cold), M8 (outside, unaffected, affected). **Seven more outlined**, four of them blocked by rulings. **Every module labelled CLEAR or BLOCKED with the specific ruling named**, and §2 ranks the six rulings by how much filming each one unblocks (R1 > R2 > R3+R4 > R6 > R5), notes that R1 blocks the shop day itself and not just one module, and gives the narration tripwires — the phrases banned on camera and the phrases that survive either outcome — that keep four modules CLEAR by wording rather than by waiting. **Flags a conflict the scripts create and do not resolve:** the every-tech track totals ~41 minutes against a 20-minute design budget, with M5 at 8:05 against a 4:30 ceiling; recommends splitting M5 and M6 at their existing seams rather than cutting content, and marks the split points in both scripts. **§6 states that Leonard Sheldon gets no video at all** and lists the five things he gets instead, including four in-person conversations lifted from the modules, and names the two structural problems behind his lane — the Drying Visit Card template does not exist and the transcriber is not named — as staffing and artifact problems that no video fixes. **§7 gives seven assessments**, each one riding on work that already had to happen; A3 (one texted photo of a labeled point) and A6 (a ten-second Notes glance inside the existing Friday office check) are named as the two that carry the program. Written quizzes, in-app completion tracking and individual scoreboards are rejected with reasons, per §12.4's own ban on nags and scoreboards. **§8 rules that video is never committed to this repo** — verified: `deploy-field.yml` runs `cp -r apps/field/. _site/` on every `main` push and force-pushes to `gh-pages` — and puts the primary copy on each phone's Files app over shop wi-fi, with tracking on a paper sheet on the shop wall. **§9 maps all eleven §12.6 code fixes to the beats they retire**, and states the finding that matters most for planning: five of the six scripted modules lose material to a queued fix, and two of them (M4, M6) lose their reason to exist when the room manager and the strokes-layer fix ship. **§10 is a verified control inventory** — every label, route, pixel dimension and code path this library taps, read out of `apps/field/js` and `apps/field/css` rather than out of the SOP, including four verifications done for this document: the `.fillh` handle is 13×13px at 50% opacity (`app.css:415–420`), `↺ Clear drawing` has no confirm and resets `nextNum` to 1 (`core.js:513–514`), the Material dropdown overwrites `dryGoal` unconditionally (`forms.js:381–387`, the write at `forms.js:385`), and `gpp("","")` computes through to 0 rather than returning null (`core.js:705–715`). **One honesty flag inside the document:** the closing beat of M8 (J1) plus that module's shot list, props, assessment and open questions were reconstructed, because the source material was cut off mid-sentence; the note is in the module and J1's narration should be checked against R4 before it is recorded. |
| **1.1** | **2026-09-07** | **Correction pass, before a frame was shot.** Three independent reviewers walked the document as a shoot day and as a code audit; every disputed claim was then re-verified against `apps/field/js`. **About two dozen beats were re-staged and none were cut** — in almost every case the app's real behaviour is the stronger demonstration. What was wrong:<br><br>**• The completeness panel only ever lists what is MISSING.** `panelModel` builds its checklist from `hardGaps` and `softGaps` alone (`completeness.js:252–258`), so a job reading `Complete — ready to bill.` has an empty checklist and `foldable()` is never even wired (`app.js:682–685`). **Four beats filmed a green panel being unfolded, which cannot happen** — M4 Shot 14A, M4 Shot 14C's A/B, M5 beat G2's "still green" cutaway and its shot-list item G2-green. All four now run on the RED panel, and the A/B is a count, not a colour. **And every panel line renders as `${g.formLabel}: ${g.label}`** (`completeness.js:255`), so the burned-in string is `Contents: Room on each contents item`, never the bare label; every reproduction of a panel line in the document was wrong and is now character-exact.<br>**• M4 Shot 14B cancelled the `➕ New room…` prompt, and cancelling writes nothing** (`app.js:1995–1997`) — so Shot 14C's reveal of a permanent invented room had nothing to reveal. The prompt is now completed, which makes 14C the strongest beat in the module: the panel returns to the exact baseline while the room stays in the filter forever (`app.js:2293–2300` never touches `project.rooms`). A defect nobody had found came with it — `newContentsItem()` pre-fills `disposition: "salvageable"` (`model.js:277`), so only ONE new line appears, not two.<br>**• M5 beat I3 said the cells stay green after typing in front of the goal. They go red.** `goalNum` strips non-digits (`forms.js:284–286`), so `9.5≤ 19%` parses to **9.519** and everything above it flags. The truth is sharper and is now filmed: the sloppy repair looks exactly like a correct one, and the only place the real number appears is the chart's goal-line label reading `Dry goal 9.519%`.<br>**• M5 beat E3 staged a confirm dialog on thirteen EMPTY columns.** The confirm is gated on `hasData` (`forms.js:365–366`). The beat now removes empty columns silently, re-adds, types one value, and removes again — which makes the real point: the warning arrives when you fix the mistake, not when you make it.<br>**• M5 beat H3 demonstrated the `_manualHrs` freeze on rows with no Placed time.** `recalcDays` only recomputes when `row.placed && row.removed && !row._manualHrs` (`forms.js:687`), so nothing could have moved either way. The props now build rows 9–12 with a Placed timestamp and the beat is an A/B: two identical rows reading `40` and `91`. Typing into *or clearing* an Hrs cell sets the flag (`forms.js:705`) — the card and the old beat both framed it as a fill-handle-only hazard.<br>**• M5 beat G2 promised two Recommended-vs-Deployed tables.** That table is not in the DOM unless `d.equipCalc` exists (`forms.js:507–510`) and the build never sets it. What the second Drying Log actually prints is worse: `newDryingLog` ships a psychro row dated today (`model.js:346–347`), `gpp("","")` computes through to 0 (`core.js:705–715`), so the carrier's copy carries **a dated monitoring visit that never happened, with a full row of zeros.**<br>**• `.app-only` is a print rule and nothing else** — one occurrence, `print.css:9`. M6's 5:00 beat claimed the sketch tool row and the Add/Remove buttons "vanish" on the on-screen packet page. They do not: the packet renders the live form sheets and those controls still *work* there (`app.js:1437–1494`, `:1506`, `:1547`). The beat now shows both pages and says the true thing — what is on the packet page is not what the carrier gets.<br>**• M6's cold open only fires on markers stamped in the same screen session as the import.** `strokes` is captured once at `sketchPad` construction (`core.js:381`) and repainted by `size()` (`core.js:413–419`), so the props list's pre-built "State A (3 markers)" would have survived the import and nothing would have vanished. State A is now built inside the take, with a rebuild recipe whose order matters.<br>**• M8 beat I1's `NaN` prop cannot be built or displayed.** Editing refT/refRH clears `_refManual` (`forms.js:748`) and the GD cell is `<input type="number">` (`forms.js:767`). Replaced with the real failure, filmed live: backspace the Unaffected RH cell and Unaffected GPP walks `37 → 3 → 0` while GD walks `−7 → −41 → −44` — the same `−44` the module opened on.<br>**• Two citations were load-bearing and wrong.** `narrative.js:26` (cited twice in M4 for the map-area trim) is a `const FN_URL` assignment; the trim is `narrative.js:47`. And M4's replacement reason for the no-trailing-space rule — that the *type* column splits the packet — is also false (`narrative.js:62`, `dryingcalc.js:155–160`). Shot 9 now demonstrates the app forgiving a trailing space rather than asserting any mechanism.<br><br>**Rulings and blocks that were unmarked and now are:** M5's closing insert held the field card's NEVER block, which carries the unruled dry-goal rule (**R2**) — it is now cropped to the FILL DOWN paragraph and shot as a standalone insert. M4's Shots 10 and 12C could not frame the map title without also framing `Dry Goal (MC%)`, one `.grid2` row below it (`forms.js:465–470`, `app.css:170`) — both are now two-frame scrolls. M8's beat H1 reached the same box and is now cut at the dashed navy box. M7's beat 1:42 puts `GYP` on camera as a labelling format that exists nowhere but one line of the SOP — **BLOCKED**, and shot with the material line captured as a separate 5-second insert. M2's asset half is **R1**-blocked and was labelled CLEAR. M8's beats A4/C/D are weather-gated and were not on §2.3's list; §2.3 now lists five non-ruling blockers instead of two.<br><br>**Production rules enforced:** M4's cold open spoke and burned in `729 photos · 67 with a room · 9%`, which M1's own hard rule 1 bans outright. The number is gone from the beat, the shot list and the post-graphics list; the `NO ROOM SET` header and the length of the scroll carry it, and the shot now opens pre-scrolled to the bottom because `photoRoomCmp` sinks roomless photos to the end (`forms.js:2021–2025`). M7's title no longer promises "forty below," a condition the module states it cannot film — the SOP's own rule is *below freezing*.<br><br>**Structure:** §3.1 stops offering three options and resolves the runtime problem — three splits (M5, M6 and **M8**, whose split puts every blocked beat in M8b), and M8 moves out of the shop day to the truck. §4.5 grew from eight sessions covering half the shot list to **eleven sessions covering all of it**, summing to the 716 minutes §1 budgets, across a minimum of **seven** calendar days rather than four. §8.0's agenda now closes at exactly 180 minutes — the ten-minute file copy moved to the first break, A0 got its ninety seconds, and M7's read test got the twelve minutes it needs. §7.2 became eight checks with a Blocked column, and §7.3a resolves the contradiction between five public performance checks and §12.4's ban on individual scoreboards. Runtimes propagated: M4 4:05 → **4:14**, M8 5:20 → **5:42**, every-tech total **41:55** across twelve files. |
| **1.2** | **2026-09-07** | **Second-pass filmability fixes. Six beats re-staged, nothing cut, no runtime moved** — every beat table, shot-list sum, session total and the 180-minute agenda are unchanged and still close. *(This entry covers the module bodies and the cross-references only; §10's citation pass is tracked separately.)*<br><br>**• M5 I3's second half could not be typed.** "Select all, delete, then type at the right end" leaves an empty box, so it produced `9.5`, not a goal string with digits appended. The half now **re-picks Material `Other / Generic (≤ 16%)`**, which rewrites the box unconditionally (`forms.js:381–387`), and types `9.5` at the end of it: `≤ 16%9.5` → `goalNum()` **169.5** → axis top **190**, label **`Dry goal 169.5%`**, all four cells green. Better than the version it replaces: it costs one tap instead of two, and it leaves the map on its build material, so I3 now self-repairs and the retake is free.<br>**• M5 I2/I3 had no lines to move.** Beat F1 deletes reading row 2, and `moistureChartSvg` draws a `<path>` only above one reading (`forms.js:103`) — with one row it draws **four dots in a single column at the plot centre** (`forms.js:74`). Both beats, both narrations and both shot-list entries now say *points*, and I3's shooting note ④ says why.<br>**• M5 H3 part 1 moved off row 1.** Row 1 carries a Placed, so a typed Removed fired `recalcDays` and silently filled `91` hours in frame — unexplained, and unclearable without burning the module's hero row (`forms.js:685–696`, `:705`). Part 1 now starts on **row 2**; nothing in the crop moves.<br>**• M4 Shot 14B was broken by its own last fix.** Completing the `➕ New room…` prompt sets `item.room` twice (`app.js:1998`, `:1979`→`:1992`), so `ct_room` passed and the `Contents: Room on each contents item` line the shot exists to burn in was never on screen. 14B is now **two halves in a forced order**: cut to job home first and film the line, then go back in and invent the room for 14C.<br>**• M4 Shot 14D's toast was not guaranteed.** `aiAvailable()` gates on `likelyOffline()` — *offline flag AND nothing succeeded in five minutes* (`officeai.js:31`, `core.js:53–56`) — so inside that window the tap opened the photo picker and started a real AI call, the exact opposite of the shot's "zero risk, no AI spend" claim. It now carries **M8 H1's relaunch rule**: force-quit and relaunch the PWA under Airplane Mode immediately before rolling.<br>**• The training job is now reconciled across sessions 6, 7 and 8.** M5 leaves a **second Drying Log** and a filled psychrometric row; both make M8's F1 narration false and make M8's B2 "before" panel state unreachable, because those four gates read any row on any log (`anyInstanceRow`, `completeness.js:31`). **M8 props gained step 0** — a two-minute teardown at the top of tablet-C day — written into §4.4, §4.5 session 8 and M5's open question 4, which is now answered. M1 Shot 2's four-row equipment state is shot on that second log before it is deleted.<br>**• M8 B2's four panel lines were in the wrong order.** `evaluateProject` pushes gaps in matrix order (`completeness.js:213–221`, `:75–81`), so the burned-in reproduction is **affected temp, affected RH, outside temp, outside RH** — not outside-first.<br><br>**Consistency and arithmetic:** M2's banner now reads **CLEAR on the four strings · BLOCKED — R1 on the asset half**, matching §3, §2.1 and A2. §3.1 names **M5b (4:33 with its bridge)** alongside M7 as the two files over 4:30. §7.2's preamble says **two** R1-blocked checks, not three. M5's teach-back costs **six** minutes, matching A5 and §8.0. §9.3 puts the `(2)` overflow map in **M6b**. §2.1's R1 row no longer claims **A0** sits inside the tagging block. M1's assessment no longer instructs the public re-ask §7.3a bans, and §7.3a is updated to say so. §4.5 session 6 names M5's **four post cards**, matching session 7's treatment. §3.2 says **three of four** items carry a staging correction. M4's production note says **ten** permanently roomless photos, matching its props. §6.2 carries R1 and R1–R4 markers on the tagging lane and the field card. The `.grid2` "no breakpoint" claim is corrected in both places it appears outside §10 — there is one, at `app.css:617–618`, and it cannot fire on an iPad. |
| **1.4** | **2026-09-07** | **Third-pass close-out.** Two verifiers re-read the corrected document — one walking it as a shoot day, one opening roughly 140 source files to check citations — and reported it sound apart from a short list, all of which is now fixed. **One beat was genuinely unshootable and is fixed with a clause, not a re-stage:** M4's Shot 9 types `Basement Utility` into a `Room / Location` cell that M5 has already filled, which would have produced `Basement UtilityBasement Utility ` instead of the caret frame the beat is built on; the cell is now cleared before the take. **Five citation range-ends were off by one closing brace** and are corrected against the source: `foldable` at `app.js:684`, `packetGroups` closing at `app.js:1494`, `photoRoomCmp` at `forms.js:2021–2025`, `refreshWarn` at `forms.js:633–640`, and `GYP` at `05-CREW-CAPTURE-SOP.md:172`. **Three descriptions were wrong about what is on screen:** `✕ Remove locations 14–26` is `btn--danger`, a **white button with red lettering** (`app.css:110`), not a red one, corrected in all six places; M5's beat E1 pointed at *a gap where the button is hidden*, and `[hidden] { display: none !important; }` (`app.css:603`) takes it out of the flex row so there is no gap; and M5's F2 legend was missing the dry-goal-source clause that SOP §3.5 makes a mandatory slot on every map. **The stylus contradiction that survived three reviews is resolved by scoping rather than by choosing:** the stylus is for fill-handle drags, where a fingertip covers the 13px handle, and every other tap stays a bare thumb so the landing point is visible — the two rules were never in conflict, they were both stated unscoped. **Arithmetic:** M8's G3 is **8s**, matching the beat table the runtime sums from, and R1 blocks **16 seconds** of beat G rather than *about 10*; M5's status line now says **twenty-seven** screen and camera beats out of thirty-two shot-list items, the other five being four post cards and the paper insert. **Session names normalised:** M1 was the only module using its own A/B/C scheme while M4 referenced those letters without defining them; both now use §4.5's session numbers, which is the only scheme the shoot order knows. **The SOP moved to v1.4 in the same pass** — see its own change log — because writing this document is what caused someone to read the code behind §3.1's no-trailing-space rule and find that its stated consequence was false. |
| **1.3** | **2026-09-07** | **§10's citation pass — the one the 1.2 entry deferred.** No beat re-staged, no runtime moved, no content cut; the appendix now says where each control actually is. **Roughly fifty file:line citations corrected**, concentrated in §10.4, §10.6, §10.7, §10.8 and §10.9, several of which had drifted onto unrelated code (`forms.js:825` was *Tech Supervisor*, not the equipment header; `forms.js:653–690` was inside `attachFill`, not `eqRow`; `app.js:1864` was the `inspections` case, not the drying-log title). **The four places where the appendix and a module gave two different numbers for the same fact are reconciled, module-side in every case:** the Remove-locations confirm (`forms.js:366`, gated at `:365`), the instance delete confirm (`app.js:1946`), the `equipCalc` filming blocker (`paintResults()` `forms.js:507–538`, guard `:509–510`) and `setBackground(null)` (`core.js:527`). **Three substantive corrections, not just numbers:** §10.9's toolbar named the wrong control — the toolbar's AI button reads `✨ AI captions (N)` / `✨ Refresh AI captions (N)` / `✨ Redo AI captions (N)` and is hidden outright when nothing is analyzable (`forms.js:2285–2297`), while `✨ Analyze` / `✨ Redo` are the per-photo card's labels (`forms.js:2175`); §10.4's flag legend was quoted with ● bullets that are not on screen (`forms.js:482`, `app.css:222–225`); and §10.2 quoted the offline voice toast with only its first sentence (`voice.js:108–109`). **§10.11 was rebuilt** around the three facts several beats had been written without — the panel lists only what is *missing*, every row renders as `Form: Label`, and there is a third, amber header string (`Ready to bill — N optional item(s) still open.`) — plus a cost note for anyone tempted to script a green panel. **§10.10 was corrected for M6's re-stage:** it still said M6 beat 7 need not film in the print preview; the re-staged 4:56 beat deliberately films both the packet page and the print sheet, because `.app-only` is a print rule only (`print.css:9–11`, the single occurrence in the codebase). **§10.8 now states that `.calc` cells are pale ORANGE on screen** (`app.css:218`) and blue only in print (`print.css:130–131`). **§10.6 now names the second `_manualHrs` path** — typing into the Hrs cell by hand sets the same permanent flag (`forms.js:705`) — and the `placed && removed && !_manualHrs` gate that decides whether the freeze is demonstrable at all (`forms.js:687`). Sixteen stale citations outside §10 that would have contradicted the corrected appendix were brought into line (M1's `.fillh` range, M6's `core.js:391`/`:463–473`/`:509–515`/`forms.js:381–388`/`:426–434`, M5's `forms.js:96` chart-label line and `core.js:450–461`, M11's `forms.js:504–506`, §6.3's and §6's `completeness.js:114–120`, §8's `media.js:16`, and the four verification citations in the 1.0 row above). **A provenance line was added at the head of §10** recording the date its citations were last checked. **All quoted on-screen strings in §10 were re-checked character for character**, including curly vs. straight quotes; the only mismatches found were the two named above. **No ruling-blocked value appears anywhere in §10** — the eight material goals it quotes come from `DRY_STANDARDS` in code, not from the unruled R2 convention, and the appendix states no asset-tag format, visit cadence, grain-depression threshold, scrubber authority or equipment billing unit. |
