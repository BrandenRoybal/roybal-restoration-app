/**
 * Moisture Mapping screen — add and view moisture readings per room.
 * Color coded: red=wet, yellow=monitoring, green=dry (IICRC standards)
 */

import { useEffect, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Modal, TextInput, ScrollView, Alert, ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../src/lib/supabase";
import { useAuthStore } from "../../../src/store/auth";
import { colors, spacing, radius } from "../../../src/lib/theme";
import type { MoistureReading, Room } from "@roybal/shared";
import { getMoistureStatus, getDryStandard, formatAlaskaDate } from "@roybal/shared";

const STATUS_COLORS = { dry: colors.success, monitoring: colors.warning, wet: colors.danger };
const STATUS_ICONS = { dry: "checkmark-circle", monitoring: "alert-circle", wet: "close-circle" };

const COMMON_MATERIALS = ["Drywall", "Wood", "Hardwood", "Subfloor", "Concrete", "OSB", "Plywood", "Block"];

export default function MoistureScreen() {
  const { id: jobId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuthStore();
  const [readings, setReadings] = useState<MoistureReading[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form state
  const [form, setForm] = useState({
    room_id: "",
    location_description: "",
    material_type: "Drywall",
    moisture_pct: "",
  });

  const fetchData = useCallback(async () => {
    if (!jobId) return;
    const [r, m] = await Promise.all([
      supabase.from("rooms").select("*").eq("job_id", jobId).order("name"),
      supabase.from("moisture_readings").select("*").eq("job_id", jobId)
        .order("reading_date", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);
    if (!r.error) setRooms((r.data ?? []) as Room[]);
    if (!m.error) setReadings((m.data ?? []) as MoistureReading[]);
    setLoading(false);
  }, [jobId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openModal = () => {
    setForm({ room_id: rooms[0]?.id ?? "", location_description: "", material_type: "Drywall", moisture_pct: "" });
    setModalVisible(true);
  };

  const saveReading = async () => {
    if (!form.room_id || !form.location_description.trim() || !form.moisture_pct) {
      Alert.alert("Missing fields", "Please fill in all required fields.");
      return;
    }
    const pct = parseFloat(form.moisture_pct);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      Alert.alert("Invalid reading", "Moisture % must be between 0 and 100.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("moisture_readings").insert({
      job_id: jobId,
      room_id: form.room_id,
      location_description: form.location_description.trim(),
      material_type: form.material_type,
      moisture_pct: pct,
      reading_date: new Date().toISOString().split("T")[0],
      recorded_by: user?.id,
    });
    setSaving(false);
    if (error) { Alert.alert("Error", error.message); return; }
    setModalVisible(false);
    await fetchData();
  };

  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  // Summary stats
  const wet = readings.filter((r) => getMoistureStatus(r.moisture_pct, r.material_type) === "wet").length;
  const monitoring = readings.filter((r) => getMoistureStatus(r.moisture_pct, r.material_type) === "monitoring").length;
  const dry = readings.filter((r) => getMoistureStatus(r.moisture_pct, r.material_type) === "dry").length;

  const renderReading = ({ item }: { item: MoistureReading }) => {
    const status = getMoistureStatus(item.moisture_pct, item.material_type);
    const standard = getDryStandard(item.material_type);
    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.roomName}>{roomMap[item.room_id] ?? "Unknown Room"}</Text>
            <Text style={styles.location}>{item.location_description}</Text>
            <Text style={styles.material}>{item.material_type} · std ≤{standard.maxPct}%</Text>
          </View>
          <View style={styles.readingBlock}>
            <Text style={[styles.readingPct, { color: STATUS_COLORS[status] }]}>{item.moisture_pct}%</Text>
            <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[status] + "22" }]}>
              <Ionicons name={STATUS_ICONS[status] as any} size={12} color={STATUS_COLORS[status]} />
              <Text style={[styles.statusText, { color: STATUS_COLORS[status] }]}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </Text>
            </View>
          </View>
        </View>
        <Text style={styles.date}>{formatAlaskaDate(item.reading_date)}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <SummaryChip count={wet} label="Wet" color={colors.danger} />
        <SummaryChip count={monitoring} label="Monitoring" color={colors.warning} />
        <SummaryChip count={dry} label="Dry" color={colors.success} />
        <TouchableOpacity style={styles.addBtn} onPress={openModal}>
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={styles.addBtnText}>Add Reading</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.orange} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={readings}
          keyExtractor={(r) => r.id}
          renderItem={renderReading}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="water-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>No readings yet</Text>
              <Text style={styles.emptySubText}>Tap "Add Reading" to log moisture levels</Text>
            </View>
          }
        />
      )}

      {/* Add Reading Modal */}
      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Moisture Reading</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Room picker */}
              <Text style={styles.fieldLabel}>Room *</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                {rooms.map((r) => (
                  <TouchableOpacity
                    key={r.id}
                    style={[styles.optionPill, form.room_id === r.id && styles.optionPillActive]}
                    onPress={() => setForm((p) => ({ ...p, room_id: r.id }))}
                  >
                    <Text style={[styles.optionPillText, form.room_id === r.id && { color: colors.orange }]}>{r.name}</Text>
                  </TouchableOpacity>
                ))}
                {rooms.length === 0 && <Text style={{ color: colors.textMuted, fontSize: 12 }}>No rooms added to this job yet.</Text>}
              </ScrollView>

              {/* Location */}
              <Text style={styles.fieldLabel}>Location Description *</Text>
              <TextInput
                style={styles.input}
                placeholder="North wall base, subfloor center…"
                placeholderTextColor={colors.textMuted}
                value={form.location_description}
                onChangeText={(v) => setForm((p) => ({ ...p, location_description: v }))}
              />

              {/* Material */}
              <Text style={styles.fieldLabel}>Material Type *</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                {COMMON_MATERIALS.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.optionPill, form.material_type === m && styles.optionPillActive]}
                    onPress={() => setForm((p) => ({ ...p, material_type: m }))}
                  >
                    <Text style={[styles.optionPillText, form.material_type === m && { color: colors.orange }]}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Moisture % */}
              <Text style={styles.fieldLabel}>Moisture % *</Text>
              <View style={styles.pctRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="0.0"
                  placeholderTextColor={colors.textMuted}
                  value={form.moisture_pct}
                  onChangeText={(v) => setForm((p) => ({ ...p, moisture_pct: v }))}
                  keyboardType="decimal-pad"
                />
                {form.moisture_pct ? (
                  <View style={[styles.previewBadge, { backgroundColor: STATUS_COLORS[getMoistureStatus(parseFloat(form.moisture_pct) || 0, form.material_type)] + "22" }]}>
                    <Text style={{ color: STATUS_COLORS[getMoistureStatus(parseFloat(form.moisture_pct) || 0, form.material_type)], fontWeight: "700", fontSize: 13 }}>
                      {getMoistureStatus(parseFloat(form.moisture_pct) || 0, form.material_type).toUpperCase()}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* Dry standard hint */}
              <Text style={styles.standardHint}>
                Dry standard for {form.material_type}: ≤ {getDryStandard(form.material_type).maxPct}%
              </Text>

              <TouchableOpacity
                style={[styles.saveBtn, saving && { opacity: 0.6 }]}
                onPress={saveReading}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>Save Reading</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SummaryChip({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <View style={[styles.summaryChip, { backgroundColor: color + "18" }]}>
      <Text style={[styles.summaryCount, { color }]}>{count}</Text>
      <Text style={[styles.summaryLabel, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  summaryBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: spacing.md, backgroundColor: colors.navyDark,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  summaryChip: {
    alignItems: "center", paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.md, minWidth: 50,
  },
  summaryCount: { fontSize: 18, fontWeight: "800" },
  summaryLabel: { fontSize: 9, fontWeight: "700", marginTop: 1 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.orange, paddingHorizontal: 14,
    paddingVertical: 9, borderRadius: radius.md, marginLeft: "auto",
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  list: { padding: spacing.md, paddingBottom: 24 },
  card: {
    backgroundColor: colors.navyDark, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: colors.border,
  },
  cardTop: { flexDirection: "row", gap: 12 },
  roomName: { fontSize: 14, fontWeight: "700", color: colors.textPrimary },
  location: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  material: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  readingBlock: { alignItems: "flex-end" },
  readingPct: { fontSize: 24, fontWeight: "900" },
  statusBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, marginTop: 4,
  },
  statusText: { fontSize: 10, fontWeight: "700" },
  date: { fontSize: 11, color: colors.textMuted, marginTop: 8 },
  empty: { alignItems: "center", marginTop: 64, gap: 8 },
  emptyText: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },
  emptySubText: { color: colors.textMuted, fontSize: 13 },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: "#000000BB", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.navyDark, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.lg, maxHeight: "90%",
    borderTopWidth: 1, borderColor: colors.border,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginBottom: 8 },
  input: {
    backgroundColor: colors.navy, borderRadius: radius.md, height: 48,
    paddingHorizontal: 14, color: colors.textPrimary, fontSize: 15,
    borderWidth: 1, borderColor: colors.border, marginBottom: 14,
  },
  optionPill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full,
    backgroundColor: colors.navy, borderWidth: 1, borderColor: colors.border,
  },
  optionPillActive: { borderColor: colors.orange },
  optionPillText: { fontSize: 13, fontWeight: "600", color: colors.textMuted },
  pctRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  previewBadge: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md },
  standardHint: { fontSize: 11, color: colors.textMuted, marginBottom: 20 },
  saveBtn: {
    backgroundColor: colors.orange, borderRadius: radius.md,
    height: 52, alignItems: "center", justifyContent: "center", marginTop: 8,
  },
  saveBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
