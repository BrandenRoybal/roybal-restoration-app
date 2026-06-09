/* ============================================================
   Roybal Field Forms — app shell + hash router
   ============================================================ */
import { h, $, clear, Store, toast, fmtDate, money, fileToDataURL, flushPending, downloadFile, csvRow } from "./core.js";
import {
  FORMS, formByKey, formCount, newProject,
  newMoistureMap, newDryingLog, newConstructionLog, newChangeOrder,
  newInvoice, newWorkAuth, newCertDrying,
  newContentsItem, newBox, CONDITIONS, DISPOSITIONS, CONTENT_CATEGORIES,
  BOX_DESTINATIONS, dispositionShort, dispositionLabel, depreciation,
} from "./model.js";
import { setCtx, field, inp, ta, sel, seg, photoUploader } from "./formkit.js";
import { RENDERERS, packBackReceipt } from "./forms.js";
import { qrSvg } from "./qr.js";

const view = $("#view");
const topbarSub = $("#topbarSub");
const backBtn = $("#backBtn");

const FACTORY = {
  moistureMaps: newMoistureMap, dryingLogs: newDryingLog,
  constructionLogs: newConstructionLog, changeOrders: newChangeOrder,
  invoices: newInvoice, workAuth: newWorkAuth, certDrying: newCertDrying,
};

/* ---------- router ---------- */
let backTarget = "#/";
function go(hash) { location.hash = hash; }
backBtn.addEventListener("click", () => go(backTarget));

window.addEventListener("hashchange", route);
window.addEventListener("load", route);

async function route() {
  await flushPending();              // persist any in-flight edit before reloading
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  window.scrollTo(0, 0);
  // parts: [] | ['new'] | ['p', id] | ['p', id, 'edit'] | ['p', id, 'f', key] | ['p', id, 'f', key, instId]
  if (parts[0] === "new") return void (await createProject());
  if (parts[0] === "p" && parts[1]) {
    const project = await Store.get(parts[1]);
    if (!project) return go("#/");
    if (parts[2] === "edit") return projectEdit(project);
    if (parts[2] === "packet") return packetPage(project);
    if (parts[2] === "f" && parts[3]) return formPage(project, parts[3], parts[4]);
    return projectHome(project);
  }
  return projectList();
}

function setChrome(sub, back) {
  topbarSub.textContent = sub;
  backTarget = back || "#/";
  backBtn.hidden = !back;
}

/* ============================================================
   Project list (home)
   ============================================================ */
async function projectList() {
  setChrome("Field Forms", null);
  const projects = await Store.all();
  const body = clear(view);

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "Jobs"),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => go("#/new") }, "+ New Job")));

  if (!projects.length) {
    body.append(h("div", { class: "empty" },
      h("div", { class: "big" }, "🧰"),
      h("p", {}, "No jobs yet."),
      h("p", { class: "subtle" }, "Tap “+ New Job” to start a water restoration project. Everything works offline and saves to this device."),
      h("button", { class: "btn btn--primary", style: "max-width:260px;margin:10px auto 0", onclick: () => go("#/new") }, "+ New Job")));
  } else {
    const list = h("div", { class: "joblist" });
    projects.forEach((p) => {
      const cat = p.waterCategory ? `Cat ${p.waterCategory}` : "";
      list.append(h("a", { class: "card card--tap jobrow", href: `#/p/${p.id}` },
        h("div", { class: "jobrow__main" },
          h("div", { class: "jobrow__title" }, p.customer || p.address || "Untitled job"),
          h("div", { class: "jobrow__sub" },
            [p.address && p.customer ? p.address : "", p.claimNo ? "Claim " + p.claimNo : "", cat, "Updated " + fmtDate((p.updatedAt || "").slice(0, 10))].filter(Boolean).join(" · "))),
        h("div", { class: "jobrow__chev" }, "›")));
    });
    body.append(list);
  }
  body.append(installHint());
}

const APP_VERSION = "v8";

function installHint() {
  return h("div", {},
    h("div", { class: "note", style: "margin-top:18px" },
      h("strong", {}, "Tip: "),
      "Add this app to your home screen (Share → “Add to Home Screen”) to launch it like a regular app and use it with no signal in the field."),
    h("div", { style: "text-align:center;color:var(--muted);font-size:11px;margin-top:14px" },
      "Roybal Field Forms · build " + APP_VERSION));
}

async function createProject() {
  const p = newProject();
  await Store.put(p);
  go(`#/p/${p.id}/edit`);
}

/* ============================================================
   Project home — tiles for each form
   ============================================================ */
function projectHome(project) {
  setChrome(project.customer || "Job", "#/");
  const body = clear(view);

  body.append(
    h("h1", {}, project.customer || project.address || "Untitled job"),
    h("p", { class: "subtle" }, [project.address, project.claimNo ? "Claim " + project.claimNo : ""].filter(Boolean).join(" · ") || "Tap Edit to add job details"));

  const badges = h("div", { class: "badgeline" });
  if (project.waterCategory) badges.append(h("span", { class: "badge cat" + project.waterCategory }, "Category " + project.waterCategory));
  if (project.waterClass) badges.append(h("span", { class: "badge" }, "Class " + project.waterClass));
  if (project.dryingSystem) badges.append(h("span", { class: "badge" }, project.dryingSystem + " drying"));
  if (badges.children.length) body.append(badges);

  body.append(h("div", { class: "btn-row", style: "margin-bottom:14px" },
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/edit`) }, "✎ Edit job details"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shareJob(project) }, "↗ Share")));

  const tiles = h("div", { class: "tiles" });
  FORMS.forEach((f) => {
    const count = formCount(project, f.key);
    const isList = f.multi || Array.isArray(project[f.key]); // moisture/drying/photos/contents…
    const noun = f.key === "contents" ? "items" : (f.key === "photos" ? "photos" : "saved");
    const badge = isList
      ? h("span", { class: "tile__count" }, count ? `${count} ${noun}` : "None yet")
      : h("span", { class: "tile__badge " + (count ? "done" : "todo") }, count ? "Started" : "Not started");
    tiles.append(h("a", { class: "tile" + (f.hero ? " tile--hero" : ""), href: `#/p/${project.id}/f/${f.key}` },
      h("div", { class: "tile__icon" }, f.icon),
      h("div", { class: "tile__name" }, f.name),
      h("div", { class: "tile__count" }, f.blurb),
      badge));
  });
  body.append(tiles);

  body.append(h("button", { class: "btn btn--primary", style: "margin-top:14px", onclick: () => go(`#/p/${project.id}/packet`) }, "📄 Full job packet (PDF)"));
}

/* ============================================================
   Full job packet — every started form, stacked for one PDF
   ============================================================ */
function packetPage(project) {
  setChrome("Job packet", `#/p/${project.id}`);
  const body = clear(view);
  setCtx(project, null);

  const included = [];
  for (const f of FORMS) {
    const v = project[f.key];
    const render = RENDERERS[f.key];
    if (!render) continue;
    if (f.multi) {
      (v || []).forEach((inst) => included.push(render(project, inst)));
    } else {
      const has = Array.isArray(v) ? v.length > 0 : !!v;   // photos/contents are arrays → one report
      if (has) included.push(render(project, v));
    }
  }

  body.append(
    h("h1", { class: "app-only" }, "Full job packet"),
    h("p", { class: "subtle app-only" }, included.length
      ? `${included.length} document(s) for ${project.customer || "this job"}. Tap “Save packet as PDF,” then share to the carrier.`
      : "Nothing to include yet — fill out some forms first."));

  included.forEach((s) => body.append(s));

  if (included.length) {
    body.append(h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}`) }, "Back"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Save packet as PDF")));
  }
}

/* ---------- share a quick job summary ---------- */
async function shareJob(project) {
  const dryDays = [];
  const lines = [
    `Roybal Restoration — ${project.customer || "Job"}`,
    project.address, project.claimNo ? "Claim #: " + project.claimNo : "",
    project.carrier ? "Carrier: " + project.carrier : "",
    project.waterCategory ? `Cat ${project.waterCategory}${project.waterClass ? " / Class " + project.waterClass : ""}` : "",
    `Moisture maps: ${(project.moistureMaps || []).length} · Drying logs: ${(project.dryingLogs || []).length} · Photos: ${(project.photos || []).length}`,
  ].filter(Boolean).concat(dryDays);
  const textBody = lines.join("\n");
  if (navigator.share) {
    try { await navigator.share({ title: "Roybal Restoration — " + (project.customer || "Job"), text: textBody }); return; } catch { /* cancelled */ }
  }
  const to = project.adjuster && project.adjuster.includes("@") ? project.adjuster : "";
  window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent("Roybal Restoration — " + (project.customer || "Job"))}&body=${encodeURIComponent(textBody)}`;
}

/* ============================================================
   Form page — list for multi forms, editor for single/instance
   ============================================================ */
async function formPage(project, key, instId) {
  const meta = formByKey(key);
  if (!meta) return go(`#/p/${project.id}`);

  // contents has its own manager (list + filters + boxes)
  if (key === "contents") {
    ensureContents(project);
    if (!instId) return contentsManager(project);
    if (instId === "report") return contentsReportPage(project);
    if (instId === "boxes") return boxesManager(project);
    if (instId === "packback") return contentsPackBack(project);
    const item = project.contents.find((x) => x.id === instId);
    if (!item) return go(`#/p/${project.id}/f/contents`);
    return contentsItemEditor(project, item);
  }

  // single-instance forms: open editor directly
  if (!meta.multi) {
    if (key === "photos") {
      if (!Array.isArray(project.photos)) { project.photos = []; await Store.put(project); }
      return formEditor(project, meta, project.photos);
    }
    if (!project[key]) { project[key] = FACTORY[key](); await Store.put(project); }
    return formEditor(project, meta, project[key]);
  }

  // multi-instance: show instance list unless a specific instance is requested
  if (instId) {
    const inst = project[key].find((x) => x.id === instId);
    if (!inst) return go(`#/p/${project.id}/f/${key}`);
    return formEditor(project, meta, inst);
  }
  return instanceList(project, meta);
}

function instanceList(project, meta) {
  setChrome(meta.name, `#/p/${project.id}`);
  const body = clear(view);
  const arr = project[meta.key];

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, meta.icon + " " + meta.name),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => addInstance(project, meta) }, "+ New")));
  body.append(h("p", { class: "subtle" }, meta.blurb));

  if (!arr.length) {
    body.append(h("div", { class: "empty" }, h("div", { class: "big" }, meta.icon), h("p", {}, "None yet."),
      h("button", { class: "btn btn--primary", style: "max-width:240px;margin:8px auto 0", onclick: () => addInstance(project, meta) }, "+ New " + meta.name)));
    return;
  }
  const list = h("div", { class: "joblist" });
  arr.slice().reverse().forEach((inst) => {
    const title = instanceTitle(meta.key, inst);
    list.append(h("a", { class: "card card--tap jobrow", href: `#/p/${project.id}/f/${meta.key}/${inst.id}` },
      h("div", { class: "jobrow__main" },
        h("div", { class: "jobrow__title" }, title),
        h("div", { class: "jobrow__sub" }, "Created " + fmtDate((inst.createdAt || "").slice(0, 10)))),
      h("div", { class: "jobrow__chev" }, "›")));
  });
  body.append(list);
}

function instanceTitle(key, inst) {
  switch (key) {
    case "moistureMaps": return inst.label || inst.material || ("Moisture map — " + fmtDate(inst.readings?.[0]?.date));
    case "dryingLogs": return "Drying log — " + fmtDate(inst.readings?.[0]?.date);
    case "constructionLogs": return "Construction log — " + fmtDate(inst.date);
    case "changeOrders": return "Change Order " + (inst.coNo || "") + " — " + fmtDate(inst.coDate);
    case "invoices": return "Invoice " + (inst.invoiceNo || "") + " — " + fmtDate(inst.invoiceDate);
    default: return "Entry";
  }
}

async function addInstance(project, meta) {
  const inst = FACTORY[meta.key]();
  project[meta.key].push(inst);
  await Store.put(project);
  go(`#/p/${project.id}/f/${meta.key}/${inst.id}`);
}

/* ---------- the actual form editor ---------- */
function formEditor(project, meta, instance) {
  const back = meta.multi ? `#/p/${project.id}/f/${meta.key}` : `#/p/${project.id}`;
  setChrome(meta.name, back);
  const body = clear(view);

  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  body.append(
    h("div", { class: "app-only", style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px" },
      h("div", {}, h("strong", { style: "font-size:18px" }, meta.icon + " " + meta.name)),
      pill));

  const sheetEl = RENDERERS[meta.key](project, instance);
  body.append(sheetEl);

  body.append(h("div", { style: "height:8px" }));

  // sticky actions
  const actions = h("div", { class: "sticky-actions app-only" },
    h("button", { class: "btn btn--ghost", onclick: () => go(back) }, "Done"),
    h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Save as PDF"));
  if (meta.multi) {
    actions.insertBefore(
      h("button", { class: "btn btn--danger", onclick: () => deleteInstance(project, meta, instance, back) }, "Delete"),
      actions.firstChild);
  }
  body.append(actions);
}

async function deleteInstance(project, meta, instance, back) {
  if (!confirm(`Delete this ${meta.name}? This cannot be undone.`)) return;
  const arr = project[meta.key];
  const i = arr.findIndex((x) => x.id === instance.id);
  if (i >= 0) arr.splice(i, 1);
  await Store.put(project);
  toast(meta.name + " deleted");
  go(back);
}

/* ============================================================
   CONTENTS — personal property inventory + pack-out boxes
   ============================================================ */
function ensureContents(project) {
  if (!Array.isArray(project.contents)) project.contents = [];
  if (!Array.isArray(project.boxes)) project.boxes = [];
  if (!Array.isArray(project.rooms)) project.rooms = [];
}
const dispClass = (d) =>
  d === "salvageable" ? "g" : d === "non-salvageable" ? "r" : d === "disposed" ? "x" : "b";
const boxLabelOf = (project, id) => (project.boxes.find((b) => b.id === id) || {}).label || "";

/* a <select> with an extra "add new" option that prompts */
function addableSelect(getVal, options, onPick, addLabel, onAdd) {
  const wrap = h("span", { class: "addable" });
  function render() {
    const cur = getVal();
    const s = h("select");
    s.append(h("option", { value: "" }, "—"));
    options().forEach((o) => s.append(h("option", { value: o.value, selected: o.value === cur }, o.label)));
    s.append(h("option", { value: "__new__" }, addLabel));
    s.addEventListener("change", () => {
      if (s.value === "__new__") {
        const added = onAdd();
        if (added != null && added !== "") onPick(added);
        render();
      } else onPick(s.value);
    });
    wrap.replaceChildren(s);
  }
  render();
  return wrap;
}
function roomSelect(project, item) {
  return addableSelect(
    () => item.room,
    () => project.rooms.map((r) => ({ value: r, label: r })),
    (v) => { item.room = v; Store.put(project); },
    "➕ New room…",
    () => {
      const name = (prompt("Room name (e.g. Kitchen, Master Bedroom)") || "").trim();
      if (!name) return null;
      if (!project.rooms.includes(name)) project.rooms.push(name);
      item.room = name; Store.put(project); return name;
    });
}
function boxSelect(project, item) {
  return addableSelect(
    () => item.boxId,
    () => project.boxes.map((b) => ({ value: b.id, label: b.label + (b.room ? " · " + b.room : "") })),
    (v) => { item.boxId = v; Store.put(project); },
    "➕ New box…",
    () => {
      const b = newBox(project.boxes.length + 1);
      const label = (prompt("Box label", b.label) || "").trim();
      if (!label) return null;
      b.label = label; b.room = item.room || "";
      project.boxes.push(b); item.boxId = b.id; Store.put(project); return b.id;
    });
}

function contentsSummary(project) {
  const items = project.contents;
  const pieces = items.reduce((s, it) => s + (Number(it.qty) || 1), 0);
  const loss = items.filter((it) => it.disposition === "non-salvageable");
  const lossTotal = loss.reduce((s, it) => s + (Number(it.value) || 0) * (Number(it.qty) || 1), 0);
  const chips = h("div", { class: "badgeline" },
    h("span", { class: "badge" }, items.length + " items · " + pieces + " pcs"),
    h("span", { class: "badge" }, project.boxes.length + " boxes"));
  if (loss.length) chips.append(h("span", { class: "badge cat3" }, loss.length + " loss · " + money(lossTotal)));
  return chips;
}

function contentsManager(project) {
  setChrome("Contents", `#/p/${project.id}`);
  const body = clear(view);
  setCtx(project, null);

  let q = "", fRoom = "", fBox = "", fDisp = "";

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "📦 Contents"),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => addItem(project) }, "+ Add item")),
    contentsSummary(project),
    h("div", { class: "btn-row", style: "margin:6px 0 12px;flex-wrap:wrap" },
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/f/contents/boxes`) }, `📦 Boxes (${project.boxes.length})`),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/f/contents/packback`) }, "↩︎ Pack-back"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/f/contents/report`) }, "📄 Inventory PDF"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => exportContentsCSV(project) }, "⬇ CSV")));

  // filters
  const search = h("input", { type: "search", placeholder: "Search items…" });
  search.addEventListener("input", () => { q = search.value.toLowerCase(); paint(); });
  const roomF = h("select", {}, h("option", { value: "" }, "All rooms"),
    ...project.rooms.map((r) => h("option", { value: r }, r)));
  roomF.addEventListener("change", () => { fRoom = roomF.value; paint(); });
  const boxF = h("select", {}, h("option", { value: "" }, "All boxes"),
    ...project.boxes.map((b) => h("option", { value: b.id }, b.label)));
  boxF.addEventListener("change", () => { fBox = boxF.value; paint(); });
  const dispF = h("select", {}, h("option", { value: "" }, "All"),
    ...DISPOSITIONS.map((d) => h("option", { value: d.value }, d.label)));
  dispF.addEventListener("change", () => { fDisp = dispF.value; paint(); });
  body.append(h("div", { class: "filterbar" }, search, h("div", { class: "grid3" }, roomF, boxF, dispF)));

  const list = h("div", { class: "joblist" });
  body.append(list);

  function paint() {
    const items = project.contents.filter((it) =>
      (!q || (it.name + " " + it.brand + " " + it.model + " " + it.notes).toLowerCase().includes(q)) &&
      (!fRoom || it.room === fRoom) && (!fBox || it.boxId === fBox) && (!fDisp || it.disposition === fDisp));
    if (!items.length) {
      list.replaceChildren(h("div", { class: "empty" }, h("div", { class: "big" }, "📦"),
        h("p", {}, project.contents.length ? "No items match." : "No items yet."),
        h("button", { class: "btn btn--primary", style: "max-width:240px;margin:8px auto 0", onclick: () => addItem(project) }, "+ Add item")));
      return;
    }
    list.replaceChildren(...items.map((it) => h("a", { class: "card card--tap citem", href: `#/p/${project.id}/f/contents/${it.id}` },
      it.photos[0] ? h("img", { class: "cthumb", src: it.photos[0], alt: "" }) : h("div", { class: "cthumb cthumb--ph" }, "📦"),
      h("div", { class: "jobrow__main" },
        h("div", { class: "jobrow__title" }, (it.qty && it.qty !== "1" ? it.qty + "× " : "") + (it.name || "Untitled item")),
        h("div", { class: "jobrow__sub" }, [it.room, boxLabelOf(project, it.boxId), it.condition].filter(Boolean).join(" · ")),
        h("div", { class: "badgeline", style: "margin:4px 0 0" },
          it.disposition ? h("span", { class: "badge disp-" + dispClass(it.disposition) }, dispositionShort(it.disposition)) : null,
          it.value ? h("span", { class: "badge" }, money((Number(it.value) || 0) * (Number(it.qty) || 1))) : null)),
      h("div", { class: "jobrow__chev" }, "›"))));
  }
  paint();
}

async function addItem(project) {
  ensureContents(project);
  const it = newContentsItem();
  project.contents.push(it);
  await Store.put(project);
  go(`#/p/${project.id}/f/contents/${it.id}`);
}

function contentsItemEditor(project, item) {
  setChrome(item.name || "Item", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  const warn = h("div", { class: "warn app-only", hidden: true });
  function checkWarn() {
    const need = item.disposition === "non-salvageable" && (!item.photos || !item.photos.length);
    warn.hidden = !need;
    if (need) warn.replaceChildren(h("strong", {}, "📷 Tip: "), "Add a photo of this non-salvageable item — carriers require photo proof for the loss claim.");
  }

  const acvLine = h("div", { class: "acvline app-only" });
  function updateAcv() {
    const d = depreciation(item);
    if (!d.rcv) { acvLine.hidden = true; return; }
    acvLine.hidden = false;
    acvLine.replaceChildren(
      h("span", {}, "RCV ", h("b", {}, money(d.rcv))),
      h("span", {}, "Depr. ", h("b", {}, Math.round(d.rate * 100) + "%")),
      h("span", {}, "ACV ", h("b", { style: "color:var(--orange-dark)" }, money(d.acv))));
  }

  body.append(
    h("div", { class: "app-only", style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px" },
      h("strong", { style: "font-size:18px" }, "📦 Item"), pill),
    h("div", { class: "card" },
      field("Photos", photoUploader(item.photos, "Add item photos")),
      warn,
      field("Item name", inp(item, "name", { placeholder: "e.g. 55\" Samsung TV" })),
      h("div", { class: "grid2" },
        field("Quantity", inp(item, "qty", { type: "number", oninput: updateAcv })),
        field("Category", sel(item, "category", CONTENT_CATEGORIES, { placeholder: "Select…", onchange: updateAcv }))),
      h("div", { class: "grid2" },
        field("Room", roomSelect(project, item)),
        field("Box", boxSelect(project, item))),
      field("Condition", seg(item, "condition", CONDITIONS)),
      field("Disposition", seg(item, "disposition", DISPOSITIONS.map((d) => ({ value: d.value, label: d.label })), { onchange: checkWarn })),
      h("div", { class: "grid2" },
        field("Replacement value (each)", inp(item, "value", { type: "number", placeholder: "$ per unit", oninput: updateAcv })),
        field("Age (yrs)", inp(item, "age", { type: "number", oninput: updateAcv }))),
      acvLine,
      h("details", { class: "app-only" },
        h("summary", { class: "linklike" }, "Brand / model (for the claim)"),
        h("div", { class: "grid2", style: "margin-top:8px" },
          field("Brand", inp(item, "brand")),
          field("Model", inp(item, "model")))),
      field("Notes", ta(item, "notes"))));
  checkWarn();
  updateAcv();

  body.append(h("div", { class: "sticky-actions app-only" },
    h("button", { class: "btn btn--danger", onclick: () => deleteItem(project, item) }, "Delete"),
    h("button", { class: "btn btn--primary", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Done")));
}

async function deleteItem(project, item) {
  if (!confirm("Delete this item?")) return;
  const i = project.contents.findIndex((x) => x.id === item.id);
  if (i >= 0) project.contents.splice(i, 1);
  await Store.put(project);
  toast("Item deleted");
  go(`#/p/${project.id}/f/contents`);
}

/* ---------- Boxes manager (+ printable labels) ---------- */
function boxesManager(project) {
  setChrome("Boxes", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);
  const countItems = (id) => project.contents.filter((it) => it.boxId === id).length;

  const listWrap = h("div", { class: "app-only" });
  function paint() {
    const cards = project.boxes.map((b) =>
      h("div", { class: "card" },
        h("div", { class: "grid2" },
          field("Box label", inp(b, "label")),
          field("Room", inp(b, "room"))),
        h("div", { class: "grid2" },
          field("Destination", sel(b, "destination", BOX_DESTINATIONS)),
          field("Packed by", inp(b, "packedBy"))),
        h("div", { class: "grid2" },
          field("Packed date", inp(b, "packedDate", { type: "date" })),
          field("Items in box", h("div", { style: "padding-top:12px;font-weight:700" }, String(countItems(b.id))))),
        h("button", { class: "btn btn--danger btn--sm", onclick: () => delBox(b) }, "Delete box")));
    listWrap.replaceChildren(
      h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px" },
        h("h1", {}, "📦 Boxes"),
        h("button", { class: "btn btn--primary btn--sm", onclick: addBox }, "+ New box")),
      project.boxes.length ? h("div", {}, ...cards)
        : h("div", { class: "empty" }, h("div", { class: "big" }, "📦"), h("p", {}, "No boxes yet."),
            h("button", { class: "btn btn--primary", style: "max-width:200px;margin:8px auto 0", onclick: addBox }, "+ New box")));
    labels.replaceChildren(...buildLabels());
  }
  function addBox() { project.boxes.push(newBox(project.boxes.length + 1)); Store.put(project); paint(); }
  function delBox(b) {
    if (!confirm("Delete " + b.label + "? Items stay in inventory but become unassigned.")) return;
    project.contents.forEach((it) => { if (it.boxId === b.id) it.boxId = ""; });
    project.boxes = project.boxes.filter((x) => x.id !== b.id);
    Store.put(project); paint();
  }
  // printable labels (one card per box)
  const labels = h("div", { class: "print-only boxlabels" });
  function buildLabels() {
    return project.boxes.map((b) => {
      const qr = h("div", { class: "boxlabel__qr" });
      const payload = [
        "ROYBAL RESTORATION", "Box: " + b.label,
        "Job: " + (project.customer || ""), "Claim: " + (project.claimNo || ""),
        "Room: " + (b.room || ""), "Dest: " + (b.destination || ""),
        "Items: " + countItems(b.id),
      ].join("\n");
      qrSvg(payload, 3, 1).then((svg) => { qr.innerHTML = svg; }).catch(() => {});
      return h("div", { class: "boxlabel" },
        h("div", { class: "boxlabel__top" },
          h("div", {},
            h("div", { class: "boxlabel__co" }, "ROYBAL RESTORATION"),
            h("div", { class: "boxlabel__no" }, b.label)),
          qr),
        h("table", { class: "boxlabel__meta" },
          h("tr", {}, h("td", {}, "Customer"), h("td", {}, project.customer || "")),
          h("tr", {}, h("td", {}, "Claim #"), h("td", {}, project.claimNo || "")),
          h("tr", {}, h("td", {}, "Room"), h("td", {}, b.room || "")),
          h("tr", {}, h("td", {}, "Destination"), h("td", {}, b.destination || "")),
          h("tr", {}, h("td", {}, "Packed by"), h("td", {}, (b.packedBy || "") + (b.packedDate ? "  " + fmtDate(b.packedDate) : ""))),
          h("tr", {}, h("td", {}, "Items"), h("td", {}, String(countItems(b.id))))));
    });
  }

  body.append(listWrap, labels);
  paint();
  if (project.boxes.length) {
    body.append(h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Done"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "🏷️ Print box labels")));
  }
}

function contentsReportPage(project) {
  setChrome("Contents PDF", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  setCtx(project, null);
  body.append(
    h("p", { class: "subtle app-only" }, "Contents inventory for the carrier. Tap “Save as PDF,” then share."),
    RENDERERS.contents(project),
    h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Back"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Save as PDF")));
}

/* ---------- CSV export ---------- */
function contentsCSV(project) {
  const boxLabel = (id) => boxLabelOf(project, id);
  const header = ["Item", "Qty", "Category", "Room", "Box", "Condition", "Disposition",
    "Unit RCV", "Ext RCV", "Age (yrs)", "Depr %", "ACV", "Brand", "Model", "Returned", "Notes"];
  const rows = (project.contents || []).map((it) => {
    const d = depreciation(it);
    return csvRow([
      it.name, it.qty, it.category, it.room, boxLabel(it.boxId), it.condition, dispositionLabel(it.disposition),
      Number(it.value) || 0, d.rcv, it.age, Math.round(d.rate * 100), d.acv.toFixed(2),
      it.brand, it.model, it.returned ? "Yes" : "No", it.notes,
    ]);
  });
  return [csvRow(header), ...rows].join("\r\n");
}
function exportContentsCSV(project) {
  if (!project.contents || !project.contents.length) return toast("No items to export");
  const safe = (project.customer || "job").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const ok = downloadFile(`contents-${safe}.csv`, contentsCSV(project), "text/csv;charset=utf-8");
  toast(ok ? "CSV exported" : "Export not supported here");
}

/* ---------- Pack-back checklist + receipt ---------- */
function contentsPackBack(project) {
  setChrome("Pack-back", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  const total = project.contents.length;
  const prog = h("div", { class: "warn app-only" });
  const refresh = () => {
    const r = project.contents.filter((i) => i.returned).length;
    prog.replaceChildren(h("strong", {}, `Returned ${r} of ${total}`),
      total ? `  ·  ${Math.round((r / total) * 100)}% complete` : "");
  };

  const receipt = packBackReceipt(project);
  receipt.addEventListener("change", refresh);   // checkboxes live in the sheet
  body.append(prog, receipt,
    h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Done"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Print receipt")));
  refresh();
}

/* ============================================================
   Project edit — shared job header
   ============================================================ */
function projectEdit(project) {
  setChrome("Edit job", `#/p/${project.id}`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  const f = (label, key, opts = {}) => {
    const el = h("input", { type: opts.type || "text", value: project[key] ?? "", placeholder: opts.placeholder || "" });
    el.addEventListener("input", () => { project[key] = el.value; Store.put(project); });
    return h("div", { class: "field" }, h("label", {}, label), el);
  };

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px" },
      h("h1", {}, "Job details"), pill),
    h("p", { class: "subtle" }, "Enter this once — it flows into every form."),
    h("div", { class: "card" },
      h("div", { class: "grid2" }, f("Customer / Owner", "customer"), f("Phone", "phone", { type: "tel" })),
      f("Property Address", "address"),
      h("div", { class: "grid2" }, f("Email", "email", { type: "email" }), f("Work Order #", "workOrderNo")),
      h("div", { class: "grid2" }, f("Claim #", "claimNo"), f("Date of Loss", "dateOfLoss", { type: "date" })),
      h("div", { class: "grid2" }, f("Insurance Carrier", "carrier"), f("Adjuster", "adjuster")),
      f("Loss Cause", "lossCause")));

  const cat = (key, vals) => {
    const wrap = h("div", { class: "seg" });
    vals.forEach((v) => {
      const b = h("button", { type: "button", class: String(project[key]) === String(v.value) ? "active" : "" }, v.label);
      b.addEventListener("click", () => {
        project[key] = String(project[key]) === String(v.value) ? "" : v.value;
        [...wrap.children].forEach((c) => c.classList.remove("active"));
        if (project[key] !== "") b.classList.add("active");
        Store.put(project);
      });
      wrap.append(b);
    });
    return wrap;
  };
  body.append(
    h("div", { class: "card" },
      h("h2", { style: "margin-top:0" }, "Loss classification"),
      h("div", { class: "field" }, h("label", {}, "Water Category (IICRC S500)"),
        cat("waterCategory", [{ value: "1", label: "Cat 1 — Clean" }, { value: "2", label: "Cat 2 — Gray" }, { value: "3", label: "Cat 3 — Black" }])),
      h("div", { class: "field" }, h("label", {}, "Class of Water"),
        cat("waterClass", [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }])),
      h("div", { class: "field" }, h("label", {}, "Drying System"),
        cat("dryingSystem", [{ value: "Open", label: "Open" }, { value: "Closed", label: "Closed" }, { value: "Hybrid", label: "Hybrid" }]))));

  body.append(
    h("button", { class: "btn btn--primary", style: "margin-top:6px", onclick: () => go(`#/p/${project.id}`) }, "Done — go to forms"),
    h("button", { class: "btn btn--danger", style: "margin-top:10px", onclick: () => deleteProject(project) }, "Delete job"));
}

async function deleteProject(project) {
  if (!confirm("Delete this entire job and all its forms? This cannot be undone.")) return;
  await Store.del(project.id);
  toast("Job deleted");
  go("#/");
}

/* ---------- network status + service worker ---------- */
function updateNet() {
  const s = $("#netStatus");
  if (navigator.onLine) { s.classList.remove("off"); s.title = "Online"; }
  else { s.classList.add("off"); s.title = "Offline — your work is saved on this device"; }
}
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);
updateNet();

if ("serviceWorker" in navigator) {
  // auto-reload once when an updated service worker takes control
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }
    hadController = true;
  });
  window.addEventListener("load", () => {
    // updateViaCache:none => browser never serves a cached worker script
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      reg.update?.();                                  // check for a new version on open
      setInterval(() => reg.update?.(), 60 * 60 * 1000); // and hourly while open
    }).catch(() => {});
  });
}
