/**
 * Shared PDF components used across all 4 Roybal Restoration report types.
 * Built with @react-pdf/renderer.
 */

import React from "react";
import { View, Text, Page } from "@react-pdf/renderer";
import { pdfStyles, PDF_COLORS } from "./styles";
import type { Job } from "../types/index";
import { formatAlaskaDate, formatAlaskaDateTime } from "../types/index";

// ============================================================
// Report Header — Roybal branding + job info band
// ============================================================
interface ReportHeaderProps {
  job: Job;
  reportTitle: string;
  generatedAt?: string;
}

export function ReportHeader({ job, reportTitle, generatedAt }: ReportHeaderProps) {
  return (
    <>
      {/* Navy header */}
      <View style={pdfStyles.header}>
        <View style={pdfStyles.headerLeft}>
          <Text style={pdfStyles.logoText}>ROYBAL</Text>
          <Text style={pdfStyles.logoSub}>RESTORATION</Text>
          <View style={pdfStyles.logoAccent} />
        </View>
        <View style={pdfStyles.headerRight}>
          <Text style={pdfStyles.reportTitle}>{reportTitle}</Text>
          <Text style={pdfStyles.headerMeta}>{job.job_number}</Text>
          {generatedAt && (
            <Text style={pdfStyles.headerMeta}>
              Generated: {formatAlaskaDateTime(generatedAt)}
            </Text>
          )}
        </View>
      </View>

      {/* Info band */}
      <View style={pdfStyles.infoBand}>
        <View style={pdfStyles.infoGroup}>
          <Text style={pdfStyles.infoLabel}>Property</Text>
          <Text style={pdfStyles.infoValue}>{job.property_address}</Text>
        </View>
        {job.date_of_loss && (
          <View style={pdfStyles.infoGroup}>
            <Text style={pdfStyles.infoLabel}>Date of Loss</Text>
            <Text style={pdfStyles.infoValue}>{formatAlaskaDate(job.date_of_loss)}</Text>
          </View>
        )}
        {job.claim_number && (
          <View style={pdfStyles.infoGroup}>
            <Text style={pdfStyles.infoLabel}>Claim #</Text>
            <Text style={pdfStyles.infoValue}>{job.claim_number}</Text>
          </View>
        )}
        {job.insurance_carrier && (
          <View style={pdfStyles.infoGroup}>
            <Text style={pdfStyles.infoLabel}>Carrier</Text>
            <Text style={pdfStyles.infoValue}>{job.insurance_carrier}</Text>
          </View>
        )}
        {job.adjuster_name && (
          <View style={pdfStyles.infoGroup}>
            <Text style={pdfStyles.infoLabel}>Adjuster</Text>
            <Text style={pdfStyles.infoValue}>{job.adjuster_name}</Text>
          </View>
        )}
        {job.loss_type && (
          <View style={pdfStyles.infoGroup}>
            <Text style={pdfStyles.infoLabel}>Loss Type</Text>
            <Text style={pdfStyles.infoValue}>
              {job.loss_type.toUpperCase()}
              {job.loss_category ? ` / ${job.loss_category.toUpperCase()}` : ""}
            </Text>
          </View>
        )}
      </View>
    </>
  );
}

// ============================================================
// Section Header
// ============================================================
export function SectionHeader({ title }: { title: string }) {
  return (
    <View style={pdfStyles.sectionHeader}>
      <Text style={pdfStyles.sectionTitle}>{title}</Text>
    </View>
  );
}

// ============================================================
// Page Footer
// ============================================================
interface PageFooterProps {
  jobNumber: string;
  pageNumber?: number;
  totalPages?: number;
}

export function PageFooter({ jobNumber, pageNumber, totalPages }: PageFooterProps) {
  return (
    <View style={pdfStyles.footer} fixed>
      <Text style={pdfStyles.footerText}>Roybal Restoration — Confidential</Text>
      <Text style={pdfStyles.footerOrange}>{jobNumber}</Text>
      {pageNumber !== undefined && (
        <Text style={pdfStyles.footerText}>
          Page {pageNumber}{totalPages ? ` of ${totalPages}` : ""}
        </Text>
      )}
    </View>
  );
}

// ============================================================
// Info pair for detail sections
// ============================================================
export function InfoPair({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 4 }}>
      <Text style={{ fontSize: 8, color: PDF_COLORS.textMuted, width: 100 }}>{label}</Text>
      <Text style={{ fontSize: 8, color: PDF_COLORS.textPrimary, flex: 1 }}>{value}</Text>
    </View>
  );
}
