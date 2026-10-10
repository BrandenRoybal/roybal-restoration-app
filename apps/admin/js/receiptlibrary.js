/* ============================================================
   🧾 Receipts — the office receipts library (Job Receipts plan,
   phase 2). The #/receipts tab of the office admin.
   ------------------------------------------------------------
   Every receipt on every job this device holds (the admin runs
   the field sync, so its local Store has them all, photos too):
   search by item, filter by store / job / date, put the photo
   full screen at a returns counter, log a return, and see which
   stores' return windows are about to close.

     #/receipts                       the library
     #/receipts/vendors               each store's return window
     #/receipts/<job>/<id>            one receipt (or one return)
     #/receipts/<job>/<id>/return     log a return against it
     #/receipts/<job>/<credit>/change change a logged return

   RETURNS are never an edit to the receipt they return. Each is a
   NEW credit element in the job's receipts[] (receiptlib.js
   buildReturnCredit), written by writeJob: a compare-and-swap that
   moves the job's updatedAt one millisecond past the copy it was
   made from, so on any merge a crew phone's edits to the OTHER
   receipts still win while the credit (a new id) and any tombstone
   always land. A sync that rewrites the row mid-save is caught by
   the CAS, or after it by the graft below.

   Logging a return waits until the server requires Field Forms v202
   or later (returnsGate): an older phone shows a credit as an
   ordinary receipt it could retype, re-read or delete.

   RETURN WINDOWS and "Nothing left over" live in Supabase (migration
   0018), owner/office only, written through their two doors.

   QUICKBOOKS (phase 3, migration 0023): each receipt shows where it
   stands with QuickBooks (receipt_qbo_links, written by the nightly
   matcher and the approval path, only read here), and each job can be
   linked to its QuickBooks project (job_qbo_links, written here through
   job_qbo_link_set, from the list qbo-proxy listProjects gives). Before
   0023 is applied both reads answer 404 and every QuickBooks control
   stays off the page.

   admin.js loads this file by dynamic import. It imports only names
   that existed in the field modules before it was written: the office
   browser can run one load on a stale cached copy of a field module
   after a deploy (sw.js stale-while-revalidate), and a missing export
   would blank the tab. New logic lives in receiptlib.js.
   ============================================================ */
import { h, clear, Store, toast, fileToDataURL, todayISO, uid, onProjectSaved, onProjectDeleted } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest, currentEmail, callFunction } from "../../js/supa.js";
import { syncNow, onSyncRowChanged } from "../../js/sync.js";
import { tombstoneItems } from "../../js/merge.js";
import { isMediaMarker } from "../../js/media.js";
import { fileToDocPages } from "../../js/pdf.js";
import { officeRole } from "../../js/magicplan.js";
import { amountNum, receiptCategoryLabel, vendorKey, PAID_WITH } from "../../js/receiptcalc.js";
import * as L from "../../js/receiptlib.js";

const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";
const LIST = "#/receipts";
const VENDORS = "#/receipts/vendors";
const enc = encodeURIComponent;
const detailHash = (jobId, id) => `#/receipts/${enc(jobId)}/${enc(id)}`;
const fieldHash = (jobId, id) => `${FIELD_ROOT}#/p/${jobId}/f/receipts/${id}`;
const PAGE = 60;
// a return slip keeps what a receipt keeps (receipts.js): 2000 px reads
// 7-pt thermal print; page 1 + 3 more of a PDF
const SLIP_MAX_DIM = 2000, SLIP_QUALITY = 0.8, MAX_PAGES = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9]+( [a-z0-9]+)*$/;          // 0018's vendor_key check

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const pretty = (key) => key.split(" ").map((w) => (/\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
const badge = (text, tone) => h("span", { class: "badge " + tone }, text);

/* ---------- the index: text only, rebuilt when a job changed ---------- */
let cache = null, dirty = true, building = null;
async function getIndex() {
  // one build at a time, shared: a caller arriving mid-build waits for it
  // rather than taking the old cache; a change landing during a build
  // re-dirties it and the loop builds once more
  for (let i = 0; i < 3 && (dirty || !cache); i++) {
    if (!building) {
      dirty = false;
      building = Store.all().then((all) => { cache = L.buildIndex(all); }).finally(() => { building = null; });
    }
    await building;
  }
  return cache;
}
const sigOf = (entries) => entries.map((e) =>
  [e.jobId, e.id, e.amount, e.returned, e.vendor, e.date, e.items.length, e.pages, e.receiptNo].join(":")).join("|");

/* The page on screen never repaints itself under the office's hands
   (admin.js leaves #/receipts out of the sync repaint): a change from a
   phone or another tab shows a "New changes — refresh" pill instead. */
let watcher = null;                    // { el, sig, scope }
let checkTimer = null;
function changed() {
  dirty = true;
  if (!watcher || !watcher.el.isConnected) { watcher = null; return; }
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const w = watcher;
    if (!w || !w.el.isConnected) return;
    const entries = await getIndex();
    if (w === watcher && w.el.isConnected && sigOf(w.scope(entries)) !== w.sig) w.el.hidden = false;
  }, 800);
}
function watch(el, entries, scope = (x) => x) { watcher = { el, sig: sigOf(scope(entries)), scope }; }

/* ---------- writes: compare-and-swap, append-only, re-applied if a sync drops them ---------- */
/* Every office write to a job: `edit` changes a fresh copy (or throws a
   sentence for the form), and the write lands only if nothing rewrote the
   row since it was read (a sync pull, another tab). If something did, it
   reads again and runs `edit` on the newer copy, so crew work that just
   arrived is never written over. `edit` returning false: nothing to write.
   Store.putIf is quiet, so this tells the page and the sync itself. */
async function writeJob(jobId, edit) {
  for (let i = 0; i < 6; i++) {
    const p = await Store.get(jobId);
    if (!p) throw new Error("This job is no longer on this device.");
    const seen = p.updatedAt;
    if (edit(p) === false) return null;
    p.updatedAt = L.nextStamp(seen);
    if (await Store.putIf(p, seen)) {
      changed();
      syncNow();                                // a sync already running skips this; the next try doesn't
      setTimeout(() => syncNow(), 4000);
      return p;
    }
  }
  throw new Error("This job kept changing while saving. Try again in a moment.");
}

/* A pull that started before an office save can finish after it and write
   the server's copy over the save (sync.js pull, clean branch). Everything
   this session wrote stays pending until a synced row shows it, and is put
   back if a row write dropped it. */
const pending = new Map();             // jobId -> [{ add, kill, tries }]
const grafting = new Set();
const savedIds = new Set();            // returns this session wrote (a retry finds its own, not another device's)
function remember(jobId, w) {
  const list = (pending.get(jobId) || []).filter((x) => !(w.add && x.add && x.add.id === w.add.id));
  list.push({ add: w.add || null, kill: w.kill || [], tries: 0 });
  pending.set(jobId, list);
}
async function graft(jobId) {
  const list = pending.get(jobId);
  if (!list || !list.length || grafting.has(jobId)) return;
  grafting.add(jobId);
  try {
    let lost = [];
    await writeJob(jobId, (p) => {
      const dead = (p.deletedIds && typeof p.deletedIds === "object") ? p.deletedIds : {};
      const have = new Set((p.receipts || []).filter(Boolean).map((r) => r.id));
      const missingAdd = (w) => w.add && !have.has(w.add.id) && !dead[w.add.id];
      lost = list.filter((w) => missingAdd(w) || w.kill.some((k) => !dead[k]));
      if (!lost.length) return false;
      if (!Array.isArray(p.receipts)) p.receipts = [];
      for (const w of lost) {
        if (missingAdd(w)) p.receipts.push(JSON.parse(JSON.stringify(w.add)));
        if (w.kill.length) {
          p.receipts = p.receipts.filter((r) => !(r && w.kill.includes(r.id)));
          tombstoneItems(p, w.kill);
        }
      }
    });
    // a save that landed while this ran added to the list; keep what it added
    for (const w of lost) w.tries++;
    const now = (pending.get(jobId) || []).filter((w) => (list.includes(w) ? lost.includes(w) : true) && w.tries < 5);
    if (now.length) pending.set(jobId, now); else pending.delete(jobId);
  } catch (e) {
    if (/no longer on this device/.test(String(e && e.message))) pending.delete(jobId);
    /* otherwise the next row change tries again */
  } finally { grafting.delete(jobId); }
}

onProjectSaved(() => changed());
onProjectDeleted(() => changed());
onSyncRowChanged((id) => { changed(); graft(id); });
export { graft };                      // for admin-receipts.test.mjs; the hook above is the app's only caller
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") changed(); });

/* ---------- return windows + "Nothing left over" (Supabase, 0018) ---------- */
const WKEY = "roybal-receipt-windows", RKEY = "roybal-receipt-reviews", FKEY = "roybal-receipt-floor";
const loadLocal = (k) => { try { const v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
let windows = loadLocal(WKEY), reviews = loadLocal(RKEY);
let windowsState = "cached";           // ok | missing (0018 not applied yet) | offline | cached
let loadedAt = 0;
// the oldest Field Forms build the server takes saves from (0018's
// field_build_floor, app_settings min_field_build): a number, null when
// never read, -1 = not the office
const RETURNS_BUILD = 202;
let floor = (() => { try { const v = JSON.parse(localStorage.getItem(FKEY)); return Number.isInteger(v) ? v : null; } catch { return null; } })();

/* Every row of a PostgREST read, 1000 at a time (the hosted row cap). */
async function readAll(path) {
  const rows = [];
  for (let from = 0; from <= 50000; from += 1000) {
    const res = await rest(`${path}&limit=1000&offset=${from}`, { method: "GET" });
    if (!res.ok) return { status: res.status, rows: null };
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return { status: 200, rows };
}

/* Today repaints on every sync, so a fresh read within a minute is reused. */
async function loadWindows(force = false) {
  if (!SYNC_ENABLED) return windows;
  if (!force && windowsState === "ok" && Date.now() - loadedAt < 60000) return windows;
  try {
    const since = L.addDaysISO(todayISO(), -380);
    const [w, r, f] = await Promise.all([
      readAll("receipt_vendors?select=vendor_key,display_name,return_days,notes&order=vendor_key"),
      readAll(`receipt_return_reviews?select=job_id,receipt_id,status&updated_at=gte.${since}&order=job_id,receipt_id`),
      rest("rpc/field_build_floor", { method: "POST", body: "{}" }).catch(() => null),
    ]);
    if (w.status === 404 || r.status === 404) { windowsState = "missing"; return windows; }
    if (w.rows) { windows = w.rows; saveLocal(WKEY, windows); }
    if (r.rows) { reviews = r.rows; saveLocal(RKEY, reviews); }
    if (f && f.ok) { const n = Number(await f.json()); floor = Number.isInteger(n) && n >= 0 ? n : null; }
    else if (f && f.status === 403) floor = -1;
    if (f && (f.ok || f.status === 403)) saveLocal(FKEY, floor);
    windowsState = w.rows && r.rows ? "ok" : "offline";
    if (windowsState === "ok") loadedAt = Date.now();
  } catch { windowsState = "offline"; }
  return windows;
}

/* Logging or changing a return waits until the server REQUIRES Field Forms
   v202 or later (app_settings min_field_build, which _sync_guard enforces):
   v201 shows a credit as an ordinary receipt, where retyping its total or an
   AI re-read changes the refund and 🗑 deletes it for good. Under the floor
   an old phone saves nothing until it reloads onto the new build (an edit it
   made first still syncs from v202 after, so the floor is armed once phones
   have had a day to update on their own). Counting phones can't stand in for
   it: the server keeps one row per login, rewritten only by a save.
   null = go ahead, else why not, for the form. */
function returnsGate() {
  if (!SYNC_ENABLED) return null;
  if (windowsState === "missing") return "Logging returns switches on after this feature's database update is applied.";
  if (floor === -1) return "Returns are logged by the office.";
  if (floor == null) return "This device needs to check once, online, that every phone is required to run the latest Field Forms. Connect and open this again.";
  if (floor < RETURNS_BUILD) return `Logging returns switches on once every phone is required to run Field Forms v${RETURNS_BUILD} or later (an older phone would show a return as a receipt it can change). That is a one-time server setting: when it is on, an older phone stops saving until it updates, which opening Field Forms with signal does.`;
  return null;
}

/** A write through one of 0018's doors (or 0023's job_qbo_link_set, which
    names its own `missing` sentence); throws with a sentence for a toast. */
async function door(fn, args, missing = "Return windows switch on after this feature's database update is applied.") {
  let res;
  try { res = await rest("rpc/" + fn, { method: "POST", body: JSON.stringify(args) }); }
  catch { throw new Error("No connection. Try again when you're online."); }
  if (res.ok) return res.json();
  let msg = "";
  try { const b = await res.json(); msg = (b && (b.message || b.hint)) || ""; } catch { /* not json */ }
  if (res.status === 404) throw new Error(missing);
  if (res.status === 403 || /42501|only the office/i.test(msg)) throw new Error("Only the office can change this.");
  throw new Error(msg || `Couldn't save (${res.status}).`);
}

/* ---------- the window-closing reminder ---------- */
function flagsCard(flags, opts = {}) {
  const shown = opts.compact ? flags.slice(0, 3) : flags;
  return h("div", { class: "card rl-flags" },
    h("div", { class: "rl-flags__head" },
      h("strong", {}, "↩ Return windows closing"),
      opts.compact ? h("a", { class: "atoggle", href: LIST }, "Open Receipts ›") : null),
    h("p", { class: "muted rl-small", style: "margin:4px 0 2px" },
      "Materials bought for these jobs with nothing returned yet. Anything left over to take back before the window closes?"),
    ...shown.map((g) => flagRow(g, opts)),
    opts.compact && flags.length > shown.length
      ? h("p", { class: "muted rl-small", style: "margin:8px 0 0" }, `+ ${flags.length - shown.length} more on the Receipts page`) : null);
}
function flagRow(g, opts) {
  const n = g.receipts.length;
  const where = `${g.vendor} on ${L.jobLabel(g.job)}`;
  const clearBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Nothing left over");
  const row = h("div", { class: "rl-flag" },
    h("div", { class: "rl-flag__main" },
      h("div", {}, h("strong", {}, where), " — ", h("span", { class: g.left <= 3 ? "rl-late" : "" }, L.daysLeftText(g.left))),
      h("div", { class: "muted rl-small" },
        `${plural(n, "receipt")} · ${L.fmtMoney(g.total)} · ${g.days}-day window · last day ${L.fmtDay(g.closes)}`)),
    h("div", { class: "rl-flag__act" },
      h("a", { class: "btn btn--ghost btn--sm", href: detailHash(g.jobId, g.receipts[0].id) }, n === 1 ? "Review" : "Review receipts"),
      clearBtn));
  clearBtn.addEventListener("click", async () => {
    if (!UUID.test(g.jobId)) return toast("This job hasn't synced yet. Try again after it syncs.");
    if (!confirm(`Nothing left over from ${where}? The reminder for ${n === 1 ? "this receipt" : "these " + n + " receipts"} goes away.`)) return;
    clearBtn.disabled = true;
    try {
      await door("receipt_return_review_set", { p_job: g.jobId, p_receipts: g.receipts.map((r) => r.id), p_status: "nothing_to_return" });
      for (const r of g.receipts) reviews.push({ job_id: g.jobId, receipt_id: r.id, status: "nothing_to_return" });
      saveLocal(RKEY, reviews);
      row.remove();
      toast("Cleared. No return needed.");
      if (opts.onCleared) opts.onCleared();
    } catch (e) { clearBtn.disabled = false; toast(e.message, 4000); }
  });
  return row;
}
const currentFlags = (entries) => L.returnFlags(entries, windows, reviews, todayISO());

/** Today (admin.js): the reminder card, only when a window is closing. */
export async function fillReturnsToday(slot, projects) {
  await loadWindows();
  if (!slot.isConnected) return;
  const entries = L.buildIndex(projects);
  const fill = () => {
    const flags = currentFlags(entries);
    slot.replaceChildren(...(flags.length ? [flagsCard(flags, { compact: true, onCleared: fill })] : []));
  };
  fill();
}

/** ⚙ Settings (admin.js): the set-once card. */
export function fillSettingsCard(slot) {
  const status = h("span", {}, "");
  const say = () => {
    status.textContent = windowsState === "missing" ? " Switches on after this feature's database update."
      : windows.length ? ` ${plural(windows.length, "store")} set.` : " No stores set yet.";
  };
  say();
  slot.replaceChildren(h("div", { class: "qb-panel" },
    h("div", { class: "qb-panel__head" }, h("strong", {}, "🧾 Receipt return windows")),
    h("p", { class: "subtle" }, "How many days each store takes returns. The Receipts tab reminds you before a window closes on materials nothing has been returned from.", status),
    h("div", { class: "qb-panel__row" }, h("a", { class: "btn btn--ghost btn--sm", href: VENDORS }, "Set return windows"))));
  loadWindows().then(say);
}

/* ---------- QuickBooks: each receipt's state, each job's project (0023) ---------- */
/* Read fresh each time a page draws, never kept across pages: the nightly
   match, an approval and the outbox move these on server-side, and a stale
   "Waiting on QuickBooks" would send the office looking for nothing. When
   job_qbo_links doesn't answer (0023 not applied yet: a 404; offline) the
   badges and the link control stay off the page, quietly. */
let jobLinks = new Map();              // job id -> its job_qbo_links row
const QBO_ID = /^[0-9]{1,20}$/;        // 0023's check on a QuickBooks id
const QBO_MISSING = "Linking jobs to QuickBooks switches on after this feature's database update is applied.";
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const low = (s) => String(s || "").toLowerCase();

async function loadJobLinks() {
  if (!SYNC_ENABLED) return false;
  try {
    const r = await readAll("job_qbo_links?select=job_id,qbo_customer_id,qbo_project_ref,qbo_name,source&order=job_id");
    if (!r.rows) return false;
    jobLinks = new Map(r.rows.map((x) => [x.job_id, x]));
    return true;
  } catch { return false; }
}

/** One page's QuickBooks read: { on: the tables answered, office: the link
    control may show }. The door and listProjects are owner/office only, so a
    crew login gets badges (if its read returns any) but no control. */
function qboLoad() {
  return loadJobLinks().then(async (on) => ({ on, office: on && (await officeRole()) !== false }));
}

// PostgREST's in.(…) with each id double-quoted: an id holding a comma, dot
// or parenthesis would otherwise split
const inList = (ids) => "in.(" + ids.map((id) => '"' + String(id).replace(/["\\]/g, "\\$&") + '"').join(",") + ")";

/** receipt_qbo_links for these ids into `known` (id -> row, null for none).
    The page shows 60 rows at a time, so a paint is one select. False when
    the table can't be read. */
async function readReceiptStates(ids, known) {
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const res = await rest(`receipt_qbo_links?select=receipt_id,state,qbo_txn_id,detail&receipt_id=${enc(inList(part))}`, { method: "GET" });
    if (!res.ok) return false;
    const rows = await res.json();
    for (const id of part) known.set(id, null);
    for (const r of Array.isArray(rows) ? rows : []) if (r && part.includes(r.receipt_id)) known.set(r.receipt_id, r);
  }
  return true;
}

const UNMATCHED = {
  waiting_feed: ["Waiting for the bank feed", "disp-x"],      // a card charge under two weeks old
  store_not_entered: ["Not in QuickBooks yet", "disp-x"],     // a store-account invoice not entered yet
  // a dump ticket: the office books those as Bills, which the match doesn't
  // read, so finding no expense says nothing about whether it's entered
  bill_not_checked: ["Booked as a bill: not checked", "disp-b"],
  needs_job_link: ["Link the job to QuickBooks", "disp-b"],   // found, but the job has no project to tag
  not_found: ["No QuickBooks match", "disp-x"],
};
function conflictWords(d) {
  const name = typeof d.qbo_customer_name === "string" ? d.qbo_customer_name.trim() : "";
  if (d.reason === "tagged_other") return "tagged to " + (name ? clip(name, 60) : "another job");
  if (d.reason === "partly_tagged") return "only part of the expense is tagged to a job";
  if (d.reason === "ambiguous") return "more than one expense matches";
  // the note door's own reason: an approval gave the expense to another receipt first
  if (d.reason === "claimed_by_other") return "another receipt has this expense";
  return String(d.reason || "").replace(/_/g, " ").trim() || "the expense needs a look";
}
// qbo-proxy's error starts with its code ("tagged_other: expense 10566 is
// already tagged to …"); the words after the code are the ones for people
function refusalWords(err) {
  const s = String(err || "").replace(/^[a-z_]+:\s*/, "").replace(/\s+/g, " ").trim();
  return s ? clip(s, 140) : "the change didn't go through";
}
// The codes qbo-proxy refuses with for good: QuickBooks, or the card, said
// no. Any other failed row outlasted the worker's retries without QuickBooks
// answering (QuickBooks down or not connected, qbo-proxy out of reach, a
// row cancelled by hand), so it isn't called a refusal. The same codes as
// QBO_REFUSED in apps/field/js/approvals.js (a test holds them equal).
export const QBO_REFUSED_CODES = ["tagged_other", "partly_tagged", "untaggable", "untaggable_line", "changed_in_qbo",
  "purchase_missing", "photo_missing", "photo_type", "photo_unreadable", "photo_too_big", "upload_refused", "qbo_refused",
  "bad_request", "relinked"];
const codeOf = (err) => (/^([a-z_]+):/.exec(String(err || "").trim()) || [])[1] || "";
// The photo QuickBooks refused after the tag (or the new entry) went in: the
// worker marks the sent row attach_error=<code>, and the row is done
const PHOTO_WORDS = {
  photo_missing: "the photo is missing", photo_type: "the photo isn't a JPEG, PNG or PDF",
  photo_unreadable: "the photo couldn't be read", photo_too_big: "the photo is over 20 MB",
  upload_refused: "QuickBooks refused it", qbo_refused: "QuickBooks refused it",
};
function photoNotAttached(d) {
  const code = (/(?:^|;)attach_error=([a-z_]+)/.exec(typeof d.provider_status === "string" ? d.provider_status : "") || [])[1];
  if (!code) return "";
  return Object.prototype.hasOwnProperty.call(PHOTO_WORDS, code) ? PHOTO_WORDS[code] : code.replace(/_/g, " ");
}

/** A receipt_qbo_links row → its badge { text, tone, title }, or null. */
export function qboStatus(row) {
  if (!row || typeof row !== "object") return null;
  const d = row.detail && typeof row.detail === "object" ? row.detail : {};
  const txn = QBO_ID.test(String(row.qbo_txn_id || "")) ? String(row.qbo_txn_id) : "";
  const title = [txn ? "QuickBooks expense " + txn : "", d.qbo_account_name, d.qbo_doc_number ? "doc # " + d.qbo_doc_number : ""]
    .filter((x) => x && typeof x === "string").join(" · ");
  const out = (text, tone, more = "") => ({ text, tone, title: [title, more].filter(Boolean).join(" · ") });
  switch (row.state) {
    case "done": {
      const why = photoNotAttached(d);
      if (why) return out("Tagged in QuickBooks" + (txn ? " #" + txn : "") + "; photo not attached: " + why, "disp-b");
      return out("In QuickBooks ✓" + (txn ? " #" + txn : ""), "disp-g");
    }
    case "in_qbo": return out("In QuickBooks ✓" + (txn ? " #" + txn : ""), "disp-g");
    case "queued": return out("Waiting on QuickBooks", "disp-b");
    case "unmatched": return out(...(Object.prototype.hasOwnProperty.call(UNMATCHED, d.reason) ? UNMATCHED[d.reason] : UNMATCHED.not_found));
    case "conflict": return out("Check in QuickBooks: " + conflictWords(d), "disp-r");
    // the badge clips a long refusal; hovering shows all of it
    case "failed": return out((QBO_REFUSED_CODES.includes(codeOf(d.error)) ? "QuickBooks refused: " : "Couldn't update QuickBooks: ")
      + refusalWords(d.error), "disp-r", typeof d.error === "string" ? clip(d.error, 600) : "");
    default: return null;
  }
}

/* One page's QuickBooks badges. Each row paints at once with a hidden slot;
   fill() reads the ids on screen in one select and swaps a badge in. Ids
   this page already read aren't asked again ("Show more" reads only the new
   rows), and reads run one after another so two quick paints never ask for
   the same id twice. */
function qboBadges(ready, live) {
  const known = new Map();
  let slots = new Map();               // receipt id -> [slot], this paint's
  let chain = Promise.resolve();
  return {
    reset() { slots = new Map(); },
    slot(id) {
      const s = h("span", { hidden: true });
      slots.set(id, [...(slots.get(id) || []), s]);
      return s;
    },
    fill() {
      const mine = slots;
      chain = chain.then(async () => {
        if (!(await ready).on) return;
        const want = [...mine.keys()].filter((id) => !known.has(id));
        if (want.length && !(await readReceiptStates(want, known))) return;
        if (!live()) return;
        for (const [id, list] of mine) {
          const st = qboStatus(known.get(id));
          if (!st) continue;
          for (const s of list) {
            const line = s.parentElement;
            if (!line) continue;
            const b = badge(st.text, st.tone);
            if (st.title) b.title = st.title;
            s.replaceWith(b);
            line.hidden = false;
          }
        }
      }).catch(() => { /* offline mid-read: no badges this time */ });
      return chain;
    },
  };
}

const qboName = (link) => String(link.qbo_name || "").trim() || "project " + link.qbo_customer_id;

/** The job's QuickBooks project: "QuickBooks: Pollen Apartments · Change",
    or a "Link to QuickBooks" button. Stays hidden (with `shell`, the card
    around it) until job_qbo_links answers, for a crew login, and for a job
    the server hasn't seen yet (the door checks field_projects). */
function qboJobLine(jobId, label, ready, live, shell = null) {
  const box = h("div", { class: "rl-small", style: "margin:8px 0 0", hidden: true });
  const paint = () => {
    const link = jobLinks.get(jobId);
    const open = () => pickQboProject(jobId, label).then((v) => { if (v !== undefined && box.isConnected) paint(); });
    const btn = (text) => h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: open }, text);
    box.replaceChildren(...(link ? ["QuickBooks: ", h("strong", {}, qboName(link)), " · ", btn("Change")] : [btn("Link to QuickBooks")]));
    box.hidden = false;
    if (shell) shell.hidden = false;
  };
  ready.then((q) => { if (q.office && UUID.test(jobId) && live()) paint(); });
  return box;
}

/** qbo-proxy listProjects with the office's session (callFunction, the path
    the QuickBooks connect panel's calls take): every active QuickBooks
    Customer with Job = true. Throws a sentence for the picker. */
async function listProjects() {
  if (!SYNC_ENABLED) throw new Error("QuickBooks needs a connection.");
  let res;
  try { res = await callFunction("qbo-proxy", { action: "listProjects" }); }
  catch { throw new Error("No connection. Try again when you're online."); }
  const body = await res.json().catch(() => ({}));
  // a qbo-proxy from before phase 3 answers 404 "Unknown action: listProjects"
  if (res.status === 404) throw new Error("The QuickBooks project list isn't available yet.");
  if (res.status === 403) throw new Error("Only the office can link a job to QuickBooks.");
  if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || `QuickBooks didn't answer (${res.status}).`);
  // the reply carries the list at the top level and under data
  const list = Array.isArray(body.projects) ? body.projects : body.data && Array.isArray(body.data.projects) ? body.data.projects : null;
  if (!list) throw new Error("The QuickBooks project list isn't available yet.");
  return list.filter((p) => p && QBO_ID.test(String(p.id)) && String(p.name || "").trim())
    .map((p) => ({ id: String(p.id), name: String(p.name).trim(), fqn: String(p.fqn || "").trim(),
      isProject: typeof p.isProject === "boolean" ? p.isProject : null }));
}

/* The project picker (the QuickBooks Time job-code picker's look, qbtime.js
   pickJobcode). Resolves to the saved link row, null after an unlink, or
   undefined when closed with nothing changed. A job already linked starts on
   its project; otherwise the one project named exactly like the job's
   QuickBooks Time job starts picked, the same rule the nightly match
   suggests a link by. Nothing is saved until Link. */
let picking = false;
function pickQboProject(jobId, label) {
  if (picking) return Promise.resolve(undefined);
  picking = true;
  return new Promise((resolve) => {
    const link = jobLinks.get(jobId) || null;
    let done = false, all = [], chosen = null, match = null, busy = false;
    const finish = (v) => {
      if (done) return;
      done = true; picking = false;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape" && !busy) finish(undefined); };
    const onHash = () => finish(undefined);
    const note = (t) => h("div", { class: "subtle", style: "padding:8px 2px;font-size:13px" }, t);

    const search = h("input", { type: "search", placeholder: "Search QuickBooks projects", "aria-label": "Search QuickBooks projects",
      style: "width:100%;padding:9px 10px;border:1px solid #cdd5df;border-radius:8px;margin-bottom:8px;font-size:16px" });
    const listBox = h("div", { style: "max-height:46vh;overflow:auto" }, note("Loading QuickBooks projects…"));
    const err = h("div", { class: "warn", hidden: true, style: "margin-top:10px" });
    const save = h("button", { type: "button", class: "btn btn--primary btn--sm", disabled: true }, "Link");
    const unlink = link ? h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Unlink") : null;
    const cancel = h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => { if (!busy) finish(undefined); } }, "Cancel");

    const card = h("div", { style: "background:#fff;border-radius:16px;padding:18px;max-width:480px;width:92%;box-shadow:0 16px 50px rgba(0,0,0,.3)" },
      h("div", { style: "font-weight:800;font-size:18px;color:var(--navy,#0f1b2d);margin-bottom:2px" }, "QuickBooks project"),
      h("div", { class: "subtle", style: "font-size:13px;margin-bottom:10px" },
        `Pick the QuickBooks project ${label}'s expenses are tagged to.`,
        link ? h("span", {}, " Linked now: ", h("strong", {}, qboName(link)), ".") : null),
      search, listBox, err,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;margin-top:14px" },
        unlink || h("span"),
        h("div", { style: "display:flex;gap:8px" }, cancel, save)));
    const overlay = h("div", { class: "rl-qbo-pick", role: "dialog", "aria-modal": "true", "aria-label": "QuickBooks project",
      style: "position:fixed;inset:0;background:rgba(15,27,45,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px",
      onclick: (e) => { if (e.target === overlay && !busy) finish(undefined); } }, card);
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    document.body.append(overlay);

    const paintSave = () => {
      const same = !!(chosen && link && chosen.id === link.qbo_customer_id);
      save.disabled = busy || !chosen || same;
      save.textContent = !chosen ? "Link" : same ? "Linked" : "Link to " + clip(chosen.name, 40);
    };
    const projectRow = (p) => {
      const on = !!(chosen && chosen.id === p.id);
      const tags = [link && link.qbo_customer_id === p.id ? "linked now" : "", match && match.id === p.id ? "QuickBooks Time match" : "",
        p.isProject === false ? "sub-customer" : ""].filter(Boolean).join(" · ");
      return h("button", { type: "button", "aria-pressed": on ? "true" : "false",
        style: "display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 10px;margin:3px 0;cursor:pointer;border-radius:10px;" +
          (on ? "border:2px solid var(--orange,#f26a21);background:#fff6f0" : "border:1px solid #e2e6ec;background:#fff"),
        onclick: () => { if (busy) return; chosen = p; err.hidden = true; paintList(); paintSave(); } },
        h("span", { style: "min-width:0" },
          h("span", { style: "font-weight:600;color:var(--navy,#0f1b2d)" }, p.name),
          p.fqn && p.fqn !== p.name ? h("div", { class: "subtle", style: "font-size:12px" }, p.fqn) : null),
        on || tags ? h("span", { class: "subtle", style: "margin-left:auto;font-size:12px;white-space:nowrap" }, [on ? "✓" : "", tags].filter(Boolean).join(" ")) : null);
    };
    const paintList = () => {
      const words = low(search.value).split(/\s+/).filter(Boolean);
      const rows = all.filter((p) => words.every((w) => low(p.name + " " + p.fqn).includes(w)));
      if (!rows.length) { listBox.replaceChildren(note(all.length ? "No project matches." : "QuickBooks has no active projects.")); return; }
      const shown = rows.slice(0, 200);
      listBox.replaceChildren(...shown.map(projectRow),
        ...(rows.length > shown.length ? [note(`${rows.length - shown.length} more: type to narrow the list.`)] : []));
    };
    search.addEventListener("input", () => { if (all.length) paintList(); });

    const say = (e) => {
      const m = String((e && e.message) || e);
      err.textContent = /no job/i.test(m) ? "This job hasn't reached the server yet. Try again after it syncs."
        : /is deleted/i.test(m) ? "This job was deleted." : m;
      err.hidden = false;
    };
    save.addEventListener("click", async () => {
      if (busy || !chosen) return;
      const p = chosen;
      busy = true; paintSave(); save.textContent = "Saving…"; err.hidden = true;
      if (unlink) unlink.disabled = true;
      try {
        // p_qbo_project_ref stays null: the line-level ProjectRef is another id
        // space, which the nightly match learns from lines already tagged
        const row = await door("job_qbo_link_set",
          { p_job_id: jobId, p_qbo_customer_id: p.id, p_qbo_name: p.name.slice(0, 160), p_qbo_project_ref: null }, QBO_MISSING);
        const saved = row && typeof row === "object" && row.job_id ? row
          : { job_id: jobId, qbo_customer_id: p.id, qbo_project_ref: null, qbo_name: p.name, source: "picked" };
        jobLinks.set(jobId, saved);
        toast(`${label} is linked to ${p.name} in QuickBooks. The next QuickBooks check uses it.`, 4000);
        finish(saved);
      } catch (e) {
        busy = false; paintSave();
        if (unlink) unlink.disabled = false;
        say(e);
      }
    });
    if (unlink) unlink.addEventListener("click", async () => {
      if (busy || !confirm(`Unlink ${label} from ${qboName(link)}? Nothing already in QuickBooks changes.`)) return;
      busy = true; unlink.disabled = true; paintSave(); err.hidden = true;
      try {
        await door("job_qbo_link_set", { p_job_id: jobId, p_qbo_customer_id: "", p_qbo_name: "", p_qbo_project_ref: null }, QBO_MISSING);
        jobLinks.delete(jobId);
        toast(`${label} is no longer linked to QuickBooks.`);
        finish(null);
      } catch (e) { busy = false; unlink.disabled = false; paintSave(); say(e); }
    });

    Promise.all([listProjects(), Store.get(jobId).catch(() => null)]).then(([projects, p]) => {
      if (done) return;
      all = projects;
      const code = low(p && p.qbJobcodeName).trim();
      const same = code ? all.filter((x) => x.isProject === true && low(x.name).trim() === code) : [];
      match = same.length === 1 ? same[0] : null;
      chosen = (link && all.find((x) => x.id === link.qbo_customer_id)) || match;
      paintList(); paintSave();
      const on = listBox.querySelector('[aria-pressed="true"]');
      if (on && typeof on.scrollIntoView === "function") on.scrollIntoView({ block: "nearest" });
      search.focus();
    }).catch((e) => { if (!done) listBox.replaceChildren(note(String((e && e.message) || e))); });
  });
}

/* ---------- the full-screen viewer (the returns-counter view) ---------- */
let opening = false;                   // a double click opens one viewer, not two
async function showReceipt(jobId, id) {
  if (opening || document.querySelector(".rl-view")) return;
  opening = true;
  try {
    const p = await Store.get(jobId);
    const r = p && (p.receipts || []).find((x) => x && x.id === id);
    if (!r) return toast("That receipt is no longer on the job.");
    viewer(r);
  } finally { opening = false; }
}
function viewer(r) {
  if (document.querySelector(".rl-view")) return;
  const pages = [r.photo, ...(Array.isArray(r.extraPages) ? r.extraPages : [])].filter(Boolean);
  let lock = null, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ov.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", close);
    if (lock) lock.release().catch(() => {});
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const scroller = h("div", { class: "rl-view__scroll" }, ...pages.map((src) => isMediaMarker(src)
    ? h("div", { class: "rl-view__miss" }, "☁️ This page hasn't loaded on this device yet. It loads the next time the office app syncs online.")
    : h("img", { src, alt: "Receipt page", class: "rl-view__img" })));
  scroller.addEventListener("click", (e) => { if (e.target.tagName === "IMG") scroller.classList.toggle("is-zoom"); });
  const facts = [L.fmtDay(L.receiptDay(r)), r.amount !== "" && r.amount != null ? L.fmtMoney(r.amount) : "",
    r.receiptNo ? "#" + r.receiptNo : "", r.cardLast4 ? "••" + r.cardLast4 : ""].filter(Boolean).join(" · ");
  const ov = h("div", { class: "rl-view", role: "dialog", "aria-modal": "true", "aria-label": "Receipt" },
    h("div", { class: "rl-view__bar" },
      h("div", { class: "rl-view__facts" },
        h("strong", {}, (L.isReturn(r) ? "↩ Return · " : "") + (String(r.vendor || "").trim() || "Receipt")),
        h("span", {}, facts)),
      h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: close }, "✕ Close")),
    pages.length ? scroller : h("div", { class: "rl-view__miss" }, "No photo on this receipt."),
    pages.length ? h("div", { class: "rl-view__hint" }, "Tap the receipt to zoom · Esc closes") : null);
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", close);
  document.body.append(ov);
  // keep the screen on while the clerk reads it
  try {
    if (navigator.wakeLock) navigator.wakeLock.request("screen").then((l) => { if (closed) l.release().catch(() => {}); else lock = l; }).catch(() => {});
  } catch { /* no wake lock */ }
}

/* ---------- routing ---------- */
let seq = 0;
const filters = { q: "", vendor: "", job: "", preset: "", show: "all" };

/** admin.js route(): every #/receipts… hash lands here. */
export async function renderReceipts(view) {
  if (!location.hash.startsWith(LIST)) return;   // a late call (a save, the pill) after the office moved on
  const my = ++seq;
  const live = () => my === seq && location.hash.startsWith(LIST);
  watcher = null;
  const hs = location.hash;
  clear(view).append(h("p", { class: "muted", style: "padding:20px 2px" }, "Loading receipts…"));
  if (hs.startsWith(VENDORS)) return renderVendors(view, live);
  const m = hs.match(/^#\/receipts\/([^/?]+)\/([^/?]+)(?:\/(return|change))?$/);
  if (m) {
    const jobId = decodeURIComponent(m[1]), id = decodeURIComponent(m[2]);
    return m[3] ? renderReturnForm(view, jobId, id, m[3], live) : renderDetail(view, jobId, id, live);
  }
  return renderList(view, live);
}

/* ---------- the library (#/receipts) ---------- */
async function renderList(view, live) {
  const entries = await getIndex();
  if (!live()) return;
  const body = clear(view);
  let limit = PAGE;
  const groups = L.vendorGroups(entries, windows);
  if (filters.vendor && !groups.some((g) => g.key === filters.vendor)) filters.vendor = "";
  const jobs = [...new Map(entries.map((e) => [e.jobId, L.jobLabel(e.job)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (filters.job && !jobs.some(([id]) => id === filters.job)) filters.job = "";

  const pill = h("button", { type: "button", class: "rl-pill", hidden: true, onclick: () => renderReceipts(view) }, "New changes — refresh");
  watch(pill, entries);

  const search = h("input", { type: "search", class: "rl-search", value: filters.q, "aria-label": "Search receipts",
    placeholder: "Search items, stores, jobs, receipt # or $ amount" });
  let typing = null;
  search.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { filters.q = search.value; limit = PAGE; paint(); }, 150); });
  const pick = (label, opts, key) => {
    const s = h("select", { "aria-label": label }, ...opts.map(([v, t]) => h("option", { value: v }, t)));
    s.value = filters[key];
    s.addEventListener("change", () => { filters[key] = s.value; limit = PAGE; paint(); });
    return s;
  };
  const chips = h("div", { class: "fchips", style: "margin-top:8px" });
  const paintChips = () => chips.replaceChildren(...L.SHOW.map(([v, t]) => h("button", { type: "button",
    class: "fchip" + (filters.show === v ? " is-on" : ""),
    onclick: () => { filters.show = v; limit = PAGE; paintChips(); paint(); } }, t)));
  paintChips();

  const flagSlot = h("div");
  const nudge = h("div");
  const jobHead = h("div");
  let headFor = null;                  // the job jobHead was drawn for
  const summary = h("p", { class: "rl-sum" });
  const list = h("div");
  const more = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "margin:12px auto 0;display:block",
    onclick: () => { limit += PAGE; paint(); } });
  const qboReady = entries.length ? qboLoad() : Promise.resolve({ on: false, office: false });
  const qb = qboBadges(qboReady, live);

  body.append(
    pill,
    h("div", { class: "atoolbar" }, h("h1", {}, "🧾 Receipts"),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
        h("a", { class: "btn btn--ghost btn--sm", href: VENDORS }, "Return windows"),
        h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => { syncNow(); toast("Syncing…"); } }, "↻ Sync"))),
    flagSlot, nudge,
    h("div", { class: "rl-filters" }, search),
    h("div", { class: "rl-filters" },
      pick("Store", [["", "All stores"], ...groups.map((g) => [g.key, `${g.label} (${g.count})`])], "vendor"),
      pick("Job", [["", "All jobs"], ...jobs], "job"),
      pick("Dates", L.DATE_PRESETS, "preset")),
    chips, jobHead, summary, list, more);

  if (!entries.length) {
    list.replaceChildren(h("div", { class: "empty" }, h("div", { class: "big" }, "🧾"),
      h("p", {}, "No receipts yet. Crews snap them from the 🧾 Receipts tile on a job in Field Forms, and they show up here once the phone syncs.")));
    summary.textContent = ""; more.hidden = true;
  } else paint();
  paintFlags();
  loadWindows().then(() => { if (live()) paintFlags(); });

  function paintFlags() {
    const flags = currentFlags(entries);
    flagSlot.replaceChildren(...(flags.length ? [flagsCard(flags, { onCleared: paintFlags })] : []));
    officeRole().then((office) => {
      if (!live()) return;
      const show = office !== false && windowsState !== "missing" && !windows.length && entries.length;
      nudge.replaceChildren(...(show ? [h("div", { class: "card rl-nudge" },
        h("strong", {}, "Set your stores' return windows once"),
        h("p", { class: "muted rl-small", style: "margin:4px 0 8px" },
          "Home Depot 90 days, Spenard 30… and this page reminds you before a window closes on materials nothing's been returned from."),
        h("a", { class: "btn btn--ghost btn--sm", href: VENDORS }, "Set return windows"))] : []));
    });
  }

  function paint() {
    if (!entries.length) return;
    const { rows, hidden } = L.filterEntries(entries, { ...filters, today: todayISO() });
    const s = L.summarize(rows);
    summary.textContent = rows.length
      ? [plural(s.purchases, "receipt"), s.returns ? `${plural(s.returns, "return")} (${L.fmtMoney(s.returned)} back)` : "",
        `${L.fmtMoney(s.spent)} net`].filter(Boolean).join(" · ")
      : "";
    const q = filters.q.trim();
    qb.reset();
    list.replaceChildren(...rows.slice(0, limit).map((e) => row(e, q, qb)));
    qb.fill();
    paintJobHead();
    if (!rows.length) {
      list.append(h("div", { class: "empty" },
        h("p", {}, q ? `Nothing matches “${q}”${hidden ? " with these filters" : ""}.` : "No receipts with these filters."),
        hidden ? h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "margin:6px auto 0",
          onclick: () => { Object.assign(filters, { vendor: "", job: "", preset: "", show: "all" }); renderReceipts(view); } },
        `Show the ${plural(hidden, "match", "matches")} outside these filters`) : null));
    } else if (hidden) {
      list.append(h("p", { class: "muted rl-small", style: "margin:10px 2px 0" }, `${plural(hidden, "more match", "more matches")} outside these filters.`));
    }
    more.hidden = rows.length <= limit;
    more.textContent = `Show ${Math.min(PAGE, rows.length - limit)} more`;
  }

  /* The list is every job's receipts, newest first, so a job's QuickBooks
     project shows as a header once the Job filter narrows it to one job
     (and on each receipt's page, in its job card). */
  function paintJobHead() {
    if (headFor === filters.job) return;
    headFor = filters.job;
    const label = (jobs.find(([id]) => id === filters.job) || [])[1];
    if (!filters.job || !label) { jobHead.replaceChildren(); return; }
    const card = h("div", { class: "card", hidden: true, style: "margin-top:10px" }, h("strong", {}, label));
    card.append(qboJobLine(filters.job, label, qboReady, () => live() && headFor === filters.job, card));
    jobHead.replaceChildren(card);
  }
}

function row(e, q, qb = null) {
  const st = L.returnStatus(e);
  const badges = [];
  if (e.kind === "return") badges.push(badge("↩ Return", "disp-g"));
  if (st === "all") badges.push(badge("↩ All returned", "disp-g"));
  else if (st === "part") badges.push(badge(`↩ ${L.fmtMoney(e.returned)} returned`, "disp-b"));
  if (L.overReturned(e)) badges.push(badge("Returns are more than the receipt", "disp-r"));
  if (L.needsTotal(e)) badges.push(badge("Needs a total", "disp-r"));
  if (e.orphan) badges.push(badge("Its receipt was deleted", "disp-x"));
  if (e.pages > 1) badges.push(badge(`${e.pages} pages`, "disp-x"));
  const lines = q ? L.matchedLines(e, q) : [];
  return h("div", { class: "card rl-row" + (e.kind === "return" ? " rl-row--ret" : "") },
    h("button", { type: "button", class: "rl-show", disabled: !e.hasPhoto,
      title: e.hasPhoto ? "Show the receipt full screen" : "No photo", "aria-label": "Show the receipt full screen",
      onclick: () => showReceipt(e.jobId, e.id) }, e.kind === "return" ? "↩" : "🧾"),
    h("a", { class: "rl-row__main", href: detailHash(e.jobId, e.id) },
      h("div", { class: "rl-row__top" },
        h("strong", {}, e.vendor || "Unknown vendor"),
        h("span", { class: "rl-amt" + (e.amount < 0 ? " rl-amt--ret" : "") }, e.amount ? L.fmtMoney(e.amount) : "—")),
      h("div", { class: "muted rl-small" }, [L.fmtDay(e.date) || "No date", L.jobLabel(e.job),
        e.receiptNo ? "#" + e.receiptNo : "", e.cardLast4 ? "••" + e.cardLast4 : ""].filter(Boolean).join(" · ")),
      // hidden until it holds a badge: the QuickBooks one arrives after the read
      h("div", { class: "badgeline rl-badges", hidden: !badges.length }, ...badges, qb ? qb.slot(e.id) : null),
      lines.length ? h("div", { class: "rl-lines" }, ...lines.map((it) => h("div", {},
        `${it.desc || "Item"}${it.qty !== 1 ? " × " + L.fmtQty(it.qty) : ""} — ${L.fmtMoney(it.price)}` +
        (e.returnedQty[it.id] ? ` · ${L.fmtQty(e.returnedQty[it.id])} returned` : "")))) : null));
}

/* ---------- one receipt (#/receipts/<job>/<id>) ---------- */
async function renderDetail(view, jobId, id, live) {
  const [entries, p] = await Promise.all([getIndex(), Store.get(jobId)]);
  if (!live()) return;
  const body = clear(view);
  const back = h("a", { class: "btn btn--ghost btn--sm", href: LIST }, "‹ Receipts");
  const e = entries.find((x) => x.jobId === jobId && x.id === id);
  const r = p && (p.receipts || []).find((x) => x && x.id === id);
  if (!e || !r) {
    body.append(h("div", { class: "atoolbar" }, h("h1", {}, "Receipt"), back),
      h("div", { class: "empty" }, h("p", {}, "That receipt is no longer on this device. It was deleted, or its job was removed.")));
    return;
  }
  const jobEntries = entries.filter((x) => x.jobId === jobId);
  const pill = h("button", { type: "button", class: "rl-pill", hidden: true, onclick: () => renderReceipts(view) }, "This job changed — refresh");
  watch(pill, entries, (all) => all.filter((x) => x.jobId === jobId));
  const ret = e.kind === "return";
  const windowSlot = h("div");
  const qboReady = qboLoad();
  const qb = qboBadges(qboReady, live);

  // filtered: DOM append() writes a null as the text "null" (no returns card)
  body.append(...[pill,
    h("div", { class: "atoolbar" },
      h("h1", {}, (ret ? "↩ Return · " : "") + (e.vendor || "Unknown vendor")),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, back,
        e.hasPhoto ? h("button", { type: "button", class: "btn btn--primary btn--sm", onclick: () => viewer(r) }, "🧾 Show at the counter") : null)),
    factsCard(e, r, jobId, windowSlot, qb.slot(e.id)),
    photoCard(r),
    ret ? creditLinesCard(e, jobEntries) : itemsCard(e),
    ret ? null : returnsCard(e, jobEntries, p, view),
    jobCard(e, jobEntries, qboJobLine(jobId, L.jobLabel(e.job), qboReady, live))].filter(Boolean));
  qb.fill();

  const paintWindow = () => windowSlot.replaceChildren(...(ret ? [] : [windowLine(e)].filter(Boolean)));
  paintWindow();
  loadWindows().then(() => { if (live()) paintWindow(); });
}

function fact(k, v) {
  return v ? h("div", {}, h("div", { class: "rl-fact__k" }, k), h("div", { class: "rl-fact__v" }, v)) : null;
}
function factsCard(e, r, jobId, windowSlot, qboSlot) {
  const ret = e.kind === "return";
  const paid = PAID_WITH.find((x) => x.value === r.paidWith);
  const st = L.returnStatus(e);
  return h("div", { class: "card" },
    h("div", { class: "rl-row__top" },
      h("span", { class: "rl-big" + (e.amount < 0 ? " rl-amt--ret" : "") }, e.amount ? L.fmtMoney(e.amount) : "No total yet"),
      h("span", { class: "muted" }, L.fmtDay(e.date))),
    h("div", { class: "badgeline rl-badges" },
      st === "all" ? badge("↩ All returned", "disp-g") : st === "part" ? badge(`↩ ${L.fmtMoney(e.returned)} returned`, "disp-b") : null,
      L.overReturned(e) ? badge("Returns are more than the receipt", "disp-r") : null,
      L.needsTotal(e) ? badge("Needs a total", "disp-r") : null,
      e.ai ? badge("✨ AI read", "disp-x") : null,
      qboSlot),
    h("div", { class: "rl-facts" },
      fact("Job", h("a", { href: `${FIELD_ROOT}#/p/${jobId}` }, L.jobLabel(e.job))),
      fact(ret ? "Slip #" : "Receipt #", e.receiptNo),
      fact("Category", receiptCategoryLabel(e.category)),
      fact("Paid with", [paid ? paid.label : "", e.cardLast4 ? "••" + e.cardLast4 : ""].filter(Boolean).join(" ")),
      fact("Subtotal / tax", e.subtotal || e.tax ? `${L.fmtMoney(e.subtotal)} + ${L.fmtMoney(e.tax)} tax` : ""),
      fact("Logged by", e.by),
      fact("Claim #", e.job.claim)),
    e.notes ? h("p", { class: "rl-small", style: "margin:10px 0 0;white-space:pre-wrap" }, e.notes) : null,
    windowSlot,
    h("div", { class: "rl-actions" },
      !ret && e.amount > 0 ? h("a", { class: "btn btn--primary btn--sm", href: detailHash(jobId, e.id) + "/return" }, "↩ Log a return") : null,
      ret ? h("a", { class: "btn btn--ghost btn--sm", href: detailHash(jobId, e.id) + "/change" }, "Change") : null,
      ret ? h("button", { type: "button", class: "btn btn--danger btn--sm",
        onclick: () => deleteCredit(jobId, e, () => { location.hash = e.orphan ? LIST : detailHash(jobId, e.returnOf); }) }, "Delete return") : null,
      h("a", { class: "btn btn--ghost btn--sm", href: fieldHash(jobId, e.id) }, "Open in Field Forms")),
    !ret && L.needsTotal(e) ? h("p", { class: "muted rl-small", style: "margin:8px 0 0" },
      "A return slip snapped as a receipt lands here with no total. Log the return from the receipt it returns and pick this slip there, and it moves onto the return.") : null);
}

function windowLine(e) {
  if (windowsState === "missing") return null;
  const w = L.windowFor(windows, e.vkey);
  const p = (...kids) => h("p", { class: "rl-small", style: "margin:10px 0 0" }, ...kids);
  if (!w) return p(h("span", { class: "muted" }, "No return window set for this store. "), h("a", { href: VENDORS }, "Set it"));
  const name = w.display_name || pretty(w.vendor_key);
  if (!(Number(w.return_days) > 0)) return p(h("span", { class: "muted" }, `${name} doesn't take returns.`));
  if (!L.validISO(e.date)) return null;
  const closes = L.addDaysISO(e.date, Number(w.return_days));
  const left = L.daysBetween(todayISO(), closes);
  return left >= 0
    ? p(`${name} takes returns for ${w.return_days} days: last day ${L.fmtDay(closes)} (`, h("span", { class: left <= 3 ? "rl-late" : "" }, L.daysLeftText(left)), ").")
    : p(h("span", { class: "muted" }, `The ${w.return_days}-day return window closed ${L.fmtDay(closes)}.`));
}

function photoCard(r) {
  const pages = [r.photo, ...(Array.isArray(r.extraPages) ? r.extraPages : [])].filter(Boolean);
  if (!pages.length) return h("div", { class: "card" }, h("p", { class: "muted", style: "margin:0" }, "No photo on this one."));
  return h("div", { class: "card rl-photos" }, ...pages.map((src) => isMediaMarker(src)
    ? h("div", { class: "empty", style: "padding:18px" }, h("div", { class: "big" }, "☁️"), h("p", {}, "This page loads the next time the office app syncs online."))
    : h("img", { src, alt: "Receipt page", class: "rl-photo", onclick: () => viewer(r) })));
}

function itemsCard(e) {
  if (!e.items.length) return h("div", { class: "card" }, h("p", { class: "muted", style: "margin:0" }, "No item lines on this receipt."));
  const anyBack = Object.keys(e.returnedQty).length > 0;
  return h("div", { class: "card acard" },
    h("strong", {}, "Items"),
    h("table", { class: "minitable", style: "margin-top:6px" },
      h("thead", {}, h("tr", {}, h("th", {}, "Item"), h("th", {}, "Qty"), h("th", {}, "Price"), h("th", {}, "Line"), anyBack ? h("th", {}, "Returned") : null)),
      h("tbody", {}, ...e.items.map((it) => h("tr", {},
        h("td", {}, it.desc || "Item", it.sku ? h("span", { class: "muted rl-small" }, "  SKU " + it.sku) : null),
        h("td", {}, L.fmtQty(it.qty) + (it.unit ? " " + it.unit : "")),
        h("td", {}, L.fmtMoney(it.price)),
        h("td", {}, L.fmtMoney(it.qty * it.price)),
        anyBack ? h("td", {}, e.returnedQty[it.id] ? L.fmtQty(e.returnedQty[it.id]) : "") : null)))));
}

function creditLinesCard(e, jobEntries) {
  const purchases = new Map(jobEntries.filter((x) => x.kind === "purchase").map((x) => [x.id, x]));
  const orig = purchases.get(e.returnOf);
  const others = [...new Set(e.items.map((it) => it.ofReceipt).filter((rid) => rid && rid !== e.returnOf))].map((rid) => purchases.get(rid)).filter(Boolean);
  const link = (x) => h("a", { href: detailHash(x.jobId, x.id) }, `${x.vendor || "Receipt"} · ${L.fmtDay(x.date)} · ${L.fmtMoney(x.amount)}`);
  return h("div", { class: "card" },
    h("strong", {}, "Return of"),
    h("div", { class: "rl-small", style: "margin:4px 0 8px" },
      orig ? link(orig) : h("span", { class: "muted" }, "The receipt it returns is no longer on the job. The refund still comes off the job's total."),
      ...others.map((x) => h("div", {}, "and ", link(x)))),
    e.items.length
      ? h("div", { class: "totals" }, ...e.items.map((it) => h("div", { class: "trow" },
        h("span", {}, `${it.desc || "Item"} × ${L.fmtQty(it.qty)}`), h("span", {}, L.fmtMoney(it.qty * it.price)))))
      : h("p", { class: "muted rl-small", style: "margin:0" }, "Refund only, no item lines."));
}

function returnsCard(e, jobEntries, p, view) {
  if (!e.returnIds.length) return null;
  const credits = jobEntries.filter((x) => e.returnIds.includes(x.id));
  return h("div", { class: "card" },
    h("strong", {}, "Returns"),
    ...credits.map((c) => h("div", { class: "rl-flag" },
      h("div", { class: "rl-flag__main" },
        h("a", { href: detailHash(c.jobId, c.id) }, h("strong", { class: "rl-amt--ret" }, L.fmtMoney(c.amount)), ` · ${L.fmtDay(c.date)}${c.receiptNo ? " · slip #" + c.receiptNo : ""}`),
        h("div", { class: "muted rl-small" }, c.items.length
          ? c.items.map((it) => `${it.desc || "Item"} × ${L.fmtQty(it.qty)}`).join(", ")
          : "Refund only")),
      h("div", { class: "rl-flag__act" },
        c.hasPhoto ? h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => showReceipt(c.jobId, c.id) }, "Slip") : null,
        h("a", { class: "btn btn--ghost btn--sm", href: detailHash(c.jobId, c.id) + "/change" }, "Change"),
        h("button", { type: "button", class: "btn btn--danger btn--sm",
          onclick: () => deleteCredit(c.jobId, c, () => renderReceipts(view)) }, "Delete")))));
}

function jobCard(e, jobEntries, qboLine) {
  const s = L.summarize(jobEntries);
  return h("div", { class: "card" },
    h("div", { class: "rl-row__top" },
      h("span", {}, h("strong", {}, L.jobLabel(e.job)), h("span", { class: "muted rl-small" }, ` · ${plural(s.purchases, "receipt")}${s.returns ? " · " + plural(s.returns, "return") : ""}`)),
      h("strong", {}, `${L.fmtMoney(s.spent)}${s.returns ? " after returns" : ""}`)),
    qboLine,
    h("a", { class: "atoggle", href: LIST, onclick: () => { Object.assign(filters, { q: "", vendor: "", job: e.jobId, preset: "", show: "all" }); } },
      "All of this job's receipts ›"));
}

async function deleteCredit(jobId, c, after) {
  if (!confirm(`Delete this ${L.fmtMoney(c.amount)} return? The job's receipts total goes back up by ${L.fmtMoney(Math.abs(c.amount))}.`)) return;
  try {
    // its derived ids too: a change another device made before hearing of
    // the delete can't bring it back (receiptlib.js returnFamily)
    const kill = L.returnFamily(c.id);
    await writeJob(jobId, (fresh) => {
      // changed past these ids, or deleted, since this page drew it
      if (!(fresh.receipts || []).some((r) => r && kill.includes(r.id))) throw new Error("This return was changed or deleted on another device. Go back and open it again.");
      fresh.receipts = (fresh.receipts || []).filter((r) => !(r && kill.includes(r.id)));
      tombstoneItems(fresh, kill);
    });
    remember(jobId, { kill });
    toast("Return deleted.");
    after();
  } catch (err) { toast(String(err && err.message || err), 4000); }
}

/* ---------- log or change a return ---------- */
let saving = false;

/** The item on a purchase entry a credit line points at: id, then sku, then
    description (an AI re-read mints new item ids). */
function itemFor(e, ln) {
  const norm = (s) => L.norm(s).replace(/[^a-z0-9]+/g, "");
  const items = e.items.filter((it) => it.price > 0);
  return (ln.of && items.find((it) => it.id === ln.of)) ||
    (ln.sku && items.find((it) => it.sku && it.sku === ln.sku)) ||
    (ln.desc && items.find((it) => norm(it.desc) === norm(ln.desc))) || null;
}

async function toPages(f) {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
  if (isPdf) return (await fileToDocPages(f)).slice(0, MAX_PAGES);
  return [await fileToDataURL(f, SLIP_MAX_DIM, SLIP_QUALITY)];
}

async function renderReturnForm(view, jobId, id, mode, live) {
  const [p] = await Promise.all([Store.get(jobId), loadWindows()]);
  if (!live()) return;
  const body = clear(view);
  const credit = mode === "change" && p ? (p.receipts || []).find((r) => r && r.id === id && L.isReturn(r)) : null;
  const startId = credit ? credit.returnOf : id;
  const cancelHash = detailHash(jobId, id);
  const stop = (msg) => body.append(
    h("div", { class: "atoolbar" }, h("h1", {}, "↩ Return"), h("a", { class: "btn btn--ghost btn--sm", href: cancelHash }, "‹ Back")),
    h("div", { class: "empty" }, h("p", {}, msg)));
  const gate = returnsGate();
  if (gate) return stop(gate);
  if (!p) return stop("This job is no longer on this device.");
  if (mode === "change" && !credit) return stop("That return is no longer on the job. It was changed or deleted on another device.");
  // a change re-checks the caps without the return it replaces, and keeps
  // every receipt it already draws from on the form
  const base = { ...p, receipts: (Array.isArray(p.receipts) ? p.receipts : []).filter((r) => !(credit && r && r.id === credit.id)) };
  const include = credit ? [...new Set((credit.items || []).filter(Boolean).map((ln) => ln.ofReceipt || credit.returnOf))] : [];
  const entries = L.buildIndex([base]);
  const sources = L.returnSources(entries, jobId, startId, include);
  if (!sources.length) return stop(credit ? "The receipt this return was logged against is no longer on the job. Delete the return instead, or log a new one." : "That receipt is no longer on the job.");
  const start = sources[0];
  if (!(start.amount > 0)) return stop("This receipt has no total yet. Add its total in Field Forms first, then log the return.");

  // ids are settled now, so a double click or a retry saves this one return,
  // never two. A change's id is derived, so two devices changing the same
  // return at once write one id and an office delete reaches it: successorId
  // when it stays on the same receipts (a phone deleting its receipt from an
  // older copy takes it along, as it would the original), movedId when it
  // moves onto others (out of that phone's reach). receiptlib.js has why.
  const newId = uid(), sameId = credit ? L.successorId(credit.id) : null, movedId = credit ? L.movedId(credit.id) : null;
  const booked = credit ? (include.length ? include : [credit.returnOf]) : [];
  const idFor = (picked) => {
    if (!credit) return newId;
    const now = new Set(L.returnTargets(startId, picked));
    return now.size === booked.length && booked.every((rid) => now.has(rid)) ? sameId : movedId;
  };
  const picks = new Map();             // "receiptId|itemId" -> qty
  if (credit) {
    for (const ln of (credit.items || []).filter(Boolean)) {
      const e = sources.find((s) => s.id === (ln.ofReceipt || credit.returnOf));
      const it = e && itemFor(e, { of: ln.of, sku: ln.sku, desc: ln.desc });
      // a line the form can't show (its receipt was read again, or deleted)
      // would silently drop off the changed return and move its money
      if (!it) return stop("Something on this return no longer matches its receipt: an item was read again, or a receipt was deleted, on another device. Delete this return and log it again.");
      picks.set(e.id + "|" + it.id, (picks.get(e.id + "|" + it.id) || 0) + amountNum(ln.qty));
    }
  }
  const byId = new Map(sources.map((s) => [s.id, s]));
  let refundTouched = !!credit;
  const refund = h("input", { type: "text", inputmode: "decimal", class: "rl-money", placeholder: "0.00",
    value: credit ? L.money2(credit.amount) : "", "aria-label": "Refund amount" });
  refund.addEventListener("input", () => { refundTouched = refund.value.trim() !== ""; });
  const pickList = () => [...picks].filter(([, q]) => q > 0).map(([k, qty]) => {
    const [receiptId, itemId] = k.split("|");
    return { receiptId, itemId, qty };
  });
  const prefill = () => { if (!refundTouched) { const v = L.prefillRefund(pickList(), byId); refund.value = v > 0 ? v.toFixed(2) : ""; } };

  const itemRows = (e) => {
    const items = e.items.filter((it) => it.price > 0);
    if (!items.length) return [h("p", { class: "muted rl-small", style: "margin:6px 0" }, "No item lines on this receipt. Enter the refund below.")];
    return items.map((it) => {
      const left = L.remainingQty(e, it);
      const key = e.id + "|" + it.id;
      const qty = h("input", { type: "number", min: "0", step: "any", max: String(left), inputmode: "decimal",
        value: picks.get(key) ? String(picks.get(key)) : "", placeholder: "0", disabled: left <= 0, "aria-label": "Quantity returned: " + (it.desc || "item") });
      qty.addEventListener("input", () => {
        const n = amountNum(qty.value);
        if (n > 0) picks.set(key, n); else picks.delete(key);
        prefill();
      });
      return h("div", { class: "rl-item" }, qty,
        h("div", { class: "rl-item__desc" }, it.desc || "Item", h("div", { class: "muted rl-small" },
          `${L.fmtMoney(it.price)} each${it.sku ? " · SKU " + it.sku : ""}`)),
        h("div", { class: "rl-item__left" }, left <= 0 ? "all returned" : `${L.fmtQty(left)} of ${L.fmtQty(it.qty)} left`));
    });
  };
  const srcHead = (e) => h("div", { class: "rl-small", style: "font-weight:700;margin-top:4px" },
    `${e.vendor || "Receipt"} · ${L.fmtDay(e.date)} · ${L.fmtMoney(e.amount)}${e.receiptNo ? " · #" + e.receiptNo : ""}` +
    (e.returned ? ` · ${L.fmtMoney(e.returned)} already returned` : ""));
  const others = sources.slice(1);
  const othersBox = others.length ? h("details", { class: "rl-src", open: others.some((s) => [...picks.keys()].some((k) => k.startsWith(s.id + "|"))) },
    h("summary", { class: "rl-small" }, `Taking back items from another ${start.vkey !== "unknown" ? pretty(start.vkey) : "store"} receipt on this job too? (${others.length})`),
    ...others.flatMap((e) => [srcHead(e), ...itemRows(e)])) : null;

  const date = h("input", { type: "date", value: credit && L.validISO(credit.date) ? credit.date : todayISO(), "aria-label": "Return date" });
  const slipNo = h("input", { type: "text", maxlength: "40", value: credit ? credit.receiptNo || "" : "", placeholder: "From the return slip" });
  const userNote = credit ? String(credit.notes || "").split(" — ").slice(1).join(" — ") : "";
  const note = h("input", { type: "text", maxlength: "200", value: userNote, placeholder: "e.g. 3 sheets left over after the subfloor" });
  const over = h("input", { type: "checkbox" });
  // a return logged as store credit stays one: re-saving it must not trip the cap
  if (credit && Math.abs(amountNum(credit.amount)) > L.refundCap(entries, jobId, booked) + 0.05) over.checked = true;

  // the slip photo: snapped, uploaded, or one the crew already snapped as a $0 receipt
  let slip = credit ? { photo: credit.photo || "", extraPages: Array.isArray(credit.extraPages) ? credit.extraPages : [], fromId: null }
    : { photo: "", extraPages: [], fromId: null };
  let ownSlip = slip;                  // the form's own slip, back when a crew slip is un-picked
  const slipView = h("div", { class: "rl-slipview" });
  const paintSlip = () => {
    if (!slip.photo) { slipView.replaceChildren(h("span", { class: "muted rl-small" }, "No slip photo yet (optional).")); return; }
    slipView.replaceChildren(
      isMediaMarker(slip.photo) ? h("span", { class: "muted rl-small" }, "☁️ Slip photo saved (loads after the next sync).")
        : h("img", { src: slip.photo, alt: "Return slip", class: "rl-slip" }),
      h("div", { class: "rl-small" },
        slip.fromId ? "This snapped slip moves onto the return and comes off the receipt list. " : "",
        slip.extraPages.length ? `${1 + slip.extraPages.length} pages. ` : "",
        h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => {
          slip = slip.fromId ? ownSlip : (ownSlip = { photo: "", extraPages: [], fromId: null });
          candSel && (candSel.value = ""); paintSlip();
        } }, "Remove")));
  };
  const onFile = (input) => async () => {
    const f = input.files && input.files[0]; input.value = "";
    if (!f) return;
    try {
      const pages = await toPages(f);
      if (!pages.length) throw new Error("empty");
      slip = ownSlip = { photo: pages[0], extraPages: pages.slice(1), fromId: null };
      if (candSel) candSel.value = "";
      paintSlip();
    } catch { toast("Couldn't read that file. Try a photo or a PDF.", 3500); }
  };
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none" });
  const upload = h("input", { type: "file", accept: "image/*,application/pdf", style: "display:none" });
  camera.addEventListener("change", onFile(camera));
  upload.addEventListener("change", onFile(upload));
  const cands = L.slipCandidates(entries, jobId).filter((c) => c.id !== startId);
  const candSel = cands.length ? h("select", { "aria-label": "A slip the crew snapped" },
    h("option", { value: "" }, "…or use a slip the crew snapped on this job"),
    ...cands.map((c) => h("option", { value: c.id }, `${c.vendor || "Unknown store"} · ${L.fmtDay(c.date)}${c.by ? " · " + c.by : ""}`))) : null;
  if (candSel) candSel.addEventListener("change", () => {
    const r = candSel.value && (p.receipts || []).find((x) => x && x.id === candSel.value);
    if (!r) {                          // back to the placeholder: that slip stays a receipt
      if (slip.fromId) { slip = ownSlip; paintSlip(); }
      return;
    }
    slip = { photo: r.photo || "", extraPages: Array.isArray(r.extraPages) ? r.extraPages.slice(0, MAX_PAGES - 1) : [], fromId: r.id };
    paintSlip();
  });
  paintSlip();

  const err = h("div", { class: "warn", hidden: true });
  const save = h("button", { type: "button", class: "btn btn--primary" }, credit ? "Save changes" : "Save return");

  body.append(
    h("div", { class: "atoolbar" },
      h("h1", {}, credit ? "Change a return" : "↩ Log a return"),
      h("a", { class: "btn btn--ghost btn--sm", href: cancelHash }, "Cancel")),
    h("div", { class: "card rl-form" },
      h("div", { class: "field" }, h("label", {}, "What went back"), srcHead(start), ...itemRows(start), othersBox),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", {}, "Refund on the slip ", h("span", { class: "hint" }, "(filled from the items plus tax; use the slip's number)")),
          h("div", { class: "rl-moneyrow" }, h("span", {}, "$"), refund)),
        h("div", { class: "field" }, h("label", {}, "Return date"), date)),
      h("label", { class: "rl-check", style: "margin:-4px 0 12px" }, over, "More than what's left on the receipt (store credit or an exchange)"),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", {}, "Slip #"), slipNo),
        h("div", { class: "field" }, h("label", {}, "Note ", h("span", { class: "hint" }, "(optional)")), note)),
      h("div", { class: "field" }, h("label", {}, "Return slip photo"),
        h("div", { class: "rl-actions", style: "margin:0 0 8px" },
          h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => camera.click() }, "📷 Snap slip"),
          h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => upload.click() }, "📎 Upload"),
          candSel),
        slipView, camera, upload),
      err,
      h("div", { class: "rl-actions" }, save,
        h("a", { class: "btn btn--ghost btn--sm", href: cancelHash }, "Cancel"))),
    h("p", { class: "muted rl-small" }, credit
      ? "Saving replaces this return with the changed one. The job's receipts total follows."
      : "The refund comes off this job's receipts total everywhere: the job tile, its costs, the morning brief. The original receipt stays as it was."));

  save.addEventListener("click", async () => {
    if (saving) return;
    saving = true; save.disabled = true; save.textContent = "Saving…"; err.hidden = true;
    try {
      const amt = Math.abs(amountNum(refund.value));
      if (!L.validISO(date.value)) throw new Error("Pick the date on the return slip.");
      const picked = pickList();
      // a new return that takes a crew slip gets the slip's derived id, the one a
      // phone turning that slip into a return writes too, so sync keeps one
      const fromSlip = !credit && slip.fromId && typeof L.slipReturnId === "function";
      const formId = fromSlip ? L.slipReturnId(slip.fromId) : idFor(picked);
      let c = null, kill = [], label = "", mine = false;
      // checked and built against the job as it is NOW, not as the form
      // opened; writeJob re-runs this if a sync lands mid-save
      await writeJob(jobId, (fresh) => {
        if (!Array.isArray(fresh.receipts)) fresh.receipts = [];
        const dead = (fresh.deletedIds && typeof fresh.deletedIds === "object") ? fresh.deletedIds : {};
        if (fresh.receipts.some((r) => r && r.id === formId)) {
          if (savedIds.has(formId)) { mine = true; return false; }     // this form's own save already landed
          throw new Error(fromSlip ? "That slip is already logged as a return (from a phone, or another device). Open the receipt to see it."
            : "This return was just changed on another device. Go back and open it again.");
        }
        if (fromSlip && dead[formId]) throw new Error("That slip was logged as a return and the return was deleted. Snap the slip again to log it.");
        if (dead[formId] || (credit && !fresh.receipts.some((r) => r && r.id === credit.id))) {
          throw new Error("This return was changed or deleted on another device. Go back and open it again.");
        }
        const freshBase = credit ? { ...fresh, receipts: fresh.receipts.filter((r) => !(r && r.id === credit.id)) } : fresh;
        const fe = L.buildIndex([freshBase]);
        const problem = L.checkReturn({ entries: fe, jobId, returnOf: startId, picks: picked, refund: amt, over: over.checked });
        if (problem) throw new Error(problem);
        let slipFrom = null;
        if (slip.fromId) {
          const se = fe.find((x) => x.id === slip.fromId);
          slipFrom = fresh.receipts.find((r) => r && r.id === slip.fromId);
          if (!se || !slipFrom || !L.needsTotal(se)) throw new Error("The snapped slip you picked changed on another device. Pick it again, or snap the slip.");
        }
        const now = L.returnSources(fe, jobId, startId, include);
        // a crew slip moves over as it is NOW: a retake synced in since it was picked comes along
        const photo = slipFrom ? slipFrom.photo || "" : slip.photo;
        const extraPages = slipFrom ? (Array.isArray(slipFrom.extraPages) ? slipFrom.extraPages.slice(0, MAX_PAGES - 1) : []) : slip.extraPages;
        c = L.buildReturnCredit({ id: formId, start: now[0], sources: now, picks: picked, refund: amt, date: date.value,
          slipNo: slipNo.value, note: note.value, photo, extraPages,
          by: currentEmail() || "office", nowISO: new Date().toISOString() });
        // a move also closes the old return's other derived ids, so a change
        // another device made to it at the same time can't add a second copy
        const old = !credit ? [] : formId === sameId ? [credit.id] : L.returnFamily(credit.id).filter((x) => x !== formId);
        kill = [...old, slipFrom && slipFrom.id].filter(Boolean);
        fresh.receipts = fresh.receipts.filter((r) => !(r && kill.includes(r.id)));
        fresh.receipts.push(c);
        if (kill.length) tombstoneItems(fresh, kill);
        label = L.jobLabel(fe[0] ? fe[0].job : { customer: fresh.customer, address: fresh.address });
      });
      if (mine) { location.hash = detailHash(jobId, formId); return; }
      savedIds.add(formId);
      remember(jobId, { add: c, kill });
      toast(`${credit ? "Return changed" : "Return logged"}: ${L.fmtMoney(c.amount)} off ${label}.`, 3500);
      location.hash = detailHash(jobId, credit ? c.id : c.returnOf);
    } catch (e) {
      err.textContent = String(e && e.message || e); err.hidden = false;
    } finally {
      saving = false; save.disabled = false; save.textContent = credit ? "Save changes" : "Save return";
    }
  });
}

/* ---------- each store's return window (#/receipts/vendors) ---------- */
async function renderVendors(view, live) {
  const entries = await getIndex();
  const [office] = await Promise.all([SYNC_ENABLED ? officeRole() : Promise.resolve(null), loadWindows(true)]);
  if (!live()) return;
  const body = clear(view);
  body.append(
    h("div", { class: "atoolbar" }, h("h1", {}, "Return windows"), h("a", { class: "btn btn--ghost btn--sm", href: LIST }, "‹ Receipts")),
    h("p", { class: "muted", style: "font-size:13px;margin:0 0 6px" },
      "How many days each store takes returns, counted from the receipt date. Set it once. The Receipts tab then reminds you when materials from that store ($50 or more on the receipt) are in the last two weeks of their window (the last half, for a window under four weeks) and nothing has been returned yet. A store's name covers its branches: Home Depot covers Home Depot Pro."));
  if (windowsState === "missing") {
    body.append(h("div", { class: "warn" }, "Return windows switch on after this feature's database update is applied. Everything else on the Receipts tab works now."));
    return;
  }
  if (office === false) {
    body.append(h("div", { class: "card" }, h("p", { style: "margin:0" }, "Return windows are set by the office.")));
    return;
  }
  if (windowsState === "offline") body.append(h("div", { class: "warn" }, "Offline: showing the windows this device saw last. Saving needs a connection."));

  const groups = L.vendorGroups(entries, windows);
  const seen = new Set(groups.map((g) => g.key));
  const extra = windows.filter((w) => !seen.has(w.vendor_key));
  const list = h("div", { class: "card" });
  list.append(
    ...groups.map((g) => windowRow(g.key, (g.own && g.own.display_name) || pretty(g.key),
      `${plural(g.count, "receipt")} · ${L.fmtMoney(g.total)}${g.label && g.label.toLowerCase() !== g.key ? " · printed “" + g.label + "”" : ""}`, g.own, g.covering)),
    ...extra.map((w) => windowRow(w.vendor_key, w.display_name || pretty(w.vendor_key), "No receipts yet", w, null)));
  if (!groups.length && !extra.length) list.append(h("p", { class: "muted", style: "margin:0" }, "No stores yet. They show up here from the receipts crews snap. You can add one below."));

  const name = h("input", { type: "text", placeholder: "Store name, e.g. Spenard Builders Supply", maxlength: "120" });
  const days = h("input", { type: "number", min: "0", max: "365", step: "1", inputmode: "numeric", class: "rl-days", placeholder: "Days" });
  const add = h("button", { type: "button", class: "btn btn--primary btn--sm" }, "Add");
  add.addEventListener("click", async () => {
    const key = vendorKey(name.value);
    const n = Number(days.value);
    if (key === "unknown" || !KEY_RE.test(key) || key.length > 120) return toast("Type the store's name.");
    if (!(Number.isInteger(n) && n >= 0 && n <= 365)) return toast("Days: a whole number from 0 (no returns) to 365.");
    add.disabled = true;
    try {
      await door("receipt_vendor_set", { p_key: key, p_days: n, p_display: name.value.trim().slice(0, 120) || pretty(key), p_notes: "" });
      await loadWindows(true);
      if (location.hash.startsWith(VENDORS)) renderReceipts(view);
      toast("Saved.");
    } catch (e) { add.disabled = false; toast(e.message, 4000); }
  });
  body.append(list,
    h("div", { class: "card" }, h("strong", {}, "Add a store"),
      h("div", { class: "rl-vrow", style: "border-top:0" }, h("div", { class: "rl-vrow__name" }, name), days, add)));
}

function windowRow(key, label, sub, own, covering) {
  const days = h("input", { type: "number", min: "1", max: "365", step: "1", inputmode: "numeric", class: "rl-days",
    value: own && Number(own.return_days) > 0 ? String(own.return_days) : "",
    placeholder: covering ? String(covering.return_days) : "Days", "aria-label": "Return window in days for " + label });
  const none = h("input", { type: "checkbox", checked: !!own && Number(own.return_days) === 0 });
  const save = h("button", { type: "button", class: "btn btn--primary btn--sm", disabled: true }, "Save");
  const state = h("span", { class: "muted rl-small" }, own ? "" : covering ? `Covered by ${covering.display_name || pretty(covering.vendor_key)} (${Number(covering.return_days) > 0 ? covering.return_days + " days" : "no returns"}). Set this only if it differs.` : "Not set");
  let saved = own;
  const remove = h("button", { type: "button", class: "btn btn--ghost btn--sm", hidden: !own }, "Remove");
  days.disabled = none.checked;
  const touched = () => { save.disabled = false; days.disabled = none.checked; };
  days.addEventListener("input", touched);
  none.addEventListener("change", touched);
  const upsertLocal = (row) => {
    windows = windows.filter((w) => w.vendor_key !== key);
    if (row) windows.push(row);
    saveLocal(WKEY, windows);
  };
  save.addEventListener("click", async () => {
    const n = none.checked ? 0 : Number(days.value);
    if (!none.checked && !(Number.isInteger(n) && n >= 1 && n <= 365)) return toast("Enter whole days from 1 to 365, or tick No returns.");
    save.disabled = true; state.textContent = "Saving…";
    try {
      const display = (saved && saved.display_name) || label;
      await door("receipt_vendor_set", { p_key: key, p_days: n, p_display: display.slice(0, 120), p_notes: (saved && saved.notes) || "" });
      saved = { vendor_key: key, display_name: display, return_days: n, notes: (saved && saved.notes) || "" };
      upsertLocal(saved);
      state.textContent = "✓ Saved"; remove.hidden = false;
    } catch (e) { state.textContent = ""; save.disabled = false; toast(e.message, 4000); }
  });
  remove.addEventListener("click", async () => {
    if (!confirm(`Remove ${label}'s return window? Its receipts stop getting reminders.`)) return;
    remove.disabled = true;
    try {
      await door("receipt_vendor_set", { p_key: key, p_days: null });
      saved = null; upsertLocal(null);
      days.value = ""; none.checked = false; days.disabled = false;
      state.textContent = "Removed"; remove.hidden = true; save.disabled = true;
    } catch (e) { toast(e.message, 4000); }
    finally { remove.disabled = false; }
  });
  return h("div", { class: "rl-vrow" },
    h("div", { class: "rl-vrow__name" }, h("strong", {}, label), h("div", { class: "muted rl-small" }, sub), state),
    days, h("span", { class: "rl-small" }, "days"),
    h("label", { class: "rl-check" }, none, "No returns"),
    save, remove);
}
