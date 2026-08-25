/* Roybal — insurance packet link page (/packet/<token>).
   The field app snapshots the whole job packet — every included sheet,
   values frozen, images swapped for content hashes — and this page puts it
   back together: the HTML skeleton renders inside an isolated iframe
   (srcdoc, same-origin, so the packet's own stylesheet can't clash with
   this page), then every image hydrates one request at a time through the
   token-gated gateway. Print / Save as PDF prints ONLY the packet frame.
   No login: the unguessable token is the credential. */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const app = document.getElementById("app");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

function tokenFromUrl() {
  const m = location.pathname.match(/\/packet\/([0-9a-f]{16,})/i);
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

const token = tokenFromUrl();

/* fill every dehydrated image, a few at a time; the frame grows as they land */
async function hydrate(doc, progressEl, onDone) {
  const imgs = [...doc.querySelectorAll("img[data-media]")];
  let done = 0, failed = 0;
  const update = () => {
    progressEl.textContent = done + failed < imgs.length
      ? `Loading images… ${done + failed} of ${imgs.length}` : failed ? `${failed} image(s) unavailable` : "";
  };
  update();
  const queue = imgs.slice();
  const worker = async () => {
    for (let img = queue.shift(); img; img = queue.shift()) {
      try {
        const r = await callGateway({ action: "photoMedia", token, hash: img.getAttribute("data-media") });
        img.src = r.src;
        done++;
      } catch { failed++; }
      update();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  onDone();
}

function render(share, html) {
  const meta = [
    share.property_address,
    share.claim_no ? `Claim # ${share.claim_no}` : "",
    share.date_of_loss ? `Date of loss ${share.date_of_loss}` : "",
  ].filter(Boolean).join(" · ");

  const frame = h("iframe", { class: "packetframe", title: "Job packet" });
  const progress = h("span", { class: "packet-progress" });
  const printBtn = h("button", { class: "btn-zip" }, "🖨 Print / Save as PDF");
  printBtn.addEventListener("click", () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.print(); }
  });

  app.replaceChildren(
    h("div", { class: "card hero" },
      h("h1", {}, "Job Packet — " + (share.customer_name || "Job")),
      meta ? h("p", { class: "addr" }, meta) : null,
      h("p", { class: "pcount" },
        "The complete documentation packet for this claim" +
        (share.image_count ? `, including ${share.image_count} embedded photo(s)` : "") +
        ". Use the button to print it or save it as a PDF. ",
        progress),
      printBtn),
    frame);

  const size = () => {
    try { frame.style.height = Math.max(600, frame.contentDocument.documentElement.scrollHeight + 40) + "px"; }
    catch { /* not ready yet */ }
  };
  frame.addEventListener("load", () => {
    size();
    hydrate(frame.contentDocument, progress, size);
  });
  frame.srcdoc = html;
  window.addEventListener("resize", size);
}

async function main() {
  if (!token) {
    app.replaceChildren(h("div", { class: "msg" }, h("div", { class: "big" }, "🔍"),
      h("h2", {}, "Link not recognized"),
      h("p", {}, "Please use the exact link you were sent, or contact Roybal Construction at 907-371-9868.")));
    return;
  }
  try {
    const share = await callGateway({ action: "photoShare", token });
    const doc = await callGateway({ action: "packetHtml", token });
    if (!doc.html) throw new Error("empty");
    render(share, doc.html);
  } catch (e) {
    app.replaceChildren(h("div", { class: "msg" }, h("div", { class: "big" }, "🔒"),
      h("h2", {}, "This link isn't active"),
      h("p", {}, "It may have been turned off or replaced. Contact Roybal Construction at 907-371-9868 for a current link.")));
  }
}

main();
