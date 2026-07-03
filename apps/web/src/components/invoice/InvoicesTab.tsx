/**
 * Invoices tab — Xactimate-style invoice builder.
 *
 * - Create invoices manually or generate a draft with AI from all job data
 *   (field forms, moisture readings, equipment logs, photo analysis, floor plan)
 * - Fully editable line items with a price-catalog picker
 * - Overhead / profit / tax controls, PDF export
 */

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { generateInvoiceDraft, detectSupplements } from "../../lib/ai";
import type { InvoiceDraftItem, SupplementSuggestion } from "../../lib/ai";
import type { Job, Room, Invoice, InvoiceItem, InvoiceStatus, FPRoom } from "@roybal/shared";
import {
  centsToDisplay,
  formatAlaskaDate,
  computeInvoiceTotals,
  INVOICE_STATUS_LABELS,
  INVOICE_CATEGORY_LABELS,
  PRICE_CATALOG,
  InvoiceReport,
} from "@roybal/shared";
import { pdf } from "@react-pdf/renderer";
import React from "react";
import { polygonArea, wallLength } from "../floorplan/geometry";
import { Plus, Trash2, RefreshCw, FileDown, Sparkles, X, ChevronLeft, Send } from "lucide-react";
import clsx from "clsx";

interface Props {
  job: Job;
  rooms: Room[];
}

/** Local editable row (prices in dollars-as-string for friendly editing) */
interface EditRow {
  localId: string;
  room_name: string;
  code: string;
  category: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string; // dollars
  notes: string;
  source: "ai" | "manual" | "scope";
}

const UNITS = ["EA", "SF", "LF", "HR", "Day", "LS", "CY", "SY", "CF"];

const emptyRow = (): EditRow => ({
  localId: crypto.randomUUID(),
  room_name: "",
  code: "",
  category: "OTH",
  description: "",
  quantity: "1",
  unit: "EA",
  unit_price: "",
  notes: "",
  source: "manual",
});

const draftItemToRow = (it: InvoiceDraftItem): EditRow => ({
  localId: crypto.randomUUID(),
  room_name: it.room_name ?? "",
  code: it.code ?? "",
  category: it.category,
  description: it.description,
  quantity: String(it.quantity),
  unit: it.unit,
  unit_price: (it.unit_price / 100).toFixed(2),
  notes: it.notes ?? "",
  source: "ai",
});

const itemToRow = (it: InvoiceItem): EditRow => ({
  localId: it.id,
  room_name: it.room_name ?? "",
  code: it.code ?? "",
  category: it.category,
  description: it.description,
  quantity: String(it.quantity),
  unit: it.unit,
  unit_price: (it.unit_price / 100).toFixed(2),
  notes: it.notes ?? "",
  source: it.source,
});

const rowTotalCents = (r: EditRow) =>
  Math.round(parseFloat(r.quantity || "0") * Math.round(parseFloat(r.unit_price || "0") * 100));

export default function InvoicesTab({ job, rooms }: Props) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, { count: number; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // AI generation
  const [generating, setGenerating] = useState(false);

  // Editor state
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [header, setHeader] = useState({ title: "", invoice_date: "", report_type: "invoice", status: "draft" as InvoiceStatus, overhead: "10", markup: "10", tax: "0", notes: "" });
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [catalogPick, setCatalogPick] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Supplement detection
  const [supplements, setSupplements] = useState<SupplementSuggestion[] | null>(null);
  const [checkingSupplements, setCheckingSupplements] = useState(false);

  const loadInvoices = async () => {
    const [inv, items] = await Promise.all([
      supabase.from("invoices").select("*").eq("job_id", job.id).order("created_at", { ascending: false }),
      supabase.from("invoice_items").select("invoice_id, total_cents").eq("job_id", job.id),
    ]);
    if (!inv.error) setInvoices((inv.data ?? []) as Invoice[]);
    const counts: Record<string, { count: number; total: number }> = {};
    for (const it of (items.data ?? []) as { invoice_id: string; total_cents: number }[]) {
      counts[it.invoice_id] = {
        count: (counts[it.invoice_id]?.count ?? 0) + 1,
        total: (counts[it.invoice_id]?.total ?? 0) + it.total_cents,
      };
    }
    setItemCounts(counts);
    setLoading(false);
  };

  useEffect(() => { loadInvoices(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [job.id]);

  // ---- Floor plan areas (for AI quantity estimation) ----
  const loadRoomAreas = async () => {
    const { data: plans } = await supabase
      .from("manual_floor_plans").select("id").eq("job_id", job.id).limit(1);
    const plan = plans?.[0];
    if (!plan) return undefined;
    const { data: fpRooms } = await supabase
      .from("floor_plan_rooms").select("*").eq("plan_id", plan.id);
    if (!fpRooms?.length) return undefined;
    const areas: Record<string, { floor_area: number; perimeter: number; net_wall_area: number; height: number }> = {};
    for (const r of fpRooms as FPRoom[]) {
      const floor = polygonArea(r.points);
      let perimeter = 0;
      for (let i = 0; i < r.points.length; i++) perimeter += wallLength(r, i);
      areas[r.name] = {
        floor_area: floor,
        perimeter,
        net_wall_area: perimeter * r.height,
        height: r.height,
      };
    }
    return areas;
  };

  // ---- Create ----
  const createInvoice = async (opts: { ai: boolean }) => {
    setError("");
    try {
      let title = `${job.loss_type ? job.loss_type.charAt(0).toUpperCase() + job.loss_type.slice(1) : "Restoration"} Mitigation — ${job.property_address}`;
      let notes: string | null = null;
      let draftRows: EditRow[] = [];

      if (opts.ai) {
        setGenerating(true);
        const roomAreas = await loadRoomAreas();
        const { draft } = await generateInvoiceDraft(job.id, roomAreas);
        title = draft.title || title;
        notes = draft.notes;
        draftRows = draft.items.map(draftItemToRow);
      }

      const { data: userData } = await supabase.auth.getUser();
      const { data: invoice, error: iErr } = await supabase
        .from("invoices")
        .insert({
          job_id: job.id,
          title,
          notes,
          ai_generated: opts.ai,
          created_by: userData?.user?.id ?? null,
        })
        .select()
        .single();
      if (iErr || !invoice) throw new Error(iErr?.message ?? "Failed to create invoice");

      if (draftRows.length) {
        const { error: itErr } = await supabase.from("invoice_items").insert(
          draftRows.map((r, i) => rowToInsert(r, invoice.id as string, i))
        );
        if (itErr) throw new Error(itErr.message);
      }

      await loadInvoices();
      openEditor(invoice as Invoice, draftRows.length ? draftRows : [emptyRow()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create invoice");
    }
    setGenerating(false);
  };

  const rowToInsert = (r: EditRow, invoiceId: string, sortOrder: number) => ({
    invoice_id: invoiceId,
    job_id: job.id,
    room_name: r.room_name.trim() || null,
    code: r.code.trim() || null,
    category: r.category,
    description: r.description.trim(),
    quantity: parseFloat(r.quantity || "0"),
    unit: r.unit,
    unit_price: Math.round(parseFloat(r.unit_price || "0") * 100),
    notes: r.notes.trim() || null,
    source: r.source,
    sort_order: sortOrder,
  });

  // ---- Editor ----
  const openEditor = async (invoice: Invoice, prefilledRows?: EditRow[]) => {
    setEditing(invoice);
    setHeader({
      title: invoice.title,
      invoice_date: invoice.invoice_date,
      report_type: invoice.report_type,
      status: invoice.status,
      overhead: String(invoice.overhead_percent),
      markup: String(invoice.markup_percent),
      tax: String(invoice.tax_percent),
      notes: invoice.notes ?? "",
    });
    if (prefilledRows) {
      setRows(prefilledRows);
    } else {
      const { data } = await supabase
        .from("invoice_items").select("*").eq("invoice_id", invoice.id).order("sort_order");
      const items = (data ?? []) as InvoiceItem[];
      setRows(items.length ? items.map(itemToRow) : [emptyRow()]);
    }
  };

  const saveInvoice = async (): Promise<boolean> => {
    if (!editing) return false;
    setSaving(true);
    setError("");
    try {
      const { error: uErr } = await supabase.from("invoices").update({
        title: header.title.trim(),
        invoice_date: header.invoice_date,
        report_type: header.report_type,
        status: header.status,
        overhead_percent: parseFloat(header.overhead || "0"),
        markup_percent: parseFloat(header.markup || "0"),
        tax_percent: parseFloat(header.tax || "0"),
        notes: header.notes.trim() || null,
      }).eq("id", editing.id);
      if (uErr) throw new Error(uErr.message);

      // Replace items wholesale — simplest way to persist edits/reorders/deletes
      const validRows = rows.filter((r) => r.description.trim());
      const { error: dErr } = await supabase.from("invoice_items").delete().eq("invoice_id", editing.id);
      if (dErr) throw new Error(dErr.message);
      if (validRows.length) {
        const { error: itErr } = await supabase.from("invoice_items").insert(
          validRows.map((r, i) => rowToInsert(r, editing.id, i))
        );
        if (itErr) throw new Error(itErr.message);
      }
      await loadInvoices();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save invoice");
      setSaving(false);
      return false;
    }
    setSaving(false);
    return true;
  };

  // ---- QuickBooks Online push ----
  const [pushingQbo, setPushingQbo] = useState(false);
  const [qboMsg, setQboMsg] = useState("");

  const pushToQuickBooks = async () => {
    if (!editing) return;
    setPushingQbo(true);
    setQboMsg("");
    setError("");
    try {
      // Persist the current edits first so QBO matches what's on screen
      const saved = await saveInvoice();
      if (!saved) throw new Error("Save failed — fix the error above and try again");
      const { data, error: fnErr } = await supabase.functions.invoke("qbo-proxy", {
        body: { action: "pushInvoice", invoiceId: editing.id },
      });
      if (fnErr) throw new Error(fnErr.message ?? "QuickBooks push failed");
      if (!data?.ok) throw new Error(data?.error ?? "QuickBooks push failed");
      const r = data.data as { docNumber: string; total: number; updated: boolean };
      setQboMsg(`${r.updated ? "Updated" : "Created"} QuickBooks invoice ${r.docNumber} — $${r.total.toFixed(2)}`);
      const { data: fresh } = await supabase.from("invoices").select("*").eq("id", editing.id).single();
      if (fresh) setEditing(fresh as Invoice);
      await loadInvoices();
    } catch (e) {
      setError(e instanceof Error ? e.message : "QuickBooks push failed");
    }
    setPushingQbo(false);
  };

  const deleteInvoice = async (invoiceId: string) => {
    await supabase.from("invoices").delete().eq("id", invoiceId);
    setConfirmDeleteId(null);
    if (editing?.id === invoiceId) setEditing(null);
    await loadInvoices();
  };

  const updateRow = (localId: string, patch: Partial<EditRow>) =>
    setRows((prev) => prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));

  // ---- Supplement detection ----
  const runSupplementCheck = async () => {
    setCheckingSupplements(true);
    setError("");
    try {
      const currentItems = rows
        .filter((r) => r.description.trim())
        .map((r) => ({
          room_name: r.room_name.trim() || null,
          code: r.code.trim() || null,
          description: r.description.trim(),
          quantity: parseFloat(r.quantity || "0"),
          unit: r.unit,
        }));
      const { suggestions } = await detectSupplements(job.id, currentItems);
      setSupplements(suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Supplement check failed");
    }
    setCheckingSupplements(false);
  };

  const addSuggestion = (s: SupplementSuggestion) => {
    setRows((prev) => [
      ...prev,
      {
        localId: crypto.randomUUID(),
        room_name: s.room_name ?? "",
        code: s.code ?? "",
        category: s.category,
        description: s.description,
        quantity: String(s.quantity),
        unit: s.unit,
        unit_price: (s.unit_price / 100).toFixed(2),
        notes: s.reason,
        source: "ai",
      },
    ]);
    setSupplements((prev) => (prev ? prev.filter((x) => x !== s) : prev));
  };

  const addFromCatalog = (code: string) => {
    const item = PRICE_CATALOG.find((c) => c.code === code);
    if (!item) return;
    setRows((prev) => [
      ...prev,
      {
        ...emptyRow(),
        code: item.code,
        category: item.category,
        description: item.description,
        unit: item.unit,
        unit_price: (item.unit_price / 100).toFixed(2),
      },
    ]);
    setCatalogPick("");
  };

  const totals = useMemo(() => {
    const items = rows.filter((r) => r.description.trim()).map((r) => ({ total_cents: rowTotalCents(r) }));
    return computeInvoiceTotals(
      items,
      parseFloat(header.overhead || "0"),
      parseFloat(header.markup || "0"),
      parseFloat(header.tax || "0")
    );
  }, [rows, header.overhead, header.markup, header.tax]);

  const downloadPdf = async () => {
    if (!editing) return;
    setDownloading(true);
    try {
      const invoiceForPdf: Invoice = {
        ...editing,
        title: header.title,
        invoice_date: header.invoice_date,
        report_type: header.report_type as Invoice["report_type"],
        status: header.status,
        overhead_percent: parseFloat(header.overhead || "0"),
        markup_percent: parseFloat(header.markup || "0"),
        tax_percent: parseFloat(header.tax || "0"),
        notes: header.notes.trim() || null,
      };
      const itemsForPdf: InvoiceItem[] = rows
        .filter((r) => r.description.trim())
        .map((r, i) => ({
          id: r.localId,
          invoice_id: editing.id,
          job_id: job.id,
          room_name: r.room_name.trim() || null,
          code: r.code.trim() || null,
          category: r.category,
          description: r.description.trim(),
          quantity: parseFloat(r.quantity || "0"),
          unit: r.unit,
          unit_price: Math.round(parseFloat(r.unit_price || "0") * 100),
          total_cents: rowTotalCents(r),
          notes: r.notes.trim() || null,
          source: r.source,
          sort_order: i,
          created_at: "",
          updated_at: "",
        }));
      const element = React.createElement(InvoiceReport, {
        job,
        invoice: invoiceForPdf,
        items: itemsForPdf,
        narrative: job.narrative,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = await pdf(element as any).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${editing.invoice_number}-${header.report_type}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError("PDF generation failed: " + (e instanceof Error ? e.message : String(e)));
    }
    setDownloading(false);
  };

  const STATUS_STYLE: Record<InvoiceStatus, string> = {
    draft: "bg-slate-500/15 text-slate-400",
    sent: "bg-blue-500/15 text-blue-400",
    paid: "bg-green-500/15 text-green-400",
  };

  const inputCls = "bg-[#0F172A] border border-[#1E293B] rounded-xl px-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#F97316]";

  // ============================================================
  // Editor view
  // ============================================================
  if (editing) {
    return (
      <div className="max-w-6xl">
        {/* Editor header */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-200 flex items-center gap-1 text-sm">
            <ChevronLeft size={16} /> All invoices
          </button>
          <span className="text-xs font-mono text-[#F97316]">{editing.invoice_number}</span>
          {editing.ai_generated && (
            <span className="flex items-center gap-1 text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full">
              <Sparkles size={11} /> AI draft — review before sending
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={downloadPdf} disabled={downloading}
              className="flex items-center gap-1.5 text-xs font-bold border border-[#1E293B] text-slate-300 hover:border-[#F97316]/40 hover:text-[#F97316] px-3 h-9 rounded-xl transition-colors disabled:opacity-50">
              {downloading ? <RefreshCw size={13} className="animate-spin" /> : <FileDown size={13} />} PDF
            </button>
            <button onClick={pushToQuickBooks} disabled={pushingQbo || saving}
              title="Save this invoice and create/update it in QuickBooks Online"
              className="flex items-center gap-1.5 text-xs font-bold bg-green-500/10 border border-green-500/40 text-green-400 hover:bg-green-500/20 px-3 h-9 rounded-xl transition-colors disabled:opacity-50">
              {pushingQbo ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
              {pushingQbo ? "Pushing…" : editing.qbo_invoice_id ? "Update in QuickBooks" : "Push to QuickBooks"}
            </button>
            <button onClick={saveInvoice} disabled={saving}
              className="flex items-center gap-1.5 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors disabled:opacity-50">
              {saving ? <RefreshCw size={14} className="animate-spin" /> : null}
              {saving ? "Saving…" : "Save Invoice"}
            </button>
          </div>
        </div>
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        {qboMsg && <p className="text-green-400 text-sm mb-3">✓ {qboMsg}{editing.qbo_synced_at ? ` · Last synced ${formatAlaskaDate(editing.qbo_synced_at)}` : ""}</p>}

        {/* Header fields */}
        <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5 mb-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Title</label>
              <input type="text" value={header.title} onChange={(e) => setHeader((h) => ({ ...h, title: e.target.value }))} className={clsx(inputCls, "w-full h-9")} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Date</label>
              <input type="date" value={header.invoice_date} onChange={(e) => setHeader((h) => ({ ...h, invoice_date: e.target.value }))} className={clsx(inputCls, "w-full h-9")} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Type / Status</label>
              <div className="flex gap-2">
                <select value={header.report_type} onChange={(e) => setHeader((h) => ({ ...h, report_type: e.target.value }))} className={clsx(inputCls, "flex-1 h-9")}>
                  <option value="invoice">Invoice</option>
                  <option value="estimate">Estimate</option>
                </select>
                <select value={header.status} onChange={(e) => setHeader((h) => ({ ...h, status: e.target.value as InvoiceStatus }))} className={clsx(inputCls, "flex-1 h-9")}>
                  {Object.entries(INVOICE_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            {(["overhead", "markup", "tax"] as const).map((k) => (
              <div key={k}>
                <label className="block text-xs text-slate-500 mb-1">{k === "overhead" ? "Overhead %" : k === "markup" ? "Profit/Markup %" : "Tax %"}</label>
                <input type="number" min="0" step="0.1" value={header[k]} onChange={(e) => setHeader((h) => ({ ...h, [k]: e.target.value }))} className={clsx(inputCls, "w-full h-9")} />
              </div>
            ))}
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs text-slate-500 mb-1">Notes (shown on PDF)</label>
              <input type="text" value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} placeholder="Assumptions, exclusions…" className={clsx(inputCls, "w-full h-9")} />
            </div>
          </div>
        </div>

        {/* Item toolbar */}
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <button onClick={() => setRows((prev) => [...prev, emptyRow()])}
            className="flex items-center gap-1.5 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] px-3 h-9 rounded-xl hover:bg-[#F97316]/20 transition-colors">
            <Plus size={13} /> Blank Line
          </button>
          <select value={catalogPick} onChange={(e) => addFromCatalog(e.target.value)} className={clsx(inputCls, "h-9 max-w-xs")}>
            <option value="">+ Add from price catalog…</option>
            {Object.entries(INVOICE_CATEGORY_LABELS).map(([cat, label]) => (
              <optgroup key={cat} label={label}>
                {PRICE_CATALOG.filter((c) => c.category === cat).map((c) => (
                  <option key={c.code} value={c.code}>{c.code} — {c.description} ({centsToDisplay(c.unit_price)}/{c.unit})</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button onClick={runSupplementCheck} disabled={checkingSupplements}
            className="flex items-center gap-1.5 text-xs font-bold bg-purple-500/15 border border-purple-500/40 text-purple-300 hover:bg-purple-500/25 px-3 h-9 rounded-xl transition-colors disabled:opacity-60"
            title="AI compares this invoice against all job documentation and flags billable work you may have missed">
            {checkingSupplements ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {checkingSupplements ? "Auditing…" : "Find Missed Items"}
          </button>
          <span className="text-xs text-slate-600">{rows.filter((r) => r.description.trim()).length} line items</span>
        </div>
        {checkingSupplements && (
          <p className="text-xs text-purple-300/80 mb-3">
            AI is auditing this invoice against photos, equipment logs, and moisture readings — this can take a minute…
          </p>
        )}

        {/* Supplement suggestions */}
        {supplements !== null && (
          <div className="bg-[#0A1628] border border-purple-500/30 rounded-2xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={14} className="text-purple-400" />
              <p className="text-xs font-bold text-purple-300">
                {supplements.length === 0
                  ? "No missed items found — everything documented appears to be billed."
                  : `${supplements.length} potentially missed item${supplements.length !== 1 ? "s" : ""} found`}
              </p>
              <button onClick={() => setSupplements(null)} className="ml-auto text-slate-500 hover:text-slate-300" title="Dismiss">
                <X size={14} />
              </button>
            </div>
            {supplements.map((s, i) => (
              <div key={i} className="flex items-start gap-3 py-2 border-t border-[#1E293B]/60">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200">
                    <span className="text-xs font-mono text-purple-400 mr-2">{s.code ?? s.category}</span>
                    {s.description}
                    <span className="text-slate-500 text-xs ml-2">{s.quantity} {s.unit} @ {centsToDisplay(s.unit_price)}{s.room_name ? ` · ${s.room_name}` : ""}</span>
                  </p>
                  <p className="text-xs text-slate-500 italic mt-0.5">{s.reason}</p>
                </div>
                <button onClick={() => addSuggestion(s)}
                  className="flex items-center gap-1 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] px-2.5 h-7 rounded-lg hover:bg-[#F97316]/20 transition-colors flex-shrink-0">
                  <Plus size={11} /> Add
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Items table */}
        <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl overflow-hidden mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1E293B]">
                  {["Room", "Code", "Cat", "Description", "Qty", "Unit", "Price ($)", "Total", ""].map((h) => (
                    <th key={h} className="px-2 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.localId} className="border-b border-[#1E293B]/50 group align-top">
                    <td className="px-2 py-1.5 w-36">
                      <input type="text" list={`rooms-${job.id}`} value={r.room_name} placeholder="Site-wide"
                        onChange={(e) => updateRow(r.localId, { room_name: e.target.value })}
                        className={clsx(inputCls, "w-full h-8 text-xs")} />
                    </td>
                    <td className="px-2 py-1.5 w-28">
                      <input type="text" value={r.code} placeholder="—"
                        onChange={(e) => updateRow(r.localId, { code: e.target.value })}
                        className={clsx(inputCls, "w-full h-8 text-xs font-mono")} />
                    </td>
                    <td className="px-2 py-1.5 w-20">
                      <select value={r.category} onChange={(e) => updateRow(r.localId, { category: e.target.value })} className={clsx(inputCls, "w-full h-8 text-xs")}>
                        {Object.keys(INVOICE_CATEGORY_LABELS).map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 min-w-64">
                      <input type="text" value={r.description} placeholder="Description…"
                        onChange={(e) => updateRow(r.localId, { description: e.target.value })}
                        className={clsx(inputCls, "w-full h-8 text-xs")} />
                      <input type="text" value={r.notes} placeholder="Notes / basis (optional)"
                        onChange={(e) => updateRow(r.localId, { notes: e.target.value })}
                        className="w-full bg-transparent text-xs text-slate-500 placeholder-slate-700 focus:outline-none px-3 pt-1" />
                    </td>
                    <td className="px-2 py-1.5 w-20">
                      <input type="number" min="0" step="any" value={r.quantity}
                        onChange={(e) => updateRow(r.localId, { quantity: e.target.value })}
                        className={clsx(inputCls, "w-full h-8 text-xs text-right")} />
                    </td>
                    <td className="px-2 py-1.5 w-20">
                      <select value={r.unit} onChange={(e) => updateRow(r.localId, { unit: e.target.value })} className={clsx(inputCls, "w-full h-8 text-xs")}>
                        {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 w-24">
                      <input type="number" min="0" step="0.01" value={r.unit_price} placeholder="0.00"
                        onChange={(e) => updateRow(r.localId, { unit_price: e.target.value })}
                        className={clsx(inputCls, "w-full h-8 text-xs text-right")} />
                    </td>
                    <td className="px-2 py-1.5 w-24 text-right font-mono font-bold text-slate-200 text-xs pt-3">
                      {centsToDisplay(rowTotalCents(r))}
                    </td>
                    <td className="px-2 py-1.5 w-8">
                      <button onClick={() => setRows((prev) => prev.filter((x) => x.localId !== r.localId))}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 mt-1"
                        title="Remove line">
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id={`rooms-${job.id}`}>
              {rooms.map((r) => <option key={r.id} value={r.name} />)}
            </datalist>
          </div>
        </div>

        {/* Totals */}
        <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-5 max-w-sm ml-auto">
          {[
            { label: "Subtotal", value: totals.subtotal },
            { label: `Overhead (${header.overhead || 0}%)`, value: totals.overhead },
            { label: `Profit/Markup (${header.markup || 0}%)`, value: totals.markup },
            ...(parseFloat(header.tax || "0") > 0 ? [{ label: `Tax (${header.tax}%)`, value: totals.tax }] : []),
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between py-1.5 border-b border-[#1E293B]/60 text-sm">
              <span className="text-slate-400">{label}</span>
              <span className="text-slate-200 font-mono">{centsToDisplay(value)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between pt-3">
            <span className="text-slate-200 font-bold">Grand Total</span>
            <span className="text-white font-black font-mono text-lg">{centsToDisplay(totals.grandTotal)}</span>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // List view
  // ============================================================
  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <p className="text-slate-400 text-sm">{invoices.length} invoice{invoices.length !== 1 ? "s" : ""}</p>
        <div className="flex items-center gap-2">
          <button onClick={() => createInvoice({ ai: true })} disabled={generating}
            className="flex items-center gap-2 bg-purple-500/15 border border-purple-500/40 text-purple-300 hover:bg-purple-500/25 font-bold px-4 h-9 rounded-xl text-sm transition-colors disabled:opacity-60">
            {generating ? <RefreshCw size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {generating ? "Generating draft…" : "Generate with AI"}
          </button>
          <button onClick={() => createInvoice({ ai: false })} disabled={generating}
            className="flex items-center gap-2 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold px-4 h-9 rounded-xl text-sm transition-colors disabled:opacity-60">
            <Plus size={16} /> New Invoice
          </button>
        </div>
      </div>
      {generating && (
        <p className="text-xs text-purple-300/80 mb-3">
          Building an invoice from your rooms, moisture readings, equipment logs, photo analysis and floor plan — this can take a couple of minutes…
        </p>
      )}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm mb-4">
          <X size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-7 h-7 border-2 border-[#F97316] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-16 text-center">
          <FileDown size={36} className="text-slate-600 mx-auto mb-3" />
          <p className="text-slate-500 mb-1">No invoices yet.</p>
          <p className="text-slate-600 text-sm">Generate one with AI from everything documented on this job, or start from a blank invoice.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map((inv) => {
            const stats = itemCounts[inv.id];
            const totals = computeInvoiceTotals(
              [{ total_cents: stats?.total ?? 0 }],
              inv.overhead_percent, inv.markup_percent, inv.tax_percent
            );
            return (
              <div key={inv.id} className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-4 flex items-center gap-4 hover:border-[#F97316]/40 transition-colors">
                <button onClick={() => openEditor(inv)} className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-[#F97316]">{inv.invoice_number}</span>
                    <span className={clsx("px-2 py-0.5 rounded-full text-xs font-bold", STATUS_STYLE[inv.status])}>
                      {INVOICE_STATUS_LABELS[inv.status]}
                    </span>
                    <span className="text-xs text-slate-600 uppercase">{inv.report_type}</span>
                    {inv.ai_generated && <Sparkles size={12} className="text-purple-400" />}
                  </div>
                  <p className="text-sm font-bold text-slate-200 mt-1 truncate">{inv.title || "Untitled"}</p>
                  <p className="text-xs text-slate-500">{formatAlaskaDate(inv.invoice_date)} · {stats?.count ?? 0} line item{(stats?.count ?? 0) !== 1 ? "s" : ""}</p>
                </button>
                <p className="text-white font-black font-mono">{centsToDisplay(totals.grandTotal)}</p>
                {confirmDeleteId === inv.id ? (
                  <div className="flex items-center gap-2">
                    <button onClick={() => deleteInvoice(inv.id)} className="text-xs font-bold text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded">Delete</button>
                    <button onClick={() => setConfirmDeleteId(null)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmDeleteId(inv.id)} className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10" title="Delete invoice">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
