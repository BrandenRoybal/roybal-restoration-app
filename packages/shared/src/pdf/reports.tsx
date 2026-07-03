/**
 * Roybal Restoration — PDF Report Documents
 *
 * Four report types:
 *   1. PhotoReport         — photos by room/category
 *   2. MoistureDryingReport — daily readings + equipment log
 *   3. EquipmentLogReport   — equipment placement/removal
 *   4. ScopeInvoiceReport   — line items, totals, signature block
 *
 * Usage (web):
 *   import { pdf } from "@react-pdf/renderer";
 *   const blob = await pdf(<PhotoReport job={job} photos={photos} rooms={rooms} />).toBlob();
 *
 * Usage (mobile):
 *   import * as Print from "expo-print";
 *   const { uri } = await Print.printToFileAsync({ html: ... });
 *   // Note: @react-pdf/renderer works in web; for mobile use expo-print with HTML
 */

import React from "react";
import { Document, Page, View, Text, Image } from "@react-pdf/renderer";
import { pdfStyles, PDF_COLORS } from "./styles";
import { ReportHeader, SectionHeader, PageFooter, InfoPair } from "./components";
import type {
  Job,
  Room,
  Photo,
  MoistureReading,
  EquipmentLog,
  LineItem,
  Invoice,
  InvoiceItem,
} from "../types/index";
import {
  getMoistureStatus,
  getDryStandard,
  centsToDisplay,
  formatAlaskaDate,
  formatAlaskaDateTime,
  computeInvoiceTotals,
  EQUIPMENT_TYPE_LABELS,
} from "../types/index";
import { INVOICE_CATEGORY_LABELS } from "../pricing";

// ============================================================
// 1. PHOTO REPORT
// ============================================================
interface PhotoReportProps {
  job: Job;
  photos: Photo[];
  rooms: Room[];
}

export function PhotoReport({ job, photos, rooms }: PhotoReportProps) {
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
  const categories = ["before", "during", "after", "moisture", "equipment", "general"] as const;

  return (
    <Document
      title={`${job.job_number} — Photo Report`}
      author="Roybal Restoration"
      subject="Job Site Photo Documentation"
    >
      {categories.map((category) => {
        const catPhotos = photos.filter((p) => p.category === category);
        if (catPhotos.length === 0) return null;

        // Group by room
        const byRoom: Record<string, Photo[]> = {};
        catPhotos.forEach((p) => {
          const key = p.room_id ?? "__general__";
          if (!byRoom[key]) byRoom[key] = [];
          byRoom[key]!.push(p);
        });

        return (
          <Page key={category} size="LETTER" style={pdfStyles.page}>
            <ReportHeader
              job={job}
              reportTitle="Photo Report"
              generatedAt={new Date().toISOString()}
            />

            <View style={pdfStyles.body}>
              <SectionHeader title={`${category.charAt(0).toUpperCase() + category.slice(1)} Photos`} />

              {Object.entries(byRoom).map(([roomId, roomPhotos]) => (
                <View key={roomId} style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textSecondary, marginBottom: 6 }}>
                    {roomId === "__general__" ? "General / Unassigned" : (roomMap[roomId] ?? "Unknown Room")}
                  </Text>

                  {/* Photo grid — 3 per row */}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {roomPhotos.map((photo) => (
                      <View key={photo.id} style={{ width: "31%", marginBottom: 8 }}>
                        {photo.url ? (
                          <Image
                            src={photo.url}
                            style={{ width: "100%", aspectRatio: 1.33, borderRadius: 3 }}
                          />
                        ) : (
                          <View style={{
                            width: "100%", aspectRatio: 1.33, borderRadius: 3,
                            backgroundColor: "#E2E8F0", alignItems: "center", justifyContent: "center",
                          }}>
                            <Text style={{ fontSize: 7, color: PDF_COLORS.textMuted }}>No image</Text>
                          </View>
                        )}
                        <Text style={{ fontSize: 7, color: PDF_COLORS.textSecondary, marginTop: 3 }}>
                          {photo.caption ?? formatAlaskaDateTime(photo.taken_at)}
                        </Text>
                        {photo.taken_at && (
                          <Text style={{ fontSize: 6, color: PDF_COLORS.textMuted }}>
                            {formatAlaskaDateTime(photo.taken_at)}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>

            <PageFooter jobNumber={job.job_number} />
          </Page>
        );
      })}
    </Document>
  );
}

// ============================================================
// 2. MOISTURE / DRYING REPORT
// ============================================================
interface MoistureDryingReportProps {
  job: Job;
  rooms: Room[];
  moistureReadings: MoistureReading[];
  equipmentLogs: EquipmentLog[];
}

export function MoistureDryingReport({
  job,
  rooms,
  moistureReadings,
  equipmentLogs,
}: MoistureDryingReportProps) {
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  // Group readings by date
  const byDate: Record<string, MoistureReading[]> = {};
  [...moistureReadings]
    .sort((a, b) => a.reading_date.localeCompare(b.reading_date))
    .forEach((m) => {
      if (!byDate[m.reading_date]) byDate[m.reading_date] = [];
      byDate[m.reading_date]!.push(m);
    });

  const allDry = moistureReadings.every((m) => m.is_dry);
  const totalEquipDays = equipmentLogs.reduce((sum, e) => sum + e.days_on_site, 0);

  return (
    <Document
      title={`${job.job_number} — Moisture/Drying Report`}
      author="Roybal Restoration"
    >
      <Page size="LETTER" style={pdfStyles.page}>
        <ReportHeader
          job={job}
          reportTitle="Moisture / Drying Report"
          generatedAt={new Date().toISOString()}
        />

        <View style={pdfStyles.body}>
          {/* Summary */}
          <SectionHeader title="Drying Summary" />
          <View style={{ flexDirection: "row", gap: 16, marginBottom: 16 }}>
            <View style={{ flex: 1, backgroundColor: allDry ? "#DCFCE7" : "#FEE2E2", borderRadius: 6, padding: 10 }}>
              <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold", color: allDry ? "#166534" : "#991B1B" }}>
                {allDry ? "DRY ✓" : "NOT DRY"}
              </Text>
              <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary, marginTop: 2 }}>
                {moistureReadings.filter((m) => m.is_dry).length} / {moistureReadings.length} readings at standard
              </Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "#F8FAFC", borderRadius: 6, padding: 10, borderWidth: 0.5, borderColor: PDF_COLORS.border }}>
              <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold", color: PDF_COLORS.navy }}>{totalEquipDays}</Text>
              <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary, marginTop: 2 }}>Total Equipment Days</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "#F8FAFC", borderRadius: 6, padding: 10, borderWidth: 0.5, borderColor: PDF_COLORS.border }}>
              <Text style={{ fontSize: 14, fontFamily: "Helvetica-Bold", color: PDF_COLORS.navy }}>
                {Object.keys(byDate).length}
              </Text>
              <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary, marginTop: 2 }}>Days of Readings</Text>
            </View>
          </View>

          {/* Daily readings */}
          <SectionHeader title="Daily Moisture Readings" />
          <View style={pdfStyles.table}>
            <View style={pdfStyles.tableHeader}>
              {["Date", "Room", "Location", "Material", "Reading", "Standard", "Status"].map((h) => (
                <Text key={h} style={pdfStyles.tableHeaderCell}>{h}</Text>
              ))}
            </View>
            {moistureReadings.map((m, i) => {
              const status = getMoistureStatus(m.moisture_pct, m.material_type);
              const standard = getDryStandard(m.material_type);
              return (
                <View key={m.id} style={[pdfStyles.tableRow, i % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                  <Text style={pdfStyles.tableCell}>{formatAlaskaDate(m.reading_date)}</Text>
                  <Text style={pdfStyles.tableCell}>{roomMap[m.room_id] ?? "—"}</Text>
                  <Text style={pdfStyles.tableCell}>{m.location_description}</Text>
                  <Text style={pdfStyles.tableCell}>{m.material_type}</Text>
                  <Text style={[pdfStyles.tableCellBold, {
                    color: status === "dry" ? PDF_COLORS.success : status === "wet" ? PDF_COLORS.danger : PDF_COLORS.warning
                  }]}>{m.moisture_pct}%</Text>
                  <Text style={pdfStyles.tableCell}>≤{standard.maxPct}%</Text>
                  <Text style={
                    status === "dry" ? pdfStyles.badgeDry
                    : status === "wet" ? pdfStyles.badgeWet
                    : pdfStyles.badgeMonitoring
                  }>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Sign-off block */}
          <SectionHeader title="Final Dry Verification" />
          <View style={{ marginBottom: 8 }}>
            <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary, marginBottom: 4 }}>
              I verify that the affected structure has been dried to IICRC S500 standards and all moisture readings
              are at or below the dry standard for their respective materials.
            </Text>
          </View>
          <View style={pdfStyles.signatureSection}>
            <View style={pdfStyles.signatureBlock}>
              <Text style={pdfStyles.signatureLabel}>Project Manager Signature</Text>
              <Text style={[pdfStyles.signatureLabel, { marginTop: 24 }]}>Date</Text>
            </View>
            <View style={pdfStyles.signatureBlock}>
              <Text style={pdfStyles.signatureLabel}>Property Owner / Rep Signature</Text>
              <Text style={[pdfStyles.signatureLabel, { marginTop: 24 }]}>Date</Text>
            </View>
          </View>
        </View>

        <PageFooter jobNumber={job.job_number} />
      </Page>
    </Document>
  );
}

// ============================================================
// 3. EQUIPMENT LOG REPORT
// ============================================================
interface EquipmentLogReportProps {
  job: Job;
  equipmentLogs: EquipmentLog[];
  rooms: Room[];
}

export function EquipmentLogReport({ job, equipmentLogs, rooms }: EquipmentLogReportProps) {
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
  const totalDays = equipmentLogs.reduce((sum, e) => sum + e.days_on_site, 0);

  return (
    <Document title={`${job.job_number} — Equipment Log`} author="Roybal Restoration">
      <Page size="LETTER" style={pdfStyles.page}>
        <ReportHeader
          job={job}
          reportTitle="Equipment Log"
          generatedAt={new Date().toISOString()}
        />

        <View style={pdfStyles.body}>
          <SectionHeader title="Equipment Placement Log" />

          <View style={pdfStyles.table}>
            <View style={pdfStyles.tableHeader}>
              {["Equipment", "Type", "Asset #", "Room", "Date Placed", "Date Removed", "Days"].map((h) => (
                <Text key={h} style={pdfStyles.tableHeaderCell}>{h}</Text>
              ))}
            </View>
            {equipmentLogs.map((e, i) => (
              <View key={e.id} style={[pdfStyles.tableRow, i % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                <Text style={pdfStyles.tableCellBold}>{e.equipment_name}</Text>
                <Text style={pdfStyles.tableCell}>{EQUIPMENT_TYPE_LABELS[e.equipment_type]}</Text>
                <Text style={pdfStyles.tableCell}>{e.asset_number ?? "—"}</Text>
                <Text style={pdfStyles.tableCell}>{e.room_id ? (roomMap[e.room_id] ?? "—") : "—"}</Text>
                <Text style={pdfStyles.tableCell}>{formatAlaskaDate(e.date_placed)}</Text>
                <Text style={pdfStyles.tableCell}>
                  {e.date_removed ? formatAlaskaDate(e.date_removed) : "Active"}
                </Text>
                <Text style={[pdfStyles.tableCellBold, { textAlign: "right" }]}>{e.days_on_site}</Text>
              </View>
            ))}
          </View>

          {/* Total row */}
          <View style={pdfStyles.totalRow}>
            <Text style={[pdfStyles.totalLabel, { flex: 6 }]}>Total Equipment Days</Text>
            <Text style={pdfStyles.totalValue}>{totalDays}</Text>
          </View>

          {/* Summary by type */}
          <SectionHeader title="Summary by Equipment Type" />
          {Object.entries(EQUIPMENT_TYPE_LABELS).map(([type, label]) => {
            const typeItems = equipmentLogs.filter((e) => e.equipment_type === type);
            if (typeItems.length === 0) return null;
            const typeDays = typeItems.reduce((sum, e) => sum + e.days_on_site, 0);
            return (
              <View key={type} style={{ flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: PDF_COLORS.border }}>
                <Text style={{ flex: 3, fontSize: 8, color: PDF_COLORS.textPrimary }}>{label}</Text>
                <Text style={{ flex: 1, fontSize: 8, color: PDF_COLORS.textSecondary, textAlign: "center" }}>{typeItems.length} units</Text>
                <Text style={{ flex: 1, fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.navy, textAlign: "right" }}>{typeDays} days</Text>
              </View>
            );
          })}
        </View>

        <PageFooter jobNumber={job.job_number} />
      </Page>
    </Document>
  );
}

// ============================================================
// 4. SCOPE OF WORK / INVOICE REPORT
// ============================================================
interface ScopeInvoiceReportProps {
  job: Job;
  lineItems: LineItem[];
  rooms: Room[];
  markupPercent?: number;
  overheadPercent?: number;
  includeSignature?: boolean;
  reportType?: "estimate" | "invoice";
}

export function ScopeInvoiceReport({
  job,
  lineItems,
  rooms,
  markupPercent = 10,
  overheadPercent = 10,
  includeSignature = true,
  reportType = "invoice",
}: ScopeInvoiceReportProps) {
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  // Group by room
  const byRoom: Record<string, LineItem[]> = {};
  lineItems.forEach((li) => {
    const key = li.room_id ?? "__general__";
    if (!byRoom[key]) byRoom[key] = [];
    byRoom[key]!.push(li);
  });

  const subtotal = lineItems.reduce((sum, li) => sum + li.total_cents, 0);
  const overheadAmount = Math.round(subtotal * (overheadPercent / 100));
  const markupAmount = Math.round((subtotal + overheadAmount) * (markupPercent / 100));
  const grandTotal = subtotal + overheadAmount + markupAmount;

  return (
    <Document
      title={`${job.job_number} — ${reportType === "invoice" ? "Invoice" : "Estimate"}`}
      author="Roybal Restoration"
    >
      <Page size="LETTER" style={pdfStyles.page}>
        <ReportHeader
          job={job}
          reportTitle={reportType === "invoice" ? "Invoice" : "Scope of Work Estimate"}
          generatedAt={new Date().toISOString()}
        />

        <View style={pdfStyles.body}>
          {/* Line items by room */}
          {Object.entries(byRoom).map(([roomId, items]) => {
            const roomTotal = items.reduce((sum, li) => sum + li.total_cents, 0);
            return (
              <View key={roomId}>
                <SectionHeader title={roomId === "__general__" ? "General / Site-Wide" : (roomMap[roomId] ?? "Unknown Room")} />
                <View style={pdfStyles.table}>
                  <View style={pdfStyles.tableHeader}>
                    {["Description", "Category", "Qty", "Unit", "Unit Price", "Total"].map((h) => (
                      <Text key={h} style={pdfStyles.tableHeaderCell}>{h}</Text>
                    ))}
                  </View>
                  {items.map((li, i) => (
                    <View key={li.id} style={[pdfStyles.tableRow, i % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                      <Text style={[pdfStyles.tableCellBold, { flex: 2 }]}>{li.description}</Text>
                      <Text style={pdfStyles.tableCell}>{li.category}</Text>
                      <Text style={pdfStyles.tableCell}>{li.quantity}</Text>
                      <Text style={pdfStyles.tableCell}>{li.unit}</Text>
                      <Text style={pdfStyles.tableCell}>{centsToDisplay(li.unit_price)}</Text>
                      <Text style={[pdfStyles.tableCellBold, { textAlign: "right" }]}>{centsToDisplay(li.total_cents)}</Text>
                    </View>
                  ))}
                  {/* Room subtotal */}
                  <View style={{ flexDirection: "row", backgroundColor: "#F1F5F9", paddingVertical: 4, paddingHorizontal: 8 }}>
                    <Text style={{ flex: 5, fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textSecondary, textAlign: "right" }}>Room Subtotal</Text>
                    <Text style={{ flex: 1, fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.navy, textAlign: "right" }}>{centsToDisplay(roomTotal)}</Text>
                  </View>
                </View>
              </View>
            );
          })}

          {/* Grand totals */}
          <View style={{ marginTop: 12 }}>
            {[
              { label: "Subtotal", value: subtotal },
              { label: `Overhead & Profit (${overheadPercent}%)`, value: overheadAmount },
              { label: `Markup (${markupPercent}%)`, value: markupAmount },
            ].map(({ label, value }) => (
              <View key={label} style={{ flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: PDF_COLORS.border, paddingHorizontal: 8 }}>
                <Text style={{ flex: 1, fontSize: 9, color: PDF_COLORS.textSecondary }}>{label}</Text>
                <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textPrimary }}>{centsToDisplay(value)}</Text>
              </View>
            ))}
            <View style={pdfStyles.totalRow}>
              <Text style={pdfStyles.totalLabel}>GRAND TOTAL</Text>
              <Text style={pdfStyles.totalValue}>{centsToDisplay(grandTotal)}</Text>
            </View>
          </View>

          {/* Assumptions */}
          <SectionHeader title="Assumptions & Exclusions" />
          <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary, lineHeight: 1.6 }}>
            • All work performed per IICRC S500 (water damage) / S520 (mold) standards.{"\n"}
            • Pricing subject to change if unforeseen conditions are discovered.{"\n"}
            • This estimate does not include reconstruction or rebuild scope unless noted.{"\n"}
            • Sales tax not included. Supplemental work will be invoiced separately.{"\n"}
            • Payment due within 30 days of invoice date.
          </Text>

          {/* Signature block */}
          {includeSignature && (
            <>
              <SectionHeader title="Authorization" />
              <View style={pdfStyles.signatureSection}>
                <View style={pdfStyles.signatureBlock}>
                  <Text style={pdfStyles.signatureLabel}>Authorized Signature (Roybal Restoration)</Text>
                  <Text style={[pdfStyles.signatureLabel, { marginTop: 28 }]}>Date</Text>
                </View>
                <View style={pdfStyles.signatureBlock}>
                  <Text style={pdfStyles.signatureLabel}>Property Owner / Authorized Rep</Text>
                  <Text style={[pdfStyles.signatureLabel, { marginTop: 28 }]}>Date</Text>
                </View>
              </View>
            </>
          )}
        </View>

        <PageFooter jobNumber={job.job_number} />
      </Page>
    </Document>
  );
}

// ============================================================
// 5. INVOICE REPORT (Xactimate-style, from the invoices module)
// ============================================================
interface InvoiceReportProps {
  job: Job;
  invoice: Invoice;
  items: InvoiceItem[];
  /** Optional narrative page appended after the invoice */
  narrative?: string | null;
  includeSignature?: boolean;
}

export function InvoiceReport({
  job,
  invoice,
  items,
  narrative,
  includeSignature = true,
}: InvoiceReportProps) {
  // Group by room name
  const byRoom: Record<string, InvoiceItem[]> = {};
  items.forEach((it) => {
    const key = it.room_name?.trim() || "__general__";
    if (!byRoom[key]) byRoom[key] = [];
    byRoom[key]!.push(it);
  });

  const { subtotal, overhead, markup, tax, grandTotal } = computeInvoiceTotals(
    items,
    invoice.overhead_percent,
    invoice.markup_percent,
    invoice.tax_percent
  );

  const isInvoice = invoice.report_type === "invoice";
  const title = isInvoice ? "Invoice" : "Estimate";

  return (
    <Document
      title={`${invoice.invoice_number} — ${title}`}
      author="Roybal Restoration"
    >
      <Page size="LETTER" style={pdfStyles.page}>
        <ReportHeader
          job={job}
          reportTitle={`${title} ${invoice.invoice_number}`}
          generatedAt={new Date().toISOString()}
        />

        <View style={pdfStyles.body}>
          {/* Invoice meta + bill-to */}
          <View style={{ flexDirection: "row", gap: 16, marginBottom: 14 }}>
            <View style={{ flex: 1, backgroundColor: "#F8FAFC", borderRadius: 6, padding: 10, borderWidth: 0.5, borderColor: PDF_COLORS.border }}>
              <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textSecondary, marginBottom: 4 }}>BILL TO</Text>
              <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textPrimary }}>{job.owner_name ?? "Property Owner"}</Text>
              <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary }}>{job.property_address}</Text>
              {job.owner_phone && <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary }}>{job.owner_phone}</Text>}
              {job.owner_email && <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary }}>{job.owner_email}</Text>}
            </View>
            <View style={{ flex: 1, backgroundColor: "#F8FAFC", borderRadius: 6, padding: 10, borderWidth: 0.5, borderColor: PDF_COLORS.border }}>
              <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textSecondary, marginBottom: 4 }}>{title.toUpperCase()} DETAILS</Text>
              <InfoPair label={`${title} #`} value={invoice.invoice_number} />
              <InfoPair label="Date" value={formatAlaskaDate(invoice.invoice_date)} />
              {job.insurance_carrier ? <InfoPair label="Carrier" value={job.insurance_carrier} /> : null}
              {job.claim_number ? <InfoPair label="Claim #" value={job.claim_number} /> : null}
              {job.adjuster_name ? <InfoPair label="Adjuster" value={job.adjuster_name} /> : null}
            </View>
          </View>

          {/* Line items grouped by room, Xactimate-style */}
          {Object.entries(byRoom).map(([roomName, roomItems]) => {
            const roomTotal = roomItems.reduce((sum, it) => sum + it.total_cents, 0);
            return (
              <View key={roomName}>
                <SectionHeader title={roomName === "__general__" ? "General / Site-Wide" : roomName} />
                <View style={pdfStyles.table}>
                  <View style={pdfStyles.tableHeader}>
                    <Text style={[pdfStyles.tableHeaderCell, { flex: 0.9 }]}>Code</Text>
                    <Text style={[pdfStyles.tableHeaderCell, { flex: 3 }]}>Description</Text>
                    <Text style={[pdfStyles.tableHeaderCell, { flex: 0.6, textAlign: "right" }]}>Qty</Text>
                    <Text style={[pdfStyles.tableHeaderCell, { flex: 0.6 }]}>Unit</Text>
                    <Text style={[pdfStyles.tableHeaderCell, { flex: 1, textAlign: "right" }]}>Unit Price</Text>
                    <Text style={[pdfStyles.tableHeaderCell, { flex: 1, textAlign: "right" }]}>Total</Text>
                  </View>
                  {roomItems.map((it, i) => (
                    <View key={it.id} style={[pdfStyles.tableRow, i % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                      <Text style={[pdfStyles.tableCell, { flex: 0.9 }]}>{it.code ?? "—"}</Text>
                      <View style={{ flex: 3 }}>
                        <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textPrimary }}>{it.description}</Text>
                        {it.notes ? (
                          <Text style={{ fontSize: 7, color: PDF_COLORS.textMuted }}>{it.notes}</Text>
                        ) : null}
                      </View>
                      <Text style={[pdfStyles.tableCell, { flex: 0.6, textAlign: "right" }]}>{it.quantity}</Text>
                      <Text style={[pdfStyles.tableCell, { flex: 0.6 }]}>{it.unit}</Text>
                      <Text style={[pdfStyles.tableCell, { flex: 1, textAlign: "right" }]}>{centsToDisplay(it.unit_price)}</Text>
                      <Text style={[pdfStyles.tableCellBold, { flex: 1, textAlign: "right" }]}>{centsToDisplay(it.total_cents)}</Text>
                    </View>
                  ))}
                  <View style={{ flexDirection: "row", backgroundColor: "#F1F5F9", paddingVertical: 4, paddingHorizontal: 8 }}>
                    <Text style={{ flex: 5, fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textSecondary, textAlign: "right" }}>Room Subtotal</Text>
                    <Text style={{ flex: 1, fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.navy, textAlign: "right" }}>{centsToDisplay(roomTotal)}</Text>
                  </View>
                </View>
              </View>
            );
          })}

          {/* Category recap */}
          <SectionHeader title="Recap by Category" />
          {Object.keys(INVOICE_CATEGORY_LABELS).map((cat) => {
            const catItems = items.filter((it) => it.category === cat);
            if (catItems.length === 0) return null;
            const catTotal = catItems.reduce((sum, it) => sum + it.total_cents, 0);
            return (
              <View key={cat} style={{ flexDirection: "row", paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: PDF_COLORS.border, paddingHorizontal: 8 }}>
                <Text style={{ flex: 1, fontSize: 8, color: PDF_COLORS.textPrimary }}>{INVOICE_CATEGORY_LABELS[cat]}</Text>
                <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: PDF_COLORS.navy }}>{centsToDisplay(catTotal)}</Text>
              </View>
            );
          })}

          {/* Grand totals */}
          <View style={{ marginTop: 12 }}>
            {[
              { label: "Subtotal", value: subtotal },
              { label: `Overhead (${invoice.overhead_percent}%)`, value: overhead },
              { label: `Profit / Markup (${invoice.markup_percent}%)`, value: markup },
              ...(invoice.tax_percent > 0 ? [{ label: `Tax (${invoice.tax_percent}%)`, value: tax }] : []),
            ].map(({ label, value }) => (
              <View key={label} style={{ flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: PDF_COLORS.border, paddingHorizontal: 8 }}>
                <Text style={{ flex: 1, fontSize: 9, color: PDF_COLORS.textSecondary }}>{label}</Text>
                <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: PDF_COLORS.textPrimary }}>{centsToDisplay(value)}</Text>
              </View>
            ))}
            <View style={pdfStyles.totalRow}>
              <Text style={pdfStyles.totalLabel}>GRAND TOTAL</Text>
              <Text style={pdfStyles.totalValue}>{centsToDisplay(grandTotal)}</Text>
            </View>
          </View>

          {/* Notes / terms */}
          <SectionHeader title="Terms & Notes" />
          <Text style={{ fontSize: 8, color: PDF_COLORS.textSecondary, lineHeight: 1.6 }}>
            {invoice.notes ? invoice.notes + "\n" : ""}
            • All work performed per IICRC S500 (water damage) / S520 (mold) standards.{"\n"}
            • Pricing subject to change if unforeseen conditions are discovered.{"\n"}
            • Sales tax not included unless itemized above. Supplemental work will be invoiced separately.{"\n"}
            • Payment due within 30 days of invoice date.
          </Text>

          {/* Signature block */}
          {includeSignature && (
            <>
              <SectionHeader title="Authorization" />
              <View style={pdfStyles.signatureSection}>
                <View style={pdfStyles.signatureBlock}>
                  <Text style={pdfStyles.signatureLabel}>Authorized Signature (Roybal Restoration)</Text>
                  <Text style={[pdfStyles.signatureLabel, { marginTop: 28 }]}>Date</Text>
                </View>
                <View style={pdfStyles.signatureBlock}>
                  <Text style={pdfStyles.signatureLabel}>Property Owner / Authorized Rep</Text>
                  <Text style={[pdfStyles.signatureLabel, { marginTop: 28 }]}>Date</Text>
                </View>
              </View>
            </>
          )}
        </View>

        <PageFooter jobNumber={job.job_number} />
      </Page>

      {/* Optional narrative page */}
      {narrative ? (
        <Page size="LETTER" style={pdfStyles.page}>
          <ReportHeader
            job={job}
            reportTitle="Job Narrative"
            generatedAt={new Date().toISOString()}
          />
          <View style={pdfStyles.body}>
            <SectionHeader title="Narrative of Loss & Work Performed" />
            <Text style={{ fontSize: 9, color: PDF_COLORS.textPrimary, lineHeight: 1.7 }}>
              {narrative}
            </Text>
          </View>
          <PageFooter jobNumber={job.job_number} />
        </Page>
      ) : null}
    </Document>
  );
}
