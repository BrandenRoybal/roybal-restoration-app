/* ============================================================
   Roybal Field Forms — Magicplan floor plans as plan images (M3)
   ------------------------------------------------------------
   The sync copies each floor's SVG into field-media next to the report
   (design §4.1 floors_svg → siteVisit.magicplan.floors[{floor, path}]).
   Two forms already take a plan IMAGE — the Moisture Map's sketch
   background and the Scope of Work's reference plans — as a raster data
   URL (forms.js fileToFloorPlan / referencePlans). This module turns a
   floor SVG into that same raster so those forms need no new field.

   Pure (Node-tested in test/magicplanplan.test.mjs): magicplanFloors,
   svgWithSize. DOM: rasterizeSvg, magicplanPlanImage, magicplanPlanChips.
   ============================================================ */
import { h, toast } from "./core.js";
import { downloadSiteFile } from "./supa.js";

const arr = (v) => (Array.isArray(v) ? v : []);

/** The floors that have an SVG on file: [{floor, path}], scan order. */
export function magicplanFloors(project) {
  const sv = project && project.siteVisit && typeof project.siteVisit === "object" ? project.siteVisit : {};
  const mp = sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : {};
  return arr(mp.floors).filter((f) => f && typeof f.path === "string" && /\.svg$/i.test(f.path))
    .map((f, i) => ({ floor: String(f.floor || "").trim() || `Floor ${i + 1}`, path: f.path }));
}

/* Safari draws an <img> of an SVG at 0×0 when the root has no pixel width and
   height (a viewBox alone is not enough), and a canvas can't rasterize that.
   Give the root explicit pixel dimensions from its viewBox, scaled so the
   longer side is maxDim; keep everything else byte for byte. */
const num = (v) => { const x = parseFloat(String(v)); return Number.isFinite(x) && x > 0 ? x : 0; };
export function svgWithSize(svgText, maxDim = 2200) {
  const text = String(svgText || "");
  const m = text.match(/<svg\b[^>]*>/i);
  if (!m) return null;
  const open = m[0];
  const attr = (name) => { const r = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(open); return r ? r[1] : ""; };
  const vb = attr("viewBox").trim().split(/[\s,]+/).map(Number);
  let w = num(attr("width")), hgt = num(attr("height"));
  const unitless = (v) => /^\s*[\d.]+\s*(px)?\s*$/i.test(v);
  if (!(w && hgt && unitless(attr("width")) && unitless(attr("height")))) {
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; hgt = vb[3]; }
    else if (!(w && hgt)) return null;
  }
  const scale = maxDim / Math.max(w, hgt);   // longer side = maxDim: crisp for a small viewBox, bounded for a huge one
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(hgt * scale));
  let root = open.replace(/\swidth\s*=\s*["'][^"']*["']/i, "").replace(/\sheight\s*=\s*["'][^"']*["']/i, "");
  if (!/viewBox/i.test(root)) root = root.replace(/<svg\b/i, `<svg viewBox="0 0 ${w} ${hgt}"`);
  root = root.replace(/<svg\b/i, `<svg width="${W}" height="${H}"`);
  return { svg: text.replace(open, root), width: W, height: H };
}

/** SVG text → JPEG data URL on a white sheet (the sketch pad and the printed
    packet both want an opaque raster). */
export function rasterizeSvg(svgText, { maxDim = 2200, quality = 0.85 } = {}) {
  return new Promise((resolve, reject) => {
    const sized = svgWithSize(svgText, maxDim);
    if (!sized) return reject(new Error("That floor plan isn't a drawable SVG"));
    const blob = new Blob([sized.svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't draw the floor plan")); };
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = sized.width; c.height = sized.height;
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", quality));
      } catch (e) { reject(e); }
      finally { URL.revokeObjectURL(url); }
    };
    img.src = url;
  });
}

/** One floor of this job's Magicplan scan as a plan image data URL. */
export async function magicplanPlanImage(project, floor) {
  const blob = await downloadSiteFile(floor.path);
  if (!blob) throw new Error("That floor plan is no longer in storage — ⟳ Pull the scan again");
  return rasterizeSvg(await blob.text());
}

/** "📐 Use Magicplan floor plan" — one chip per floor; onPick(dataUrl, floor).
    Renders nothing when the job has no scan on file, so the forms stay as
    they are on every other job. */
export function magicplanPlanChips(project, { onPick, label = "Use Magicplan floor plan" } = {}) {
  const floors = magicplanFloors(project);
  const box = h("div", { class: "app-only", style: "display:flex;gap:6px;flex-wrap:wrap" });
  if (!floors.length) return box;
  for (const f of floors) {
    const chip = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" },
      `📐 ${label}${floors.length > 1 ? ": " + f.floor : ""}`);
    chip.addEventListener("click", async () => {
      chip.disabled = true;
      toast("Drawing the Magicplan floor plan…", 4000);
      try { await onPick(await magicplanPlanImage(project, f), f); }
      catch (e) { toast((e && e.message) || "Couldn't load the floor plan", 4000); }
      chip.disabled = false;
    });
    box.append(chip);
  }
  return box;
}
