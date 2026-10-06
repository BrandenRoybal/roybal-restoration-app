/* Playwright network mock for the manual's screenshots.
   Every request that leaves localhost is answered here or ABORTED, so a
   screenshot run can never read or write the real Supabase project. */
import * as D from "./demo-data.mjs";

const json = (route, body, extra = {}) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), ...extra });

function restGet(table, url) {
  const q = url.search;
  switch (table) {
    case "field_projects": return D.fieldRows();
    case "coordination_jobs":
      if (q.includes("stage=eq.lead")) return D.BOARD_JOBS.filter((r) => r.data.stage === "lead");
      return D.BOARD_JOBS;
    case "crew_members": return D.CREW;
    case "time_entries": return D.TIME;
    case "pending_actions": return D.PENDING_ACTIONS;
    case "sms_messages":
      if (q.includes("direction=eq.inbound")) return D.SMS.filter((m) => m.direction === "inbound" && q.includes(m.from_number.slice(-10)));
      if (q.includes("direction=eq.outbound")) return [];
      return D.SMS;
    case "email_messages": return D.EMAILS;
    case "receipt_vendors": return D.VENDORS;
    case "contacts": return D.CONTACTS;
    default: return [];
  }
}

function portal(body) {
  switch (body.action) {
    case "view": return { ok: true, ...D.PORTAL_VIEW };
    case "messages": return { ok: true, messages: D.PORTAL_MESSAGES };
    case "selections": return { ok: true, ...D.PORTAL_SELECTIONS };
    case "media": return { ok: true, src: D.PORTAL_MEDIA[body.hash] || D.roomPhoto() };
    case "signDoc": return { ok: true, html: `<div style="font-family:Arial;padding:24px"><h2>Change Order #2</h2><p>Built-in mudroom bench with boot storage and six coat hooks.</p><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Item</th><th>Amount</th></tr><tr><td>Bench + hooks, painted</td><td>$1,850.00</td></tr></table><p>Demo document. Not a real contract.</p></div>` };
    default: return { ok: true };
  }
}

export async function installMocks(ctx) {
  await ctx.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.href), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.hostname.endsWith("supabase.co")) return route.abort();
    const p = url.pathname;
    if (p.startsWith("/auth/v1/")) return json(route, { access_token: "demo", refresh_token: "demo", expires_in: 86400, user: { email: "branden@example.com" } });
    if (p.startsWith("/storage/v1/")) return route.fulfill({ status: 404, body: "" });
    if (p.startsWith("/functions/v1/")) {
      const fn = p.split("/")[3];
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch {}
      if (fn === "roybal-portal") return json(route, portal(body));
      if (body.action === "getStatus") return json(route, { ok: true, data: { connected: true, updatedAt: new Date().toISOString(), account: "demo account" } });
      if (fn === "magicplan-proxy") return json(route, { ok: true, data: { name: "Demo workspace", ownerEmail: "branden@example.com", prefix: "RC" } });
      return json(route, { ok: true, data: {} });
    }
    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = p.slice("/rest/v1/rpc/".length);
      if (fn === "role_is") return json(route, true);
      if (fn === "field_build_floor") return json(route, 202);
      if (fn === "push_project") return json(route, { status: "applied", rev: 1 });
      return json(route, null);
    }
    if (p.startsWith("/rest/v1/")) {
      const table = p.slice("/rest/v1/".length);
      if (req.method() !== "GET" && req.method() !== "HEAD") return json(route, []);
      const rows = restGet(table, url);
      return json(route, rows, { headers: { "Content-Range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } });
    }
    return json(route, {});
  });
}

/* Signed-in session + the build label the app reads from CacheStorage. */
export const SIGNED_IN = () => {
  localStorage.setItem("roybal-session", JSON.stringify({ access_token: "demo", refresh_token: "demo", expires_at: Date.now() + 864e5, email: "branden@example.com" }));
  localStorage.setItem("roybal-tech", JSON.stringify({ id: "crew-cj", name: "CJ" }));
  try { caches.open("roybal-field-v202"); } catch (_) {}
};
