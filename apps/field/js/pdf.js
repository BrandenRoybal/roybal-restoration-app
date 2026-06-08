/* ============================================================
   Roybal Field Forms — floor-plan import (lazy-loaded pdf.js)
   Converts an imported PDF (or image) into a raster image the
   tech can draw moisture markers on top of in the Moisture Map.
   pdf.js is only loaded the first time a PDF is imported.
   ============================================================ */
import { fileToDataURL } from "./core.js";

let _pdfjs;
async function lib() {
  if (!_pdfjs) {
    _pdfjs = await import("../assets/vendor/pdfjs/pdf.min.mjs");
    _pdfjs.GlobalWorkerOptions.workerSrc =
      new URL("../assets/vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  }
  return _pdfjs;
}

/** Render page 1 of a PDF File to a JPEG data URL. */
export async function pdfToImage(file, { scale = 2, maxDim = 2200 } = {}) {
  const buf = await file.arrayBuffer();
  const pdfjs = await lib();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  let viewport = page.getViewport({ scale });
  const longest = Math.max(viewport.width, viewport.height);
  if (longest > maxDim) viewport = page.getViewport({ scale: (scale * maxDim) / longest });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Accept a PDF or image File and return a background image data URL. */
export async function fileToFloorPlan(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  if (isPdf) return pdfToImage(file);
  return fileToDataURL(file, 2200, 0.85);
}
