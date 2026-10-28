/* ============================================================
   Roybal Job Board — crew save merge
   Pure function: no DOM, no fetch, no imports (data.js passes the
   server read in), so Node can unit-test it — same discipline as
   schedule.js.

   WHY: crew_members rows are whole-object last-write-wins — no `rev`
   guard like coordination_jobs — and several writers save from copies
   that can be minutes old: the Crew board's Out toggle, the
   assistant's crewAvailabilityWrite, and the crew editor's own
   snapshot (the background poll pauses while a modal is open).

   That was survivable while the blob was cosmetic. It stopped being
   cosmetic when data.email became the link between a Supabase login
   and a crew card: the field app's My Week and the morning schedule
   text both key off it. A stale save that never knew the field
   existed would erase it, and that tech's schedule would quietly
   stop recognising them — with no error anywhere.
   ============================================================ */

/** Merge a crew save onto the server's current copy.
    - keys the caller never carried survive (the stale-copy case)
    - a blank email never overwrites a real one (retype to change it;
      a stale save landing late can't blank it)
    - a read failure returns the caller's object unchanged: offline
      saves must still land, exactly as before.
    `fetchRow(id)` resolves the server's `data` object, or null. */
export async function crewMergedOverServer(member, fetchRow) {
  try {
    const server = await fetchRow(member.id);
    if (!server) return member;
    const merged = { ...server, ...member };
    if (!String(member.email || "").trim() && String(server.email || "").trim()) merged.email = server.email;
    return merged;
  } catch {
    return member;
  }
}
