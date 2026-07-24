/* ============================================================
   Roybal Field Forms — Tech identity (Step E: captured_by)
   ------------------------------------------------------------
   Who's using this device, under the shared crew login. The chosen
   name rides along as capture_events.captured_by / ai_usage.captured_by
   so you get per-tech attribution and AI usage without per-tech auth.

   - Device-stored (localStorage). Set once, changeable anytime via the
     header chip; also gated at first voice capture.
   - The roster is pulled from the Board's existing crew list
     (crew_members), shared via the same login. Offline / no roster ->
     free-text entry still works (offline-first).
   ============================================================ */
import { h, toast } from "./core.js";
import { rest, isSignedIn, currentEmail } from "./supa.js";

const TECH_KEY = "roybal-tech"; // stores JSON { id, name } (tolerates a legacy plain name string)

/* ---------- pure helpers (unit-tested) ---------- */

/* Parse the stored identity. Accepts the JSON shape or a legacy plain name. */
export function parseTech(raw) {
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  if (obj && typeof obj === "object") {
    const name = String(obj.name || "").trim();
    return name ? { id: obj.id || null, name } : null;
  }
  const name = String(raw).trim();      // legacy: the value was just a name
  return name ? { id: null, name } : null;
}

/* captured_by precedence: chosen tech name, else the signed-in email, else null. */
export function resolveCapturedBy(name, email) {
  const n = (name || "").trim();
  if (n) return n;
  const e = (email || "").trim();
  return e || null;
}

/* Map crew_members rows -> a sorted, active-only roster of { id, name, color }.
   Mirrors the Board's activeCrew(): each row's `data` IS the crew object. */
export function rosterFromRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => (r && r.data ? r.data : r))
    .filter((c) => c && String(c.name || "").trim() && c.active !== false)
    .map((c) => ({ id: c.id || null, name: String(c.name).trim(), color: c.color || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- device identity ---------- */
export function getTech() {
  try { return parseTech(localStorage.getItem(TECH_KEY)); } catch { return null; }
}
export function setTech(tech) {
  try { localStorage.setItem(TECH_KEY, JSON.stringify({ id: tech.id || null, name: tech.name })); } catch {}
  // let the header chip (or anything else) refresh, wherever the tech was set
  try { window.dispatchEvent(new CustomEvent("roybal-tech-changed")); } catch {}
}
export function clearTech() {
  try { localStorage.removeItem(TECH_KEY); } catch {}
}
export function techName() { const t = getTech(); return t ? t.name : ""; }
export function hasTech() { return !!techName(); }

/* What the Edge Function records as captured_by. */
export function capturedBy() { return resolveCapturedBy(techName(), currentEmail()); }

/* ---------- roster (from the Board's crew list) ---------- */
export async function fetchRoster() {
  if (!isSignedIn()) return [];   // anon can't read crew_members (RLS: authenticated)
  try {
    const res = await rest("crew_members?select=data&deleted=is.false", { method: "GET" });
    if (!res.ok) return [];
    return rosterFromRows(await res.json());
  } catch { return []; }
}

/* ---------- picker (shared modal: header chip + first-capture gate) ----------
   Resolves to the chosen { id, name } (also persisted) or null if cancelled.
   Idempotent: if a picker is already open (e.g. a rapid double-tap), the extra
   call resolves to null instead of stacking a second overlay. */
let pickerOpen = false;
export function pickTech() {
  if (pickerOpen) return Promise.resolve(null);
  pickerOpen = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; pickerOpen = false; overlay.remove(); resolve(val); };
    const choose = (tech) => { setTech(tech); toast("Capturing as " + tech.name); finish(tech); };

    const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const rosterBox = h("div", { style: "max-height:42vh;overflow:auto;margin:6px 0 12px" },
      h("div", { class: "subtle", style: "padding:8px 2px" }, "Loading crew…"));

    const nameInput = h("input", {
      type: "text", placeholder: "Or type a name",
      style: "flex:1;min-width:120px;padding:9px 10px;border:1px solid #cdd5df;border-radius:8px",
    });
    const useTyped = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Use name");
    useTyped.addEventListener("click", () => {
      const n = nameInput.value.trim();
      if (!n) return toast("Type a name first.");
      choose({ id: null, name: n });
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") useTyped.click(); });

    const cancel = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Cancel");
    cancel.addEventListener("click", () => finish(null));

    const card = h("div", {
      style: "background:#fff;border-radius:16px;padding:18px;max-width:420px;width:92%;box-shadow:0 16px 50px rgba(0,0,0,.3)",
    },
      h("div", { style: "font-weight:800;font-size:18px;color:var(--navy,#0f1b2d);margin-bottom:2px" }, "Who's capturing?"),
      h("div", { class: "subtle", style: "font-size:13px;margin-bottom:8px" }, "Tags your photos, logs & voice captures to you."),
      rosterBox,
      h("div", { style: "display:flex;gap:8px;align-items:center" }, nameInput, useTyped),
      h("div", { style: "display:flex;justify-content:flex-end;margin-top:14px" }, cancel));

    const overlay = h("div", {
      style: "position:fixed;inset:0;background:rgba(15,27,45,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px",
      onclick: (e) => { if (e.target === overlay) finish(null); },
    }, card);
    document.body.appendChild(overlay);

    fetchRoster().then((roster) => {
      if (done) return;
      rosterBox.replaceChildren();
      if (!roster.length) {
        rosterBox.append(h("div", { class: "subtle", style: "padding:8px 2px;font-size:13px" },
          isSignedIn() ? "No crew list found — type your name below." : "Offline — type your name below."));
        return;
      }
      const me = techName();
      roster.forEach((c) => {
        const dot = h("span", {
          style: "width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;" +
            "font-size:11px;font-weight:700;color:#fff;background:" + (c.color || "#7a8aa0"),
        }, initials(c.name));
        const btn = h("button", {
          type: "button",
          style: "display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 10px;margin:3px 0;" +
            "border:1px solid " + (c.name === me ? "var(--orange,#f26a21)" : "#e2e6ec") + ";border-radius:10px;background:#fff;cursor:pointer",
        }, dot, h("span", { style: "font-weight:600;color:var(--navy,#0f1b2d)" }, c.name),
          c.name === me ? h("span", { class: "subtle", style: "margin-left:auto;font-size:12px" }, "current") : null);
        btn.addEventListener("click", () => choose(c));
        rosterBox.append(btn);
      });
    });
  });
}
