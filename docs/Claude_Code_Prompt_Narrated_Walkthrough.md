# Claude Code build brief — Narrated Walkthrough (V0 → V1 → V2, then V3 / V3b / V4)

*Paste into Claude Code from the repo root:* **"Read `docs/Claude_Code_Prompt_Narrated_Walkthrough.md` and start V0."** Everything below is the brief. Nothing in it is open for debate except where it says *stop and ask*.

---

## 0. What you are building, in one paragraph

The field app's Site Visit packet (`apps/field/js/sitevisit.js`, shipped in #217/#219) already takes silent Magicplan room clips (turned into stills in the browser) and **one** walk recording (transcribed by Deepgram with timestamps; the estimate draft already cites `walk 14:20`). You are turning that seam into the primary scope capture: **narrated walk clips** — one to three minutes per room, recorded with the phone's own Camera while the owner talks — that each yield stills captioned with the words spoken at that second plus a timestamped transcript; an offline media queue with resumable uploads so clips shot with no signal upload themselves later; a **scope-notes** extraction the owner reviews before the estimate is drafted; then recorded client meetings with a consent stamp, a retention job, and the mitigation-side uses. The spec is `docs/Narrated_Walkthrough_Design.md`; it is approved and every question in it is ruled (§2 decisions 1–13, §11). Do not re-open them.

## 1. Read these first, in this order

1. `docs/Narrated_Walkthrough_Design.md` — the spec. §1 what exists, §2 locked decisions (1–13), §3 the flow, §4 data, §5 UI, §6 server, §7 the narration protocol (the cue words the parser and the prompt depend on), §8 meetings, §9 mitigation, §10 sequencing (amended 2026-09-25), §12 fence.
2. `docs/Lead_Bid_Workflow_Design.md` (the bid file and the Bid card — PRs 1–4 merged) and `docs/Magicplan_Integration_Design.md` (quantities come from there, never from video — §12 of the walkthrough doc).
3. `docs/architecture/05-CREW-CAPTURE-SOP.md` §5 and §8 ("Type readings. Never dictate them." — the rule V4 must not break) and `03-TARGET-ARCHITECTURE-AND-ROADMAP.md` (P1: proposals, events, jobs_queue; "the field app owns the blob").
4. Code you will extend — read whole before touching:
   - `apps/field/js/sitevisit.js` — `KINDS`, `MAX_IMAGES` (client mirror of the server cap), `FRAMES_PER_VIDEO`, `frameTimes()`, `frameCaption()`, `videoFrames()`, `addFiles()`, `transcribe()`, `slot()`, `siteFilePath()`, `packetForDraft()`, `packetReady()`, and the `files[]` row shape
   - `apps/field/js/supa.js` — `uploadSiteFile()` (plain POST, 413 → toast), `downloadSiteFile()`, `ensureFresh()`, `authHeaders()`
   - `apps/field/js/officeai.js` — `transcribeSiteAudio()`, `startSiteVisitDraft()`, `checkSiteVisitDraft()`, `aiAvailable()`, the request envelope and error handling
   - `apps/field/js/dictate.js` — the iOS-safe MediaRecorder recipe (`audio/mp4`, 250 ms chunks); V3's recorder is this, hardened
   - `apps/field/js/core.js` — `Store`, `DB_NAME = "roybal-field"`, `indexedDB.open(DB_NAME, 2)`, `onupgradeneeded`; V1 adds an object store here
   - `apps/field/js/bid.js` — the Bid card (Packet line, Verify line land here); `apps/field/js/forms.js` — the estimate form's Pricing Basis
   - `apps/field/sw.js` — the precache list; every new `js/*.js` file goes in it or the PWA breaks offline
   - `supabase/functions/roybal-ai-office/index.ts` — `siteVisitTranscribe` (~line 831: signed URL → Deepgram `diarize&utterances&smart_format&punctuate` + `keyterm`), `signMedia`, `isSitePath`, `STT_MODEL` (nova-3), `STT_KEYTERMS` (env-driven), how `audioSeconds` and tokens are metered into `ai_usage`, how actions are registered and gated
   - `supabase/functions/roybal-ai-office/sitevisit.ts` — `formatTranscript()`, `MAX_IMAGES`, `MAX_TRANSCRIPT_CHARS`, the `SiteFile` type, the draft prompt (the `SITE WALK TRANSCRIPT` block and the `basis` field description), the structured-output mechanism the estimate uses (reuse it for extraction)
   - `supabase/migrations/0004_backbone_contract_tables.sql` — `proposals` (:399), `events` (:553), `jobs_queue` (:649)
   - Tests: `apps/field/test/sitevisit.test.mjs`, `supabase/functions/roybal-ai-office/sitevisit.test.mjs`; `package.json` scripts (`npm test`; fn tests run under `node --test --experimental-strip-types`)
5. `git log --oneline -15 origin/main` — PR titles are the convention. Yours read `Walkthrough V0: narrated clips into the packet (v184)`.

## 2. House rules — every one has a scar behind it

1. **Start from `origin/main`.** `git fetch origin && git worktree add .claude/worktrees/walkthrough-v0 -b feat/walkthrough-v0 origin/main`. Work only in the worktree.
2. **Additive only.** New file kinds, new optional blob fields, new actions, one new IndexedDB store. The old `videos` and `audio` kinds keep working forever. Deleting your PR restores today.
3. **Files never ride inside the job record.** Video and audio go to `field-media/sitevisit/<job>/…` via `siteFilePath()`, exactly as the packet does today; `project.siteVisit.files[]` holds paths and metadata only. Never a blob, never a data URL, in `field_projects`.
4. **Capture works offline; understanding needs signal.** Nothing in the record path may require the network. Transcription and extraction are online-only and degrade to a toast, like every AI feature in the app.
5. **AI output is a proposal.** Scope notes, meeting summaries, discrepancy flags land amber and are accepted by a person. Nothing derived from a recording writes a reading, an equipment row, a price, or a customer-facing sentence on its own. Actionable findings become P1 `proposals` rows, never applied.
6. **Keys never reach a browser.** All Deepgram and Anthropic calls run in `roybal-ai-office` behind the existing JWT check and `ai_usage` metering. The browser never re-uploads audio to the AI function — Deepgram reads by signed URL as today.
7. **Extend, don't duplicate.** `siteVisitTranscribe` gains `utterances` in its result; it does not get a twin. `videoFrames()` gains a still-count parameter; it is not copied.
8. **Tests or it didn't happen.** Every pure helper gets Node tests (`apps/field/test/*.test.mjs` pattern; `--experimental-strip-types` for `.ts` modules). `npm test` green before every commit. Fixtures are hand-written; never a real customer's transcript.
9. **Build bump** in `apps/field/js/config.js` (`v183` on `origin/main` as of this writing — read it fresh) once per PR that touches `apps/field`, and the new files in `sw.js`.
10. **Staging only.** Deploy `roybal-ai-office` to staging (`efbuagiwowcwwsezkgsw`) when a phase needs a live test. Never production; the owner deploys after merge. No `supabase db push`, ever (E0-RUNBOOK §0) — and this brief needs no migration until V3b.
11. **Stop and ask only for owner-only steps** (§7). Everything else is ruled. When you stop, print exactly what he must do, then wait.
12. **One PR per phase.** Push, open the PR (what / why / how tested / owner steps to deploy / rollback / deviations), stop. Do not start the next phase until he says the previous one merged.

## 3. Rulings you must not re-open (design §2, 1–13)

- A narrated clip is **one thing**: `kind:'walk'` yields stills **and** a timestamped transcript; stills are captioned with what was being said at that second.
- **Many short clips**, one per room, 1–3 min; the room is whatever is spoken in the first five seconds.
- **Who records:** owner and office/estimator on bids; crew leads for the day-1 arrival clip and optional monitoring clip on mitigation (V4). The record buttons render for those roles; the server actions are gated owner/office/crew_lead. Find how the client learns the signed-in role (a cached `profiles` read at sign-in); if it has no such thing, add one small cached read — do not build a second auth path. The server gate is the enforcement.
- **Consent:** announce on tape every time, per the §8.4 script; a no stops the recording and stamps `consent.declined`. **No phone-call recording anywhere.**
- **Retention:** raw walk video and meeting audio purged **3 years from job close**, by job, by the V3b retention job; `purgedAt` on the file row; per-job **Hold** flag; never a delete by tap. Transcripts, stills, notes, summaries stay with the job.
- **Camera rule:** 1080p/30 HEVC on company phones — a settings line in the SOP, not code. Your code must handle whatever arrives.
- **Carrier sees** stills and transcript excerpts only; no send rail or packet builder may attach raw video or audio.
- **Recap text** after a meeting is drafted always, sent only on the owner's tap through the existing approved-send rails, never with prices.
- **No measurements from video.** A still-inferred number is a `verify` item, never a `quantity`.
- **No writes to the Drying Log, equipment rows, psychrometrics, or invoice lines from any recording.**
- The Deepgram **callback route lives in V3**, not V1 (§10 amendment).

## 4. V0 — narrated clips into the packet

**Stop and ask first (owner, ten minutes, no code):** *"Please record a 30-second narrated clip with the Camera app (1080p/30, HEVC), open a bid file on staging, and upload the same `.mov` twice — once in the 'Site walk recording' slot and press Transcribe, once in the 'Magicplan room videos' slot. Tell me: did you get a timestamped transcript, and did you get eight stills? Then raise the project's global file-size limit and the `field-media` bucket's `file_size_limit` to 1 GB (Supabase → Storage → Settings)."* If the transcript fails, stop: the `.mov`/HEVC assumption is wrong and we test H.264 ("Most Compatible") before continuing. If stills fail, the canvas path needs work before V0. Do not start V0 code until both pass and the limits are raised.

### 4.1 Client (`sitevisit.js`, new `apps/field/js/walk.js` for the pure helpers, `apps/field/test/walk.test.mjs`)

1. **`KINDS.walk`** — label "🎥 Walk clips", `accept: "video/*,.mp4,.mov"`, `multiple: true`. The slot renders **two** buttons: **🎥 Record** (`<input type="file" accept="video/*" capture="environment">` — opens the Camera) and **Add from Photos** (same input without `capture`). Relabel `videos` to *Silent clips (Magicplan)*; keep `audio` as is.
2. **Refuse oversize until V1:** a clip over 180 s or 250 MB is refused with the toast *"Split it by room — under 3 minutes per clip. Bigger clips come in V1."* Read duration from a `<video>` element the way `videoFrames()` already does.
3. **Stills:** `stillTimes(duration)` = evenly spaced, count `max(8, min(24, floor(duration / 10)))`; `videoFrames(file, times)` takes the times (default remains the old 8 for `videos`). Rows stay `kind:'frames'` with `videoId`, exactly today's shape, so `packetForDraft()` needs no change.
4. **Upload** the clip with `uploadSiteFile()` (plain POST, as today) to `siteFilePath(project.id, id, name)`; row `{id, kind:'walk', name, mime, size, path, duration, at, status:'uploaded'}`. Then call the transcribe action (below) and store the result on the row: `transcript: {utterances:[{start,end,speaker,text}], text, seconds, model, at}` and `room`.
5. **Room parser** (pure): `roomFromOpening(utterances, {rooms, magicplanRooms, lexicon})` — text spoken in the first 5 s (or the first utterance), normalized; exact/contains match against `project.rooms`, then Magicplan room names on `siteVisit.magicplan` (may be absent), then a small lexicon (kitchen, bath/bathroom, bedroom, living, dining, hall/hallway, utility, laundry, garage, basement, crawlspace/crawl space, attic, entry/arctic entry, mudroom, office, closet, stairs, exterior, roof); else `null`, and the UI shows "Clip n" with an editable Room field. Never guess.
6. **Transcript rebuild** (pure): `rebuildTranscript(sv)` → for every `walk`/`audio`/`meeting` row with a transcript, in `at` order: header `— Clip n · <Room or "Clip n"> · <m:ss> —` then that row's `text` (the server's `mm:ss [Speaker] …` lines). Result assigned to `sv.transcript` (the field the draft already reads) and `sv.transcriptSeconds` summed. `sv.transcript` is now derived, never typed into.
7. **Alignment** (pure): `captionForStill(t, utterances, windowSec = 6)` → the utterances overlapping `[t−6, t+6]`, joined, trimmed to ~200 chars, quoted; still `caption = frameCaption(...) + ' · "' + quote + '"'`. Runs when the transcript arrives; re-running is idempotent.
8. **Delete** of a walk row removes its stills (the existing `videoId` rule) and triggers `rebuildTranscript`. The storage object is not deleted (retention owns that).
9. **Bid card** (`bid.js`) Packet line: `4 clips · 11 min · transcript ✓`.

### 4.2 Server (`roybal-ai-office/index.ts`, `sitevisit.ts`, tests)

1. `siteVisitTranscribe` returns `{transcript, seconds, utterances}` — `utterances` trimmed to `{start, end, speaker, text}`. `formatTranscript()` unchanged. Metering unchanged.
2. `STT_KEYTERMS` default gains the cue words: `instruction`, `pre-existing`, `homeowner says`, `verify`, `end`, plus `flood cut`, `baseboard`, `subfloor`, `drywall`, `LVP`, `OSB`, `air mover`, `dehumidifier`. Keep it env-overridable.
3. `MAX_IMAGES` → **150** on both sides (`sitevisit.ts` and the client mirror). `packetForDraft()` already lists photos before frames, so truncation drops the newest stills first — assert that in a test.
4. Prompt (`sitevisit.ts`): the `SITE WALK TRANSCRIPT` block header explains the clip headers ("each clip opens with `— Clip n · Room · length —`; timestamps are minutes:seconds into **that clip**"); the `basis` description's example becomes `walk Kitchen 02:14: "take it to four feet on the sink wall"`; one added rule: *the room named at the top of a clip is the room every line from that clip belongs to unless the speaker names another.* Tests in `sitevisit.test.mjs`.

### 4.3 Done when (V0) — verify on staging with the owner

`npm test` green; `roybal-ai-office` deployed to staging; new build live on staging. **Owner step:** records two narrated clips in two rooms per §7 of the design doc, adds them with 🎥 Record on a staging bid file. Then: both rows show a room parsed from speech (or an editable "Clip n" if he didn't say one), stills carry quotes from the right seconds, `sv.transcript` shows two clip headers, and a drafted estimate's `basis` reads `walk <Room> mm:ss`. Open the PR.

## 5. V1 — offline queue and resumable upload

Branch `feat/walkthrough-v1` off the new `origin/main`.

1. **IndexedDB:** bump `indexedDB.open(DB_NAME, 3)` in `core.js`; `onupgradeneeded` adds `media_queue` (`keyPath: "id"`, index on `projectId`). Test the upgrade path on a phone that already has jobs — an installed PWA must not lose a row. Row: `{id, projectId, fileId, blob, mime, size, name, bytesSent, tusUrl, createdAt, attempts, lastError}`.
2. **Order of operations on capture:** write the blob to `media_queue` **first**; then pull stills; then start the upload. Safari drops the File reference on reload — the queue write is what makes the clip survive a backgrounded app.
3. **Minimal TUS client** (`apps/field/js/tusup.js`, hand-written, ~150 lines, Node-tested against a mock `fetch`): `POST ${SUPABASE_URL}/storage/v1/upload/resumable` with `Tus-Resumable: 1.0.0`, `Upload-Length`, `x-upsert: true`, `Upload-Metadata: bucketName <b64>,objectName <b64>,contentType <b64>,cacheControl <b64>`, auth headers from `supa.js` → `Location`; `PATCH` **6 MiB** chunks (`Content-Type: application/offset+octet-stream`, `Upload-Offset`); `HEAD` to recover the offset on resume; URLs expire after 24 h → start over from 0. No npm dependency — the app has no bundler, and the house style is `zip.js`/`docx.js`: write it. If the documented storage hostname (`<project>.storage.supabase.co`) is required, use it; try `SUPABASE_URL` first and note which worked in the PR.
4. **Drain:** oldest first, one at a time, on `online`, `visibilitychange` → visible, and app open; pause (not abort) when the page hides; after 5 failed attempts the row shows *Failed — tap to retry*. Remove the row only after the final chunk is acknowledged.
5. **UI:** row status chip `queued · uploading 40 % · uploaded · transcribed ✓ · failed`; **field home banner** "2 clips waiting to upload · 410 MB" (tap → the job); Site Visit panel total. Lift the V0 size refusal to **15 minutes / 1 GB** with a soft warning at 3 minutes ("shorter clips make better scope notes").
6. Transcription still runs synchronously via `siteVisitTranscribe` — clips are short. No callback route here.

**Done when:** four clips recorded in airplane mode on a staging bid file upload themselves after the phone reconnects, without the panel being open; a clip whose connection is cut at ~80 % resumes from ~80 % (verify with the `HEAD` offset in the console); the IndexedDB upgrade on a phone with existing jobs loses nothing.

## 6. V2 — scope notes

Branch `feat/walkthrough-v2`.

1. **Server action `walkExtract`** (`roybal-ai-office`, new module `walk.ts` + `walk.test.mjs`): **one clip per call.** Input `{projectId, clip:{id, room, utterances}, stills:[{path, caption, t}], rooms[], magicplanRooms[], jobKind}`. Stills go in by signed URL (`signMedia`), ≤ 24. Structured output with the JSON schema in design §4.2 — the same mechanism the estimate draft uses. Direct request (not Batches); tokens metered into `ai_usage`. Extraction rules baked in (design §6): quote before paraphrase; every item carries `{clip, at}` and **the parser drops any item without one**; rooms only from the spoken cue → `rooms` → Magicplan names, never invented, unplaceable → `jobWide`; a still-inferred quantity goes to `verify` with `"~12 LF (est. from still 01:42)"`; trade only, never a company; `homeownerSaid` attributed and never rewritten into a finding; readings/equipment counts/dates spoken on a mitigation clip → `verify`, never applied.
2. **Client** (`walk.js`): `extractAll(project)` runs `walkExtract` per untranscribed-but-transcribed clip in parallel (cache by clip `id` + transcript hash — re-running after adding a clip extracts one clip, not four); `mergeScopeNotes(perClip[])` (pure, tested) merges by room name into `siteVisit.scopeNotes` (design §4.2), `status:'draft'`.
3. **Scope Notes UI** (Site Visit panel): room accordions; **Accept all in this room** plus per-item ✕ and ✎; each item's clip-time chip seeks a `<video>` (signed URL via `downloadSiteFile`'s sibling — add `signedSiteUrl(path)` to `supa.js` if there isn't one) to that second. **Use as typed scope** appends the accepted items of a room to `siteVisit.typedScope` under a `## <Room>` heading and records `scopeNotes.used[itemKey] = true`; the draft's `WALK SCOPE NOTES` block (below) excludes used items so the estimator never sees one instruction twice.
4. **Draft prompt** (`sitevisit.ts`): optional `WALK SCOPE NOTES (reviewed by the estimator)` block ahead of the raw transcript, containing only accepted, unused items; rule: *accepted notes are instructions; the transcript is evidence.* Tests.
5. **Verify line** on the Bid card: open `verify` items with a checkbox each; checking stamps `verifiedAt`.
6. **Not in estimate:** after a draft lands, `missingLines(scopeNotes, estimateItems)` (pure; room match + keyword overlap, conservative) lists accepted `instructions`/`trades` with no matching line. Show them on the panel as **"Not in estimate (n)"** and write each as a `proposals` row via a server action `proposeMissingLines` (service role; follow 0004's row shape exactly; `kind:'estimate.missing_line'`, payload = the item + citation). The panel is the review surface until P1 has one.
7. **Golden set:** `apps/field/test/fixtures/walks/` — three transcripts (owner-supplied, customer names replaced) with owner-written expected notes; `node supabase/functions/roybal-ai-office/walk-eval.mjs` runs `walkExtract` against them and prints precision/recall per bucket. Manual, not part of `npm test`. **Stop and ask** for the three walks and the expected notes before you write the eval.

**Done when:** the Scope Notes section shows a room-by-room list the owner accepts in under two minutes; every item plays its clip at the right second; an accepted instruction with no estimate line appears under *Not in estimate* and as a `proposals` row; the golden set runs.

## 7. After V2 — V3, V3b, V4 (each its own brief section, same rules)

- **V3 — Client meetings** (`feat/walkthrough-v3`): 🎙️ slot; consent screen with the §8.4 script and one **Start**; long-form recorder from `dictate.js`'s recipe with chunks flushed to `media_queue` every 15 s, Pause/Resume/Stop, running timer; Voice Memo import via the same slot; `consent:{announced, at, by, declined}` on the row; **Deepgram `callback` route** in `roybal-ai-ingest` (per-job HMAC token in the URL, `request_id` match) + `jobs_queue walk.transcribe` + adopt-on-open for recordings over ~25 min; speaker naming from the script's first 20 s with one-tap correction; `meetingSummarize` (design §8.3 schema); Commitments line on the Bid card; recap draft on the existing human-approved rails; narrative *Homeowner account* paragraph on claims. **Prerequisites (owner): the one-line recording notice on the work authorization form (its own small PR) and the counsel check.** Stop and ask before starting.
- **V3b — Retention** (`feat/walkthrough-v3b`, the only migration in this brief): a scheduled function (the repo's cron pattern — find it) that purges `walk`/`meeting` storage objects 3 years after `project.closedAt` (or the last estimate's `sentAt` on a lost bid), skips jobs with `hold: true`, writes `purgedAt` on each file row **through the field app's adopt path or a proposals row — never a direct `field_projects` write** (decide by reading how other server-side facts reach the blob; document the choice), and an `events` row per purge; per-job **Hold** toggle (owner/office) on the job home; Settings → AI *Recordings* row (minutes this month, next purge date, jobs on Hold).
- **V4 — Mitigation** (`feat/walkthrough-v4`): walk slot on the **Field Report** (internal; never the Drying Log); day-1 arrival clip + meeting → **loss-intake summary** draft for Supporting Docs (arrival time, conditions found, cause per homeowner, emergency actions and times); monitoring clip → `walkExtract` in mitigation mode returns `verify` only, compared to that day's Drying Log rows → `events` + a chip, **never a write**; scope-change clips → `proposals kind:'scope.change'`; SOP §4.0/§5.0 paragraphs and the three card lines from design §7 steps 9–10.

## 8. Stop-and-ask points — the only ones

| When | Ask for | Why you can't do it |
|---|---|---|
| Before V0 code | The ten-minute `.mov` test result; storage limits raised to 1 GB | Needs his phone; Storage settings are dashboard-only |
| V0 §4.3 | Two narrated clips in two rooms on a staging bid file | Needs a phone and a room |
| V1 done-when | The airplane-mode test and the cut-connection test on his phone | Needs a phone |
| V2 §6.7 | Three real walks (names swapped) and his expected notes for each | He is the domain expert |
| Before V3 | Confirmation the authorization-form notice PR merged and counsel signed off on §8.4 and 3-year retention | Owner and attorney |
| Anything that would touch production | Nothing — don't. Exact steps go in the PR body. | Owner deploys after merge |

## 9. What "finished" looks like for each PR

Branch pushed; PR open with **What**, **Why** (design section), **How tested** (Node tests, the staging click-through and what you saw), **Owner steps to deploy** (exact commands), **Rollback**, **Deviations from the design doc** (or "none"). `npm test` output pasted. Build bumped; `sw.js` updated. No key, no customer transcript, no real address in the diff. Then stop, and say which phase is next and what you need from him to start it.
