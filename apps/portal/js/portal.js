/* Roybal Customer Portal — read-only status page + message thread.
   Reads the share token from the URL (/j/<token>), asks the roybal-portal
   gateway for the curated slice, and renders status + milestones + photos +
   a two-way message thread with the office. No login: the token is the
   credential. */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const app = document.getElementById("app");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
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

async function callGateway(payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-portal`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { const e = new Error(body.error || "load_failed"); e.status = res.status; throw e; }
  return body;
}

const fetchView = (token) => callGateway({ action: "view", token });
const fetchThread = (token) => callGateway({ action: "messages", token });
const askConcierge = (token, body) => callGateway({ action: "ask", token, body });

function message(icon, title, sub) {
  app.replaceChildren(h("div", { class: "msg" },
    h("div", { class: "big" }, icon), h("h2", {}, title), sub ? h("p", {}, sub) : null));
}

/* pretty, terse timestamp for a message bubble */
function whenLabel(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}

/* ---------- message thread ---------- */
function renderThread(listEl, messages) {
  const bubbles = (messages || []).map((m) =>
    h("div", { class: "bubble bubble--" + (m.from === "you" ? "me" : "them") },
      h("div", { class: "bubble__body" }, m.body),
      h("div", { class: "bubble__meta" }, (m.from === "you" ? "You" : "Roybal Construction") + " · " + whenLabel(m.at))));
  if (!bubbles.length) {
    listEl.replaceChildren(h("p", { class: "thread__empty" },
      "Have a question about your project? Ask here — you'll get an answer right away, and anything that needs our team we'll follow up on personally."));
  } else {
    listEl.replaceChildren(...bubbles);
    listEl.scrollTop = listEl.scrollHeight;
  }
}

function threadCard(token) {
  const list = h("div", { class: "thread", id: "thread" },
    h("p", { class: "thread__empty" }, "Loading messages…"));
  const input = h("textarea", { class: "composer__input", rows: "1", placeholder: "Write a message…",
    "aria-label": "Write a message" });
  const btn = h("button", { class: "composer__send", type: "submit" }, "Send");
  const status = h("div", { class: "composer__status", role: "status" });

  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };
  input.addEventListener("input", grow);

  const form = h("form", { class: "composer",
    onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      btn.disabled = true; status.textContent = "";
      // optimistic: show the question + a "typing" bubble immediately
      const typing = h("div", { class: "bubble bubble--them bubble--typing" },
        h("div", { class: "bubble__body" }, h("span", { class: "dots" }, h("i"), h("i"), h("i"))));
      list.append(h("div", { class: "bubble bubble--me" },
        h("div", { class: "bubble__body" }, text),
        h("div", { class: "bubble__meta" }, "You · just now")), typing);
      list.scrollTop = list.scrollHeight;
      input.value = ""; grow();
      try {
        await askConcierge(token, text);
        renderThread(list, (await fetchThread(token)).messages);
      } catch (err) {
        typing.remove();
        status.textContent = err.status === 429
          ? "You've sent a lot of messages — please give us a moment to reply."
          : "Couldn't send. Please try again, or call 907-371-9868.";
      } finally { btn.disabled = false; }
    } }, input, btn);

  // Enter sends, Shift+Enter makes a newline
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  const card = h("div", { class: "card" },
    h("p", { class: "sectitle" }, "Messages"), list, form, status);

  // load the thread
  fetchThread(token).then((r) => renderThread(list, r.messages)).catch(() => {
    list.replaceChildren(h("p", { class: "thread__empty" }, "Messages will appear here."));
  });
  return card;
}

function render(data, token) {
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
      h("img", { src: p.url, alt: p.caption || "Project photo", loading: "lazy",
        onclick: () => openLightbox(p.url, p.caption || "Project photo") }),
      (p.caption || p.stage) ? h("figcaption", {}, p.caption || "",
        p.stage ? h("span", { class: "stage" }, (p.caption ? " · " : "") + p.stage) : null) : null));
  const gallery = photos.length
    ? h("div", { class: "card" }, h("p", { class: "sectitle" }, "Photos"), h("div", { class: "gallery" }, ...photos))
    : null;

  // native replaceChildren stringifies null args ("null"), so drop falsy first
  app.replaceChildren(...[hero, timeline, gallery, threadCard(token)].filter(Boolean));
}

const currentLabel = (ms) => (ms || []).find((m) => m.state === "current")?.label || "";

/* full-screen photo viewer — tap the backdrop, the ✕, or Esc to close */
function openLightbox(src, alt) {
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const box = h("div", { class: "lightbox", role: "dialog", "aria-label": "Photo", onclick: close },
    h("button", { class: "lightbox__close", "aria-label": "Close", onclick: close }, "✕"),
    h("img", { src, alt, onclick: (e) => e.stopPropagation() }));
  document.addEventListener("keydown", onKey);
  document.body.append(box);
}

(async () => {
  const token = tokenFromUrl();
  if (!token) return message("🔗", "Link not found", "Open the project link we sent you to view your job status.");
  try {
    render(await fetchView(token), token);
  } catch (e) {
    if (e.status === 404) message("🔒", "This link isn't active", "It may have expired or been turned off. Call us at 907-371-9868 and we'll send a fresh one.");
    else message("⚠️", "Couldn't load your project", "Please try again in a moment, or call us at 907-371-9868.");
  }
})();
