/* ============================================================
   Roybal Field Forms — app shell + hash router
   ============================================================ */
import { h, $, clear, Store, toast, fmtDate } from "./core.js";
import {
  FORMS, formByKey, formCount, newProject,
  newMoistureMap, newDryingLog, newConstructionLog, newChangeOrder,
  newInvoice, newWorkAuth, newCertDrying,
} from "./model.js";
import { setCtx } from "./formkit.js";
import { RENDERERS } from "./forms.js";

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
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  window.scrollTo(0, 0);
  // parts: [] | ['new'] | ['p', id] | ['p', id, 'edit'] | ['p', id, 'f', key] | ['p', id, 'f', key, instId]
  if (parts[0] === "new") return void (await createProject());
  if (parts[0] === "p" && parts[1]) {
    const project = await Store.get(parts[1]);
    if (!project) return go("#/");
    if (parts[2] === "edit") return projectEdit(project);
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

function installHint() {
  return h("div", { class: "note", style: "margin-top:18px" },
    h("strong", {}, "Tip: "),
    "Add this app to your home screen (Share → “Add to Home Screen”) to launch it like a regular app and use it with no signal in the field.");
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

  body.append(h("button", { class: "btn btn--ghost btn--sm", style: "margin-bottom:14px", onclick: () => go(`#/p/${project.id}/edit`) }, "✎ Edit job details"));

  const tiles = h("div", { class: "tiles" });
  FORMS.forEach((f) => {
    const count = formCount(project, f.key);
    const badge = f.multi
      ? h("span", { class: "tile__count" }, count ? `${count} saved` : "None yet")
      : h("span", { class: "tile__badge " + (count ? "done" : "todo") }, count ? "Started" : "Not started");
    tiles.append(h("a", { class: "tile" + (f.hero ? " tile--hero" : ""), href: `#/p/${project.id}/f/${f.key}` },
      h("div", { class: "tile__icon" }, f.icon),
      h("div", { class: "tile__name" }, f.name),
      h("div", { class: "tile__count" }, f.blurb),
      badge));
  });
  body.append(tiles);
}

/* ============================================================
   Form page — list for multi forms, editor for single/instance
   ============================================================ */
async function formPage(project, key, instId) {
  const meta = formByKey(key);
  if (!meta) return go(`#/p/${project.id}`);

  // single-instance forms: open editor directly
  if (!meta.multi) {
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
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
