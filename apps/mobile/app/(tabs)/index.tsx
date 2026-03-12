/**
 * Job List screen — shows all jobs assigned to the current tech.
 * Filterable by status. Tap to open Job Detail.
 */

import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../src/lib/supabase";
import { useAuthStore } from "../../src/store/auth";
import { colors, spacing, radius } from "../../src/lib/theme";
import type { Job, JobStatus } from "@roybal/shared";
import { JOB_STATUS_LABELS, JOB_STATUS_ORDER, formatAlaskaDate } from "@roybal/shared";

const STATUS_COLORS: Record<JobStatus, string> = {
  new: "#64748B",
  active: colors.orange,
  drying: "#3B82F6",
  final_inspection: colors.warning,
  invoicing: "#A855F7",
  closed: colors.success,
};

const LOSS_TYPE_ICONS: Record<string, string> = {
  water: "water-outline",
  fire: "flame-outline",
  mold: "leaf-outline",
  smoke: "cloudy-outline",
  other: "help-circle-outline",
};

export default function JobListScreen() {
  const router = useRouter();
  const { profile } = useAuthStore();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">("all");

  const fetchJobs = useCallback(async () => {
    let query = supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const { data, error } = await query;
    if (!error && data) {
      setJobs(data as Job[]);
    }
    setLoading(false);
    setRefreshing(false);
  }, [statusFilter]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchJobs();
  };

  const filteredJobs = jobs.filter((j) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      j.property_address.toLowerCase().includes(q) ||
      j.job_number.toLowerCase().includes(q) ||
      (j.owner_name ?? "").toLowerCase().includes(q)
    );
  });

  const renderJob = ({ item }: { item: Job }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push(`/job/${item.id}`)}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[item.status] + "22" }]}>
          <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[item.status] }]} />
          <Text style={[styles.statusText, { color: STATUS_COLORS[item.status] }]}>
            {JOB_STATUS_LABELS[item.status]}
          </Text>
        </View>
        <Text style={styles.jobNumber}>{item.job_number}</Text>
      </View>

      <Text style={styles.address} numberOfLines={1}>{item.property_address}</Text>

      {item.owner_name ? (
        <Text style={styles.owner} numberOfLines={1}>
          <Ionicons name="person-outline" size={12} color={colors.textMuted} /> {item.owner_name}
        </Text>
      ) : null}

      <View style={styles.cardFooter}>
        <View style={styles.lossTag}>
          <Ionicons
            name={(LOSS_TYPE_ICONS[item.loss_type ?? "other"] ?? "help-circle-outline") as any}
            size={12}
            color={colors.textSecondary}
          />
          <Text style={styles.lossText}>
            {item.loss_type?.toUpperCase() ?? "—"}{" "}
            {item.loss_category ? `· ${item.loss_category.toUpperCase()}` : ""}
          </Text>
        </View>
        {item.date_of_loss ? (
          <Text style={styles.dateText}>DOL: {formatAlaskaDate(item.date_of_loss)}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search jobs, addresses…"
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Status filter chips */}
      <View style={styles.filterRow}>
        <TouchableOpacity
          style={[styles.chip, statusFilter === "all" && styles.chipActive]}
          onPress={() => setStatusFilter("all")}
        >
          <Text style={[styles.chipText, statusFilter === "all" && styles.chipTextActive]}>All</Text>
        </TouchableOpacity>
        {JOB_STATUS_ORDER.filter((s) => s !== "closed").map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.chip, statusFilter === s && styles.chipActive]}
            onPress={() => setStatusFilter(s)}
          >
            <Text style={[styles.chipText, statusFilter === s && styles.chipTextActive]}>
              {JOB_STATUS_LABELS[s]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.orange} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={filteredJobs}
          keyExtractor={(j) => j.id}
          renderItem={renderJob}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.orange}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="briefcase-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>No jobs found</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.navyDark,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 15 },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: 8,
    flexWrap: "wrap",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.navyDark,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.orange, borderColor: colors.orange },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  chipTextActive: { color: "#FFFFFF" },
  list: { paddingHorizontal: spacing.md, paddingBottom: 24 },
  card: {
    backgroundColor: colors.navyDark,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
    gap: 5,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  jobNumber: { fontSize: 12, color: colors.textMuted, fontWeight: "600" },
  address: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, marginBottom: 4 },
  owner: { fontSize: 13, color: colors.textSecondary, marginBottom: 8 },
  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  lossTag: { flexDirection: "row", alignItems: "center", gap: 4 },
  lossText: { fontSize: 11, color: colors.textSecondary, fontWeight: "600" },
  dateText: { fontSize: 11, color: colors.textMuted },
  empty: { alignItems: "center", marginTop: 64, gap: 12 },
  emptyText: { color: colors.textMuted, fontSize: 16 },
});
