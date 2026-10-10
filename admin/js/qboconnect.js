/* ============================================================
   Roybal Admin — QuickBooks ONLINE connect panel (invoice push)
   ------------------------------------------------------------
   Separate from the QuickBooks Time panel: QBO uses Intuit's
   appcenter OAuth (scope com.intuit.quickbooks.accounting) and its
   callback carries a realmId — QB Time's TSheets callback doesn't,
   which is how the two callbacks are told apart on this same URL.
   No secrets client-side; the exchange happens in qbo-proxy.
   ============================================================ */
import { h, toast } from "../../js/core.js";
import { QBO_CLIENT_ID } from "../../js/config.js";
import { currentEmail } from "../../js/supa.js";
import { qboStatus, qboDisconnect, qboExchangeCode } from "../../js/qbo.js";

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";

function redirectUri() { return location.origin + location.pathname; }

function buildAuthUrl() {
  const state = "qbo-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem("qbo_oauth_state", state);
  const p = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTH_BASE}?${p}`;
}

/** Finish the QBO OAuth exchange if Intuit just redirected back here.
    Only claims callbacks that carry a realmId (QBO-specific) — TSheets
    callbacks fall through to handleQbCallback(). Returns true if handled. */
export async function handleQboCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const realmId = params.get("realmId");
  if (!code || !realmId) return false;

  const state = params.get("state");
  const saved = sessionStorage.getItem("qbo_oauth_state");
  history.replaceState({}, "", location.pathname); // scrub the code from the URL

  if (saved && state && saved !== state) { toast("QuickBooks Online state mismatch — connect again."); return true; }
  try {
    await qboExchangeCode(code, realmId, currentEmail());
    toast("QuickBooks Online connected — invoices can now push.");
  } catch (e) {
    toast((e && e.message) || "QuickBooks Online connection failed");
  }
  return true;
}

/** The dashboard card: status + connect / disconnect. */
export function qboPanel() {
  const box = h("div", { class: "card qb-panel" });

  function render(status) {
    box.replaceChildren();
    box.append(h("div", { class: "qb-panel__head" },
      h("strong", {}, "QuickBooks Online (invoicing)"),
      status && status.connected
        ? h("span", { class: "qb-ok" }, "● Connected")
        : h("span", { class: "qb-off" }, "○ Not connected")));

    if (!QBO_CLIENT_ID) {
      box.append(h("p", { class: "subtle" }, "Add QBO_CLIENT_ID to config.js to enable invoice push."));
      return;
    }

    if (status && status.connected) {
      box.append(h("p", { class: "subtle" }, "Company " + (status.realmId || "") +
        (status.updatedAt ? " · updated " + new Date(status.updatedAt).toLocaleDateString() : "")));
      const disc = h("button", { class: "btn btn--ghost btn--sm" }, "Disconnect");
      disc.addEventListener("click", async () => {
        if (!confirm("Disconnect QuickBooks Online invoicing?")) return;
        try { await qboDisconnect(); toast("Disconnected."); load(); }
        catch (e) { toast((e && e.message) || "Disconnect failed"); }
      });
      box.append(h("div", { class: "qb-panel__row" }, disc));
    } else {
      const connect = h("button", { class: "btn btn--primary btn--sm" }, "Connect QuickBooks Online");
      connect.addEventListener("click", () => { location.href = buildAuthUrl(); });
      box.append(h("p", { class: "subtle" }, "Connect once so mitigation invoices push straight into QuickBooks — customer, line items, and doc number included."), connect);
    }
  }

  async function load() {
    render({ connected: false });
    try { render(await qboStatus()); } catch { render({ connected: false }); }
  }
  load();
  return box;
}
