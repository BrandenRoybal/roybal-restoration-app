/* ============================================================
   Roybal Field Forms — Leads / Bids
   ------------------------------------------------------------
   The step between a lead on the Job Board and the estimate engine
   (docs/Lead_Bid_Workflow_Design.md). A lead tile stays board-only until
   a person chooses to bid it; then it gets an ordinary job file
   (boardpush.js adoptTile / startBid) that carries the Site Visit packet
   and the Estimate, and that file simply BECOMES the job when the lead
   is won. This module is:

     1. the pure state readers (Node-tested, test/bid.test.mjs);
     2. the ghost rows on the jobs list — open lead tiles with no file,
        each with one button, 📐 Start bid;
     3. the Bid card on the job home — Site visit · Packet · Estimate ·
        Sent, one line each, while the linked tile is still a lead;
     4. the three writes the field makes onto a lead tile, all through
        coordination_job_patch (the rev-bumping shallow merge the office
        Leads Inbox already rides): site-visit done, and — PR 3 — the
        estimate total and "estimate sent".

   Ownership rule (docs §2.5): field owns the packet, the estimate and its
   total; board/admin own stage, outcome, follow-ups and dates.
   ============================================================ */
import { h, Store, toast, fmtDate, uid } from "./core.js";
import { rest, currentEmail } from "./supa.js";
import { tileCandidates, startBid, findBoardRow, isBidLead } from "./boardpush.js";
import { jobType } from "./model.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ---------- pure: which jobs-list tab a tile belongs on ----------
   Mirrors fieldSeedFromBoardJob: water / fire / mold tiles are restoration
   files; everything else (remodel, new build, rebuild, other, untyped) is
   construction. */
export const tileMode = (d) =>
  (d && (d.type === "water" || d.type === "fire" || d.type === "mold")) ? "restoration" : "construction";

/* an open lead: lead stage, no outcome, not filed away, not a calendar marker */
export const isOpenLeadTile = (d) =>
  !!d && !d.isMilestone && (d.stage || "lead") === "lead" && !d.outcome && !d.archived;

/* ---------- pure: the ghost rows ----------
   Open lead tiles with no job file, for this tab, newest first. An ACTIVE
   lookalike job file (same claim # or customer) means the office links it
   from that side — the row still shows, but startBid refuses it (`blocked`).
   Archived lookalikes don't count: a repeat customer is a new bid. */
export function unlinkedLeadTiles(rows, projects, mode) {
  const live = arr(projects).filter((p) => p && !p.archivedAt);
  return arr(rows)
    .filter((r) => r && r.data && isOpenLeadTile(r.data) && !r.data.fieldJobId && tileMode(r.data) === mode)
    .map((r) => ({ row: r, blocked: tileCandidates(r.data, live).length > 0 }))
    .sort((a, b) => String(b.row.data.createdAt || "").localeCompare(String(a.row.data.createdAt || "")));
}

/* ---------- pure: estimate total, the way the estimate editor prints it ----------
   forms.js recalc(): line items → design contingency (construction
   estimates, or any estimate carrying a %) → O&P on that base → tax on the
   base → less deductible / previous payments. Contract billing: the agreed
   figure IS the total. Kept here so the Bid card and the tile's estValue
   never disagree with the printed sheet. */
export function estimateTotal(inv, isBuild = false) {
  if (!inv) return 0;
  const subtotal = arr(inv.items).reduce((t, it) => t + num(it && it.qty) * num(it && it.price), 0);
  const contract = inv.billingModel === "contract";
  const amt = (inv.opMode || "pct") === "amount";
  const contPct = num(inv.contingencyPct);
  const cont = contract || !(isBuild || contPct > 0) ? 0 : subtotal * (contPct / 100);
  const opBase = subtotal + cont;
  const base = contract ? num(inv.contractAmount) : opBase;
  const oh = contract ? 0 : (amt ? num(inv.overheadAmount) : opBase * (num(inv.overheadPct) / 100));
  const pf = contract ? 0 : (amt ? num(inv.profitAmount) : opBase * (num(inv.profitPct) / 100));
  const rcv = base + oh + pf;
  const tax = base * (num(inv.taxRate) / 100);
  return Math.round((rcv - num(inv.deductible) - num(inv.previousPayments) + tax) * 100) / 100;
}

/* ---------- pure: read the bid's state off the file + the tile ---------- */
export function bidState(project, d) {
  const p = project || {};
  const t = d || {};
  const sv = (p.siteVisit && typeof p.siteVisit === "object") ? p.siteVisit : {};
  const tsv = (t.siteVisit && typeof t.siteVisit === "object") ? t.siteVisit : {};
  const ests = arr(p.reconEstimates);
  const latest = ests.length ? ests[ests.length - 1] : null;
  const isBuild = jobType(p) === "construction";
  const doneAt = tsv.doneAt || sv.doneAt || "";
  return {
    visit: {
      at: tsv.at || "",
      by: tsv.by || "",
      status: doneAt ? "done" : (tsv.status || (tsv.at ? "scheduled" : "")),
      doneAt,
    },
    packet: {
      files: arr(sv.files).length,
      transcript: !!String(sv.transcript || "").trim(),
      scope: !!String(sv.typedScope || "").trim(),
    },
    estimate: latest ? {
      id: latest.id || "",
      no: String(latest.invoiceNo || ""),
      lines: arr(latest.items).length,
      total: estimateTotal(latest, isBuild),
      count: ests.length,
    } : null,
    sent: { at: (latest && latest.sentAt) || t.estimateSentAt || "" },
    lead: {
      message: String(sv.leadMessage || t.message || ""),
      channel: String(sv.leadChannel || t.channel || (t.source === "web" ? "web-form" : "") || ""),
      stage: t.stage || "lead",
      outcome: t.outcome || "",
      lost: t.outcome === "lost",
    },
  };
}

/* ---------- pure: dates and money for chips ---------- */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/* "2026-09-26T14:00" | "2026-09-26" → "Thu 9/26 2:00 PM" | "Thu 9/26".
   Parsed by hand from the local-ISO string so a phone in another zone (or
   Node in UTC) prints the appointment the office typed, not a shifted one. */
export function fmtVisitAt(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(at || ""));
  if (!m) return "";
  const [, y, mo, da, hh, mm] = m;
  const dow = DAYS[new Date(Number(y), Number(mo) - 1, Number(da)).getDay()];
  let s = `${dow} ${Number(mo)}/${Number(da)}`;
  if (hh != null) {
    const H = Number(hh);
    s += ` ${((H + 11) % 12) + 1}:${mm} ${H < 12 ? "AM" : "PM"}`;
  }
  return s;
}
/* "branden@roybalconstruction.com" → "Branden"; a plain name passes through */
export const whoLabel = (by) => {
  const s = String(by || "").trim();
  if (!s) return "";
  const local = s.includes("@") ? s.split("@")[0] : s;
  return local.charAt(0).toUpperCase() + local.slice(1);
};
export const shortMoney = (n) => "$" + Math.round(num(n)).toLocaleString("en-US");
const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${Number(m[2])}/${Number(m[3])}` : "";
};

/* one chip's worth of progress for the jobs-list row: the furthest step */
export function bidChip(state) {
  const s = state || {};
  if (s.lead && s.lead.lost) return "✕ lost";
  if (s.sent && s.sent.at) return `📄 ${shortMoney(s.estimate ? s.estimate.total : 0)} sent ${shortDate(s.sent.at)}`;
  if (s.estimate && s.estimate.lines) return `📄 est. ${shortMoney(s.estimate.total)}`;
  if (s.visit && s.visit.doneAt) return `🔍 inspected ${shortDate(s.visit.doneAt)}`;
  if (s.visit && s.visit.at) return `📅 visit ${fmtVisitAt(s.visit.at)}`;
  return "📐 bid started";
}

/* ---------- pure: bid files whose lead died ----------
   A file linked to a tile marked LOST leaves the phones the same week —
   archivedAt only, nothing deleted, ↩ Unarchive still there. */
export function lostBidFiles(rows, projects) {
  const byId = new Map(arr(rows).filter((r) => r && r.data).map((r) => [r.id, r.data]));
  const byLink = new Map(arr(rows).filter((r) => r && r.data && r.data.fieldJobId).map((r) => [r.data.fieldJobId, r.data]));
  return arr(projects).filter((p) => {
    if (!p || p.archivedAt) return false;
    const d = (p.bidOf && byId.get(p.bidOf)) || byLink.get(p.id) || null;
    return !!d && d.outcome === "lost" && (d.stage || "lead") === "lead";
  });
}

/* ---------- pure: the site-visit-done patch for coordination_job_patch ----------
   Shallow merge means the whole siteVisit object and the whole leadLog
   array are sent back. The follow-up is cleared only when it WAS the visit
   ("Site visit", "inspection", "walk-through") — an unrelated next action
   the office typed is left alone. First touch stamps once, like every
   triage action in the inbox. */
export function siteVisitDonePatch(d, at, by, entryId) {
  const t = d || {};
  const day = String(at || "").slice(0, 10);
  const prev = (t.siteVisit && typeof t.siteVisit === "object") ? t.siteVisit : {};
  const patch = {
    siteVisit: { ...prev, status: "done", doneAt: day },
    leadLog: [...arr(t.leadLog), {
      id: entryId || uid(), at: day, kind: "inspected",
      note: "Site visit done" + (by ? " — " + whoLabel(by) : "") + " (Field Forms)",
      action: String(t.nextAction || ""),
    }],
  };
  if (!t.firstTouchAt) patch.firstTouchAt = at;
  if (/site\s*visit|inspect|walk/i.test(String(t.nextAction || ""))) { patch.nextAction = ""; patch.nextActionAt = ""; }
  return patch;
}

/* ============================================================
   Network — browser only, every call fail-safe for the UI
   ============================================================ */

/* the guarded write path (migrations 230 + 246): owner/office JWTs pass; a
   crew JWT gets the RPC's null no-op, which the caller turns into a toast */
export async function patchLeadTile(id, patch) {
  const res = await rest("rpc/coordination_job_patch", {
    method: "POST", body: JSON.stringify({ p_id: id, p_patch: patch }),
  });
  if (!res.ok) throw new Error("board save failed (" + res.status + ")");
  return await res.json();   // the merged blob, rev bumped — or null when refused
}

/** ✓ Site visit done. The file's own stamp lands first (offline-safe); the
    tile's leadLog / siteVisit / firstTouchAt follow through the RPC. */
export async function markSiteVisitDone(project) {
  const at = new Date().toISOString();
  if (!project.siteVisit || typeof project.siteVisit !== "object") {
    project.siteVisit = { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
  }
  project.siteVisit.doneAt = at.slice(0, 10);
  await Store.put(project);
  let row = null;
  try { row = await findBoardRow(project); } catch (_) { row = null; }
  if (!row || !row.data) return { board: false, reason: "offline" };
  try {
    const merged = await patchLeadTile(row.id, siteVisitDonePatch(row.data, at, currentEmail()));
    return { board: !!merged, reason: merged ? "" : "refused" };
  } catch (e) {
    return { board: false, reason: String((e && e.message) || e) };
  }
}

/** Archive the bid files whose leads were marked lost. Returns how many. */
export async function archiveLostBidFiles(rows, projects) {
  let n = 0;
  for (const p of lostBidFiles(rows, projects)) {
    p.archivedAt = new Date().toISOString();
    await Store.put(p);
    n++;
  }
  return n;
}

/* ============================================================
   UI
   ============================================================ */
const CHANNEL_LABEL = {
  "web-form": "Web form", "ai-chat": "AI chat", phone: "Phone",
  referral: "Referral", repeat: "Repeat", "walk-in": "Walk-in",
};
const channelLabel = (id) => CHANNEL_LABEL[id] || (id ? String(id) : "");
const chip = (text, tone) => h("span", {
  style: "font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;" +
    (tone === "bad" ? "background:#fdecea;color:#b3261e"
      : tone === "warn" ? "background:#fff4e5;color:#8a6d00"
      : tone === "good" ? "background:#e6f4ea;color:#1e6b3a"
      : "background:#e7eef7;color:#1e4a72"),
}, text);
const ageLabel = (iso) => {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const dDays = Math.floor(ms / 86400000);
  if (dDays < 1) return "today";
  return dDays === 1 ? "1d old" : `${dDays}d old`;
};

/** The ghost rows: open lead tiles with no file, dimmed, one button each.
    Returns null when there is nothing to show — the caller appends nothing.
    Board-owned data painted read-only; nothing here syncs anywhere. */
export function ghostLeadRows(rows, projects, mode, { onStarted } = {}) {
  const leads = unlinkedLeadTiles(rows, projects, mode);
  if (!leads.length) return null;
  const wrap = h("div", { style: "margin-top:16px" });
  wrap.append(h("div", { style: "display:flex;align-items:center;gap:7px;margin:0 2px 8px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)" },
    h("span", { style: "width:9px;height:9px;border-radius:50%;flex:none;background:#7a8aa0" }),
    `Leads on the board — not started (${leads.length})`));
  wrap.append(h("div", { class: "subtle", style: "font-size:12px;margin:0 2px 8px" },
    "Open leads from the web form, the phone line and the office. Nothing is on this device until you start the bid — dead leads never land on the crew's phones."));
  const list = h("div", { class: "joblist" });
  for (const { row, blocked } of leads) {
    const d = row.data;
    const btn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto;flex:none", disabled: blocked || null,
      title: blocked ? "A job file with this customer or claim # already exists — open that job; it links itself" : "Create the bid file: site visit packet + estimate" },
      "📐 Start bid");
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.disabled = true; btn.textContent = "Starting…";
      try {
        const { project, reason } = await startBid(row, projects, currentEmail());
        if (project) {
          toast("Bid file started — the site visit packet and estimate live here now.");
          if (onStarted) onStarted(project);
          return;
        }
        toast(reason === "offline" ? "You're offline — starting a bid writes to the Job Board. Try again with signal."
          : reason === "linked" ? "This lead already has a job file."
          : reason === "lookalike" ? "A job file with this customer or claim # already exists — open that job; it links itself."
          : "This lead's job file was deleted before — the office can restore it from the trash.");
      } catch (err) {
        toast("Couldn't start the bid: " + String((err && err.message) || err));
      }
      btn.disabled = false; btn.textContent = "📐 Start bid";
    });
    const meta = [channelLabel(d.channel || (d.source === "web" ? "web-form" : "")), ageLabel(d.createdAt),
      d.estValue ? "~" + shortMoney(d.estValue) : "",
      d.siteVisit && d.siteVisit.at ? "📅 " + fmtVisitAt(d.siteVisit.at) : ""].filter(Boolean);
    const msg = String(d.message || "").trim();
    list.append(h("div", { class: "card jobrow", style: "opacity:.78;border-style:dashed" },
      h("div", { class: "jobrow__main" },
        h("div", { class: "jobrow__title" }, d.title || d.customer || "Untitled lead"),
        h("div", { class: "jobrow__sub" }, [d.address, meta.join(" · ")].filter(Boolean).join(" · ")),
        msg ? h("div", { class: "subtle", style: "font-size:12px;margin-top:4px;font-style:italic" },
          "“" + (msg.length > 140 ? msg.slice(0, 140).trim() + "…" : msg) + "”") : null),
      btn));
  }
  wrap.append(list);
  return wrap;
}

/** The Bid card for a job home. Paints from the file at once (offline), then
    from the tile when it loads; hides itself once the tile is past the lead
    stage — at that point the file is the job and the normal home is enough. */
export function bidCard(project, { openEstimate, onChanged } = {}) {
  if (!project || !project.bidOf) return null;
  const wrap = h("div", { class: "card app-only", style: "border-left:4px solid #f26a21" });
  const paint = (d) => {
    const s = bidState(project, d);
    wrap.replaceChildren();
    if (d && s.lead.stage !== "lead") { wrap.hidden = true; return; }
    wrap.hidden = false;
    const head = h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" },
      h("div", { style: "font-weight:800;letter-spacing:.3px" }, "📐 BID"),
      s.lead.channel ? chip(channelLabel(s.lead.channel)) : null,
      d && d.createdAt ? chip(ageLabel(d.createdAt)) : null,
      s.lead.lost ? chip("✕ marked lost — this file archives on the next jobs-list open", "bad") : null,
      !d ? chip("board offline — showing this device's copy", "warn") : null);
    wrap.append(head);

    const line = (icon, label, value, btn) => h("div", { style: "display:grid;grid-template-columns:110px 1fr auto;gap:8px;align-items:center;margin-top:8px;font-size:13px" },
      h("div", { style: "font-weight:700" }, icon + " " + label),
      h("div", { class: value ? "" : "subtle" }, value || "—"),
      btn || h("span"));

    // 📅 Site visit
    const visitTxt = s.visit.doneAt ? `done ${fmtDate(s.visit.doneAt)}` + (s.visit.at ? ` (was ${fmtVisitAt(s.visit.at)})` : "")
      : s.visit.at ? fmtVisitAt(s.visit.at) + (s.visit.by ? " · " + whoLabel(s.visit.by) : "")
      : "not scheduled — the office sets it from the Leads Inbox";
    let doneBtn = null;
    if (!s.visit.doneAt) {
      doneBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto", title: "Stamps 🔍 Inspected on the lead and stops its follow-up clock" }, "✓ Site visit done");
      doneBtn.addEventListener("click", async () => {
        doneBtn.disabled = true; doneBtn.textContent = "Saving…";
        const r = await markSiteVisitDone(project);
        toast(r.board ? "Site visit logged on the lead — 🔍 Inspected."
          : r.reason === "offline" ? "Saved on this device. The lead on the board wasn't updated (offline) — log it from the Leads Inbox."
          : r.reason === "refused" ? "Saved on this device. Bid actions on the board are office-only — log it from the Leads Inbox."
          : "Saved on this device. Board update failed: " + r.reason);
        if (onChanged) onChanged(); else load();
      });
    }
    wrap.append(line("📅", "Site visit", visitTxt, doneBtn));

    // 📎 Packet
    const packetTxt = [s.packet.files ? `${s.packet.files} file${s.packet.files === 1 ? "" : "s"}` : "",
      s.packet.transcript ? "transcript ✓" : "", s.packet.scope ? "scope typed ✓" : ""].filter(Boolean).join(" · ");
    const packetBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto", title: "The Site Visit panel lives on the estimate: Magicplan report, photos, note pages, room videos, the walk recording" },
      s.packet.files || s.packet.transcript ? "Open packet" : "Start packet");
    packetBtn.addEventListener("click", () => openEstimate && openEstimate());
    wrap.append(line("📎", "Packet", packetTxt, packetBtn));

    // 📄 Estimate
    const est = s.estimate;
    const estTxt = est ? [est.no, est.lines ? shortMoney(est.total) : "no lines yet", est.lines ? `${est.lines} line${est.lines === 1 ? "" : "s"}` : "",
      est.count > 1 ? `(${est.count} versions)` : ""].filter(Boolean).join(" · ") : "";
    const estBtn = h("button", { class: est ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm", style: "width:auto" }, est ? "Open estimate" : "Draft estimate");
    estBtn.addEventListener("click", () => openEstimate && openEstimate());
    wrap.append(line("📄", "Estimate", estTxt, estBtn));

    // ✉️ Sent — PR 3 adds the send button and the tile write
    wrap.append(line("✉️", "Sent", s.sent.at ? fmtDate(String(s.sent.at).slice(0, 10)) : "", null));

    if (s.lead.message) {
      const m = s.lead.message.trim();
      wrap.append(h("div", { class: "note", style: "margin-top:10px;font-size:12px" },
        h("strong", {}, "Customer asked: "), m.length > 280 ? m.slice(0, 280).trim() + "…" : m));
    }
  };
  let load = async () => {
    let row = null;
    try { row = await findBoardRow(project); } catch (_) { row = null; }
    paint(row && row.data ? row.data : null);
  };
  paint(null);   // instant, offline-true
  load();
  return wrap;
}

/* the tile-side test of "is this a bid" — re-exported so app.js has one import */
export { isBidLead };
