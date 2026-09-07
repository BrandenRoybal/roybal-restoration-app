# Crew Capture SOP — Water Mitigation
**Roybal Construction LLC · Version 1.4 · Effective 2026-09-07**

Who reads what:
- **Sections 3–11** are for field technicians. Print section 11 and carry it.
- **Sections 1, 2, 12, 13** are for the owner and the office.

**Every instruction in this document has been checked against the app as it exists today.** If a step tells you to tap something, that control is on the screen right now. Where the app cannot do a thing, it is in §13 with what to do instead. Nothing in §3–§11 depends on software that has not shipped.

**Sections 3–11 carry no production statistics.** Rules stand on their own; a technician does not need a count to follow one. The evidence behind the rules is in §2, dated, in one block.

---

## 1. Why this changed

An adjuster sits at a desk and re-does our math. If they can't rebuild our equipment days and our drying trend from the paperwork alone, they cut the invoice — and they do it without calling us.

Here is what that looks like in our own files. Asset number `101` appears on four different jobs. On those four rows it is typed as `Air mover`, `Air mover  `, `Axial Air Mover` and `Dehumidifier Dry-Eaze Xi7000` — three air movers and a dehumidifier, all carrying the same tag. Nobody read `101` off a machine. It was manufactured by dragging the fill handle down the Asset column, which auto-increments, so every job independently regenerates 101, 102, 103. An adjuster who asks which machine `101` was, or whether the same unit was billed on two jobs at once, cannot be answered from the file. Neither can we.

The field work is not the problem. Four machines are not one machine because a spreadsheet handle said so.

The paperwork is what leaks money.

Nothing in here is about working harder. It is about writing down, at the moment you do it, the four things a carrier pays for: **which spot, which machine, which day, which number.**

**Read this before you believe the rest of the document.** Until the P3 rebuild lands, this discipline buys us an **internal leak detector**, not a bulletproof carrier justification. The app still stores a reading point as a bare column number. The Certificate's equipment-day boxes are still free text that nothing computes. Two documents in one packet still count equipment two different ways. We do this now anyway for two reasons: it catches our own billing errors before the adjuster does, and it means the rebuild is a data migration instead of starting over. The full list of what the app cannot do is §13, and the office check in §12.4 — not the app's completeness panel — is what actually clears a packet for submission.

---

## 2. What is different starting now

| | Before | Starting now |
|---|---|---|
| **Asset numbers** | Numbers created by dragging the fill handle down the Asset column, which auto-increments — so the same tag lands on unrelated machines on unrelated jobs. | Every machine carries a permanent fleet tag (`AM-014`). You type the tag you read off the machine. **Never drag-fill the Asset column.** |
| **Equipment type** | Freehand. `Air mover`, `Air mover  ` and `Axial Air Mover` are three strings for one class. The two counters diverge on the **different words**, not on the whitespace: the narrative groups on the trimmed string as typed (`narrative.js:62`) so `Air mover` and `Axial Air Mover` become two line items, while the sizing table lowercases and pattern-matches (`dryingcalc.js:152-162`) and counts both as air movers. Same rows, two numbers, one packet. | Exactly four strings, copied character for character. Make, model and rating go in Notes. |
| **Room names** | Whatever each tech typed, in four unlinked free-text boxes that nothing reconciles. | One room list, written on a card taped in the panel door on day 1. Everyone copies it exactly. There is no room manager in the app — the card is the list. |
| **Reading spots** | A number in a column. Which wall it was lives in somebody's head. | Numbered **1–13 within each map**, a paint-pen mark on the material, and a written legend in the first reading row's Notes. Same spots, same order, every visit. |
| **Dry goal** | Auto-filled from the app's generic table, usually left alone. | Set on day 1 from a **control reading** on unaffected material of the same type, with the same meter — in the **moisture map's** Dry Goal box, after Material is set. |
| **Removal time** | Often reconstructed at closeout. | Set the same day you pull the machine, from the truck or the warm station. |
| **Psychrometrics** | One row satisfies the app. Rows go out with the Unaffected pair blank — and a blank pair does not print empty, it prints `0` GPP. | Outside, Unaffected, Affected — every visit, no blanks, one row per affected chamber, chamber name first in that row's Notes. |
| **Photos** | Fewer than one photo in ten carries a room. | Room on every photo, spelled like the room card. Stage set to Before / After on the shots that have to be Before or After. |
| **Reading cadence** | The app is satisfied by one reading, once, on one map. | A reading round and a psychrometric row for every day equipment is on site — **or a one-line reason code** for the day you didn't go. |

### The evidence behind these rules — live jobs, as of 2026-09-07

This is the only place in this document that quotes production counts. Every number below was read off the live database on that date. **§3–§11 carry none of them**, deliberately: a rule that needs a statistic to be worth following is not a rule.

| Measured | Count |
|---|---|
| Job photos (top level) | **729** |
| …of those, carrying a room | **67 (9%)** |
| Moisture maps | **14** |
| …of those, with an empty name | **7** |
| Equipment rows whose **type** string has untrimmed whitespace | **45** *(this is a type-string defect. No equipment row has an untrimmed room/location value.)* |
| Per-unit equipment rows | **116 across 7 jobs** |
| …complete with asset, type, location, placed, removed and hours | **113** |
| Asset `101`, typed four ways across four jobs | `Air mover` · `Air mover  ` (two trailing spaces) · `Axial Air Mover` · `Dehumidifier Dry-Eaze Xi7000` |
| Best-documented job in the system (Jeff Hebard) | 12 moisture reading dates · 11 psychrometric dates |
| The 215-air-mover-day job (Cheria Fidler) | 10 moisture reading dates · 7 psychrometric dates · 31 equipment rows — **well documented; it is not the problem job** |
| Rows in the `equipment_logs` database table | **5**, all dated March 2026, **none carrying a removal** — and no code anywhere in the app writes to it |

**Two corrections to things you may have heard.**

**Per-unit equipment logging is not new.** It has been in the Drying Log the whole time and the crew has been filling it — 113 of 116 rows are already complete with asset, type, location, placed, removed and hours. You already have the habit. This SOP does not introduce it; it tightens two things about it: the asset number has to identify a real machine, and the type string has to be one of four exact spellings.

**The `equipment_logs` database table is dead.** Nothing writes to it, and what little it holds was never finished (see the table above). Everything real lives in the Drying Log's equipment table. Ignore anything that tells you otherwise.

---

## 3. Room names and reading points

### 3.1 The room list

**The lead tech makes the room list once, on the first visit. Nobody invents a room name after that.**

**The list lives on a card taped inside the electrical panel door. That card is the list.** The app has no room manager and no room picker — the Room boxes on the moisture map, on photos and on equipment rows are all free text, and nothing links them. **The spelling is the link.** Copy the card by hand into each box.

> Do **not** use Contents → ➕ New room… to build the list. That option only exists inside a contents *item*, so using it on a water job means creating a nameless contents item — which then prints on the Contents Inventory, lands on the carrier CSV as a blank row, turns the job's Contents badge on, and permanently attaches the contents billing gates to a job that has no contents. It buys nothing: `project.rooms` feeds exactly one dropdown filter on the contents list and appears on zero printed documents. If the job **does** have contents, use the same card spellings in that picker.
>
> The **AI photo-scan bulk-add panel** is the other way rooms get invented — it pushes whatever room names it read out of the photos straight onto that same list, and creates contents items for them. **Treat anything it adds as something to correct, not to adopt.** The panel-door card is still the list.

**Grammar:** `<Level> <Room> <number if repeated>`

Level is one of exactly seven words. No others:

`Basement` · `Crawl` · `Main` · `Upper` · `Attic` · `Garage` · `Exterior`

Repeated rooms are numbered **clockwise from the front door**, so two techs number them the same way.

Good: `Main Kitchen` · `Main Living` · `Upper Bedroom 2` · `Basement Utility` · `Crawl North Bay`

**Three rules that break the job if you break them:**

- **No trailing space.** No space after the last letter. Typing hygiene, not a mechanism — and v1.4 corrected what this rule used to claim. Nothing in the app splits a room on a trailing space: the room prompt trims what you type before it stores it (`app.js:1995`), and every consumer trims again before grouping — photos (`forms.js:2015`, which also collapses double spaces), contents (`forms.js:1266`, `:1398`) and the packet narrative (`narrative.js:47`, `:69`). The rule that actually has teeth is the equipment **type** string in §6.2, and it is about different *words*, not whitespace.
- **⚠ Spell it right the first time, because a room name cannot be deleted.** `project.rooms` has two writers — the ➕ New room… prompt inside a contents item (`app.js:1997`) and the AI photo scan (`app.js:2090`) — and **no delete path anywhere**. Deleting the contents item that created a room does not remove the room (`deleteItem`, `app.js:2293-2300`, tombstones the item and never touches `rooms`). A typo you make once is on that job for the life of the job, in every room dropdown, forever. This is the real reason to slow down on the spelling.
- **Never put a material in a room name.** `Basement Drywall` is not a room. The material belongs to the map (§3.2), not to the room. A map whose title names one material while its Material dropdown says another — drywall judged against a wood standard — is a defect an adjuster catches on sight.
- **One spelling, three places, plus the front of the map title.** The same room string goes in: every photo's **Room** field, every equipment row's **Room / Location**, the invoice line's room — and it is the **first part** of the moisture map's title. The map title is *not* the same string as the photo Room; it is the room name **plus a hyphen plus the material** (§3.2). Everything before the hyphen must match the card exactly.

**Never rename a room after day 1.** A rename creates a second room, it does not move anything.

### 3.2 One moisture map per room **and** per material

Material and Dry Goal live on the **map**, not on the individual reading point. So a room with wet drywall and wet framing needs **two maps**.

- Map's **Room / Area (titles this map)** = the room name from the card, verbatim, then a **plain hyphen**, then the material: `Basement Utility - Drywall`. That box is what the carrier narrative uses to name the affected area, and it is the only place a map gets a name at all. **A plain hyphen, not an em dash or a middot** — those are not on the phone keyboard and half the crew will type something else.
- Map's **Material** = the actual material those numbers read. It must agree with the material in the title.
- **Name every map.** An unnamed map falls back to its material in the list — so four unnamed wood maps all show the identical string and nobody can tell them apart.

**The Material list is eight fixed options** — Drywall / Gypsum · Plaster · Concrete / Slab · Hardwood Flooring · Carpet / Pad · Framing / Wood / Subfloor · OSB / Particle Board · Other / Generic. There is no LVP, tile, insulation, cabinet base or engineered wood. If your material isn't on the list: pick **Other / Generic**, name the real material in the map title, and say so in the first-row Notes — in the map-flags slot at the end of that cell (§3.5). Do not invent your own convention.

**One map per room+material, created once on day 1, reused for the life of the job.** Every visit adds a *reading date* to the existing map — never a second map for the same room and material.

**The one exception, and the only one: point-count overflow.** A map holds thirteen points and no more (§3.3). If a single room needs more than twelve affected points of the *same* material, open a second map for that room+material and title it `Basement Utility - Drywall (2)`. Number it 1–13 like any other map, with **Loc 1 as the control on that map too**, and say in its first-row Notes — map-flags slot, at the end of that cell (§3.5) — `overflow map - continues Basement Utility - Drywall`. This is the only reason a room+material ever gets two maps; a new visit is never a reason.

*Why this way:* the alternative was to tell a tech to drop real readings or to tap `+ Add locations 14–26`, which prints thirteen blank numbered boxes to the carrier. A tired tech gets "start a second map and call it (2)" right; nobody gets "decide which four readings to throw away" right.

### 3.3 Reading points — numbered 1–13, **per map**

**Place every marker before you write the first number.** Use the sketch pad's **① Number** tool. Tap a color or the Number button first — the pad starts in scroll mode and will not draw until you arm a tool.

**Numbering is per map and starts at 1 on every map. That is what the app does and it cannot be changed.** The ① Number tool counts from that map's own counter; a new map always starts at 1, and there is nowhere to set a starting number. So a four-map job will have four markers labelled "1", four labelled "2", and that is correct.

**Because a bare number is ambiguous, a point is always named `<Map name> Loc N`.** Say it that way on the phone, write it that way in captions, write it that way in Notes. `Basement Utility - Drywall Loc 3`. Never "point 3." Plain hyphens only — no middots, no em dashes.

**Import the floor plan BEFORE you stamp any marker.** Importing, cropping or removing a plan re-fits the canvas and redraws the markers from the state the screen opened in — so markers stamped and then followed by a plan import can silently revert, while the counter keeps climbing and your next stamp issues a number with no visible predecessor. Plan first, markers second, every time. If you must change the plan on a map that already has markers, re-open the map afterwards and **count the markers before you stamp another one.**

**Point 1 is always the CONTROL, on every map.** You stamp it first, so the auto-numbering gives it to you for free.

- **The control is not in this room.** It is the same material, read somewhere unaffected in the same structure.
- **Where you put the marker does not carry that meaning — the legend does.** On a map with an imported plan the plan is stretched to fill the entire canvas, so there is no empty corner to put it in. Stamp Loc 1 anywhere on the sketch that is clear of a room you will need later — a margin if the plan leaves one, otherwise a corner — and then **name the control's real location in the first reading row's Notes**: `1=CONTROL unaff Main Hall gyp`. That string is what an adjuster reads. The dot on the plan is not.
- Affected points are **2 through 13**.

**Thirteen points per map, maximum. Do not tap `+ Add locations 14–26`.** The grid has 13 columns and there is no way to have fewer. Adding a block adds thirteen more columns, and every one of them prints as an empty bordered box under a filled navy numbered header on every visit row of the carrier's copy. An adjuster reads a blank numbered cell as a reading that wasn't taken.

**Where the thirteenth point is not enough, there is exactly one move:** open a second map for the same room and material, titled `(2)` (§3.2). Never add columns. If you have already tapped `+ Add locations 14–26` by accident, the red **`✕ Remove locations 14–26`** button beside it takes them back out — it warns first if any of those columns already hold a reading. Use it the moment you notice, before the packet prints.

Even at 13 points you may leave some columns unused. Say so in the legend, in the one spelling this document uses everywhere: **`cols 5-13 unused`** on a map that defines points 1 through 4 — the first number is the one right after your last defined point, the second is always 13. It goes in the first-row Notes, right after the legend (§3.5). One string, and the blank boxes stop looking like missed readings.

**Height is part of the point.** `12" AFF` is the standard wall point — below the flood-cut line, above the base plate. A point at 24" on the same stud bay is a **different number**. Never "same wall, about the same height." That drift is invisible in review and it destroys the trend line.

**Never renumber. Never reuse a retired number. Never insert.** If a point is destroyed by demo, retire the number and write `Loc 6 retired 09/12 - flood cut` in **that day's reading-row Notes** — never in the first row, which is the map's legend cell (§3.5). A renumber silently rewrites the job's reading history and it cannot be repaired later.

- A retired point leaves its column blank from that day on. The retire note in Notes is what stops that blank reading as a missed reading — write it the same day.
- **You do not have to replace a retired point.** Only open a replacement if the material is still there and still needs watching.
- If you do need a replacement and the map already uses all thirteen numbers, the replacement goes on the `(2)` overflow map (§3.2) with its own numbering. Never re-issue a retired number to get around a full map.

> **⚠ `↺ Clear drawing` is live ordnance.** It sits in the same small button row as `↩ Undo`, one gloved thumb away. There is **no confirm dialog.** One tap erases every stroke and every number marker on the map, resets the numbering counter to 1 so your next stamp re-issues a number already in use in the grid, wipes the undo stack, and saves immediately. Undo cannot bring it back — and the undo history is gone anyway the moment you navigate off the map screen and come back. What survives: the imported floor plan, the equipment-placement pad, the whole reading grid and its numbers, the Notes legend, and the map's Room / Material / Dry Goal. What does not: your markers.
>
> **A mis-placed marker gets a paint-pen X on the material and a retire note. It does not get cleared.**

### 3.4 Physical labeling

Write the label on the material with an **oil-based paint pen**.

- **Regular Sharpie is banned** — it runs when wet and fades under a dehu.
- **Blue painter's tape is banned** — it releases in high humidity and cold.
- Inside a flood-cut zone, write straight on the drywall or the stud. It's coming out anyway.
- On a finished surface you can't mark: a plastic tag on a short zip tie, or write it inside the outlet cover.

**Cold-weather lane — below freezing an oil paint pen will not flow.** The nib will not prime and the paint will not lay down; this is not a technique problem. So:

- **Keep the pen inside your jacket** between marks, nib down. Two minutes against your body is usually enough.
- **Mark while the space is still warm** from demo or from the heaters, not at the end of the visit.
- **If it still won't write:** number a strip of aluminum flashing with a nail set or a center punch and wire it to the stud, or a plastic tag on a zip tie. Then **photograph the tag** — the photo is the label.
- A mark you cannot make is not a rule. Take the photo and tell the lead.

Label format, readable by headlamp at arm's length:

```
   7
 12" AFF
   GYP
```

Put the label about 2 inches to the left of the pin holes so the holes stay visible and the next tech reads the same spot.

**Three anchors per point, so losing one doesn't lose the point:** (1) the paint-pen or tag mark, (2) the number label, (3) a day-1 photo of the labeled point with the meter in frame.

### 3.5 Write the legend down — in two places

The app does not store a name for a reading point. The number in the column is all there is. **The legend is the only thing that makes those numbers mean anything.**

**There is no text tool on the sketch layer.** The tool row is `✋ Move` (which is the mode the pad starts in — tap a color or `① Number` to arm it), a pen in four colors, the number stamp, `↩ Undo` and `↺ Clear drawing`. That is all of it. You cannot type a label next to a marker, and finger-drawing "N wall 12in AFF" next to a 34-pixel circle on a 320-pixel canvas will not be legible in the packet. Don't try. The legend lives in exactly two places:

1. **In the map's first reading row Notes cell.** That cell is the map's header, not a visit note, and **five different rules put a string in it.** They go in this order and no other — this is the map-Notes order for the whole document, the way §4.2 is the psychrometric one:

   **`<initials>.`** then **`<the point legend>`** then **`<the unused-columns note>`** then **`<the dry-goal source>`** then **`<map-level flags, if any>`** — with a semicolon typed between the pieces.

   `BR. 1=CONTROL unaff Main Hall gyp; 2=N wall 12in AFF; 3=N wall 48in AFF; 4=E wall 12in AFF; cols 5-13 unused; goal from control Loc 1 = 5.9 on 2026-09-06`

   1. **Your initials**, always, first. The reading row has no tech field.
   2. **The legend** — every defined point, in number order, `n=<where it is>`. Loc 1 is written `1=CONTROL <where>`.
   3. **The unused-columns note**, in exactly this spelling: **`cols 5-13 unused`** — where the first number is **the one right after your last defined point**, and the second is always 13. Four points defined means `cols 5-13 unused`. Nine points defined means `cols 10-13 unused`. Omit it only when all thirteen are defined.
   4. **The dry-goal source** (§4.8) — exactly one of `goal from control Loc 1 = 5.9 on 2026-09-06` or `no unaffected framing available, goal from IICRC table`. Every map carries one of the two.
   5. **Map-level flags, when they apply:** the real material when the Material dropdown says `Other / Generic` (§3.2) — `material = LVP over slab` — and, on an overflow map, `overflow map - continues Basement Utility - Drywall` (§3.2). Both, in that order, if both apply.

   **First row only.** Later rows' Notes are that visit's notes: the retire note (§3.3), what you did about a point, what changed. Nothing from the list above is ever repeated on a later row, and nothing from a later row is ever added to this one.
2. **One photo per point at creation**, Room = the room card name, caption in the §8 format:
   `<what> - <Room> - Loc <n>` — for example `Control point, unaff Main Hall gyp - Main Hall - Loc 1`. Plain hyphens; the same caption format as every other photo on the job.

---

## 4. First visit — initial assessment

Do these in order. Nothing on this list can be reconstructed later.

1. **Time of loss report and time of first arrival.** Write both in the Field Report's **Notes** box — the one under the *Notes for the Office* heading — the moment you have them.
   > **The Field Report has no field for a time, a volume or a measurement.** Its only writable text is three free-text boxes — **Notes**, **Issues**, **Materials Needed** — plus photos and a signature. Everything §4 sends to the Field Report goes in the **Notes** box, one labelled line each, so the office can lift them onto the loss-intake summary without guessing which line is which:
   > `loss reported 09/06 0710; first arrival 09/06 0845`
   >
   > ⚠ **The Field Report does not reach the carrier.** The packet builder skips it by design — it is the crew-to-office form, and it is labelled "internal — not in packet" in the app itself. So writing these two times in the Field Report records them for *us*; it does not defend the emergency-service or after-hours line items. **The office lifts them onto a one-page loss-intake summary and uploads it to Supporting Docs, which does print full page in the packet** (§12.4). Your job is to capture the times accurately on day 1. Nobody can reconstruct them later.
2. **Category and Class, with a one-line reason each.** Tap the segmented **Water Category** and **Class** buttons on the Drying Log. **There is no reason box next to them** — so type the reason into the **first psychrometric row's Notes**, after the chamber name, in the Notes order below:
   `Basement Utility - Cat 2 supply line to washer, no sewage. Class 2 wet carpet + wicking under 24in in 3 of 4 rooms.`
   Class is the divisor in the dehumidifier sizing math and Category drives the whole air-scrubber line. An undocumented Class is an undefended dehu count.

   > **THE PSYCHROMETRIC NOTES ORDER — set here, once, for the whole document.**
   >
   > **Everything any section of this SOP puts in a psychrometric row's Notes goes in this order and no other. Where another section names a string, it names the slot it belongs in; it does not define a new order.**
   >
   > **`<Chamber name>`** then **`<reason line, if any>`** then **`<dehu outlet, if taken>`** then **`<the day's notes>`** then **`<source stamp, office only>`** — with a plain hyphen typed between them.
   >
   > 1. **Chamber name, always, on every row.** It is the only thing that tells two rows on the same date apart.
   > 2. **The reason line, when there is one.** On day 1 that is the Cat/Class reason. After a missed day it is the no-visit reason code (§5). A row never needs both, because day 1 cannot follow a gap.
   > 3. **The dehu outlet string** (§7.3), if you took one: `dehu DH-003 outlet 96/14`.
   > 4. **The day's notes** — everything else that day needs, in whatever order it happened. This slot is the catch-all, and it is where the rest of the document's strings land: the standing-water volume (§4.3), the migration boundary and its dry check (§4.5), an out-of-range outside instrument (§5.1), a Drying System change with its date and reason (§5.8), and the conditions and actions of the visit.
   > 5. **The source stamp `[paper - <tech name>]`**, last, and **only when the office transcribed the row off a paper card** (§10.2). A tech typing their own row never writes it — so in the field the order is exactly the four slots above, which is what the card prints.
   >
   > *Why chamber first:* it is on every single row, so a tech never has to decide. The reason line is the exception, and exceptions go second. Everything else is the day's notes, so there is nothing left to rank.
3. **Standing water, before you extract it.** Length × width × depth. (cu ft × 7.48 = gallons.) Write it in the Field Report's **Notes** box **and** — because the Field Report is internal — say it again in that day's psychrometric Notes, in the day's-notes slot (§4.2): `standing water 12x8x0.25 ft = 24 cu ft / 180 gal before extraction`. If you extract first, the extraction quantity is a guess forever.
4. **Write the room list on a card and tape it inside the panel door** (§3.1). Do not touch Contents.
5. **Walk the migration boundary** with the non-penetrating meter. Mark it on the sketch with the pen **and** write it in words in **that day's psychrometric Notes**, in the day's-notes slot: `wet extends 18in up N wall, 4ft out from door.` (Not the moisture map's first-row Notes — on day 1 that cell is the legend, §3.5.) Then **take one DRY reading just outside the boundary and write the number** in the same place: `boundary check 5ft out from door = 8.1% on wood, dry`. A boundary you only described is an assertion; a boundary with a dry number behind it is evidence.
6. **Measure each affected room** — these are the literal inputs to the equipment worksheet:
   - floor SF
   - wall perimeter LF
   - ceiling height
   - wet wall + ceiling SF **above 2 ft**
   - count of wall insets / offsets **greater than 18 inches**

   Write these in the Field Report's **Notes** box, one line per room, and keep the tape shot: `Main Kitchen: 180 SF floor, 54 LF perim, 8ft clg, 60 SF wall+clg above 2ft, 1 inset`. **Two things to know about where they land.** First, the floor plan's dimensions table is internal — it does not print in the packet, so a measurement that lives only there is a measurement the adjuster never sees. Second, unless the AI floor-plan takeoff has run (it needs signal), the sizing worksheet gives you exactly one **Wet floor area (SF)** box and one **Affected wall perimeter (LF)** box for the whole job, and it sizes as a single room. **Step 1 of the air-mover worksheet is one air mover per affected room**, so on a four-room job entered by hand the worksheet recommends three fewer than §6.5 does. That is not an error in your deployment. **Write the per-room count in the Deviation box** — `4 affected rooms; worksheet run as one area, +3 air movers per worksheet step 1` — and the packet carries the real math.
   > **The Deviation boxes do not exist on screen until the worksheet has been run once.** They are cells in the Recommended-vs-Deployed table, and that table is not drawn until you tap **🧮 Size the equipment** (step 13). Take the measurements now, write them in the Field Report now, and write the Deviation line at step 13 — that is why sizing is the later step.
7. **Control reading, per material class.** For every wet material type, find the same material in an **unaffected** part of the same structure and read it. Same meter, same scale.
   - **It is Loc 1 on that map** — stamp its marker first, anywhere clear on the sketch, and name its real location in the first-row Notes legend (§3.3). The legend carries the meaning, not the position of the dot.
   - Mark and label the physical control point `1 CONTROL`.
   - Photograph the meter display at the control.
   - Read Loc 1 on **every** visit for the rest of the job. It proves the whole house didn't just get wetter.
8. **Set the Material FIRST, then the Dry Goal — in that order, and never go back.**
   - **The box is the Dry Goal on the MOISTURE MAP**, beside Material — same row, to its right on a tablet, under it only on a small phone. That is the one the app computes from: it drives the green/red cell flagging, the trend chart, the billing gate, the drying-down flag, and the customer portal.
   - **⚠ Changing Material at any later date silently overwrites your Dry Goal with the app's generic table value.** No warning, no confirm, no history. Correcting a map from `Other / Generic` to `Framing / Wood / Subfloor` in week two replaces `5.9` with `19` and turns every red cell on that map green on the spot. If you ever touch Material again, **re-enter the control-derived goal immediately and re-check the flagged cells.**
   - **Type a bare number and nothing else.** The app strips everything that isn't a digit or a dot and re-reads what's left, so `≤ 19% (ctrl 12.4)` becomes a dry goal of **1912.4%** — which flags every cell green and draws the goal line off the top of the chart. Provenance goes in Notes, never in the box.
   - **Goal = the control reading + 2 points.** That is the rule. A measured dry standard on the same material, in the same building, with the same meter, beats a generic table — that is the whole reason §4.7 has you take a control at all.
     - **The app's auto-filled table value never raises a control-derived goal.** If the control gives you 7.5 on framing, the goal is 9.5, not the table's 19. Type over the auto-fill.
     - **Use the table value only when no control was taken** — no unaffected sample of that material exists in the structure. Then say so: `no unaffected framing available, goal from IICRC table`.
     - **Record the source either way, in the map's first-row Notes, in the dry-goal-source slot** (§3.5): `goal from control Loc 1 = 5.9 on 2026-09-06`. Every map carries one of these two strings.
     - *Why this way:* "whichever is higher" always selected the table on wood, which would flip currently-wet cells green and end jobs with framing still above its own building's dry standard. Signing a Certificate of Drying on framing at 18% in a house whose own unaffected framing reads far lower is a re-open, and it is not what S500 means by a dry standard. See §12.0.2 — the owner confirms this against the meters we own before it is trained.
   - **The Drying Log has a second Dry Goal box. It computes nothing** — it is read by no code anywhere in the app — **but it prints.** Leave it empty, or copy the map's number into it verbatim. A different number there contradicts the Certificate of Drying in the same packet.
   - **The goal must be on the same scale as the meter.** If you're on a Tramex non-invasive scale, a "19%" pin-meter goal is meaningless. Name the instrument and the mode in **Meter / Setting** — `Tramex MEX5 - non-invasive, scale 2` — and keep the same meter on that material for the whole job. **Meter / Setting is a dropdown, not a text box:** pick the preset if it is already in the list; if it isn't, choose **`➕ New meter / setting…`** and type it. The presets it saves live on that one tablet and never reach another, so type the make, model and mode exactly the way every other device does.
9. **Place all markers, label them, photograph them, write the legend** (§3.3–3.5).
10. **First reading at every point.**
11. **Set Dry-out Start Date** on the Drying Log. It drives the drying-window banner you and the office watch all job, and it is the narrative's fallback start date. It does **not** flow into the Certificate of Drying — that form has its own hand-typed **Drying Start Date**, **Drying Completion Date** and **Drying Duration (days)** boxes, and its number wins over the narrative's. Filling those is a closeout step (§9.3), not this one. Set this today anyway; nobody has been.
12. **First psychrometric row** — Outside, Unaffected, Affected, plus date, time and your name. One row per affected chamber, chamber name first in the Notes (§7).
13. **Size the equipment, once.** Drying Log → **🧮 Size the equipment**. Check it against §6.5. If what you deploy differs from the worksheet, **type the reason in the Deviation box that day** — `09/06 two circuits available, staged deployment`. That box prints for the adjuster.
    - **Set these three before you tap the button, or the worksheet quietly uses defaults:** **Ceiling height (ft)** (defaults to 8), **Dehumidifier type**, and **Unit size (AHAM pints)** (defaults to 70). We run 70 / 110 / 130 LGRs — a 130-pint machine sized at 70 makes the worksheet recommend nearly twice the units you deployed, and the packet prints your honest deployment as a shortfall.
    - **The air-scrubber row always sizes at 500 CFM.** There is no CFM box for it — the one that exists only appears for desiccant dehumidifiers. If you run a different rating, the worksheet's scrubber count is wrong for your fleet: put the real arithmetic in the Deviation box — `Phoenix Guardian 700 CFM: 9,600 cu ft x 2 ACH / 60 = 320 CFM = 1 unit`.
    - **Run the worksheet on day 1 and never re-run it.** It stores a single snapshot that overwrites, and its heat justification is computed from the *latest* affected temperature in the log — so re-running it in week two, with the chamber at 78°F, flips the printed basis to "no auxiliary heat needed" and retroactively destroys the justification for every heater day you billed. If conditions change, write the change in the Deviation box and in that day's Notes instead.
    - The Deviation box is one free-text field per equipment type that overwrites when edited, so **date-stamp every deviation inside the text.**
14. **Place the equipment and log every unit** (§6).
15. **Before photos, room by room, before you touch anything.** Plus the source of loss. **Set Stage = Before on every one of them** (§8).
16. **Signed Work Authorization.**

---

## 5. Every monitoring visit

**A reading round happens on every calendar day equipment is on site — or the day gets a written reason.** A day with equipment, no reading row, and no reason is a day we will not bill for equipment.

> **Two rules that sit above every step below.**
>
> **Never write a reading, a date or an hour for a visit that did not happen.** Not a carried-forward number, not an estimate, not "it was probably the same." One invented row makes every other row in the file arguable, and it is the one defect that turns a reduction into a denial. A missed day gets a reason code, not a number.
>
> **One device edits one job on one day.** Two tablets on the same job do not merge field by field — for the drying log and the moisture maps the newer save wins the *whole* record, so the loser silently gives up its equipment rows and its psychrometric rows, not just its moisture numbers. On a two-tech visit, **one tech carries the tablet.** This does not require paper to happen; two tablets is enough. The mid-visit-failure procedure is §10.2.

**No-visit reason codes.** If a day is missed, the *next* visit's psychrometric row Notes carries the reason for the gap in the reason-line slot — after the chamber name, before everything else (§4.2) — in one of these forms:

`NO ACCESS 09/08 - homeowner away, texted 0830` · `ROAD CLOSED 09/08 - Chena Hot Springs Rd` · `HOLIDAY 09/08 - units running, no change` · `SAFETY 09/08 - active gas leak, utility on site`

A documented skip is defensible. A silent gap is not. You cannot go back and take Sunday's reading, so write the reason the first time you're back.

Do the visit in this order — it minimizes glove-off cycles and backtracking.

**0. Before you leave the shop.** **Sync while you still have signal** — open the app, let the dot go green, and open every job you are visiting today so you know it is on the tablet. A job created or changed on another device since your last sync is not on this one, and you cannot pull it in a dead zone. Check your battery, and confirm you are the only person taking a tablet onto each of these jobs today. Keep the tablet inside your coat between rooms — a cold battery quits well above 20%.

1. **Outside T and RH — at the truck, before you go in.** Hang the hygrometer outside and give it **three to five minutes to equilibrate** before you read it; carried straight out of a 70°F cab it reads the cab. Most field hygrometers are not rated below freezing — if the display blanks, stalls or reads impossibly, write `outside instrument out of range, est. -22°F from truck gauge` in the row's Notes, in the day's-notes slot (§4.2), and put the truck's temperature in. Never invent an RH.
2. **Unaffected room T and RH.** This room is the **warm station**. The tablet lives here. All typing that isn't a bare number happens here or in the truck.
3. **Equipment round — before the readings.** Walk every unit. Running? Tag matches the row? A tripped breaker changes what today's numbers mean, and finding it now means you fix it on this visit. Note only what **changed** — "all present and running" is the default, not twelve entries.
   - Pulling units today? **Write the tags and the clock time on your hand, your card or a photo, at the machine.** Then enter Removed date+time **at the warm station or in the truck, before you leave the property.** Working a datetime picker on twenty units in a −20°F crawlspace is not going to happen, and a rule nobody follows is worse than an honest one. Never at closeout. Never the next day.
4. **Affected T and RH — one reading per chamber**, taken while you're at the machines. Plus the dehu outlet (§7.3).
5. **Add today's reading date to every map.** On an eight-map job that is eight separate `+ Add reading date` taps, and there is no way to do them all at once. Forgetting one leaves a gap the office finds at closeout. **Count your maps.**
   - **Reading dates go in in date order.** The trend chart plots rows in the order they sit in the table, not by date, and the narrative reports the *last row* as the final reading. Back-filling a missed day puts it at the bottom, so the packet's narrative reports the older, wetter number as the final one and the chart draws a rise at the end of the job. If you must back-fill, **look at the trend chart afterwards and confirm it still falls left to right.**
   - **If it doesn't, there is no reorder control** — the table has a date box, the value cells, Notes and a ✕ delete, and nothing else. The only fix is to **delete the rows that now sit out of order and re-enter them, oldest first**, copying the values off the printed sheet or a photo before you delete anything. **The ✕ at the right end of a row deletes it on the tap, with no confirm** — unlike the column-delete button, which warns. Slow hands near that edge, on this screen and on the equipment table. Do it the same day, at the warm station, while you still have the numbers in front of you. Tell the office it happened.
6. **Moisture route** — **every map, every point, `Loc 1, 2, 3…` in order.** Read the label, not your memory. Same pin holes.
   - **Read every established point, including Loc 1, the control.** No skips. If a point is gone, retire it (§3.3) — do not leave the column blank without a note.
   - Can't reach it, or can't work the screen? **Photograph the meter display next to the point label.** You type the number at the warm station.
   - **Start every moisture row's Notes with your initials.** The reading row has no tech field and no time; your initials are the only chain of custody on those numbers.
   - **Type readings. Never dictate them.** Voice dictation needs signal, so on a real job it usually just fails — and when it does work it drops the number into the next *empty* column regardless of the location you said, which silently files a reading against the wrong point. The same goes for the floor plan's ✨ Read dimensions and the AI photo analysis: useful in the office, never a step you depend on in the field.
7. **Photos of anything different from yesterday.** Demo, new equipment, a new wet area, a tenant problem.
8. **Warm station: type in everything you photographed.** Then:
   - Any point **at or below goal** — say so in that day's Notes, and either pull the equipment serving that area or write why it stays.
   - Any point **not improving** — write what you did about it: added a unit, raised heat, opened a cavity, drilled weep holes, changed from open to closed. "Not drying, no change made" reads as a billable day with no work behind it.
   - **If you change the Drying System toggle** (Open / Closed / Hybrid), write the date and the reason in that day's psychro Notes, in the day's-notes slot (§4.2), **before** you move it. That toggle is one project-level setting with no date on it, so moving it rewrites what the record says was running on every earlier day.
   - Any unit **7+ days on site** — the app turns the job tile amber. Write the justification **that day**, in the equipment row's Notes, citing the reading: `Loc 4 still 3 pts over goal on 09/12.`
9. **Driveway check, before you drive away.** Job saved (there is no Save button — it saves every keystroke)? Battery? Sync dot — **green means synced; red is normal off-grid and means "saved on this device."** The dot cannot tell you the difference between offline and a sync error on a touchscreen, so red is not a reason to sit in the driveway. If it is still red on the next job with good signal, call the office.

### Time budget — what this adds

Most of a monitoring visit is drive, gear-up, homeowner and the equipment round. This SOP does not touch any of that.

**What it adds, estimated — not measured. Check these on the first reference job (§12.3) and correct the table:**

| Job size | Added per monitoring visit |
|---|---|
| 1–2 rooms, 2–3 maps, ≤ 8 units | **10–15 minutes** |
| 4 rooms, 8 maps, 20 units | **25–40 minutes** |
| **First visit, any size** | **60–90 minutes** on top of the assessment |

That is real time and it is **billable monitoring labor.** It is also the cheapest insurance we buy: one reduction on one job costs more than a winter of it. Log it on your timesheet as monitoring — do not absorb it.

**What we cut to keep it there** — these are deliberately *not* required, and nobody should add them back without the owner:

- **No per-point photo on routine visits.** Day 1 only, plus any point you couldn't type on site.
- **No photo of every unit every visit.** Day 1 placement, and any unit that moved or changed.
- **No writing on the sketch layer.** There is no text tool; the legend and the day-1 photo carry it (§3.5).
- **No second reading round to double-check.** Read once, carefully, off the label.
- **No hand-computed GPP or GD, ever.** The app computes both.

If a step is costing you more than the table says, tell the lead — with the number. We cut steps on evidence, not on grumbling, and we do not cut them silently in the field.

---

## 6. Equipment

**None of this is new work.** The crew already fills asset, type, location, placed, removed and hours on nearly every equipment row. Two things change: **the asset number has to be one you read off a machine**, and **the type has to be one of four exact strings.**

### 6.1 Fleet tags — every machine gets one, permanently

Format: **two-letter type prefix + three digits.**

| Prefix | Machine |
|---|---|
| `AM-` | Air mover |
| `DH-` | Dehumidifier (LGR) |
| `AF-` | Air scrubber / AFD |
| `HT-` | Heater |

`AM-014` · `DH-003` · `AF-002` · `HT-001`

Assigned once from the master list. **Never reused.** The prefix makes a typo self-checking — an `AM-` can never be a dehu. This is the fix for the duplicate `101`s in §1: those tags were generated by a drag-fill, not read off a machine.

**Tagging the machine** (done once, in the shop — see §12):
- 20-mil polyester or anodized aluminum label, permanent adhesive.
- **On the top or the handle-side face**, where a headlamp hits it. **Never on a grille or a filter door** — those get swapped between machines and the identity corrupts silently.
- **Paint-pen the same number in 2-inch characters somewhere else on the housing.** Two independent copies.
- **Mark the power cord near the plug** too. In a stack of eight air movers in a crawlspace, the cord is often the only part you can reach.
- Adhesive must be applied **above 50°F and cure 24–72 hours** before the machine goes out. Tagging in a cold shop is the main reason tags fall off.

### 6.2 One Drying Log, one row per physical unit

**ONE Drying Log per job, created on day 1. Every visit adds ROWS to that log.**

On the Drying Log screen you land on a list. **Tap the existing row titled `Drying log — <date>`. Never tap `+ New`.** The `+ New` button is the most prominent control on that screen and it makes a second log titled with today's date, which looks completely legitimate. Nothing in the app will ever warn you. What it costs: the equipment table and the psychro table split in two, the packet prints two `DRYING LOG` sheets each with half the evidence, and the Recommended-vs-Deployed table prints twice — "8 deployed" and "12 deployed" against the same recommendation, each one reading as a shortfall. The completeness panel stays green through all of it.

Same rule for moisture maps: one per room+material, created day 1, reused for the life of the job.

The table is **Equipment Deployment & Runtime**. Columns: `Asset # | Equipment Type / Make / Model | Room / Location | Placed | Removed | Days | Hrs | Notes`.

**Never put "6 air movers" on one row.** The narrative counts one unit per row, so a grouped row throws away five units of billing.

**Equipment Type is one of exactly four strings. Copy them exactly:**

`Air mover` · `Dehumidifier` · `Air scrubber` · `Heater`

No capital M. No trailing space. No "Axial." Nothing else. This is not tidiness: the packet's two equipment counters normalise the type string differently — the narrative groups on the trimmed string as typed, the sizing table lowercases and pattern-matches — so `Air mover` and `Axial Air Mover` print as two line items in the narrative and one combined total in the sizing table. **Freehand type strings make two documents in the same packet contradict each other.**

**Make, model and rating go in the Notes column.** Include the rating, because Xactimate prices dehus by size class and scrubbers by CFM: `Dri-Eaz LGR 7000XLi - 130 AHAM pt` · `Phoenix Guardian - 700 CFM` · `Dri-Eaz Sahara Pro X3`. Plain hyphens inside the string, like every other string on the job (§8). Without the rating on the row, the unit price on the invoice line has no basis in the file.

**Room / Location is a ROOM**, from the panel card, verbatim. Not a machine name, not "upstairs," not blank. If the machine is in Basement Utility, the location is `Basement Utility`.

### 6.3 Logging a bank of machines fast

Use the drag-down fill handle (the small square in the corner of a cell) on **Type**, **Room** and **Placed** only. That is the practical way to log 20 air movers with gloves on.

**Three columns you must never fill down. There is no undo on a fill.**

- **NEVER fill Asset.** The fill does not copy the number — it *increments* it. Dragging from `101` down seven rows stamps `102, 103, 104, 105, 106, 107, 108`: seven distinct-looking tags nobody ever read off a machine, and the next job's drag starts over at the same numbers. **This is where our duplicate 101s came from.** Type every asset tag by hand.
- **NEVER fill Removed.** It stamps a false pickup time on machines that are still running.
- **NEVER fill Hrs.** A filled Hrs cell is marked manual **permanently** — that row's hours will never recalculate again when you finally enter Removed.

The handle is a small span in the corner of every cell, easy to catch with a gloved thumb. If you catch one by accident, fix the cells by hand immediately, before you leave the screen.

### 6.4 Placement, moves, removal

- **Placed** and **Removed** both carry a date **and a time**, and both are captured the same way, because it is the same picker on the same twenty units in the same cold:
  - **At the machine:** write the tag and the clock time on your hand, your card, or a photo. That is the whole job at the machine.
  - **At the warm station or in the truck, before you leave the property:** type them into the rows. Working a datetime picker on twenty units in a −20°F crawlspace is not going to happen, and a rule nobody follows is worse than an honest one.
  - **Never at closeout. Never the next day.** The clock time on your hand is only good for a few hours.
  - Placed may be drag-filled down a bank of units set down together (§6.3). **Removed may never be filled** — it would stamp a pickup time on machines that are still running.
- **A unit that moves rooms KEEPS ITS ROW.** Do not close the row and open a new one. Write the move in that row's Notes — `moved to Main Living 09/10 14:30` — and take one photo of it in the new room.
  **Why:** both equipment counters in the packet count *rows*, not machines, and neither de-duplicates on the asset tag. Move eight air movers once each and the packet's opening narrative reports **16 air movers**, and the sizing table shows 16 deployed against a worksheet recommending 8. That is the easiest reduction on the page and it would be entirely self-inflicted. One row per physical machine, for the life of the job.
- At the end of every drop or pull, **say the count out loud and photograph the room's machines.** Rows added must equal machines in the house.
- Keep filling the per-day **Dehu / AM / Scrb** count boxes on the psychrometric row too. They are not the billing record and they never replace unit rows — but the office reconciles against them. Do both.

### 6.5 The sizing math, so you can check yourself

**Air movers:** 1 per affected room **+** wet floor SF ÷ 70 (low) to ÷ 50 (high) **+** wet wall/ceiling SF above 2 ft ÷ 150 to ÷ 100 **+** 1 per inset or offset over 18 inches. Round fractions **up**.
*Alternative, never combined with the above:* lower-walls-only losses (migration under 24in, limited flooring) = 1 air mover per **14 affected LF** of wall.

**Dehumidifiers (we run LGR only, 70 / 110 / 130 AHAM pints):** room volume in cubic feet ÷ class factor = required pints ÷ the unit's AHAM rating = number of units.
LGR class factors: **Class 1 = 100 · Class 2 = 50 · Class 3 = 40 · Class 4 = 40.**

**Air scrubbers:** cu ft × ACH ÷ 60 = CFM ÷ the unit's CFM rating. The worksheet uses **Cat 3 → 4 ACH, Cat 2 → 2 ACH, Cat 1 → "not required."**

> **Treat the worksheet's scrubber row as a floor, not as a rule.** Those air-change numbers come from the app's own code, which adapts a desiccant-dehumidifier chart by water category; they are not an IICRC AFD standard, and S500 does not size AFDs by category at all. Containment and particulate control routinely justify a scrubber on a Cat 1 demo. **If a scrubber is warranted, deploy it and write the justification in the Deviation box that day** — `09/06 AFD on containment during drywall demo, Cat 1` — so a unit the worksheet prints as "not required" still arrives at the carrier with a reason attached. The owner is sourcing these numbers (§12.0.5); until then, the Deviation box carries the real argument.

**Heat:** affected air under **70°F** means evaporation has stalled — add heat. Common on Fairbanks freeze jobs, and the affected-air temperature on your psychro row is the justification for billing it.

---

## 7. Psychrometrics

Drying Log → **Daily Psychrometric Readings**. **A row per affected chamber, per visit**, every visit, including the placement day and the final dry day.

### 7.1 What to read

| Column group | Where you stand |
|---|---|
| **Outside / Ambient** | Outside, at the truck, before you go in |
| **Unaffected (Ref.)** | The warm station — an unaffected interior room |
| **Affected** | **One** chamber — not an average |

Enter **T (°F)** and **RH (%)**. **GPP fills itself. GD fills itself.** Never compute either by hand.

Also fill: **Date, Time, Tech**, and the Dehu / AM / Scrb counts.

**The row cannot name a room. There is no room, area or chamber field on it** — the columns are Date, Time, three T/RH/GPP groups, GD, three counts, Tech and Notes, and that is all. So:

> **The FIRST thing in every psychrometric row's Notes is the chamber name, copied from the panel card** — then the rest of the cell in **the Notes order defined in §4.2**, which is the only order this document has. Do not invent a second one.
>
> `Basement Utility - dehu DH-003 outlet 96/14 - aff. 78/31, RH still falling.`

One row per affected chamber per visit, each one named. Tap `+ Add reading` for the second chamber; **do not create a second Drying Log for it** (§6.2). Two rows on the same date with nothing in the Notes are indistinguishable on the printed sheet, and on a four-chamber job the packet's headline grain-depression figures are then drawn from whichever chamber happens to sort first.

**No psychrometric cell is ever left blank.** This is not a tidiness rule and it is not "the app will just leave it empty." A blank T/RH pair reads to the app as **0°F at 0% RH**, so it prints **`0`** in the GPP column — and because GD is Unaffected GPP minus Affected GPP, a blank Unaffected pair drags GD to a large false negative on the document the adjuster reads. Skip the Outside pair and it prints Outside GPP `0`, which reads as a measurement, not a gap. It fires the moment the log is opened, before you type anything. Rows go out this way today.

### 7.2 What "good" looks like

These are sanity checks, not standards. If a number is way off, look for a cause before you leave.

| Reading | What to expect | What it means if it's off |
|---|---|---|
| **GD** = Unaffected GPP − Affected GPP | **Negative or near zero is normal while the chamber is warm and wet**, climbing toward zero and through it as the job dries. Do not treat a negative or a zero GD as an error — it is what a working warm chamber reads. | **Flat or falling day over day is the alarm** — a door open, a dehu down, or fresh water still entering. A negative GD on the last day of a January job is normal, not a failure: an unaffected Fairbanks interior in winter is very dry while the chamber is deliberately warm. |
| **Affected temperature** | **70–90°F** | Under 70°F evaporation stalls. Add heat and write it down. |
| **Affected RH** | falling day over day; under 50% once the units catch up | Flat or rising = something is open, or a unit is down. |
| **Affected GPP** | falling day over day | Flat GPP with falling MC% means moisture is coming in from somewhere else. |
| **Outside** | just record it | In a Fairbanks winter, cold dry outside air is often the argument for the drying system you chose. Say which system on the log: open / closed / hybrid. |

> **Do not expect a big positive grain depression on this column.** Warm air holds more moisture at the same RH, and a drying chamber is deliberately warm, so the affected air usually holds *more* grains than the unaffected reference even when it is drier by RH. Worked example: affected 78°F/31% = 44 GPP, unaffected 70°F/34% = 37 GPP, **GD −7** — arithmetically perfect, and a working chamber. A "+25 to +40" depression between two occupied rooms of the same house is not reachable at any indoor temperature and humidity we will ever read. **The +25-to-40 number belongs to the dehumidifier's own inlet-minus-outlet check — a machine-performance measurement, and this app has no column for it (§7.3).**
>
> **A negative GD does not mean you left a column blank.** If you left a column blank, GPP prints `0` — that is the tell, not the sign.
>
> **But glance at the GD cell anyway: it has to be a number.** On an older row carried in from before, the reference grain value can be missing and the cell fills with `NaN` instead. The completeness panel counts that as filled, so nothing else will catch it. Re-enter that row's Unaffected and Affected T/RH pairs and watch it recompute.

### 7.3 Dehumidifier outlet — **no field exists (open request to the owner)**

A carrier wants proof the dehu is actually working: the air coming out should be much warmer and much drier than the air going in. **There is no column for it, and none in the planned schema either.**

**Interim:** take the reading anyway and put it in the psychro row's **Notes**, in the dehu-outlet slot of the Notes order (§4.2) — after the chamber name and any reason line — in exactly this format:

`dehu DH-003 outlet 96/14`   *(T °F / RH %)*

One entry per dehu. Nothing computes it; the string is what a human reads later. **This is where a large positive depression legitimately shows up** — inlet minus outlet, on one machine.

---

## 8. Photos

Every photo needs a **Room**, a **caption**, and — on the shots that have to be Before or After — a **Stage**.

**Room = the room card name.** Most photos on our jobs today carry no room at all, which is why the Photo Report groups them into one undifferentiated pile. (The photo gallery does group case- and space-insensitively, so `Kitchen` and `kitchen ` will still file together — but type it off the card anyway, because equipment rows and map titles are not so forgiving.)

**Stage defaults to `During`.** It is a dropdown on each photo card, and **"at least one Before photo" and "at least one After photo" are hard billing gates keyed on it.** A whole first visit of untouched before-photos counts as **zero** before-photos to the app and prints in the wrong section of the packet. Set Stage = **Before** on the first-visit shots and **After** on the final-visit shots, as you take them.

**Caption format:** `<what> - <Room> - <Loc n | asset tag>`
Examples: `Wet drywall at base - Main Kitchen - Loc 3` and `Air mover placed - Basement Utility - AM-014`

**Plain hyphens, everywhere on this job.** The middot `·` and the em dash `—` are not on the phone keyboard and half the crew will type something else. Captions, map titles, point names, equipment notes — one separator, the hyphen.

**The shot list:**

| When | Shoot |
|---|---|
| First visit, before touching anything | Source of loss. Every affected room, wide. **Stage = Before.** |
| First visit | Each labeled reading point, with the meter in frame. The control point especially. |
| First visit | Each unit in place, tag legible where possible. |
| Every visit | The meter display at each point you couldn't type on site. |
| Any move | The moved unit in its new room, with the tag if you can get it. |
| Any demo | The cut line **with a tape measure in frame** showing height and extent. |
| Contents work | Pack-out, boxes, damaged items. |
| Final visit | After photos **matching the before angles. Stage = After.** |

**At least one photo of every room that will appear on the invoice.** Nothing in the app tells you which rooms those are, so this is checked by the office (§12.4), not guessed in the field.

Photos are not linked to reading points, equipment rows or invoice lines anywhere in the app. **The caption text is the only link there is.** Write it right.

---

## 9. Final visit and release

1. **Read every established point, including Loc 1, the control.** Every affected point at or below its goal.
2. **Set Removed date and time on every equipment row.** A row with no removal keeps accruing days and reads as a machine we never picked up.
3. **Set Dry-out Finish Date** on the Drying Log — **and fill the Certificate of Drying's own three boxes**, labelled on screen **Drying Start Date**, **Drying Completion Date** and **Drying Duration (days)**. They are separate hand-typed fields; nothing copies the Drying Log's dates into them. If **Drying Duration (days)** is filled, **it is the number the packet's opening narrative prints**, so a blank one and a wrong one are both worse than a right one. **Count the duration the same way you count equipment days in step 6: 24-hour periods from Drying Start Date to Drying Completion Date, a partial period rounded up.** It is a count of days, not the unit-days of step 6 — but it has to come from the same clock, or the Certificate and the equipment lines describe two different jobs.
4. **After photos** matching the before angles, **Stage = After**.
5. **Fill the Certificate of Drying verification rows** — Material / Location · Meter / Setting · Goal % · Final % · **Ref %** · ✓ Dry.
   - **Goal** is the number you set on day 1 from the control, not something you decide now.
   - **Ref %** is Loc 1's final reading, copied off the map — not remembered.
   - **Meter** is the same instrument and scale you used all job.
6. **The Certificate's four equipment-day boxes** — Dehumidifiers, Air Movers, Air Scrubbers, Heaters — are free text and **nothing computes them.** They currently hold hand-typed shorthand nobody else can rebuild.
   **Do not copy the app's Days column into them, and do not invent shorthand.** Write the arithmetic out: `24 units × 8 days = 192 unit-days`. **Count 24-hour periods from the placed and removed timestamps, rounding a partial period up** — because "per 24 hr period" is the unit printed on our own invoice lines, so that is the number the invoice is actually claiming. The office recomputes it before submission (§12.4.3) and the owner is ruling on the convention (§12.0.6).
7. **Before you print: set the photo Sort to `Room, then Before → After` or `Before → During → After`** — those are the two option labels in the picker, word for word. The default is `Manual (◀ ▶ to arrange)`, and the printed Photo Report follows whatever the sort is set to — so all the room discipline in §8 does not appear in the packet unless somebody changes that control.
8. **Tech signature.** Or attach a wet-signed scan — an attached signed page replaces the generated form in the packet.
9. **If the Construction Narrative has already been generated, regenerate it after any correction.** It is a stored snapshot of text, not a live view — fix an equipment row and the narrative keeps printing the old unit count on the packet's first page, next to a corrected table. Generating it needs signal and a signed-in session, so it is an office step, not a driveway one.
10. **The completeness panel is a floor, not the check.** "Complete — ready to bill" is satisfied by *one* reading on *one* day on *one* map, one psychro row, one equipment row. Clear it, but do not treat it as a release control. **The office checklist in §12.4 is the release control.**

The packet is produced by **📄 Full job packet (PDF) → ⬇ Save packet as PDF**, which is your device's print-to-PDF. There is no generated PDF file — check the printed preview before you save it.

---

## 10. The paper lane

**This is the fallback for everyone, not one person's exception.** Use it when your tablet dies, the screen freezes at −35°F, or you don't use the app at all. Leonard Sheldon works this lane by default: paper, phone, no app, no automated messages of any kind.

### 10.1 The card — an office artifact, built by hand

> **The app cannot print this.** There is no visit-card template in the app and there will not be one before P3. The app's own Moisture Map and Drying Log sheets print the rows that already exist, with their dates — several pages — and to get one blank line the office would have to add a dated reading row to the live job first. **The Drying Visit Card is a Word or Excel one-pager the office keeps and fills in by hand.**

**Owner of the artifact: the office admin.** Built once per job, at setup, from the job's legend string and the equipment table. Photocopied for every visit. Rebuilt only when points or units change.

Lay the boxes out in the same order as the app's tables, so transcription is column-for-column with no interpretation:

- **Moisture (one block per map):** map name across the top, then `Date | 1 | 2 | … | 13 | Notes` — with the legend printed down the side so the tech reads `2 = N wall 12in AFF` and not a bare number. `1` is always labelled `CONTROL`.
- **Equipment:** `Asset # | Type | Room / Location | Placed (date+time) | Removed (date+time) | Notes` — asset tags currently on site pre-printed.
- **Psychrometrics:** `Chamber | Date | Time | Out T/RH | Unaffected T/RH | Affected T/RH | Dehu # | AM # | Scrb # | Tech | Notes`
  The three count boxes and the Notes line are not optional. Every string §4.2, §5, §7.1 and §7.3 requires — chamber name, reason line, dehu outlet, the day's notes — lands in that one Notes cell in the app, in §4.2's order, and the counts are what the office reconciles the equipment table against (§6.4). A card without them cannot be transcribed without the transcriber inventing something. **The transcriber adds one string the card does not carry: the `[paper - <tech>]` source stamp, last in the cell** (§4.2 slot 5, §10.2).
- Exceptions box, no-visit reason box, tech initials, arrival and departure times, **and hours worked**.

**The tech never invents a room name or a point number — they are already printed.**

**Photos on a paper job have an owner, and it is the tech.** Before / After photos and a caption on every photo are hard billing gates — a job run entirely on paper cannot clear billing without them, and the paper card has nowhere to put a picture. So: **the tech shoots on their phone** (§8's shot list applies unchanged, paper or not) **and texts the shots to the office with the card.** The **transcriber uploads them, sets Room and Stage, and writes the captions** in the same sitting as the readings, off what the tech said on the phone. On Leonard's jobs this is the office device, the same one that holds every other entry.

**Fill it in PENCIL.** Ballpoint gels below 0°F and will not write on wet paper.

**Leave GPP and GD blank.** The app computes both. Never make a person compute a derived number.

### 10.2 Who transcribes, and by when

- **A named person, not "the office."** The office admin, with the lead restoration tech as backup. **The owner is the fallback, never the default** — if the owner is the transcriber it slips, every time.
- **Same day, before 6:00 pm.** A reading entered two days late has already missed the drying decision it was supposed to inform.
- **The trigger:** the tech photographs the finished card and texts it to the office phone at the end of the visit. That is a phone, not an app. The paper original comes in weekly as the legal record.
- **One device per job, per day — and the rule for a mid-visit failure.** This is the §5 rule, and it is not a paper-lane rule: two tablets on one job is enough to lose a whole drying log. For the drying log and the moisture maps the **newer save wins the whole record**, so the loser silently gives up its equipment rows and its psychrometric rows — the entire billing record for that visit, not just moisture numbers.
  - If a tablet dies **mid-visit**: the tech's tablet is still the job's device. The tech finishes on paper, and either the office transcribes the card into **that tablet** the next morning, or the tech reads the card to the office by phone and does not touch the tablet again that day. **Never both.**
  - On Leonard's jobs the **office device is the job's device** and no tech tablet ever opens the job. That sentence is what makes his lane safe.
- **Scan the paper card into Supporting Docs** so the packet carries the original.
- **Stamp the source.** Put `[paper - L.Sheldon]` **last in the psychro row's Notes** — after the day's notes, slot 5 of §4.2's order — and at the end of the equipment row's Notes, and put the *tech's* name in the Tech field, not the transcriber's.
- **Somebody enters the paper tech's hours.** The Labor Log is a hard billing gate and accepts manual entries. The control is hidden: on the Labor Log, tap **✎ Edit** — that reveals **+ Add labor row**, which is invisible in read mode. The transcriber enters the hours from the card's arrival/departure times in the same sitting, or a paper job sits at "not yet billable" with nobody owning the reason.
  > ⚠ **Never tap `⤓ Sync labor from QuickBooks` on a job that has hand-entered hours.** It does not merge — it **replaces the entire entries list** with whatever QuickBooks returns, and then reports success. Leonard is not in QuickBooks Time by design, so on his jobs one tap of the most prominent button on that screen silently deletes every hour anyone transcribed, with no warning and no undo. If a job has any manual labor row, that button is off limits until the code is fixed (§12.6). If it has already been tapped, the hours have to be re-entered from the paper cards.
- **No automated message, digest, schedule text, or AI-generated anything goes to Leonard.** Ever. Phone call or a text typed by a human.

### 10.3 Three checks that catch transcription errors

1. **Range check, before committing.** The app flags cells green at/below goal, red above. A cell that flipped green overnight, or a jump of more than about 10 points, gets a **phone call to the tech first**. Thirty seconds, and it catches the transposition (47 typed as 74) that is the dominant paper error.
2. **Point count.** The card has N printed points on that map. The app row must end with N values. A missing value means "go back tomorrow," not "leave it blank."
3. **Friday reconcile.** When the paper originals come in, a **second** person spot-checks three random cards against the app. This is what catches systematic drift — like affected temperature landing in the reference column every time.

---

## 11. Field card — print this page alone

*Half-letter, 5.5 × 8.5 in, printed both sides on waterproof synthetic paper or 5-mil laminate. 11pt Roboto Condensed (or any condensed sans) at 0.35 in margins — that is what the text below actually fits in: **front 30 lines, back 41, longest line 62 characters.** Grommet in the top corner, on a retractable reel clipped to the tool bag.*

**Both sides are full. Nothing goes on this card without something coming off it.** Everything that didn't fit is in §3–§10, which is why the card carries no room grammar, no sizing math and no shot list — a tech looks those up once, in the truck, not at −20°F.

**Every rule printed here is explained in §3–§10.** Nothing on this card is sourced only from §12 or §13; if a card line ever has no body section behind it, the card is wrong, not the body.

> **One thing on this card is not settled yet.** The tag format on the EQUIP line — `AM-014 DH-003 AF-002 HT-001` — is the format §12.0.1 *recommends*, not one the owner has ruled on. That is exactly why §12.0 holds the card back from the laminator until the first four rulings land. **If the format changes, this line changes before anything is printed**, and the fleet is tagged to the ruled format on shop day, not to this draft.

---

### FRONT — MONITORING VISIT, IN THIS ORDER

```
0 SHOP: SYNC while you have signal, open today's jobs,
  check battery. ONE tablet per job - confirm you're it.
1 OUTSIDE at the truck   T ___ RH ___
  hang it 3-5 min first. Out of range -> say so in Notes.
2 UNAFFECTED room = WARM STATION   T ___ RH ___
3 EQUIPMENT ROUND, before readings. Running? Tag matches
  the row? Note only what CHANGED. Placing or pulling ->
  tag + clock time on the card NOW, type Placed/Removed
  at the warm station or truck BEFORE you leave.
4 AFFECTED - one reading PER CHAMBER   T ___ RH ___
  TAKE THE DEHU OUTLET T/RH too: "dehu DH-003 outlet 96/14"
  NOTES ORDER on every row, no exceptions:
  CHAMBER - reason line - dehu outlet - today's notes
5 ADD TODAY'S DATE TO EVERY MAP, IN DATE ORDER. Count them.
  Back-filled? check the chart still falls left to right.
6 MOISTURE ROUTE - Loc 1,2,3... in order, EVERY map.
  Loc 1 = the CONTROL. Read it too.
  Read the LABEL, not your memory. Same pin holes.
  TYPE the numbers - NEVER dictate. Notes: YOUR INITIALS.
  Can't reach / can't type -> PHOTO meter by the label.
7 PHOTOS of anything different. Room + caption.
  Before/After shots: SET THE STAGE (defaults to During).
8 WARM STATION - type in what you photographed.
  at goal?   say so + pull the unit, or say why it stays
  not drying? write what you DID about it
  7+ days?   write the reason, name the reading
  missed a day? REASON LINE: NO ACCESS / ROAD CLOSED /
                HOLIDAY / SAFETY + the date
9 DRIVEWAY - saved? battery? Dot green = synced.
  RED IS NORMAL OFF-GRID. Still red next job -> call office.
```

### BACK — THE RULES

```
POINTS: 1-13 PER MAP, every map starts at 1. Loc 1 = CONTROL,
 stamp it FIRST; import the plan BEFORE any marker. Say
 "<map> Loc 3". Never renumber, reuse or insert - RETIRE a
 dead point in that day's Notes. 13 max: NEVER "+ Add
 locations 14-26", they print EMPTY to the carrier. Need
 more -> SECOND MAP: same room+material, "(2)", Loc 1 =
 CONTROL again, first-row Notes "overflow map - continues
 <map 1>". LEGEND = FIRST row's Notes only: initials,
 1=CONTROL <where>; 2=<where>; ...; cols 5-13 unused.
ROOMS: copy the PANEL CARD exactly - it IS the list, the app
 has none. Same spelling in PHOTO Room, EQUIP Location and
 invoice line. MAP TITLE = room name + " - " + material, e.g.
 Basement Utility - Drywall. No trailing space. PLAIN HYPHENS.
EQUIP TYPE, these four only: Air mover / Dehumidifier / Air
 scrubber / Heater. make+model+RATING -> Notes. Location is a
 ROOM. Tags: AM-014 DH-003 AF-002 HT-001
FILL DOWN Type, Room, Placed ONLY - no undo on a fill. NEVER
 Asset (it INVENTS numbers), NEVER Removed, NEVER Hrs.
COLD: paint pen won't flow below freezing - keep it inside
 your jacket, mark while warm. Won't write? tag it + PHOTO.
GD = Unaffected GPP - Affected GPP. NEGATIVE OR ZERO IS
 NORMAL on a warm chamber - not an error. It climbs toward
 zero AND THROUGH IT as the job dries, so a POSITIVE GD late
 is fine too. Flat/falling = door open, unit down, water.
NEVER
 "+ New" on the Drying Log - ONE log per job, add ROWS. A
   second log splits your billing record, and nothing warns.
 "Clear drawing" on a map with markers - no confirm, no undo:
   wipes every marker and resets numbering to 1.
 leave ANY psychro cell blank - blanks print 0 GPP, and a
   blank UNAFFECTED pair prints a FALSE NEGATIVE GD.
 touch Material after day 1 - it silently overwrites the Dry
   Goal. Material FIRST, goal = CONTROL + 2, BARE NUMBER ONLY.
 close+reopen a row when a unit moves - SAME ROW + a Notes
   line "moved to <room> <date> <time>". 2 rows = 2 machines.
 let two devices edit one job - the newer save wins the
   WHOLE log, equipment and psychro rows included.
 write a reading, date or hour for a visit that didn't
   happen. One invented row voids the file.
No Save button; it saves every keystroke. TABLET DEAD? Paper
card -> photo texted to the office same day. (907) ___-____
```

---

## 12. Rollout — for the owner

### 12.0 Before anything is printed or trained — six rulings, one evening

The field card cannot go to a laminator until the first four are settled, because all four are printed on it: the tag format on the EQUIP line, the dry-goal rule as `goal = CONTROL + 2` on the Material line, the reason codes on front step 8, and the grain-depression line on the back. Rule differently on any of them and that line is wrong on seven laminated cards. The last two move money and belong to you alone.

1. **Asset-tag format.** Recommended `AM-014` — three digits, self-checking prefix, with a QR printed on the same label now even though nothing scans it yet, so adding a scanner later never means re-tagging. If this changes after the shop day the fleet gets re-tagged for nothing.
2. **The dry-goal rule — changed in this version, confirm it.** v1.1 said "control + 2 points, or the IICRC table value, **whichever is higher**." That rule always selects the table on wood: the app's Framing / Wood / Subfloor value is 19, and a control on unaffected framing in a Fairbanks interior reads well under that. Applying it would raise the crews' control-derived wood goals to 19, flip currently-wet cells green, and end those jobs with framing above its own building's dry standard — which is a re-open, and it contradicts §12.0's own praise for those overrides. **v1.2 changes the rule to: goal = control + 2 points, full stop; the table value is used only when no control of that material could be taken.** Our crews read a Tramex MEX5 non-invasive scale; the app's defaults are pin-meter values. **You hold the WRT cert. Confirm this before it goes on a printed card.**
3. **The daily-visit commitment.** §5 now says "a reading round every equipment day, or a written reason." Price it: seven techs, weekends and holidays, 45-minute winter drives, against the equipment-days it protects. If we are not staffing it, the reason-code path is the rule and we should say so plainly rather than watch the crew learn the rule is optional.
4. **Grain depression is settled — confirm it once.** The app computes Unaffected GPP − Affected GPP; negative or zero is normal on a healthy warm chamber, and the "+25 to +40" figure people quote is the dehu inlet-minus-outlet check, for which we have no column. §7.2 now says exactly that. Read it and confirm, because an earlier draft told the crew the opposite and a tech who believes a normal reading means they did it wrong will start inventing reference readings.
5. **Air-scrubber sizing has no cited source.** The worksheet's Cat 3 → 4 ACH / Cat 2 → 2 ACH / **Cat 1 → not required** comes from the app's own code, which adapts a desiccant-dehumidifier chart by water category. S500 does not size AFDs by water category; containment and particulate control are the usual justification and are routine on Cat 1 demo. As written, the packet prints "not required" on every Cat 1 job while we deploy and bill scrubbers on some of them. §6.5 now treats the worksheet's scrubber row as a floor with the Deviation box carrying the argument. **Either give us the authority to cite, or confirm the floor-plus-deviation approach.**
6. **The equipment billing unit — this is the one that moves the most money.** Our Xactimate lines read "Air mover axial fan … **(per 24 hr period)**" and "Dehumidifier **(per 24 hr period)**". v1.1 told the office to bill **calendar days inclusive**, which counts a partial day at each end as a whole 24-hour period and adds roughly one unit-day to **every equipment row we have**. The app's own Days column, meanwhile, is elapsed hours rounded to nearest, which lands a day *below* the calendar count on our normal afternoon-set / morning-pull pattern. Three different numbers, one invoice. **v1.2's interim rule is to bill 24-hour periods from the placed/removed timestamps, rounding a partial period up, and to state that convention in the packet** — because that is the unit our own line items name, and because an adjuster who recomputes from the timestamps we so carefully insist on must not find the invoice exceeding our own arithmetic. **Rule on this, or give us the carrier authority for calendar-inclusive billing.**

**Then, in order:** (1) office builds the master asset list and the Drying Visit Card template (§10.1); (2) print the field cards; (3) shop day.

### 12.1 Week 0 — shop day, 3 hours, all hands, paid, indoors

**Tag the whole fleet as the training exercise.** Everyone handles every machine, reads out the number, applies the label, paint-pens the backup. This teaches "the machine has a name" better than any lecture, it is the one job that genuinely needs everyone at once, and it produces the master asset list as a by-product. Labels cure over the weekend.

Then walk one mock room: name it, place 4 markers with Loc 1 as the control, label them, take a control reading, enter it. Thirty minutes.

**Two five-minute tests worth doing while everyone is there:**
- **Photograph a backlit meter display** in a dark corner with a headlamp, five frames, then look at them on the office desktop. Photos are downscaled and compressed on capture; if that photo is not readable, the offline fallback in §5.6 is not a fallback and we need a different one.
- **Try the paint pen outside**, at whatever the temperature is. Confirm the jacket-pocket trick and the flashing-strip fallback actually work before seven people are told to rely on them.

Hand out: field cards on reels, **tethered capacitive styluses**, thin liner gloves, oil-based paint pens. The stylus is the highest-value purchase in the whole rollout — numbers get entered with gloves on.

### 12.2 Week 1 — ride along

Seven ride-alongs in five days is heavy. Cut it to **two**: ride the worst job first — the crawlspace, on the coldest day — and one ordinary one. If the SOP survives the crawlspace it survives everything, and the buddy check in §12.3 does the rest at zero owner cost.

**Say nothing during the visit. Watch. Correct once at the end.** Watching is how you find out that a step is impossible in a real crawlspace.

### 12.3 Weeks 2–4 — one reference job

The next real water loss gets done fully to this SOP. **Its finished packet is what you show everyone else.** One example done right teaches more than the document.

**The buddy check, for the first two weeks:** whoever sets a job up does **not** do visit 2. Visit 2's tech has to find every point from the labels alone. If they can't, the labeling failed — they fix it on the spot and tell the setup tech. Zero owner time, and it catches the exact failure this SOP exists to prevent.

### 12.4 How compliance gets checked

**Do not build a nag.** No push notifications. No daily texts. A tech who sees their own job tile amber and can clear it in 20 seconds will clear it; a tech who gets a text at 7pm games the metric.

- **Tech sees:** the flag pills on their own job tile, plus the completeness panel.
- **Owner sees:** the drying flags live in the **Field app's Jobs list, on the 💧 Restoration tab** — red and amber 💧 pills on the job cards. **They are not on the Job Board and not in Admin.** Nothing in `apps/board` computes them. Open the field app to check compliance.
  Three things they will not tell you, so do not read a clean list as a clean shop:
  - They never fire on an **archived** job or a job already marked **certified**.
  - They never fire on a job with **no readings and no equipment logged at all** — so a job nobody documented shows **clean**, not red. A blank job is invisible.
  - "No reading in N+ days" counts from **moisture-map reading dates only** (not psychro rows, not equipment days), and it fires at 36 hours while printing "1+ days."
- **Shop wall, weekly, team number only:** "jobs that closed carrier-clean this week: 4 of 5." Never an individual scoreboard. Individual correction happens in person, privately, and only for repeats.
- **The real enforcement is the invoice.** The packet doesn't go to the carrier until the office check below is clean, and the job isn't done until the packet ships.

**Office check before anything is submitted — Branden, Friday.** (Named on purpose. An unowned task in a 14-section SOP is a task that does not happen.)

1. Completeness panel shows no hard gaps — **as a floor, not as the check.** It passes on a single reading on a single day.
2. **Count DISTINCT ASSET TAGS, not rows.** Both the narrative's unit count and the sizing table's "deployed" count rows and neither de-duplicates. If a machine moved and somebody opened a second row anyway, fix the rows before printing.
3. **Equipment unit-days, computed from the timestamps and reconciled four ways.** The interim convention is **24-hour periods from the placed timestamp to the removed timestamp, partial periods rounded up** (§12.0.6 — pending your ruling). Compute it yourself, per machine. Then compare against the three other unit-day figures the same packet prints:
   - the app's **Days** column — elapsed hours rounded to nearest, floored at 1;
   - the **Construction Narrative's** per-type unit-days — the same elapsed hours rounded to nearest but with **no floor**, so a same-day place-and-pull is 0 there and 1 in the table;
   - the **Certificate of Drying's** four free-text boxes, which compute nothing at all.

   All four can disagree on the same job. Reconcile them to one number, write that number in the Certificate boxes as full arithmetic (`24 units × 8 days = 192 unit-days`), and **regenerate the narrative afterwards** (item 9) so the packet's opening page carries the corrected count too.
4. Reading dates checked for continuity against equipment days. **Every equipment day has a reading row or a written reason code.**
5. Map's Material vs. its Dry Goal checked for contradiction (no drywall at a 19% wood standard). Also check the Drying Log's Dry Goal box does not print a different number than the maps.
6. **At least one photo of every room that appears on an invoice line.** The field cannot check this; you can.
7. **Photo sort set to `Room, then Before → After` or `Before → During → After`** before the packet prints.
8. **The two internal-only forms have been lifted into the packet.** The **Field Report** and the **floor plan's dimensions table** are both excluded from the packet by design, so the day-1 facts the crew put there — time of loss reported, time of first arrival, pre-extraction standing-water volume, per-room measurements — reach nobody outside the company. Type them onto a one-page **loss-intake summary and upload it to Supporting Docs**, which does print full page. Without it, the emergency-service and after-hours line items are undefended no matter how carefully the tech captured them.
9. **The Construction Narrative is a stored snapshot — regenerate it last.** It does not update when you fix a row. If you corrected anything above, regenerate the narrative before the packet prints, or the opening page contradicts the corrected table behind it.
10. **The Certificate of Drying's own dates are filled** — **Drying Start Date**, **Drying Completion Date**, **Drying Duration (days)**, as they are labelled on the form. They are independent of the Drying Log's Dry-out dates, and the Certificate's duration is the number the narrative prints when it is filled.
11. **On any job with hand-entered labor: `⤓ Sync labor from QuickBooks` is off limits.** It replaces the whole entries list and deletes the transcribed paper hours (§10.2). Check the Labor Log still holds them before printing.
12. **The submission logged by hand** — what packet, which version, to which carrier and adjuster, on what date, by what channel, and what came back. Nothing in the system records that a packet was ever sent. A spreadsheet is fine; six months of it turns "what carriers cut" from a guess into evidence.

### 12.5 New app rules — what can actually be enforced

**None of the rules below exist in code today.** They are a build request, not a setting. When they ship they go **soft first**, carry a dated "hard on `<date>`" label, become hard after **30 days**, and bind only jobs created after that date. Never retroactive.

**Wave 0 — the only rules that can pass on a normal water job**, because every field they check already exists and is already reachable:

| Rule | Checks | Why it can be hard |
|---|---|---|
| `eq_asset` | Asset # filled on every equipment row | The field exists, the crew already fills it on nearly every row, and the SOP only changes *what* goes in it (§2) |
| `eq_type_vocab` | Equipment type is one of the four exact strings | Fixes the defect where two packet documents disagree |
| `dl_ref` | Unaffected T **and** RH on **every** psychro row, not just one | Prevents the `0` GPP / false-negative-GD document |

**Deliberately NOT proposed, and why** — these were in the previous draft and would block billing on nearly every job:

- `mm_label_room` and `ph_room` (validate map titles and photo rooms against the job's room list) — **there is no room list a water job can populate.** `project.rooms` is writable only from inside a contents item. A rule validating against an empty list fires on every job. These become possible only after a real room manager ships (§13).
- `dl_visit_coverage` as a **hard** gate — a missed day cannot be repaired retroactively, so one denied-access day would permanently fail the job. Ship it **soft, permanently**, and change it to "a row **or a documented reason code**" for every equipment day.

**Wave 1 (at P3):** `eq_removed` goes hard; a legend entry required per map; a control reading required per map; a room manager and a real room picker; and the two copies of the rule set — the browser's and the server's, which have drifted — get reconciled instead of a third being added.

### 12.6 Code fixes queued — each one retires a rule from the laminated card

Software that cannot produce the wrong number is a stronger control than seven people remembering. In rough order of value per line changed:

| Fix | Retires | Size |
|---|---|---|
| Remove the fill handle from the **Asset**, **Removed** and **Hrs** columns | Three NEVER lines on the field card, and the mechanism that created every duplicate asset number | Small |
| `gpp()` returns null when T or RH is blank instead of computing 0°F/0%RH | The `0` GPP and false-negative GD on carrier documents | One line |
| Confirm dialog on **↺ Clear drawing** (the column-delete button already has one) | The most destructive single tap in the app | Small |
| De-duplicate the narrative and sizing-table equipment counts on asset tag | The move double-count, and the two-documents-disagree defect | Small |
| Warn before **Material** overwrites a non-empty Dry Goal | The silent dry-standard rewrite | Small |
| Make `⤓ Sync labor from QuickBooks` **merge** instead of replacing — keep every row flagged `manual: true` | The one tap that deletes a paper job's transcribed hours; a line on the office checklist | Small |
| Re-read the strokes layer on resize so importing / cropping / removing a floor plan does not revert markers stamped before it | An undocumented, silent marker wipe next to the documented one | Small |
| Give the air-scrubber worksheet its own **Unit CFM rating** input (today it is hardcoded to 500) | The scrubber row of the Recommended-vs-Deployed table printing a false shortfall | Small |
| Put the same 1-day floor on the narrative's unit-days that the Days column has | One of the four contradicting unit-day figures in §12.4.3 | One line |
| Port `dryingwatch` flags into the Job Board | The owner having to open the field app to see compliance | Medium |
| A room list on the job, with a picker on map Room/Area, photo Room and equipment Location | Roughly half of what this SOP asks a human to enforce by spelling | Medium — unblocks `mm_label_room` / `ph_room` |

---

## 13. What the app cannot do yet

Honest list, for the owner and the office. **Every gap here already has its interim instruction written into §3–§11** — this table is the reasoning behind those instructions, not a second set of them. A tech should never have to read this section to do their job. If a rule appears here and nowhere in §3–§11, that is a bug in this document.

| Gap | What the crew does in the meantime | Fixed in |
|---|---|---|
| **A reading point has no identity.** It is a column number plus a marker drawn as pixels. Marker numbering restarts at 1 on every map and cannot be seeded. | Per-map numbering 1–13, Loc 1 = control, cite points as `<map name> Loc n` (§3.3 — plain hyphens, no middots). Legend in the first-row Notes + a day-1 photo (§3.5). **A mid-job renumber cannot be repaired later.** | P3 (`moisture_locations`) |
| **The moisture grid always has 13 columns, added only 13 at a time.** Unused columns print as empty bordered boxes under filled navy numbered headers on every visit row of the carrier's copy. | 13 points max per map; split by material instead of adding a block; note `cols 5-13 unused` in the legend, in that spelling (§3.3, §3.5). | P3 |
| **A room name can never be deleted.** `project.rooms` has two writers — the ➕ New room… prompt inside a contents item (`app.js:1997`) and the AI photo scan (`app.js:2090`) — and no delete path. `deleteItem` (`app.js:2293-2300`) tombstones the contents item and never touches `rooms`, so a typo outlives the item that created it and shows in every room dropdown on that job. Nothing printed reads `project.rooms`; it only feeds a filter. | Do not create rooms through Contents at all (§3.1). The panel-door card is the room list. Spell it once, correctly. | P3 (room manager, and whoever builds it needs to know this field has two writers, no reader that prints, and no delete) |
| **No text tool on the sketch layer** — a pen in four colors, a number stamp, Undo, Clear. That is all. | Legend in Notes + the day-1 photo. Never try to write on the canvas. | P3 |
| **`↺ Clear drawing` has no confirm.** It wipes every stroke and marker, resets numbering to 1, kills the undo stack and saves immediately. Undo is also gone the moment you leave the screen. | Treat that button as live ordnance. Mis-placed marker → paint-pen X and a retire note. | Queued code fix (§12.6) |
| **Row-delete ✕ on the moisture and equipment tables has no confirm either** (the column-delete button does — inconsistent). | Slow hands near the right edge of a row, on the moisture table and the equipment table both (§5.5). | Queued |
| **Material and dry goal are per map, not per point.** | One map per room **and** per material. | P3 |
| **Setting Material silently overwrites a control-derived Dry Goal**, with no warning and no history. | Material FIRST, then goal. Never touch Material again; if you must, re-enter the goal at once. | Queued code fix (§12.6) |
| **The Dry Goal box parses out non-digits**, so `≤ 19% (ctrl 12.4)` becomes a goal of 1912.4%. | Bare number only. Provenance in Notes. | P3 |
| **Two Dry Goal boxes.** The Drying Log's box is read by no code at all — but it prints. | Leave it empty or copy the map's number verbatim. | P3 |
| **No place for a start-of-job control reading.** The only Ref % box is on the Certificate, at the end. | Loc 1 on every map is the control; read it every visit; goal source in the first-row Notes. | P3 (`dry_standards`) |
| **Meter / Setting is a dropdown, not a text box**, and the only way to add a value is the `➕ New meter / setting…` option, which opens a browser prompt. The presets it saves live in **that one device's local storage** and never sync. | Pick the existing preset if it is there; otherwise add it through `➕ New meter / setting…`, typing the make, model and mode identically to every other device (§4.8). One meter per material for the whole job. | P3 |
| **A blank psychrometric T/RH pair computes as 0°F / 0% RH**, so it prints `0` GPP and a large false negative GD — and it fires on load, before anyone types. | No blank cells, ever. | Queued code fix (§12.6) |
| **The Field Report is excluded from the packet by design.** The packet builder skips it; the app labels it "internal — not in packet." Anything a tech writes there — time of loss, first arrival, standing-water volume — reaches the office and stops. | Capture it there anyway (§4.1, §4.3), and the office lifts it onto a **loss-intake summary uploaded to Supporting Docs**, which does print (§12.4.8). | P3 |
| **The floor plan's room-dimensions takeoff table is internal too.** The plan pages print full size; the table does not. | Per-room measurements go in the Field Report and onto the loss-intake summary; the Deviation box carries the room count the worksheet missed (§4.6). | P3 |
| **Importing, cropping or removing a floor plan reverts markers stamped since the screen opened.** The canvas redraws from the strokes captured when the map was opened — while the marker counter keeps climbing, so the next stamp issues a number with no visible predecessor. | **Import the plan before stamping anything** (§3.3). After any plan change on a marked map, re-open it and count the markers. | Queued code fix (§12.6) |
| **The moisture grid has no row reorder.** A back-filled date lands at the bottom permanently. | Enter dates in order. If rows end up out of order, copy the values off, delete those rows and re-enter oldest first (§5.5). | P3 |
| **`⤓ Sync labor from QuickBooks` replaces the whole entries list**, ignoring the `manual` flag, and reports success. On a paper job it silently deletes every transcribed hour. | Never tap it on a job with hand-entered hours (§10.2, §12.4.11). `+ Add labor row` is hidden until you tap **✎ Edit**. | Queued code fix (§12.6) |
| **The equipment sizing worksheet defaults silently.** Ceiling height defaults to 8 ft and dehumidifier size to 70 AHAM pints; the air-scrubber CFM rating is **hardcoded to 500** with no input at all (the CFM box that exists only appears for desiccant dehumidifiers). | Set ceiling and AHAM pints before tapping 🧮; put the real scrubber arithmetic in the Deviation box (§4.13). | Queued code fix (§12.6) |
| **Without the AI floor-plan takeoff the worksheet sizes the whole job as one room** — two hand-entry boxes, one room object. Step 1 of the air-mover worksheet is one unit per affected room, so a multi-room job under-recommends by one per extra room. | Enter the real room count in the Deviation box with the corrected arithmetic (§4.6). | P3 |
| **The air-scrubber ACH figures are the app's own convention, not a cited standard**, and Cat 1 prints "not required." | Treat the scrubber row as a floor; the Deviation box carries the containment justification (§6.5). Owner ruling pending (§12.0.5). | Needs a ruling |
| **The Certificate of Drying's Drying Start Date, Drying Completion Date and Drying Duration (days) are independent hand-typed fields.** Nothing copies the Drying Log's Dry-out dates into them, and when Drying Duration is filled it **wins over** the narrative's own computation. | Fill all three at closeout and make them agree with the equipment-day arithmetic (§9.3, §12.4.10). | P3 |
| **The narrative's unit-days have no 1-day floor** while the Days column does, so a same-day place-and-pull is 0 in one document and 1 in the other. | Office reconciles all four unit-day figures to one number (§12.4.3). | Queued code fix (§12.6) |
| **The Construction Narrative is a stored, hand-editable snapshot**, generated on demand and requiring signal and a signed-in session. It does not update when the rows behind it change. | Regenerate it last, after every correction (§9.9, §12.4.9). | P3 |
| **A psychrometric row cannot name a room.** No area, chamber or location field exists on it. On a multi-chamber job the narrative's first/last grain depression comes from an unidentified chamber. | One row per chamber per visit, chamber name first in that row's Notes. **This one the crew cannot fully close.** | P3 |
| **No dehumidifier-outlet column** — not in the app, not in the planned schema. | `dehu DH-003 outlet 96/14` in the psychro Notes. | Undecided — needs a ruling |
| **Drying Logs and moisture maps are multi-instance, and `+ New` is the most prominent button on the screen.** A second log splits the equipment and psychro tables, prints two partial DRYING LOG sheets and two contradictory sizing tables — and every completeness rule still passes, because they all test "any row in any instance." | ONE log per job, one map per room+material. Tap the existing row, never `+ New`. | P3 |
| **Reading rows plot and summarise in array order, not date order.** A back-filled date lands at the end, so the narrative reports it as the final reading and the chart draws a rise. | Enter dates in order. After any back-fill, check the trend chart still falls left to right. | P3 |
| **The equipment Days column is elapsed hours rounded to the nearest day, floored at 1** — so it rounds *down* on a short final day and *up* on a long one, and it disagrees with both of the other unit-day figures the packet prints. A same-day place-and-pull shows 1 day in the table and 0 in the narrative. | **Office computes unit-days itself from the placed/removed timestamps** — 24-hour periods, partials rounded up (§12.4.3, interim pending §12.0.6) — and treats the Days column as a cross-check, never as the source. Keep setting precise timestamps: they are what makes any of these countable. | P3 |
| **Both packet equipment counters count ROWS, not machines, and neither de-duplicates on asset tag.** They also normalise the type string differently, so the narrative and the sizing table can print different counts from the same rows. | One row per machine for the life of the job; moves go in Notes. Office counts distinct tags. Four exact type strings. | Queued code fix (§12.6) |
| **Cert of Drying's four "# × days" boxes compute nothing.** | Hand arithmetic, written out in full — **24-hour periods from the placed/removed timestamps, partials rounded up** (§9.6); office verifies (§12.4.3). | P3 |
| **Photo Stage defaults to `During`**, and before/after are hard gates keyed on it. | Set Stage as you shoot. | P3 |
| **The printed Photo Report follows whatever sort is set**, default `manual`. | Set the sort before printing (§9.7). | P3 |
| **Photos don't attach to a reading, an equipment row, or an invoice line.** | The caption is the link: `<what> - <Room> - <Loc n \| asset tag>` | P4 |
| **Room is free text in four places and there is no room manager.** The job's room list has two writers, neither of them a room manager: the Room dropdown inside a contents *item* (which manufactures a nameless contents item that prints on the Contents Inventory and the carrier CSV), and the AI photo-scan bulk-add panel, which pushes scanned room names straight onto the list and creates contents items too. | The panel-door card is the list. Copy it by hand. **Never use Contents to make rooms on a water job**, and treat any room the photo scan invents as something to correct, not to adopt (§3.1). | P3 (`roomIds`) — see §12.6 |
| **Asset # is a per-job string, not a fleet asset.** Nothing detects the same machine on two jobs at once. | Fleet tags, read off the machine, never drag-filled. | P3 (`equipment_units`) |
| **The fill handle is on every column**, including Asset (which auto-increments), Removed, and Hrs (which permanently freezes that row's hours). No undo on a fill. | Fill Type, Room, Placed only. | Queued code fix (§12.6) |
| **The drying flags are in the field app's Jobs list only** — not the Job Board, not Admin. They are silent on archived jobs, certified jobs, and jobs with no data at all. | Owner opens the field app. Treat a clean list as "no red," not "all documented." | Queued code fix (§12.6) |
| **The sync dot is a color with a hover tooltip.** Offline and sync-error are the same red, and a touchscreen has no hover. | Red is normal off-grid. Still red on the next job with signal → call the office. | Not scheduled |
| **Invoice lines carry no code and no justification.** The AI's basis text is discarded on apply. | Nothing the crew can do. Office keeps the basis outside the app. | P4 (`line_items`) |
| **No record that a packet was ever sent.** | The manual submission log (§12.4.12). | P1 (`submittals`) |
| **Voice dictation is online-only, and dictated readings land in the next empty column regardless of the location you say.** | Type readings. Never dictate them. Same for the floor-plan "✨ Read dimensions" and AI photo analysis — no required step depends on signal. | Not scheduled |
| **Two devices on the same job silently lose one side's record.** For maps and drying logs the newer save wins the whole instance — equipment rows and psychro rows included, not just moisture numbers. | One designated device per job (§10.2). On a two-tech visit, one tech carries the tablet. | P3 |
| **No way to add today's date to every map at once.** On an eight-map job that is eight taps, and a missed one is a silent gap. | Count your maps before you leave the warm station. | P3 |
| **Legacy psychro rows missing `refGPP` can write NaN into the GD cell, and completeness counts "NaN" as filled** — so the grain-depression gate can pass on garbage. | Look at the GD cell. If it isn't a number, re-enter that row's T/RH pairs (§7.2). | Queued |
| **The `equipment_logs` table is dead** — nothing anywhere in the app writes to it, and the handful of rows it holds were never finished (counts in §2). | Ignore it. The Drying Log's equipment table is the record. | Delete or wire it up |

### Where the research disagreed, and what we decided

- **Are per-unit equipment rows new?** The architecture review said the live sample has none. Production says otherwise, and by a wide margin — the counts are in §2's evidence block, where every figure in this document lives. **We went with production.** The SOP standardizes an existing habit rather than introducing a capability, because telling techs to start doing something they've done for months discredits the rest of the document.
- **Job-unique point numbers or per-map?** **Per-map, 1–13**, because that is the only thing the app can produce: the number stamp counts from 1 on every map with no way to seed it, and the grid labels columns 1–13 per map. Job-unique numbering was unreachable by any sequence of taps and would have failed on the first two-map job — while it was printed on the laminated card.
- **Where does the control live — a separate map, marker 13, or marker 1?** **Loc 1 on every map.** Marker 13 required counting to a reserved slot and left it stranded whenever a map had fewer points; Loc 1 comes out of the auto-increment for free because you stamp it first. Same rule on every map, nothing to remember. *A tired tech will get "stamp the control first" right; they will not reliably get "leave 13 free" right.*
- **Use the drag-down fill handle, or ban it?** **Both, by column.** Fill Type, Room and Placed. Never Asset, Removed or Hrs — and the handle should come off those three columns in code.
- **Close-and-reopen a row when a unit moves, or keep the row?** **Keep the row.** Closing and reopening double-counts the machine on the packet's opening page and in the sizing table, because both count rows and neither de-duplicates.
- **Does demanding precise removal timestamps cost us money?** **No, but the rounding does.** The Days column is elapsed hours rounded to nearest, so precision swings it ±1 either way — and our normal afternoon-set / morning-pull pattern lands it one day *below* the calendar count on nearly every row regardless of precision. So: keep the precise timestamps as evidence, and **bill neither from that column nor from the calendar — count 24-hour periods off the timestamps themselves, partials rounded up** (see the billing-unit decision below, and §12.0.6).
- **What does the GD column actually show?** **Unaffected GPP − Affected GPP, normally negative on a healthy warm chamber.** The previous draft's "+25 to +40 healthy" band was the dehu inlet-minus-outlet number, which this app has no column for; and "negative means you left Unaffected blank" was wrong — a blank pair prints `0` GPP, which is the real tell. That correction matters more than any other in this revision: a crew told that every honest reading is a mistake will start inventing reference readings.
- **Dry goal = control + 2 points, or the IICRC table?** **Control + 2, full stop** — the table only when no control of that material could be taken. v1.1 said "whichever is higher," which on wood always selects the app's 19 and would flip currently-wet cells green on jobs whose own control reads far lower. A measured dry standard from the same building beats a generic table; that is the entire reason we take a control. Still flagged for the owner's WRT ruling (§12.0.2) because the meter-scale question — Tramex non-invasive vs. pin %MC — is not settled in code or in the docs.
- **Where do the day-1 loss facts go, when the form they belong in is internal?** **Both places.** The tech writes them in the Field Report because that is where they can be captured on site in the cold; the office copies them onto a loss-intake summary in Supporting Docs because that is what prints. Routing them into a psychrometric Notes cell instead would have been one more string competing for a cell that already carries four.
- **What breaks first when a room needs more than thirteen points?** **The one-map-per-room+material rule yields, not the thirteen-column ceiling.** Adding columns prints blank numbered boxes to the carrier on every visit row — an adjuster reads those as readings we didn't take. A second map titled `(2)` costs the office one extra sheet and costs the carrier nothing. *A tired tech gets "start a second map" right; nobody gets "decide which four readings to throw away" right.*
- **Which rule owns the first position of a psychrometric Notes cell?** **The chamber name, always** — it is the only one that applies to every row, so there is no decision to make in the field. The reason line, the dehu outlet and the day's notes follow in that fixed order (§4.2). Three rules each claiming "first" is three rules nobody follows.
- **Do we bill calendar days or 24-hour periods?** **24-hour periods, partials rounded up, until the owner rules otherwise (§12.0.6)** — because "per 24 hr period" is the unit printed on our own invoice lines. Calendar-inclusive counts a partial day at each end as a whole period and would add about one unit-day to every equipment row in the file, on a number that already exceeds elapsed time. An adjuster who recomputes from the timestamps must not find our invoice above our own arithmetic.
- **Does the air-scrubber worksheet decide whether we deploy one?** **No.** Its ACH-by-category figures are the app's own convention adapted from a desiccant chart, not an IICRC AFD standard, and its Cat 1 answer is "not required" with no exception. It is a floor. Containment justifies the unit; the Deviation box carries the justification (§6.5).
- **Should §3–§11 quote production statistics?** **No.** Three passes of this document quoted counts and got a different subset wrong each time, and a technician who catches one wrong number discounts the rest of the page. The rules are true whether or not a count supports them. All measured figures now live in one dated block in §2.

---

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.4 | 2026-09-07 | **Two false statements removed, one real hazard added — all three found by writing the training video, which forced someone to read the code instead of the document.** §3.1's no-trailing-space rule had a stated consequence that is simply not true: nothing in the app splits a room on trailing whitespace. The room prompt trims what you type before storing it (`app.js:1995`) and every consumer trims again — photos (`forms.js:2015`), contents (`forms.js:1266`, `:1398`), the packet narrative (`narrative.js:47`, `:69`). §2's Before/Now row made the same mistake about equipment types; the two counters diverge on the different **words** (`Air mover` versus `Axial Air Mover`), which §6.2 always stated correctly. Both were flagged in v1.3 as needing a decision; the code settled them. **In their place, the hazard that is real:** a room name can never be deleted. `project.rooms` has two writers and no delete path, and deleting the contents item that created a room does not remove the room — so a typo is permanent on that job. Added to §3.1 as the reason to slow down on spelling, and to §13's gap table for whoever builds the room manager. |
| 1.3 | 2026-09-06 | **Consistency pass — no rule changed, several stopped contradicting themselves.** **The billing unit now reads one way everywhere.** Two v1.1 sentences had survived in §13 and still said *bill from the calendar dates*: the removal-timestamps bullet and the Certificate's `# × days` gap row. Both now say what §9.6, §12.0.6, §12.4.3 and the rest of §13 say — **24-hour periods counted off the placed and removed timestamps, a partial period rounded up**, because "per 24 hr period" is the unit on our own invoice lines. It is still an open owner ruling (§12.0.6); it is no longer two answers. **Production counts pulled back into §2.** §2 says it is the only place in the document that quotes them, and three places broke that: the `equipment_logs` figures (now a row in §2's evidence table, where they belong), §13's restatement of the equipment-row counts (now a pointer to §2), and §12.5's `eq_asset` justification — which borrowed §2's *complete on all six fields* count and presented it as the pass rate for *asset filled alone*. The asset-filled count was never measured, so that cell now makes its argument without a number rather than reusing one that means something narrower. **Every Field Report instruction now names a box.** The Field Report has three writable text boxes — **Notes**, **Issues**, **Materials Needed** — and no field for a time, a volume or a measurement. §4.1, §4.3 and §4.6 all now say **Notes**, with a labelled-line format so the office can lift them onto the loss-intake summary; §4.1 says outright what the form does and does not have. §4.5's "that day's Notes" is pinned to the psychrometric row, because on day 1 the map's first row is the legend cell. §4.6 also notes that the Deviation boxes do not exist on screen until the worksheet has been run at step 13. **Two Notes cells, one order each, stated once.** The psychrometric cell's order (§4.2) now has five slots and absorbs every claimant — standing water, the migration boundary, an out-of-range instrument, a Drying System change all land in *the day's notes*, and the `[paper - <tech>]` stamp is slot 5, written by the office transcriber and never by a tech, so the field order is still the four the card prints. The moisture map's first-row Notes cell (§3.5) gets the same treatment: initials, legend, unused-columns note, dry-goal source, map-level flags. §3.2, §3.3, §4.3, §4.5, §4.8, §5.1, §5.8, §7.1, §10.1 and §10.2 now point at those two orders instead of restating or competing with them. **One spelling of the unused-columns token:** `cols 5-13 unused`, in §3.3, §3.5, §13 and now on the card. The two variants that used to sit beside it — one with a trailing "on this map", one with an en dash and a different starting column — are gone. **Field card re-cut and re-measured — front 30 lines, back 41, longest line 62 characters.** Added: take the dehu outlet reading (it named the Notes slot for a measurement it never told you to take); GD climbs toward zero **and through it**, so a positive GD late in a job is fine; the second map's two other requirements (Loc 1 is a control again, first-row Notes carries the continues-note); the legend and its token; the retire note; and `goal = CONTROL + 2`, which is what makes §12.0's claim true that all four gating rulings are printed on the card. Corrected: the blank-psychro-cell line, which asserted a false-negative GD from any blank cell when only a blank **Unaffected** pair does that. §11 also states plainly that the tag format on the card is §12.0.1's recommendation, not a ruling. **Controls called what the screen calls them:** the Certificate's **Drying Start Date / Drying Completion Date / Drying Duration (days)** in §9.3, §12.4.10 and §13; the photo sort options `Room, then Before → After` and `Before → During → After` in §9.7 and §12.4.7. §9.3's "count it the same way as equipment days" is now executable — same clock, same 24-hour periods, and it says why a day count and a unit-day product are not the same number. **Hyphens finished.** Em dashes removed from the strings a tech types — Meter / Setting in §4.8, the equipment Notes examples in §6.2 — and the middot removed from §13's point citation, which §3.3 bans. The app's own `Drying log — <date>` title is quoted as the app writes it, and §14's claim narrowed to what is actually true. **Four §13 gaps that had no §3–§11 instruction now have one**, as §13's own header requires: the Meter / Setting dropdown and its device-local presets (§4.8), the row-delete ✕ with no confirm (§5.5), the `NaN` grain-depression cell that completeness counts as filled (§7.2), and the AI photo-scan room adder (§3.1). §13's cross-reference for the manual submission log corrected from §12.4.8 to §12.4.12. |
| 1.2 | 2026-09-06 | **Corrections pass.** **§1's opening anecdote replaced** — the claim that a 215-air-mover-day job "shows readings on two dates" was false (that job, Cheria Fidler, has 10 moisture reading dates, 7 psychrometric dates and 31 equipment rows, and is one of the better-documented files we have). The new opener is the verified asset-`101` collision: one tag on four jobs as three air movers and a dehumidifier, manufactured by the fill handle. §12.4's repeat of the same misreading is gone. **All production statistics removed from §3–§11** and replaced by one dated evidence block in §2 — every earlier pass got a different subset of them wrong, and rules do not need counts. Corrected figures: **729 photos / 67 with a room (9%)**; **14 maps / 7 unnamed**; **45 equipment rows with an untrimmed TYPE string** (it was attributed to room names; no equipment row has an untrimmed location). Unverifiable figures deleted rather than re-sourced, including the 79-minute visit baseline and the GD "−10 to −40" band. **Unexecutable instructions fixed:** "place marker 1 in an empty corner" (impossible once a plan is imported — the plan fills the canvas; now: import the plan first, stamp Loc 1 anywhere clear, and let the legend carry the meaning); the **13-column ceiling now has an escape hatch** (a second map titled `(2)` for the same room+material, the one permitted exception in §3.2); the **§3.1/§3.2 map-title contradiction settled** — the map title is `<Room> - <Material>` and is *not* the same string as the photo Room, and the card now says so; **one Notes order defined** (chamber, reason line, dehu outlet, notes) where three rules had each claimed first position; **Placed given the same honest capture lane as Removed**; **back-filled rows given a corrective action** (there is no reorder — delete and re-enter); **the Field Report's exclusion from the packet stated plainly**, with the loss-intake summary in Supporting Docs as the carrier-facing route. **Money findings resolved:** billing changed from calendar-days-inclusive to **24-hour periods, partials rounded up**, matching the unit on our own invoice lines (owner ruling §12.0.6); the dry-goal rule changed from "control + 2 **or the table, whichever is higher**" to **control + 2, table only when no control was taken**, because the old rule always selected the table on wood and would end jobs early; the unsourced "Cat 1 → no air scrubber" recast as a **worksheet floor** with the Deviation box carrying the containment justification (owner ruling §12.0.5). **Also added:** the `⤓ Sync labor from QuickBooks` warning (it replaces the entries list and destroys transcribed paper hours); photography ownership on a paper job; Dehu/AM/Scrb counts and a Notes line on the paper card's psychrometric block; the marker-revert on floor-plan import; the sizing worksheet's silent defaults and hardcoded 500-CFM scrubber; the Certificate's independent drying dates; narrative regeneration after corrections; plain hyphens in the strings the crew types. §11 rebuilt, and every card rule given a §3–§10 section behind it (the card's current measurements are in §11). §12.4 grew from 8 checks to 12; §13 by twelve gaps; §12.6 by five code fixes. |
| 1.1 | 2026-09-06 | **Rewrite for executability.** Every instruction re-checked against the shipped app; three that described software that does not exist were removed. **Numbering** changed from job-unique to **per-map 1–13** (the app counts from 1 on every map and cannot be seeded), points cited as `<map> · Loc n`, and the control moved from reserved marker 13 to **Loc 1 on every map**. **Room list** no longer built through Contents — the panel-door card is the list, and creating rooms via a contents item is now explicitly banned. **Grain depression** corrected: the "+25 to +40 healthy" band and "negative means you left Unaffected blank" were both wrong; GD is normally negative and a blank pair prints `0` GPP. **Time budget** corrected from "90 seconds" to 10–15 / 25–40 minutes per monitoring visit and 60–90 on setup, with the cut list that keeps it there. **Equipment moves** now keep one row (close-and-reopen double-counts on the carrier's first page). **Removal timestamps** kept, with the honest statement that the Days column rounds a day low and the office bills from the calendar dates *(superseded in 1.2 — see the 1.2 row)*. **Dry Goal** box named (the moisture map's, under Material) with the Material-overwrite and non-digit-parsing traps. **Cat/Class reason** given a named box (first psychro row's Notes). **Psychrometrics** given per-chamber discipline. **Daily-visit rule** given reason codes. **Cold-weather labeling lane** added and every step re-checked against −20°F and gloves. Added: one-Drying-Log rule, the `↺ Clear drawing` warning, the three fill-handle columns, Photo Stage, photo sort, size-once, date-order readings, Dry-out Start/Finish, the fabricated-row integrity rule. **§12.4** now points the owner at the field app's Jobs list, not the board. **§12.5** re-scoped to three enforceable rules and names the two that would have blocked billing on every job. §12.6 added: the code fixes that retire card rules. §13 grew by fourteen verified gaps. |
| 1.0 | 2026-09-06 | First issue. Answers open question A2 ("may the crew's capture shape change this year"). Established: room list on the panel door, physical point labels and a written legend, day-1 control reading and dry standard, fleet asset tags, four fixed equipment type strings, monitoring cadence, room on every photo, the paper lane with a named same-day transcriber, and a printable field card. |

### Owner decisions still outstanding

Nothing below is asserted as a rule anywhere in this document. Where an interim rule was needed to keep the office working, it is named as interim and points back here.

1. **Asset-tag format** (§12.0.1) — `AM-014` recommended, with a QR on the same label now. Changing it after the shop day means re-tagging the fleet.
2. **The dry-goal rule** (§12.0.2) — v1.2 changed it to **control + 2 points, table value only when no control was taken**. You hold the WRT cert and the meter-scale question (Tramex non-invasive vs. pin %MC) is unsettled in code and in the docs. Confirm or overrule.
3. **The daily-visit commitment** (§12.0.3) — are we staffing a visit on every equipment day, or is the reason-code path the real rule? Say which, plainly, rather than letting the crew learn it is optional.
4. **Grain depression** (§12.0.4) — confirm-and-close. §7.2 now says negative or zero is normal.
5. **Air-scrubber sizing authority** (§12.0.5) — the ACH-by-category figures and the flat "Cat 1 → not required" have no cited source. Give us the authority, or confirm the floor-plus-deviation approach §6.5 now uses.
6. **The equipment billing unit** (§12.0.6) — **24-hour periods with partials rounded up** (interim, matching our own invoice lines) versus **calendar days inclusive**. The difference is roughly one unit-day on every equipment row in the file. This is the largest open money question in the document.

**Open schema request:** a dehumidifier-outlet T/RH/GPP column on the psychrometric row (§7.3).

**Deliberately left alone, and why:** the added-time estimates in §5 are estimates, labelled as such — measure them on the reference job (§12.3) rather than replacing one unsourced number with another. **Two of v1.3's three open items are closed in v1.4**, because building the training video forced someone to read the code rather than the document: §3.1's justification for the no-trailing-space rule was false in both directions — nothing splits a room on whitespace, because the prompt trims on entry and every consumer trims again — and it has been replaced with the hazard that is real, that a room name can never be deleted; §2's Before/Now row no longer blames trailing spaces for the two counters disagreeing, since only the different words do that, which §6.2 always stated correctly. **Still open and still needing a decision rather than an edit:** §12.0's closing sequence, which has the office building the master asset list before the shop day that produces it. The `+25 to +40` correction in §7.2 keeps its worked example (78°F/31% = 44 GPP against 70°F/34% = 37 GPP, GD −7): it was re-checked in 1.3 against the app's own psychrometric function and is exact, and a crew told a normal reading is a mistake needs to see the arithmetic, not just the conclusion. Section structure, the shot list, the cold-weather lane, §6.1–§6.3 and §12.1–§12.3 were checked and left as they were.
