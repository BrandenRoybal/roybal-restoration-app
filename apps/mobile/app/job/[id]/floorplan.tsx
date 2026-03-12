/**
 * Floor Plan Viewer — shows synced Magicplan floor plan.
 * Manual sync button + auto-sync via webhook.
 * Supports zoomable image on mobile.
 */

import { useEffect, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, ScrollView, Linking,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../src/lib/supabase";
import { colors, spacing, radius } from "../../../src/lib/theme";
import type { FloorPlan, Job } from "@roybal/shared";
import { formatAlaskaDateTime } from "@roybal/shared";
import { MagicplanService } from "@roybal/shared";

const MAGICPLAN_API_KEY = process.env.EXPO_PUBLIC_MAGICPLAN_API_KEY ?? "";
const MAGICPLAN_CUSTOMER_ID = process.env.EXPO_PUBLIC_MAGICPLAN_CUSTOMER_ID ?? "";

export default function FloorPlanScreen() {
  const { id: jobId } = useLocalSearchParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchData = useCallback(async () => {
    if (!jobId) return;
    const [j, fp] = await Promise.all([
      supabase.from("jobs").select("id,magicplan_project_id,job_number").eq("id", jobId).single(),
      supabase.from("floor_plans").select("*").eq("job_id", jobId).order("version", { ascending: false }),
    ]);
    if (!j.error && j.data) setJob(j.data as Job);
    if (!fp.error) setFloorPlans((fp.data ?? []) as FloorPlan[]);
    setLoading(false);
  }, [jobId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSync = async () => {
    if (!job?.magicplan_project_id) {
      Alert.alert(
        "No Magicplan Project",
        "This job isn't linked to a Magicplan project yet. Link it from the web admin or have a tech create the floor plan in Magicplan first."
      );
      return;
    }

    if (!MAGICPLAN_API_KEY) {
      Alert.alert("Config Missing", "Magicplan API key is not configured.");
      return;
    }

    setSyncing(true);
    try {
      const mp = new MagicplanService(MAGICPLAN_API_KEY, MAGICPLAN_CUSTOMER_ID);
      const { fileUrl, fileType } = await mp.syncFloorPlan(job.magicplan_project_id);

      if (!fileUrl) {
        Alert.alert("No Files", "No floor plan files found in Magicplan for this project.");
        setSyncing(false);
        return;
      }

      // Get current max version
      const latestVersion = floorPlans[0]?.version ?? 0;
      const nextVersion = latestVersion + 1;

      const { error } = await supabase.from("floor_plans").insert({
        job_id: jobId,
        magicplan_project_id: job.magicplan_project_id,
        file_url: fileUrl,
        storage_path: null, // Direct URL from Magicplan, not uploaded to storage
        version: nextVersion,
        synced_at: new Date().toISOString(),
      });

      if (error) throw error;
      await fetchData();
      Alert.alert("Synced!", `Floor plan v${nextVersion} synced from Magicplan.`);
    } catch (err) {
      Alert.alert("Sync Failed", String(err));
    } finally {
      setSyncing(false);
    }
  };

  const latestPlan = floorPlans[0];

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Floor Plan</Text>
          {job?.magicplan_project_id ? (
            <Text style={styles.headerSub}>Magicplan ID: {job.magicplan_project_id}</Text>
          ) : (
            <Text style={[styles.headerSub, { color: colors.warning }]}>No Magicplan project linked</Text>
          )}
        </View>
        <TouchableOpacity
          style={[styles.syncBtn, syncing && { opacity: 0.6 }]}
          onPress={handleSync}
          disabled={syncing}
        >
          {syncing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Ionicons name="sync" size={16} color="#fff" />
              <Text style={styles.syncBtnText}>Sync</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.orange} style={{ marginTop: 48 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Latest plan viewer */}
          {latestPlan ? (
            <View style={styles.planCard}>
              <View style={styles.planCardHeader}>
                <Text style={styles.planVersion}>Version {latestPlan.version}</Text>
                <Text style={styles.planDate}>Synced: {formatAlaskaDateTime(latestPlan.synced_at)}</Text>
              </View>

              {latestPlan.file_url ? (
                <TouchableOpacity
                  style={styles.openBtn}
                  onPress={() => Linking.openURL(latestPlan.file_url!)}
                >
                  <Ionicons name="open-outline" size={20} color={colors.orange} />
                  <Text style={styles.openBtnText}>Open Floor Plan</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.orange} />
                </TouchableOpacity>
              ) : (
                <View style={styles.noFileBox}>
                  <Text style={styles.noFileText}>File URL not available. Tap Sync to refresh.</Text>
                </View>
              )}
            </View>
          ) : (
            <View style={styles.emptyCard}>
              <Ionicons name="map-outline" size={56} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No Floor Plans Synced</Text>
              <Text style={styles.emptyBody}>
                {job?.magicplan_project_id
                  ? "Tap Sync to pull the latest floor plan from Magicplan."
                  : "Link a Magicplan project to this job from the web admin, then tap Sync."}
              </Text>
            </View>
          )}

          {/* Version history */}
          {floorPlans.length > 1 && (
            <View style={styles.historySection}>
              <Text style={styles.historyTitle}>Version History</Text>
              {floorPlans.slice(1).map((fp) => (
                <View key={fp.id} style={styles.historyRow}>
                  <Text style={styles.historyVersion}>v{fp.version}</Text>
                  <Text style={styles.historyDate}>{formatAlaskaDateTime(fp.synced_at)}</Text>
                  {fp.file_url && (
                    <TouchableOpacity onPress={() => Linking.openURL(fp.file_url!)}>
                      <Ionicons name="open-outline" size={16} color={colors.orange} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Magicplan info */}
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={18} color={colors.textMuted} />
            <Text style={styles.infoText}>
              Floor plans automatically update when you export from the Magicplan mobile app.
              You can also manually tap Sync at any time.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: spacing.md, backgroundColor: colors.navyDark,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  headerSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  syncBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.orange,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.md,
  },
  syncBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  content: { padding: spacing.md, paddingBottom: 48 },
  planCard: {
    backgroundColor: colors.navyDark, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: "hidden", marginBottom: spacing.md,
  },
  planCardHeader: {
    padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  planVersion: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  planDate: { fontSize: 11, color: colors.textMuted },
  openBtn: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md,
    backgroundColor: colors.orange + "11",
  },
  openBtnText: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.orange },
  noFileBox: { padding: spacing.md },
  noFileText: { fontSize: 13, color: colors.textMuted },
  emptyCard: {
    backgroundColor: colors.navyDark, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 40,
    alignItems: "center", gap: 12, marginBottom: spacing.md,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.textSecondary },
  emptyBody: { fontSize: 13, color: colors.textMuted, textAlign: "center", lineHeight: 20 },
  historySection: { marginBottom: spacing.md },
  historyTitle: { fontSize: 12, fontWeight: "700", color: colors.textMuted, marginBottom: 8, letterSpacing: 0.5 },
  historyRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: colors.navyDark, borderRadius: radius.md,
    padding: 12, marginBottom: 6, borderWidth: 1, borderColor: colors.border,
  },
  historyVersion: { fontSize: 13, fontWeight: "700", color: colors.textSecondary },
  historyDate: { flex: 1, fontSize: 12, color: colors.textMuted },
  infoBox: {
    flexDirection: "row", gap: 10, backgroundColor: colors.navyDark,
    borderRadius: radius.md, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, alignItems: "flex-start",
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
});
