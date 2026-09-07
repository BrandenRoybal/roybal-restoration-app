/* Twilio status-callback mapping — pure-logic tests (no Deno, no network).
   Run: node supabase/functions/roybal-notify/status.test.mjs
   Picked up automatically by `npm run fn:test` (glob over *.test.mjs). */
import assert from "node:assert/strict";
import { mapTwilioStatus, blockedStatuses, STATUS_RANK } from "./status.mjs";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

/* the five column values, and nothing else */
const ALLOWED = new Set(["queued", "sent", "delivered", "undelivered", "failed"]);
for (const s of ["accepted", "scheduled", "queued", "sending", "sent", "delivered",
                 "undelivered", "failed", "canceled", "read"]) {
  ok(`'${s}' maps into the allowed column set`, ALLOWED.has(mapTwilioStatus(s).status));
}

ok("in-flight statuses collapse to queued",
  ["accepted", "scheduled", "queued", "sending"].every((s) => mapTwilioStatus(s).status === "queued"));
ok("sent stays sent", mapTwilioStatus("sent").status === "sent");
ok("delivered stays delivered", mapTwilioStatus("delivered").status === "delivered");
ok("undelivered stays undelivered", mapTwilioStatus("undelivered").status === "undelivered");
ok("canceled counts as failed — it never reached anyone",
  mapTwilioStatus("canceled").status === "failed" && mapTwilioStatus("cancelled").status === "failed");

/* Twilio sends these capitalized in some flows; whitespace happens */
ok("case- and space-insensitive", mapTwilioStatus("  DELIVERED ").status === "delivered");

/* an unknown status must never be guessed into a delivery claim */
ok("unknown status -> null", mapTwilioStatus("teleported") === null);
ok("empty / missing status -> null",
  mapTwilioStatus("") === null && mapTwilioStatus(undefined) === null && mapTwilioStatus(null) === null);

/* ordering: the reason this file exists */
ok("delivered outranks sent outranks queued",
  mapTwilioStatus("delivered").rank > mapTwilioStatus("sent").rank &&
  mapTwilioStatus("sent").rank > mapTwilioStatus("queued").rank);
ok("the three terminal states tie — first one to land wins, none downgrades another",
  STATUS_RANK.delivered === STATUS_RANK.failed && STATUS_RANK.failed === STATUS_RANK.undelivered);

/* the guard list = what this callback may NOT overwrite */
ok("a re-delivered 'queued' cannot un-deliver a delivered row",
  blockedStatuses(mapTwilioStatus("queued").rank).includes("delivered"));
ok("a late 'sent' cannot overwrite 'failed' or 'undelivered'",
  ["failed", "undelivered"].every((s) => blockedStatuses(mapTwilioStatus("sent").rank).includes(s)));
ok("a callback never overwrites its own state (idempotent replay)",
  ["queued", "sent", "delivered", "undelivered", "failed"]
    .every((s) => blockedStatuses(mapTwilioStatus(s).rank).includes(s)));
ok("'delivered' may still overwrite a pending/queued/sent row",
  ["pending", "queued", "accepted", "sending", "sent"]
    .every((s) => !blockedStatuses(mapTwilioStatus("delivered").rank).includes(s)));
ok("pending is never blocked — a row stuck at the pre-send value always settles",
  [1, 2, 3].every((r) => !blockedStatuses(r).includes("pending")));
ok("an inbound row is blocked at every rank — a stray callback can't rewrite a reply",
  [1, 2, 3].every((r) => blockedStatuses(r).includes("received")));
ok("the guard list is never empty (an empty PostgREST not.in.() is invalid)",
  [1, 2, 3].every((r) => blockedStatuses(r).length > 0));
ok("the guard list is stable/sorted",
  blockedStatuses(3).join(",") === blockedStatuses(3).slice().sort().join(","));

/* ---- F-034 drift guard: the URL we hand Twilio vs the URL we verify against ----
   Twilio signs the callback over the exact URL it posted to. twilioPost names
   that URL when it sends; twilioSignatureValid rebuilds it when the callback
   arrives. They live in different functions, so nothing but this test stops the
   two from drifting apart — and if they drift, every callback 403s silently and
   the rows go back to sitting at 'queued'. Asserted against the source text. */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const sent = src.match(/StatusCallback:\s*`([^`]+)`/)?.[1];

ok("the outbound send asks Twilio for a status callback at all", !!sent);
ok("the callback URL is the one the signature check rebuilds for route='status'",
  sent === "${SUPABASE_URL}/functions/v1/roybal-notify/status");
ok("the signature check still rebuilds that same shape",
  src.includes("`${SUPABASE_URL}/functions/v1/roybal-notify/${route}`"));
ok("no query string on the callback URL — it would change what Twilio signs",
  !!sent && !sent.includes("?"));
ok("no trailing slash on the callback URL — same reason",
  !!sent && !sent.endsWith("/"));

console.log(`\nstatus.test.mjs: ${pass} assertions passed`);
