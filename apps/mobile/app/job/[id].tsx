/**
 * Job Detail screen — tabbed layout with Overview | Photos | Moisture | Equipment | Scope | Floor Plan
 */

import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useLocalSearchParams, useRouter, Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../src/lib/supabase";
import { colors, spacing, radius } from "../../src/lib/theme";
import type { Job } from "@roybal/shared";
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_ORDER,
  formatAlaskaDate,
  formatAlaskaDateTime,
} from "@roybal/shared";

type TabKey = "overview" | "photos" | "moisture" | "equipment" | "scope" | "floorplan";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "overview", label: "Overview", icon: "document-text-outline" },
  { key: "photos", label: "Photos", icon: "camera-outline" },
  { key: "moisture", label: "Moisture", icon: "water-outline" },
  { key: "equipment", label: "Equipment", icon: "hardware-chip-outline" },
  { key: "scope", label: "Scope", icon: "list-outline" },
  { key: "floorplan", label: "Floor Plan", icon: "map-outline" },
];

const STATUS_COLORS: Record<string, string> = {
  new: "#64748B",
  active: colors.orange,
  drying: "#3B82F6",
  final_inspection: colors.warning,
  invoicing: "#A855F7",
  closed: colors.success,
};

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  useEffect(() => {
    if (!id) return;
    supabase
      .from("jobs")
      .select("*")
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (!error && data) setJob(data as Job);
        setLoading(false);
      });
  }, [id]);

  const advanceStatus = async () => {
    if (!job) return;
    const current = JOB_STATUS_ORDER.indexOf(job.status);
    if (current === JOB_STATUS_ORDER.length - 1) {
      Alert.alert("Job Closed", "This job is already closed.");
      return;
    }
    const next = JOB_STATUS_ORDER[current + 1];
    if (!next) return;
    Alert.alert(
      "Advance Status",
      `Move job to "${JOB_STATUS_LABELS[next]}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Advance",
          onPress: async () => {
            const { data, error } = await supabase
              .from("jobs")
              .update({ status: next })
              .eq("id", job.id)
              .select()
              .single();
            if (!error && data) setJob(data as Job);
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator color={colors.orange} size="large" />
      </View>
    );
  }

  if (!job) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={{ color: colors.textMuted }}>Job not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.jobNumber}>{job.job_number}</Text>
          <Text style={styles.address} numberOfLines={1}>{job.property_address}</Text>
        </View>
        <TouchableOpacity
          style={[
            styles.statusBtn,
            { backgroundColor: (STATUS_COLORS[job.status] ?? colors.orange) + "22" },
          ]}
          onPress={advanceStatus}
        >
          <Text style={[styles.statusLabel, { color: STATUS_COLORS[job.status] ?? colors.orange }]}>
            {JOB_STATUS_LABELS[job.status]}
          </Text>
          {job.status !== "closed" && (
            <Ionicons name="chevron-forward" size={14} color={STATUS_COLORS[job.status] ?? colors.orange} />
          )}
        </TouchableOpacity>
      </View>

      {/* Tab Bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBar}
        contentContainerStyle={styles.tabBarContent}
      >
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Ionicons
              name={tab.icon as any}
              size={16}
              color={activeTab === tab.key ? colors.orange : colors.textMuted}
            />
            <Text
              style={[
                styles.tabLabel,
                activeTab === tab.key && styles.tabLabelActive,
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Tab Content */}
      <View style={{ flex: 1 }}>
        {activeTab === "overview" && <OverviewTab job={job} />}
        {activeTab !== "overview" && (
          // Deep-link to sub-route screens
          <View style={styles.deepLinkContainer}>
            <Link
              href={`/job/${job.id}/${activeTab}` as any}
              style={styles.deepLinkBtn}
            >
              <Text style={styles.deepLinkText}>
                Open {TABS.find((t) => t.key === activeTab)?.label}
              </Text>
            </Link>
          </View>
        )}
      </View>
    </View>
  );
}

function OverviewTab({ job }: { job: Job }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md }}>
      <InfoGroup title="Loss Details">
        <InfoRow label="Date of Loss" value={formatAlaskaDate(job.date_of_loss)} />
        <InfoRow label="Loss Type" value={job.loss_type?.toUpperCase() ?? "—"} />
        <InfoRow label="Category" value={job.loss_category?.toUpperCase() ?? "—"} />
      </InfoGroup>

      <InfoGroup title="Property Owner">
        <InfoRow label="Name" value={job.owner_name ?? "—"} />
        <InfoRow label="Phone" value={job.owner_phone ?? "—"} />
        <InfoRow label="Email" value={job.owner_email ?? "—"} />
      </InfoGroup>

      <InfoGroup title="Insurance">
        <InfoRow label="Carrier" value={job.insurance_carrier ?? "—"} />
        <InfoRow label="Claim #" value={job.claim_number ?? "—"} />
        <InfoRow label="Adjuster" value={job.adjuster_name ?? "—"} />
        <InfoRow label="Adj. Phone" value={job.adjuster_phone ?? "—"} />
      </InfoGroup>

      {job.notes ? (
        <InfoGroup title="Notes">
          <Text style={styles.notesText}>{job.notes}</Text>
        </InfoGroup>
      ) : null}

      <Text style={styles.metaText}>
        Created {formatAlaskaDateTime(job.created_at)}
      </Text>
    </ScrollView>
  );
}

function InfoGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.groupBody}>{children}</View>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    paddingTop: 48,
    backgroundColor: colors.navyDark,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  backBtn: { padding: 4 },
  jobNumber: { fontSize: 11, color: colors.textMuted, fontWeight: "700", letterSpacing: 1 },
  address: { fontSize: 15, color: colors.textPrimary, fontWeight: "700" },
  statusBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.full,
    gap: 4,
  },
  statusLabel: { fontSize: 12, fontWeight: "700" },
  tabBar: {
    backgroundColor: colors.navyDark,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    maxHeight: 52,
  },
  tabBarContent: { paddingHorizontal: spacing.md, gap: 4 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: colors.orange },
  tabLabel: { fontSize: 13, color: colors.textMuted, fontWeight: "600" },
  tabLabelActive: { color: colors.orange },
  group: {
    backgroundColor: colors.navyDark,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textMuted,
    letterSpacing: 1,
    marginBottom: 12,
  },
  groupBody: { gap: 8 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  infoLabel: { fontSize: 13, color: colors.textSecondary, flex: 0.4 },
  infoValue: { fontSize: 13, color: colors.textPrimary, fontWeight: "600", flex: 0.6, textAlign: "right" },
  notesText: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  metaText: { fontSize: 11, color: colors.textMuted, textAlign: "center", marginTop: 8 },
  deepLinkContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
  deepLinkBtn: {
    backgroundColor: colors.orange,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: radius.md,
  },
  deepLinkText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
