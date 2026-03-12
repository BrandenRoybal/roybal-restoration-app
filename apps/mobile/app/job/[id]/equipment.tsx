/**
 * Equipment Log screen — place and remove equipment by room.
 * Flags items on-site > 7 days without a moisture check.
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
import type { EquipmentLog, Room, EquipmentType } from "@roybal/shared";
import { EQUIPMENT_TYPE_LABELS, formatAlaskaDate } from "@roybal/shared";

const EQUIPMENT_OPTIONS: EquipmentType[] = [
  "lgr_dehumidifier", "refrigerant_dehumidifier", "air_mover",
  "hepa_scrubber", "hepa_vac", "axial_fan", "other",
];

export default function EquipmentScreen() {
  const { id: jobId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuthStore();
  const [equipment, setEquipment] = useState<EquipmentLog[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    equipment_type: "air_mover" as EquipmentType,
    equipment_name: "",
    asset_number: "",
    serial_number: "",
    room_id: "",
  });

  const fetchData = useCallback(async () => {
    if (!jobId) return;
    const [e, r] = await Promise.all([
      supabase.from("equipment_logs").select("*").eq("job_id", jobId).order("date_placed"),
      supabase.from("rooms").select("*").eq("job_id", jobId).order("name"),
    ]);
    if (!e.error) setEquipment((e.data ?? []) as EquipmentLog[]);
    if (!r.error) setRooms((r.data ?? []) as Room[]);
    setLoading(false);
  }, [jobId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const saveEquipment = async () => {
    if (!form.equipment_name.trim()) {
      Alert.alert("Required", "Equipment name is required.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("equipment_logs").insert({
      job_id: jobId,
      room_id: form.room_id || null,
      equipment_type: form.equipment_type,
      equipment_name: form.equipment_name.trim(),
      asset_number: form.asset_number.trim() || null,
      serial_number: form.serial_number.trim() || null,
      date_placed: new Date().toISOString().split("T")[0],
      placed_by: user?.id,
    });
    setSaving(false);
    if (error) { Alert.alert("Error", error.message); return; }
    setModalVisible(false);
    setForm({ equipment_type: "air_mover", equipment_name: "", asset_number: "", serial_number: "", room_id: "" });
    await fetchData();
  };

  const markRemoved = (item: EquipmentLog) => {
    Alert.alert("Remove Equipment", `Mark "${item.equipment_name}" as removed today?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        onPress: async () => {
          await supabase.from("equipment_logs")
            .update({ date_removed: new Date().toISOString().split("T")[0] })
            .eq("id", item.id);
          await fetchData();
        },
      },
    ]);
  };

  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
  const active = equipment.filter((e) => !e.date_removed);
  const removed = equipment.filter((e) => e.date_removed);
  const totalActiveDays = active.reduce((sum, e) => sum + e.days_on_site, 0);

  const renderItem = ({ item }: { item: EquipmentLog }) => {
    const isActive = !item.date_removed;
    const flagged = isActive && item.days_on_site >= 7;
    return (
      <View style={[styles.card, flagged && styles.cardFlagged]}>
        <View style={styles.cardRow}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={styles.equipName}>{item.equipment_name}</Text>
              {flagged && (
                <View style={styles.flagBadge}>
                  <Ionicons name="warning" size={10} color={colors.warning} />
                  <Text style={styles.flagText}>7+ Days</Text>
                </View>
              )}
            </View>
            <Text style={styles.equipType}>{EQUIPMENT_TYPE_LABELS[item.equipment_type]}</Text>
            {item.asset_number && <Text style={styles.assetNum}>Asset: {item.asset_number}</Text>}
            {item.room_id && <Text style={styles.assetNum}>Room: {roomMap[item.room_id] ?? "—"}</Text>}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.daysText, { color: flagged ? colors.warning : colors.textPrimary }]}>
              {item.days_on_site}
            </Text>
            <Text style={styles.daysLabel}>days</Text>
          </View>
        </View>
        <View style={styles.cardFooter}>
          <Text style={styles.dateText}>Placed: {formatAlaskaDate(item.date_placed)}</Text>
          {isActive ? (
            <TouchableOpacity style={styles.removeBtn} onPress={() => markRemoved(item)}>
              <Ionicons name="log-out-outline" size={14} color={colors.danger} />
              <Text style={styles.removeBtnText}>Remove</Text>
            </TouchableOpacity>
          ) : (
            <Text style={[styles.dateText, { color: colors.success }]}>
              Removed: {formatAlaskaDate(item.date_removed)}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Summary */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryVal}>{active.length}</Text>
          <Text style={styles.summaryLbl}>Active</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryVal, { color: colors.warning }]}>
            {active.filter((e) => e.days_on_site >= 7).length}
          </Text>
          <Text style={styles.summaryLbl}>Flagged</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryVal}>{totalActiveDays}</Text>
          <Text style={styles.summaryLbl}>Total Days</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setModalVisible(true)}>
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={styles.addBtnText}>Place Equipment</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.orange} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={[...active, ...removed]}
          keyExtractor={(e) => e.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="hardware-chip-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>No equipment logged</Text>
            </View>
          }
        />
      )}

      {/* Add Modal */}
      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Place Equipment</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <Text style={styles.fieldLabel}>Equipment Type</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                {EQUIPMENT_OPTIONS.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.optionPill, form.equipment_type === t && styles.optionPillActive]}
                    onPress={() => setForm((p) => ({ ...p, equipment_type: t }))}
                  >
                    <Text style={[styles.optionPillText, form.equipment_type === t && { color: colors.orange }]}>
                      {EQUIPMENT_TYPE_LABELS[t]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={styles.fieldLabel}>Equipment Name *</Text>
              <TextInput style={styles.input} placeholder="Dri-Eaz LGR 7000XLi" placeholderTextColor={colors.textMuted}
                value={form.equipment_name} onChangeText={(v) => setForm((p) => ({ ...p, equipment_name: v }))} />

              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Asset #</Text>
                  <TextInput style={styles.input} placeholder="DRE-001" placeholderTextColor={colors.textMuted}
                    value={form.asset_number} onChangeText={(v) => setForm((p) => ({ ...p, asset_number: v }))} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Serial #</Text>
                  <TextInput style={styles.input} placeholder="SN123456" placeholderTextColor={colors.textMuted}
                    value={form.serial_number} onChangeText={(v) => setForm((p) => ({ ...p, serial_number: v }))} />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Room</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                <TouchableOpacity style={[styles.optionPill, !form.room_id && styles.optionPillActive]}
                  onPress={() => setForm((p) => ({ ...p, room_id: "" }))}>
                  <Text style={[styles.optionPillText, !form.room_id && { color: colors.orange }]}>No Room</Text>
                </TouchableOpacity>
                {rooms.map((r) => (
                  <TouchableOpacity key={r.id} style={[styles.optionPill, form.room_id === r.id && styles.optionPillActive]}
                    onPress={() => setForm((p) => ({ ...p, room_id: r.id }))}>
                    <Text style={[styles.optionPillText, form.room_id === r.id && { color: colors.orange }]}>{r.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={saveEquipment} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Place Equipment</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  summaryBar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: spacing.md, backgroundColor: colors.navyDark,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  summaryItem: { alignItems: "center" },
  summaryVal: { fontSize: 20, fontWeight: "800", color: colors.textPrimary },
  summaryLbl: { fontSize: 9, fontWeight: "700", color: colors.textMuted, marginTop: 1 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.orange,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md, marginLeft: "auto",
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  list: { padding: spacing.md, paddingBottom: 24 },
  card: {
    backgroundColor: colors.navyDark, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  cardFlagged: { borderColor: colors.warning + "66" },
  cardRow: { flexDirection: "row", gap: 12 },
  equipName: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
  equipType: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  assetNum: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  daysText: { fontSize: 28, fontWeight: "900" },
  daysLabel: { fontSize: 10, color: colors.textMuted, fontWeight: "600" },
  flagBadge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: colors.warning + "22", paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full,
  },
  flagText: { fontSize: 9, fontWeight: "700", color: colors.warning },
  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 },
  dateText: { fontSize: 11, color: colors.textMuted },
  removeBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  removeBtnText: { fontSize: 12, fontWeight: "700", color: colors.danger },
  empty: { alignItems: "center", marginTop: 64, gap: 8 },
  emptyText: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },
  modalOverlay: { flex: 1, backgroundColor: "#000000BB", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.navyDark, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.lg, maxHeight: "90%", borderTopWidth: 1, borderColor: colors.border,
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
  saveBtn: {
    backgroundColor: colors.orange, borderRadius: radius.md,
    height: 52, alignItems: "center", justifyContent: "center", marginTop: 8,
  },
  saveBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
