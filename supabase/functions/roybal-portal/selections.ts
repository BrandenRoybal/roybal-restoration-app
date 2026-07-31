/* ============================================================
   Customer-facing view of a selection sheet — the privacy boundary.

   portal_selections is an OFFICE table. It carries our loaded unit
   prices (lkq_unit_cost, lkq_total), the Xactimate category/selector
   codes, and the per-item cost rollup. None of that belongs in front of
   a customer:

     * the prices are our cost basis, not a quote, and there is no
       catalog yet to give them any context
     * the Cat/Sel codes are an interop key with Xactimate, meaningless
       to a homeowner and an invitation to argue line items

   customerSelection() is an ALLOW-LIST, not a delete-list — a column
   added to the table later cannot leak by being forgotten here.

   Pure and dependency-free so it can be unit-tested without Deno.
   ============================================================ */

export type Choice = "match" | "change";

export const NOTE_MAX = 500;

export interface SelectionRow {
  selection_id?: string;
  sort_order?: number;
  type?: string;
  label?: string;
  scope?: string;
  room?: string;
  rooms?: unknown;
  title?: string;
  descr?: string;
  qty?: number | string | null;
  unit?: string;
  items?: unknown;
  customer_choice?: string | null;
  customer_note?: string | null;
  responded_at?: string | null;
  // present on the row and deliberately NOT projected:
  // cat, sel, lkq_unit_cost, lkq_total, waste_pct, delta_cents, chosen_*
}

const str = (v: unknown) => (v == null ? "" : String(v));
const numOrNull = (v: unknown) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* One decision, as the customer may see it. */
export function customerSelection(row: SelectionRow) {
  const items = Array.isArray(row.items) ? row.items : [];
  return {
    id: str(row.selection_id),
    title: str(row.title),
    label: str(row.label),
    scope: str(row.scope) || "room",
    room: str(row.room),
    rooms: Array.isArray(row.rooms) ? row.rooms.map(str) : [],
    // what we are putting back, in plain words + how much of it
    what: str(row.descr),
    qty: numOrNull(row.qty),
    unit: str(row.unit),
    // the companion pieces ("carpet pad"), described but never priced
    alsoIncludes: items
      .map((it) => (it && typeof it === "object" ? str((it as Record<string, unknown>).desc) : ""))
      .filter((d, i) => d && i > 0),
    choice: row.customer_choice === "match" || row.customer_choice === "change" ? row.customer_choice : null,
    note: str(row.customer_note),
    respondedAt: row.responded_at || null,
  };
}

/* The whole sheet, plus the progress the card shows. */
export function customerSheet(rows: SelectionRow[]) {
  const list = (rows || []).map(customerSelection);
  const answered = list.filter((s) => s.choice).length;
  const wantsChange = list.filter((s) => s.choice === "change").length;
  return {
    selections: list,
    total: list.length,
    answered,
    remaining: list.length - answered,
    wantsChange,
    complete: list.length > 0 && answered === list.length,
  };
}

/* Validate one incoming response. Throws the same short error codes the
   rest of the gateway uses, so serve()'s mapper turns them into 4xx. */
export function validateResponse(selectionId: unknown, choice: unknown, note: unknown) {
  const id = String(selectionId ?? "").trim();
  if (!id || id.length > 120 || !/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error("bad_selection");
  if (choice !== "match" && choice !== "change") throw new Error("bad_choice");
  const text = String(note ?? "").trim();
  if (text.length > NOTE_MAX) throw new Error("too_long");
  // A note only means anything alongside "something different".
  return { id, choice: choice as Choice, note: choice === "change" ? text : "" };
}

/* What the office is told on the thread when a sheet is submitted. Written
   as the customer, because it lands in their conversation. */
export function submissionMessage(sheet: { total: number; wantsChange: number }) {
  const n = sheet.wantsChange;
  if (!n) {
    return `I've gone through my ${sheet.total} selections — please put everything back the way it was.`;
  }
  return `I've gone through my ${sheet.total} selections. There ${n === 1 ? "is 1 item" : `are ${n} items`} ` +
    `I'd like to talk about changing — the rest can go back the way ${n === 1 ? "it" : "they"} w${n === 1 ? "as" : "ere"}.`;
}
