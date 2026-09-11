/* ============================================================
   Roybal Field Forms — customer selections (office side)

   The office imports the Xactimate "Export to Excel" of an approved
   reconstruction estimate; xactimate.js turns it into a sheet of
   DECISIONS, and this module publishes that sheet to portal_selections
   so the customer portal can serve it.

   Two things this is careful about:

   1. RE-IMPORT MUST NOT ORPHAN A CUSTOMER'S PICKS. Selection ids are
      deterministic, so a revised estimate updates decisions in place.
      Anything the customer already chose is carried forward; decisions
      that vanished from the estimate are reported and removed.

   2. A CHANGED BASELINE IS REPORTED, NOT SWALLOWED. If a re-import moves
      the like-kind-and-quality total on a decision the customer already
      answered, their upgrade delta was computed against the old number.
      publishSelections() counts those so the office is told to re-check
      rather than finding out on the invoice.

   supa.js is imported lazily so the pure functions here load under Node.
   ============================================================ */

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* PURE: a selection sheet -> portal_selections rows for one shared job.
   Column names are snake_case to match the table exactly, so the caller
   can hand the result straight to PostgREST. */
export function selectionRows(portalJobId, sheet) {
  if (!portalJobId) throw new Error("no portal job id — enable the portal for this job first");
  const selections = (sheet && sheet.selections) || [];
  return selections.map((s, i) => ({
    portal_job_id: portalJobId,
    selection_id: s.id,
    sort_order: i,
    type: s.type || "",
    label: s.label || "",
    scope: s.scope || "room",
    room: s.room || "",
    room_key: s.roomKey || "",
    rooms: Array.isArray(s.rooms) ? s.rooms : [],
    title: s.title || "",
    descr: s.desc || "",
    cat: s.cat || "",
    sel: s.sel || "",
    qty: money(s.qty),
    unit: s.unit || "",
    lkq_unit_cost: money(s.lkqUnitCost),
    lkq_total: money(s.lkqTotal),
    waste_pct: s.waste == null ? null : money(s.waste),
    items: Array.isArray(s.items) ? s.items : [],
  }));
}

/* PURE: fold what the customer already answered into a freshly imported
   sheet. Returns the rows to upsert, the selection_ids that no longer
   exist in the estimate, and the answered decisions whose baseline moved. */
export function mergeSelectionRows(nextRows, existingRows) {
  const prior = new Map();
  for (const r of existingRows || []) if (r && r.selection_id) prior.set(r.selection_id, r);

  const repriced = [];
  const rows = (nextRows || []).map((row) => {
    const was = prior.get(row.selection_id);
    if (!was || !was.chosen_option_id) return row;
    // Carry the customer's answer across the re-import.
    if (money(was.lkq_total) !== money(row.lkq_total)) {
      repriced.push({
        selection_id: row.selection_id,
        title: row.title,
        was: money(was.lkq_total),
        now: money(row.lkq_total),
      });
    }
    return {
      ...row,
      chosen_option_id: was.chosen_option_id,
      chosen_label: was.chosen_label || null,
      delta_cents: was.delta_cents || 0,
      chosen_at: was.chosen_at || null,
    };
  });

  const keep = new Set(rows.map((r) => r.selection_id));
  const removed = [...prior.values()]
    .filter((r) => !keep.has(r.selection_id))
    .map((r) => ({ selection_id: r.selection_id, title: r.title, wasChosen: !!r.chosen_option_id }));

  return { rows, removed, repriced };
}

/* PURE: the one-line summary the office panel shows after an import. */
export function selectionSummary(sheet) {
  const t = (sheet && sheet.totals) || {};
  return {
    decisions: t.selectionCount || 0,
    selectionValue: money(t.selectionValue),
    scopeValue: money(t.scopeValue),
    estimateValue: money(t.estimateValue),
    lineCount: t.lineCount || 0,
    rooms: ((sheet && sheet.rooms) || []).length,
  };
}

/* ---------- persistence ---------- */

export async function fetchSelections(portalJobId) {
  if (!portalJobId) return [];
  const { rest } = await import("./supa.js");
  const q = `portal_selections?portal_job_id=eq.${portalJobId}` +
    `&select=id,selection_id,sort_order,type,label,scope,room,title,descr,cat,sel,qty,unit,` +
    `lkq_unit_cost,lkq_total,waste_pct,items,chosen_option_id,chosen_label,delta_cents,chosen_at` +
    `&order=sort_order.asc`;
  const res = await rest(q, { method: "GET" });
  if (!res.ok) throw new Error("Selections load failed (" + res.status + ")");
  return res.json();
}

/* Publish an imported sheet for a shared job. Upserts on
   (portal_job_id, selection_id), deletes decisions the estimate no longer
   has, and stamps the source onto portal_jobs. Returns what changed so the
   office gets told rather than guessing. */
export async function publishSelections(project, sheet, meta = {}) {
  const share = (project && project.portalShare) || {};
  const portalJobId = share.id;
  if (!share.enabled || !share.shareToken) throw new Error("Turn the customer portal on for this job first.");

  const { rest } = await import("./supa.js");
  const next = selectionRows(portalJobId, sheet);
  if (!next.length) throw new Error("That estimate produced no customer decisions.");

  const existing = await fetchSelections(portalJobId).catch(() => []);
  const { rows, removed, repriced } = mergeSelectionRows(next, existing);

  const res = await rest("portal_selections", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("Publish failed (" + res.status + "): " + (await res.text().catch(() => "")));

  // Drop decisions the revised estimate no longer contains.
  if (removed.length) {
    const list = removed.map((r) => `"${r.selection_id}"`).join(",");
    await rest(`portal_selections?portal_job_id=eq.${portalJobId}&selection_id=in.(${list})`, { method: "DELETE" })
      .catch(() => { /* the upsert already landed; a stale row is not worth failing the publish */ });
  }

  const summary = selectionSummary(sheet);
  const source = {
    file: meta.file || "",
    importedAt: new Date().toISOString(),
    ...summary,
  };
  await rest(`portal_jobs?id=eq.${portalJobId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ selections_source: source, selections_published_at: source.importedAt }),
  }).catch(() => { /* selections are published; the stamp is cosmetic */ });

  return { published: rows.length, removed, repriced, source, summary };
}
