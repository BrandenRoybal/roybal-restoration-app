/* Roybal Customer Portal — read-only status page.
   Reads the share token from the URL (/j/<token>), asks the roybal-portal
   gateway for the curated slice, and renders status + milestones + photos.
   No login: the token in the link is the credential. */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const app = document.getElementById("app");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

function tokenFromUrl() {
  const m = location.pathname.match(/\/j\/([0-9a-f]{16,})/i);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get("t");
  return q && /^[0-9a-f]{16,}$/i.test(q) ? q : "";
}

async function fetchView(token) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-portal`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "view", token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { const e = new Error(body.error || "load_failed"); e.status = res.status; throw e; }
  return body;
}

function message(icon, title, sub) {
  app.replaceChildren(h("div", { class: "msg" },
    h("div", { class: "big" }, icon), h("h2", {}, title), sub ? h("p", {}, sub) : null));
}

function render(data) {
  const job = data.job || {};
  const badge = job.status
    ? h("span", { class: "statusbadge" }, h("span", { class: "dot" }),
        (job.milestones.find((m) => m.key === job.status)?.label) || currentLabel(job.milestones) || "In progress")
    : null;

  const hero = h("div", { class: "card hero" },
    h("h1", {}, job.customerName || "Your project"),
    job.address ? h("p", { class: "addr" }, job.address) : null,
    badge);

  const steps = (job.milestones || []).map((m) =>
    h("li", { class: "step step--" + (m.state || "upcoming") },
      h("div", { class: "step__rail" }, h("div", { class: "step__dot" }, m.state === "done" ? "✓" : m.state === "current" ? "●" : "")),
      h("div", { class: "step__label" }, m.label)));
  const timeline = steps.length
    ? h("div", { class: "card" }, h("p", { class: "sectitle" }, "Progress"), h("ul", { class: "steps" }, ...steps))
    : null;

  const photos = (data.photos || []).map((p) =>
    h("figure", { class: "photo" },
      h("img", { src: p.url, alt: p.caption || "Project photo", loading: "lazy" }),
      (p.caption || p.stage) ? h("figcaption", {}, p.caption || "",
        p.stage ? h("span", { class: "stage" }, (p.caption ? " · " : "") + p.stage) : null) : null));
  const gallery = photos.length
    ? h("div", { class: "card" }, h("p", { class: "sectitle" }, "Photos"), h("div", { class: "gallery" }, ...photos))
    : null;

  const empty = (!timeline && !gallery)
    ? h("div", { class: "msg" }, h("p", {}, "Your project details will appear here soon.")) : null;
  // native replaceChildren stringifies null args ("null"), so drop falsy first
  app.replaceChildren(...[hero, timeline, gallery, empty].filter(Boolean));
}

const currentLabel = (ms) => (ms || []).find((m) => m.state === "current")?.label || "";

(async () => {
  const token = tokenFromUrl();
  if (!token) return message("🔗", "Link not found", "Open the project link we sent you to view your job status.");
  try {
    render(await fetchView(token));
  } catch (e) {
    if (e.status === 404) message("🔒", "This link isn't active", "It may have expired or been turned off. Call us at 907-371-9868 and we'll send a fresh one.");
    else message("⚠️", "Couldn't load your project", "Please try again in a moment, or call us at 907-371-9868.");
  }
})();
