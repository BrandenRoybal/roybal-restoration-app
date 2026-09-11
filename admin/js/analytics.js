/* ============================================================
   Office Admin — 📊 Analytics (docs/CRM_Design.md §14.1)
   ------------------------------------------------------------
   Read-only rollup of numbers the app already captures: conversion
   by channel, lost reasons, speed to lead, and estimate accuracy
   (board estimatedHours vs QB Time actuals; estValue vs
   contractValue). One time-range filter scopes every card; every
   chart has a table twin so no value hides behind a hover.

   Charts are hand-rolled SVG, dependency-free (house rule).
   Palette validated (dataviz six-checks, 2026-09-01): bars #1c5fb0;
   diverging over #c0392b / under #0d9488; text never wears the
   series color. Marks: bars ≤24px, 4px rounded data-end (square at
   the baseline), hairline solid grid.

   NOT here on purpose: job-cost accounting — QBO already does that
   for QBO projects (§14.3 will pull QBO's own P&L into this tab).
   ============================================================ */
import { h, clear } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest } from "../../js/supa.js";
import { fmtTouch } from "./leads.js";

const C = {
  bar: "#1c5fb0",           // single-series magnitude
  over: "#c0392b",          // diverging: actual ran OVER the estimate
  under: "#0d9488",         // diverging: actual came in under
  grid: "#e7ebf1",          // hairline, one step off the card surface
  mid: "#98a2b0",           // diverging midpoint rule
};
const CHANNEL_LABEL = { "web-form": "Web form", "ai-chat": "AI chat", phone: "Phone",
  referral: "Referral", repeat: "Repeat", "walk-in": "Walk-in", "": "(untagged)" };
const channelOf = (d) => d.channel || (d.source === "web" ? "web-form" : "");
const LOST_LABEL = { price: "Price", "went-with-other": "Went with another contractor",
  "no-response": "No response", "not-a-fit": "Not a fit", other: "Other" };

const pct = (x) => Math.round(x * 100) + "%";
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* one range filter above everything (the dataviz filter-row rule) */
const RANGES = [["all", "All time"], ["365", "12 months"], ["90", "90 days"], ["30", "30 days"]];
let range = "all";           // module-level: survives the sync repaint

/* ---------- data ---------- */
async function fetchJobs() {
  const res = await rest("coordination_jobs?deleted=eq.false&select=id,data&limit=500", { method: "GET" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()).map((r) => ({ id: r.id, ...(r.data || {}) })).filter((d) => !d.isMilestone);
}
async function fetchHoursByJob() {
  // PostgREST pages at 1000 rows — walk pages (the qb-time lesson)
  const byJob = {};
  for (let off = 0; off < 5000; off += 1000) {
    const res = await rest(`time_entries?deleted=eq.false&select=data&limit=1000&offset=${off}`, { method: "GET" });
    if (!res.ok) throw new Error(String(res.status));
    const rows = await res.json();
    for (const r of rows) {
      const e = r.data || {};
      if (e.jobId) byJob[e.jobId] = (byJob[e.jobId] || 0) + (Number(e.hours) || 0);
    }
    if (rows.length < 1000) break;
  }
  return byJob;
}
const inRange = (iso) => {
  if (range === "all" || !iso) return range === "all" ? true : false;
  return Date.now() - Date.parse(iso) <= Number(range) * 86400000;
};

/* ---------- SVG helpers ---------- */
const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids) el.append(kid);
  return el;
}
/* bar with a 4px rounded DATA end and a square baseline end */
function barPath(x, y, w, ht, roundRight) {
  const r = Math.min(4, w, ht / 2);
  return roundRight
    ? `M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${ht - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z`
    : `M${x + w},${y} v${ht} h-${w - r} a${r},${r} 0 0 1 -${r},-${r} v-${ht - 2 * r} a${r},${r} 0 0 1 ${r},-${r} z`;
}

/* horizontal single-hue bar list: rows = { label, value, display, title } */
function hBars(rows, { unit = "" } = {}) {
  const LBL = 150, VAL = 130, ROW = 30, BAR = 16, W = 640;   // VAL fits "100% (12/12)" — labels never clip
  const trackW = W - LBL - VAL;
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  const svg = s("svg", { viewBox: `0 0 ${W} ${rows.length * ROW}`, width: "100%", role: "img", style: "display:block" });
  rows.forEach((r, i) => {
    const y = i * ROW, w = Math.max(2, (r.value / max) * trackW);
    const g = s("g", {});
    g.append(
      s("title", {}, r.title || `${r.label}: ${r.display}`),
      s("rect", { x: 0, y, width: W, height: ROW, fill: "transparent" }),         // generous hover target
      s("text", { x: LBL - 10, y: y + ROW / 2 + 4, "text-anchor": "end", "font-size": 12.5, fill: "var(--muted, #5f6b7a)" }, r.label),
      s("line", { x1: LBL, y1: y + ROW / 2, x2: LBL + trackW, y2: y + ROW / 2, stroke: C.grid, "stroke-width": 1 }),
      s("path", { d: barPath(LBL, y + (ROW - BAR) / 2, w, BAR, true), fill: C.bar }),
      s("text", { x: LBL + w + 8, y: y + ROW / 2 + 4, "font-size": 12.5, "font-weight": 600, fill: "var(--navy, #16395a)" }, r.display + unit));
    svg.append(g);
  });
  return svg;
}

/* diverging bars around a neutral midpoint: rows = { label, valuePct (+over/−under), display, title } */
function divergingBars(rows) {
  const LBL = 170, ROW = 30, BAR = 16, W = 640, PAD = 64;   // labels are short ("+30%") — detail lives in tooltip + table
  const half = (W - LBL - 2 * PAD) / 2, mid = LBL + PAD + half;
  const max = Math.max(...rows.map((r) => Math.abs(r.valuePct)), 10);
  const svg = s("svg", { viewBox: `0 0 ${W} ${rows.length * ROW + 18}`, width: "100%", role: "img", style: "display:block" });
  svg.append(s("line", { x1: mid, y1: 0, x2: mid, y2: rows.length * ROW, stroke: C.mid, "stroke-width": 1 }));
  rows.forEach((r, i) => {
    const y = i * ROW, over = r.valuePct >= 0;
    const w = Math.max(2, (Math.abs(r.valuePct) / max) * half);
    const g = s("g", {});
    g.append(
      s("title", {}, r.title || `${r.label}: ${r.display}`),
      s("rect", { x: 0, y, width: W, height: ROW, fill: "transparent" }),
      s("text", { x: LBL - 10, y: y + ROW / 2 + 4, "text-anchor": "end", "font-size": 12.5, fill: "var(--muted, #5f6b7a)" }, r.label),
      over
        ? s("path", { d: barPath(mid, y + (ROW - BAR) / 2, w, BAR, true), fill: C.over })
        : s("path", { d: barPath(mid - w, y + (ROW - BAR) / 2, w, BAR, false), fill: C.under }),
      s("text", { x: over ? mid + w + 8 : mid - w - 8, y: y + ROW / 2 + 4,
        "text-anchor": over ? "start" : "end", "font-size": 12.5, "font-weight": 600,
        fill: "var(--navy, #16395a)" }, r.display));
    svg.append(g);
  });
  svg.append(s("text", { x: mid, y: rows.length * ROW + 14, "text-anchor": "middle", "font-size": 11, fill: "var(--muted, #5f6b7a)" }, "on estimate"));
  return svg;
}

/* two semantic series → a legend is required (the ≥2-series rule) */
const divergingLegend = () => h("div", { class: "alegend" },
  h("span", {}, h("i", { style: `background:${C.over}` }), " ran over the estimate"),
  h("span", {}, h("i", { style: `background:${C.under}` }), " came in under"));

/* ---------- card scaffolding: chart + table twin ---------- */
function chartCard(title, subtitle, chartNode, tableRows, tableHead) {
  const card = h("div", { class: "card acard" });
  const chartHost = h("div", {}, chartNode);
  const tableHost = h("div", { hidden: true });
  const tbl = h("table", { class: "minitable" },
    h("thead", {}, h("tr", {}, ...tableHead.map((c) => h("th", {}, c)))),
    h("tbody", {}, ...tableRows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, String(c)))))));
  tableHost.append(tbl);
  const toggle = h("a", { href: "#", class: "atoggle" }, "table");
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    const showTable = tableHost.hidden;
    tableHost.hidden = !showTable; chartHost.hidden = showTable;
    toggle.textContent = showTable ? "chart" : "table";
  });
  card.append(
    h("div", { style: "display:flex;align-items:baseline;gap:10px" },
      h("div", { style: "font-weight:700" }, title), h("span", { style: "flex:1" }), toggle),
    subtitle ? h("p", { class: "muted", style: "font-size:12.5px;margin:2px 0 10px" }, subtitle) : null,
    chartHost, tableHost);
  return card;
}
const emptyCard = (title, msg) => h("div", { class: "card acard" },
  h("div", { style: "font-weight:700" }, title),
  h("p", { class: "muted", style: "font-size:13px" }, msg));

/* ---------- the tab ---------- */
export function analyticsTab() {
  const box = h("div");
  const toolbar = h("div", { class: "atoolbar" }, h("h1", {}, "Analytics"));
  box.append(toolbar);
  if (!SYNC_ENABLED) { box.append(h("p", { class: "muted" }, "Analytics needs the cloud connection.")); return box; }

  const rangeSel = h("select", {}, ...RANGES.map(([v, l]) => h("option", { value: v, selected: range === v }, l)));
  toolbar.append(h("div", { class: "muted", style: "font-size:13px;display:flex;align-items:center;gap:8px" }, "Range", rangeSel));
  const host = h("div");
  box.append(host);
  host.append(h("p", { class: "muted" }, "Crunching the numbers…"));

  let jobs = null, hoursByJob = null;
  async function paint() {
    try {
      if (!jobs) [jobs, hoursByJob] = await Promise.all([fetchJobs(), fetchHoursByJob()]);
    } catch (_) {
      clear(host).append(h("div", { class: "card" },
        h("p", { class: "muted" }, "Couldn't load the numbers — check your connection and try again.")));
      return;
    }
    const scoped = jobs.filter((d) => range === "all" || inRange(d.createdAt));

    /* conversion (explicit outcomes only — the board Pipeline rule) */
    const won = scoped.filter((d) => d.outcome === "won");
    const lost = scoped.filter((d) => d.outcome === "lost");
    const byChan = {};
    for (const d of scoped) {
      const ch = channelOf(d);
      const g = (byChan[ch] = byChan[ch] || { leads: 0, won: 0, lost: 0 });
      if (d.outcome === "won") { g.leads++; g.won++; }
      else if (d.outcome === "lost") { g.leads++; g.lost++; }
      else if ((d.stage || "lead") === "lead" && !d.archived) g.leads++;   // open lead
    }

    /* speed to lead */
    const touchByChan = {};
    for (const d of scoped) {
      const ms = Date.parse(d.firstTouchAt || "") - Date.parse(d.createdAt || "");
      if (Number.isFinite(ms) && ms >= 0) (touchByChan[channelOf(d)] = touchByChan[channelOf(d)] || []).push(ms);
    }
    const allTouch = Object.values(touchByChan).flat();

    /* estimate accuracy — completed jobs with both sides of the story */
    const done = scoped.filter((d) =>
      ((d.stage === "done") || (d.archived && d.outcome !== "lost"))
      && Number(d.estimatedHours) > 0 && (hoursByJob[d.id] || 0) > 0);
    const hourRows = done.map((d) => {
      const est = Number(d.estimatedHours), act = hoursByJob[d.id];
      return { d, est, act, ratio: act / est };
    }).sort((a, b) => b.ratio - a.ratio);
    const bidRows = scoped.filter((d) => d.outcome === "won" && Number(d.estValue) > 0 && Number(d.contractValue) > 0)
      .map((d) => ({ d, est: Number(d.estValue), act: Number(d.contractValue), ratio: Number(d.contractValue) / Number(d.estValue) }))
      .sort((a, b) => b.ratio - a.ratio);
    const hourFactor = median(hourRows.map((r) => r.ratio));
    const bidFactor = median(bidRows.map((r) => r.ratio));

    clear(host);

    /* headline tiles (§14.1.1) */
    const winRate = won.length + lost.length ? won.length / (won.length + lost.length) : null;
    host.append(h("div", { class: "kpis" },
      tile(winRate == null ? "—" : pct(winRate), `Win rate (${won.length}/${won.length + lost.length})`),
      tile(hourFactor == null ? "—" : "×" + hourFactor.toFixed(2), `Hours: actual ÷ estimate (n=${hourRows.length})`),
      tile(bidFactor == null ? "—" : "×" + bidFactor.toFixed(2), `Dollars: contract ÷ bid (n=${bidRows.length})`),
      tile(allTouch.length ? fmtTouch(allTouch.reduce((a, b) => a + b, 0) / allTouch.length) : "—", "Avg first touch")));

    /* conversion by channel */
    const chanRows = Object.entries(byChan).filter(([, g]) => g.leads > 0)
      .map(([ch, g]) => ({ ch, ...g, rate: g.won + g.lost ? g.won / (g.won + g.lost) : null }))
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    host.append(chanRows.length
      ? chartCard("Conversion by channel", "Win rate over decided leads (won ÷ won+lost); open leads don't count yet.",
          hBars(chanRows.map((r) => ({
            label: CHANNEL_LABEL[r.ch] ?? r.ch, value: r.rate ?? 0,
            display: r.rate == null ? "no outcomes" : `${pct(r.rate)} (${r.won}/${r.won + r.lost})`,
          }))),
          chanRows.map((r) => [CHANNEL_LABEL[r.ch] ?? r.ch, r.leads, r.won, r.lost, r.rate == null ? "—" : pct(r.rate)]),
          ["Channel", "Leads", "Won", "Lost", "Win rate"])
      : emptyCard("Conversion by channel", "No leads in this range yet."));

    /* why we lose */
    const byReason = {};
    for (const d of lost) byReason[d.lostReason || "other"] = (byReason[d.lostReason || "other"] || 0) + 1;
    const reasonRows = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
    host.append(reasonRows.length
      ? chartCard("Why we lose", "Reasons recorded when a lead is marked lost.",
          hBars(reasonRows.map(([id, n]) => ({ label: LOST_LABEL[id] ?? id, value: n, display: String(n) }))),
          reasonRows.map(([id, n]) => [LOST_LABEL[id] ?? id, n]),
          ["Reason", "Lost leads"])
      : emptyCard("Why we lose", "No lost leads in this range — either great news or nobody's marking them."));

    /* speed to lead */
    const speedRows = Object.entries(touchByChan)
      .map(([ch, xs]) => ({ ch, avg: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length }))
      .sort((a, b) => a.avg - b.avg);
    host.append(speedRows.length
      ? chartCard("Speed to lead", "Average time from a lead landing to the first action on it, by channel.",
          hBars(speedRows.map((r) => ({
            label: CHANNEL_LABEL[r.ch] ?? r.ch, value: r.avg, display: `${fmtTouch(r.avg)} (n=${r.n})`,
          }))),
          speedRows.map((r) => [CHANNEL_LABEL[r.ch] ?? r.ch, fmtTouch(r.avg), r.n]),
          ["Channel", "Avg first touch", "Leads"])
      : emptyCard("Speed to lead", "First-touch stamps start with the Leads Inbox — this fills in as leads get worked."));

    /* est vs actual hours */
    if (hourRows.length) {
      const card = chartCard("Estimate vs actual — completed jobs",
        "Hours over or under the estimate. Board estimated hours vs QuickBooks Time actuals.",
        divergingBars(hourRows.slice(0, 12).map((r) => ({
          label: r.d.title || r.d.customer || "job",
          valuePct: Math.max(-100, Math.min(100, (r.ratio - 1) * 100)),
          display: `${r.ratio >= 1 ? "+" : "−"}${Math.abs(Math.round((r.ratio - 1) * 100))}%`,
          title: `${r.d.title || r.d.customer || "job"}: ${Math.round(r.act)}h actual vs ${r.est}h estimated`,
        }))),
        hourRows.map((r) => [r.d.title || r.d.customer || "job", r.est + "h", Math.round(r.act * 10) / 10 + "h", (r.ratio >= 1 ? "+" : "−") + Math.abs(Math.round((r.ratio - 1) * 100)) + "%"]),
        ["Job", "Estimated", "Actual", "Variance"]);
      card.insertBefore(divergingLegend(), card.children[2]);
      host.append(card);
    } else {
      host.append(emptyCard("Estimate vs actual — completed jobs",
        "Lights up when a completed job has both estimated hours (board editor) and logged hours (QuickBooks Time)."));
    }

    /* bid vs contract */
    if (bidRows.length) {
      const card = chartCard("Bid vs contract — won jobs",
        "How the signed number compared to the bid.",
        divergingBars(bidRows.slice(0, 12).map((r) => ({
          label: r.d.title || r.d.customer || "job",
          valuePct: Math.max(-100, Math.min(100, (r.ratio - 1) * 100)),
          display: `${r.ratio >= 1 ? "+" : "−"}${Math.abs(Math.round((r.ratio - 1) * 100))}%`,
          title: `${r.d.title || r.d.customer || "job"}: ${money(r.act)} contract vs ${money(r.est)} bid`,
        }))),
        bidRows.map((r) => [r.d.title || r.d.customer || "job", money(r.est), money(r.act), (r.ratio >= 1 ? "+" : "−") + Math.abs(Math.round((r.ratio - 1) * 100)) + "%"]),
        ["Job", "Bid", "Contract", "Variance"]);
      card.insertBefore(divergingLegend(), card.children[2]);
      host.append(card);
    } else {
      host.append(emptyCard("Bid vs contract — won jobs",
        "Lights up when won jobs carry both an estimated value and a contract value."));
    }

    host.append(h("p", { class: "muted", style: "font-size:12px;margin-top:12px" },
      "The ×factors up top are the calibration numbers the estimating engine will read (doc §14.2) — suggestions only, and only once there's enough completed work to trust them. Job-cost profitability stays in QuickBooks; §14.3 brings QBO's own project P&L into this tab."));
  }

  rangeSel.addEventListener("change", () => { range = rangeSel.value; paint(); });
  paint();
  return box;
}
const tile = (v, label) => h("div", { class: "kpi" },
  h("div", { class: "kpi__n", style: "font-variant-numeric:normal" }, v),
  h("div", { class: "kpi__l" }, label));
