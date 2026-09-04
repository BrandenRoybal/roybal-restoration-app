/* Drying Watch — pure rule checks (no DOM, no network). */
import { dryingFlags, isCertified } from "../js/dryingwatch.js";

let passed = 0;
function check(name, cond) {
  if (!cond) { console.error("✗ " + name); process.exit(1); }
  console.log("  ✓ " + name);
  passed++;
}

const NOW = new Date("2026-07-10T12:00:00").getTime();
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

const base = () => ({
  moistureMaps: [], dryingLogs: [], certDrying: null,
});

// empty / undocumented projects are never flagged
check("empty project -> no flags", dryingFlags(base(), NOW).length === 0);
check("no drying docs -> no flags", dryingFlags({ ...base(), photos: [{}] }, NOW).length === 0);

// stale — last reading 3 days ago
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [{ date: day(3), values: ["30"] }] }];
  const f = dryingFlags(p, NOW);
  check("stale reading flagged", f.some((x) => x.kind === "stale"));
}

// fresh reading (today) -> not stale
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [{ date: day(0), values: ["30"] }] }];
  check("fresh reading not stale", !dryingFlags(p, NOW).some((x) => x.kind === "stale"));
}

// stalled — latest max MC not below previous, still over goal
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [
    { date: day(1), values: ["25"] },
    { date: day(0), values: ["26"] },
  ] }];
  check("stalled area flagged", dryingFlags(p, NOW).some((x) => x.kind === "stalled"));
}

// improving trend -> not stalled
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [
    { date: day(1), values: ["25"] },
    { date: day(0), values: ["18"] },
  ] }];
  check("improving trend not stalled", !dryingFlags(p, NOW).some((x) => x.kind === "stalled"));
}

// at/under goal -> not stalled even if flat
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [
    { date: day(1), values: ["11"] },
    { date: day(0), values: ["11"] },
  ] }];
  check("flat at goal not stalled", !dryingFlags(p, NOW).some((x) => x.kind === "stalled"));
}

// equipment over 7 days, not removed
{
  const p = base();
  p.dryingLogs = [{ equipment: [
    { type: "air_mover", placed: day(9), removed: "" },
    { type: "lgr", placed: day(9), removed: day(2) },   // removed — not counted
    { type: "scrubber", placed: day(2), removed: "" },  // recent — not counted
  ] }];
  const f = dryingFlags(p, NOW);
  const eq = f.find((x) => x.kind === "equip7d");
  check("one unit over 7 days flagged", !!eq && eq.label.startsWith("1 unit"));
}

// certified jobs are never flagged
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [{ date: day(9), values: ["30"] }] }];
  p.certDrying = { sigTech: "data:sig", issueDate: day(1) };
  check("isCertified true", isCertified(p));
  check("certified -> no flags", dryingFlags(p, NOW).length === 0);
}

// merely opening the cert form (factory prefills issueDate) is NOT certified
{
  const p = base();
  p.moistureMaps = [{ dryGoal: "12", readings: [{ date: day(9), values: ["30"] }] }];
  p.certDrying = { sigTech: "", issueDate: day(0), uploadedPages: [] };
  check("blank cert (prefilled issueDate) is not certified", !isCertified(p));
  check("blank cert keeps the flags alive", dryingFlags(p, NOW).length > 0);
}

console.log(`\n${passed} drying-watch checks passed.`);
