/* Meter reading — the pure half (no Deno, no network).
   A crew member photographs the moisture meter's screen beside a reading on
   the Moisture Map; `meterRead` (index.ts) sends that one photo here-shaped
   and the field app (meterphotos.js applyMeterRead) keeps the read on the
   photo. The photo is the evidence; the number is only ever a prefill a
   person confirms (doc 03 §6.15, "prefill, never commit"). Everything the
   model returns passes through normalizeMeterRead, so a garbled read can
   never put anything but a plain decimal into a reading cell.
   Tested by meter.test.mjs. */

export const METER_UNITS = ["%", "REL", "scale", "other", ""] as const;
export const METER_DEVICES = ["moisture_meter", "thermo_hygrometer", "other"] as const;

export const METER_READ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["device", "readable", "value", "unit", "mode", "confidence", "note"],
  properties: {
    device: { type: "string", enum: ["moisture_meter", "thermo_hygrometer", "other"], description: "moisture_meter = a pin or pinless moisture meter (Protimeter, Tramex, Delmhorst, FLIR…); thermo_hygrometer = shows air temperature and RH; other = anything else or no display in the photo" },
    readable: { type: "boolean", description: "true only when the main number on the display can be read with certainty, every digit and the decimal point" },
    value: { type: "string", description: "The main reading exactly as displayed, digits and at most one '.', e.g. '17.4', '8', '112'. No unit, no % sign, no spaces. Empty when not readable" },
    unit: { type: "string", enum: ["%", "REL", "scale", "other", ""], description: "% = percent moisture content (%MC or %WME shown); REL = a relative/reference/search-mode number; scale = a numbered material scale (e.g. Tramex scale 1-3); other; empty when unclear" },
    mode: { type: "string", description: "What the screen says about the mode or setting, e.g. 'Pin WME', 'Search REL', 'Scale 2', 'Drywall'; empty when nothing is shown" },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are of every digit and the decimal point" },
    note: { type: "string", description: "One short line a technician would act on: why it is unreadable (glare, blur, cut off, screen off) or what else is shown (HOLD, low battery, a second number); empty when nothing" },
  },
} as const;

export const METER_SYSTEM =
  "You read moisture meter displays for Roybal Construction, LLC (water damage restoration, Fairbanks Alaska). " +
  "A technician photographed the meter's screen at a reading location; your read is shown to them as a suggestion " +
  "to confirm, and the photo is kept as evidence. Report only what the display shows. A wrong number is worse " +
  "than no number: when any digit or the decimal point is uncertain, say it is not readable. " +
  "Call `meter` with the structured result.";

/** The prompt text, with what the crew typed for this map's meter and
    material as context (never as the answer). */
export function meterReadText(hint: { meter?: unknown; material?: unknown } = {}): string {
  const clean = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const meter = clean(hint.meter), material = clean(hint.material);
  return (
    "Read the main number on this meter display.\n" +
    (meter ? `The crew's moisture map says the meter / setting is: ${meter}\n` : "") +
    (material ? `Material being read: ${material}\n` : "") +
    "RULES:\n" +
    "- value: the LARGE primary reading only, digits exactly as displayed. Ignore small annunciators (HOLD, MAX, MIN, " +
    "AUTO), bar graphs, battery icons, scale labels and any smaller secondary number.\n" +
    "- Most of these screens are seven-segment LCDs. Check each digit segment by segment: 1 vs 7, 5 vs 6, 6 vs 8, " +
    "8 vs 0 vs 9, 3 vs 9. The decimal point is a small dot low between digits; include it only when you can see it.\n" +
    "- readable is false, and value empty, when the screen is off, blurred, glared, cut off, too far away, or any digit " +
    "is uncertain. Never guess and never round.\n" +
    "- unit: '%' when the screen shows % / %MC / WME; 'REL' for a relative, reference or search-mode number; 'scale' " +
    "for a numbered material scale; otherwise empty.\n" +
    "- device: thermo_hygrometer when the screen shows air temperature and RH rather than a moisture reading; then " +
    "value is the RH number if readable, and say so in note."
  );
}

export type MeterRead = {
  device: string; readable: boolean; value: string; unit: string; mode: string;
  confidence: number; note: string;
  /** readable, a moisture meter, and a plain decimal: the only read the
      field app may ever offer as a cell value */
  fillable: boolean;
};

const VALUE_RE = /^\d{1,3}(\.\d{1,2})?$/;

/** Never throws: a thin or garbled tool input comes back as "not readable". */
export function normalizeMeterRead(input: unknown): MeterRead {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, max = 160) => (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, max);
  const device = (METER_DEVICES as readonly string[]).includes(str(o.device)) ? str(o.device) : "other";
  const unit = (METER_UNITS as readonly string[]).includes(str(o.unit)) ? str(o.unit) : "other";
  let c = Number(o.confidence);
  if (!Number.isFinite(c)) c = 0;
  const confidence = Math.round(Math.min(1, Math.max(0, c)) * 100) / 100;
  // "17,4" → "17.4", "17.4 %" → "17.4", "07.5" → "7.5"; anything else is not a number we offer
  let value = str(o.value, 20).replace(/\s+/g, "").replace(",", ".").replace(/%$/, "");
  value = value.replace(/^0+(?=\d)/, "");
  let readable = o.readable === true;
  if (!VALUE_RE.test(value)) { value = ""; readable = false; }
  if (!readable) value = "";
  return {
    device, readable, value, unit, mode: str(o.mode, 60), confidence, note: str(o.note),
    fillable: readable && device === "moisture_meter" && value !== "",
  };
}

/** METER_READ: what the reader does. "check" (the default) reads and records
    the number on the photo but the field app fills nothing — the state until
    the reader has passed its test. "fill" lets the field app prefill an empty
    reading cell for the tech to confirm. "off" stops reading (no AI spend);
    photos are still kept. Anything unrecognised means "check". */
export function meterReadMode(raw: string | undefined | null): "off" | "check" | "fill" {
  const v = String(raw ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(v)) return "off";
  if (["fill", "on", "true", "1", "yes"].includes(v)) return "fill";
  return "check";
}

/** Which photo and cell a read was for (from the field app's request), for
    the server's record of the read: matched later to the number the tech
    typed in that cell, which is how the reader is tested before "fill".
    Ids are uid strings; anything else is dropped. Never sent to the model. */
export function meterRef(body: Record<string, unknown> | null | undefined) {
  const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : "");
  const b = body && typeof body === "object" ? body : {};
  const loc = typeof b.loc === "number" && Number.isInteger(b.loc) && b.loc >= 0 && b.loc < 1000 ? b.loc : null;
  return { photoId: id(b.photoId), mapId: id(b.mapId), rowKey: id(b.rowKey), loc };
}
