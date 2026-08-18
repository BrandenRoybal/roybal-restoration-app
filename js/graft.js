/* ============================================================
   Graft — update a live project object in place (pure module)
   ------------------------------------------------------------
   Form pages bind their inputs to ONE in-memory project object
   (and to sub-objects inside it: project.workAuth, one photo,
   one drying log). When sync merges another device's changes
   into the stored row, that in-memory object is suddenly stale —
   and the next autosave would write the stale copy back over the
   merged one, silently re-erasing the other device's work.

   graftProject(live, fresh) rewrites `live` to deep-equal `fresh`
   WITHOUT replacing the objects/arrays the UI is bound to:
   arrays keep their identity and their id-matched elements keep
   theirs, nested objects are updated key-by-key. Bound editors
   keep working mid-edit, and the next autosave persists the
   merged content plus whatever the user typed since.
   ============================================================ */

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

export function graftProject(live, fresh) {
  if (!isObj(live) || !isObj(fresh)) return live;
  graftObj(live, fresh);
  return live;
}

function graftObj(live, fresh) {
  for (const k of Object.keys(live)) if (!(k in fresh)) delete live[k];
  for (const [k, v] of Object.entries(fresh)) {
    const cur = live[k];
    if (Array.isArray(v) && Array.isArray(cur)) graftArr(cur, v);
    else if (isObj(v) && isObj(cur)) graftObj(cur, v);
    else live[k] = v;
  }
}

function graftArr(live, fresh) {
  const byId = new Map();
  for (const x of live) if (isObj(x) && x.id != null) byId.set(x.id, x);
  const next = fresh.map((v) => {
    if (isObj(v) && v.id != null && byId.has(v.id)) {
      const keep = byId.get(v.id);
      graftObj(keep, v);
      return keep;
    }
    return v;
  });
  live.length = 0;
  live.push(...next);
}
