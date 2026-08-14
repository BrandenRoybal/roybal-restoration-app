/* Who's-coming-today — pure-logic tests (no Deno, no network).
   Run: node supabase/functions/roybal-portal/crewtoday.test.mjs */
import assert from "node:assert/strict";
import { crewToday, namesLine, crewLine } from "./crewtoday.mjs";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

const WED = "2026-08-12", SAT = "2026-08-15";
const job = { stage: "in_progress", startDate: "2026-08-01", targetDate: "2026-08-30", crewIds: ["a", "b"] };

ok("base roster on a weekday inside the window", crewToday(job, WED).join() === "a,b");
ok("weekend → nobody (Mon–Fri default settings)", crewToday(job, SAT).length === 0);
ok("before start → nobody", crewToday(job, "2026-07-30").length === 0);
ok("after target → nobody", crewToday({ ...job, targetDate: "2026-08-10" }, WED).length === 0);
ok("open-ended target: day after start still counts", crewToday({ ...job, targetDate: "" }, WED).join() === "a,b");
ok("lead/on_hold/done stages → nobody",
  ["lead", "on_hold", "done"].every((s) => crewToday({ ...job, stage: s }, WED).length === 0));
ok("archived and milestones → nobody",
  crewToday({ ...job, archived: true }, WED).length === 0 && crewToday({ ...job, isMilestone: true }, WED).length === 0);

/* crewSpans: b only rides Aug 20–25 */
const spanned = { ...job, crewSpans: { b: [{ from: "2026-08-20", to: "2026-08-25" }] } };
ok("a span keeps a member off outside it", crewToday(spanned, WED).join() === "a");
ok("…and on inside it (Aug 20 is a Thursday)", crewToday(spanned, "2026-08-20").join() === "a,b");
ok("blank span ends are open", crewToday({ ...job, crewSpans: { b: [{ from: "", to: "" }] } }, WED).join() === "a,b");

/* dayCrew: the effCrew delta rule */
const overridden = { ...job, dayCrew: { [WED]: { remove: ["a"], add: ["c"] } } };
ok("dayCrew remove+add applies on that day only",
  crewToday(overridden, WED).join() === "b,c" && crewToday(overridden, "2026-08-13").join() === "a,b");

/* copy */
ok("one name reads 'is'", crewLine(["Joel Hess"]) === "Good morning! Joel Hess from our crew is scheduled at your property today.");
ok("two names read 'and … are'", crewLine(["Joel Hess", "Jimmy Soland"]).includes("Joel Hess and Jimmy Soland from our crew are"));
ok("three names get the comma", namesLine(["A", "B", "C"]) === "A, B and C");
ok("no names → empty (post nothing)", crewLine([]) === "");

console.log(`\n${pass} crew-today checks passed.`);
