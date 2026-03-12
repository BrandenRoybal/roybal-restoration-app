/**
 * Shared PDF styles — Roybal Restoration branding.
 * Dark navy + safety orange color palette.
 * Used across all 4 report types.
 */

import { StyleSheet } from "@react-pdf/renderer";

export const PDF_COLORS = {
  navy: "#0A1628",
  navyMid: "#112240",
  orange: "#F97316",
  success: "#22C55E",
  warning: "#EAB308",
  danger: "#EF4444",
  textPrimary: "#1E293B",
  textSecondary: "#475569",
  textMuted: "#94A3B8",
  border: "#E2E8F0",
  rowAlt: "#F8FAFC",
} as const;

export const pdfStyles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    backgroundColor: "#FFFFFF",
    paddingTop: 0,
    paddingBottom: 40,
    paddingHorizontal: 0,
    fontSize: 9,
    color: PDF_COLORS.textPrimary,
  },

  // ── Header ──
  header: {
    backgroundColor: PDF_COLORS.navy,
    paddingHorizontal: 32,
    paddingTop: 28,
    paddingBottom: 22,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerLeft: {},
  logoText: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: "#FFFFFF",
    letterSpacing: 4,
  },
  logoSub: {
    fontSize: 8,
    color: PDF_COLORS.orange,
    letterSpacing: 6,
    marginTop: 2,
  },
  logoAccent: {
    width: 32,
    height: 2,
    backgroundColor: PDF_COLORS.orange,
    marginTop: 6,
  },
  headerRight: {
    alignItems: "flex-end",
  },
  reportTitle: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: "#FFFFFF",
    textAlign: "right",
  },
  headerMeta: {
    fontSize: 8,
    color: PDF_COLORS.textMuted,
    textAlign: "right",
    marginTop: 4,
  },

  // ── Job Info Band ──
  infoBand: {
    backgroundColor: PDF_COLORS.navyMid,
    paddingHorizontal: 32,
    paddingVertical: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  },
  infoGroup: {
    minWidth: 140,
  },
  infoLabel: {
    fontSize: 7,
    color: PDF_COLORS.textMuted,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  infoValue: {
    fontSize: 9,
    color: "#FFFFFF",
    fontFamily: "Helvetica-Bold",
  },

  // ── Page Body ──
  body: {
    paddingHorizontal: 32,
    paddingTop: 20,
  },

  // ── Sections ──
  sectionHeader: {
    borderLeftWidth: 3,
    borderLeftColor: PDF_COLORS.orange,
    paddingLeft: 8,
    marginBottom: 10,
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: PDF_COLORS.navy,
  },

  // ── Tables ──
  table: {
    width: "100%",
    marginBottom: 16,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: PDF_COLORS.navy,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tableHeaderCell: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: "#FFFFFF",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    flex: 1,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.border,
  },
  tableRowAlt: {
    backgroundColor: PDF_COLORS.rowAlt,
  },
  tableCell: {
    fontSize: 8,
    color: PDF_COLORS.textPrimary,
    flex: 1,
  },
  tableCellBold: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: PDF_COLORS.textPrimary,
    flex: 1,
  },

  // ── Status badges in tables ──
  badgeDry: {
    backgroundColor: "#DCFCE7",
    color: "#166534",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
  },
  badgeWet: {
    backgroundColor: "#FEE2E2",
    color: "#991B1B",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
  },
  badgeMonitoring: {
    backgroundColor: "#FEF9C3",
    color: "#854D0E",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
  },

  // ── Totals ──
  totalRow: {
    flexDirection: "row",
    backgroundColor: PDF_COLORS.navy,
    paddingVertical: 7,
    paddingHorizontal: 8,
    marginTop: 2,
  },
  totalLabel: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "#FFFFFF",
    flex: 4,
    textAlign: "right",
  },
  totalValue: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: PDF_COLORS.orange,
    flex: 1,
    textAlign: "right",
  },

  // ── Signature block ──
  signatureSection: {
    marginTop: 32,
    flexDirection: "row",
    gap: 32,
  },
  signatureBlock: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.textPrimary,
    paddingTop: 6,
  },
  signatureLabel: {
    fontSize: 8,
    color: PDF_COLORS.textSecondary,
  },

  // ── Footer ──
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 32,
    backgroundColor: PDF_COLORS.navy,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 32,
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 7,
    color: PDF_COLORS.textMuted,
  },
  footerOrange: {
    fontSize: 7,
    color: PDF_COLORS.orange,
    fontFamily: "Helvetica-Bold",
  },
});
