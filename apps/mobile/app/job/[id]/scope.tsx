/**
 * Scope / Line Item Builder — Xactimate-style per-room line items.
 * Supports T&M and scope billing. Running totals with grand total.
 */

import { useEffect, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Modal, TextInput, ScrollView, Alert, ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../src/lib/supabase";
import { colors, spacing, radius } from "../../../src/lib/theme";
import type { LineItem, Room, BillingType } from "@roybal/shared";
import { centsToDisplay, dollarsToCents } from "@roybal/shared";

const CATEGORIES = ["Demo", "Drying", "Structural", "Contents", "Cleaning", "Labor", "Materials", "Other"];
const UNITS = ["SF", "LF", "SY", "EA", "HR", "DAY", "LS", "CF"];

export default function ScopeScreen() {
  const { id: jobId } = useLocalSearchParams<{ id: string }>();
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    description: "",
    category: "Demo",
    room_id: "",
    quantity: "1",
    unit: "SF",
    unit_price_dollars: "",
    billing_type: "scope" as BillingType,
    notes: "",
  });

  const fetchData = useCallback(async () => {
    if (!jobId) return;
    const [li, r] = await Promise.all([
      supabase.from("line_items").select("*").eq("job_id", jobId).order("sort_order").order("created_at"),
      supabase.from("rooms").select("*").eq("job_id", jobId).order("name"),
    ]);
    if (!li.error) setLineItems((li.data ?? []) as LineItem[]);
    if (!r.error) setRooms((r.data ?? []) as Room[]);
    setLoading(false);
  }, [jobId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const saveLineItem = async () => {
    if (!form.description.trim() || !form.unit_price_dollars) {
      Alert.alert("Required", "Description and unit price are required.");
      return;
    }
    const qty = parseFloat(form.quantity);
    const unitPrice = dollarsToCents(form.unit_price_dollars);
    if (isNaN(qty) || qty <= 0 || isNaN(unitPrice) || unitPrice <= 0) {
      Alert.alert("Invalid", "Quantity and unit price must be positive numbers.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("line_items").insert({
      job_id: jobId,
      room_id: form.room_id || null,
      description: form.description.trim(),
      category: form.category,
      quantity: qty,
      unit: form.unit,
      unit_price: unitPrice,
      billing_type: form.billing_type,
      notes: form.notes.trim() || null,
      sort_order: lineItems.length,
    });
    setSaving(false);
    if (error) { Alert.alert("Error", error.message); return; }
    setModalVisible(false);
    setForm({ description: "", category: "Demo", room_id: "", quantity: "1", unit: "SF", unit_price_dollars: "", billing_type: "scope", notes: "" });
    await fetchData();
  };

  const deleteItem = (item: LineItem) => {
    Alert.alert("Delete Line Item", `Remove "${item.description}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          await supabase.from("line_items").delete().eq("id", item.id);
          await fetchData();
        },
      },
    ]);
  };

  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
  const grandTotal = lineItems.reduce((sum, li) => sum + li.total_cents, 0);

  // Group by room
  const byRoom: Record<string, LineItem[]> = {};
  lineItems.forEach((li) => {
    const key = li.room_id ?? "__general__";
    if (!byRoom[key]) byRoom[key] = [];
    byRoom[key]?.push(li);
  });

  const renderItem = ({ item }: { item: LineItem }) => (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowDesc}>{item.description}</Text>
        <Text style={styles.rowMeta}>
          {item.quantity} {item.unit} × {centsToDisplay(item.unit_price)} · {item.category} · {item.billing_type.toUpperCase()}
        </Text>
        {item.room_id && <Text style={styles.rowRoom}>{roomMap[item.room_id] ?? ""}</Text>}
      </View>
      <Text style={styles.rowTotal}>{centsToDisplay(item.total_cents)}</Text>
      <TouchableOpacity onPress={() => deleteItem(item)} style={{ marginLeft: 8, padding: 4 }}>
        <Ionicons name="trash-outline" size={16} color={colors.danger + "88"} />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Total bar */}
      <View style={styles.totalBar}>
        <View>
          <Text style={styles.totalLabel}>Grand Total</Text>
          <Text style={styles.totalAmount}>{centsToDisplay(grandTotal)}</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setModalVisible(true)}>
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={styles.addBtnText}>Add Line Item</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.orange} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={lineItems}
          keyExtractor={(li) => li.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.border }} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="list-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>No line items yet</Text>
            </View>
          }
        />
      )}

      {/* Add Modal */}
      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Line Item</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <Text style={styles.fieldLabel}>Description *</Text>
              <TextInput style={styles.input} placeholder="Remove and dispose of wet drywall" placeholderTextColor={colors.textMuted}
                value={form.description} onChangeText={(v) => setForm((p) => ({ ...p, description: v }))} />

              <Text style={styles.fieldLabel}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity key={c} style={[styles.pill, form.category === c && styles.pillActive]}
                    onPress={() => setForm((p) => ({ ...p, category: c }))}>
                    <Text style={[styles.pillText, form.category === c && { color: colors.orange }]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={styles.fieldLabel}>Room</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                <TouchableOpacity style={[styles.pill, !form.room_id && styles.pillActive]}
                  onPress={() => setForm((p) => ({ ...p, room_id: "" }))}>
                  <Text style={[styles.pillText, !form.room_id && { color: colors.orange }]}>All / General</Text>
                </TouchableOpacity>
                {rooms.map((r) => (
                  <TouchableOpacity key={r.id} style={[styles.pill, form.room_id === r.id && styles.pillActive]}
                    onPress={() => setForm((p) => ({ ...p, room_id: r.id }))}>
                    <Text style={[styles.pillText, form.room_id === r.id && { color: colors.orange }]}>{r.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Quantity *</Text>
                  <TextInput style={styles.input} placeholder="1" placeholderTextColor={colors.textMuted}
                    value={form.quantity} onChangeText={(v) => setForm((p) => ({ ...p, quantity: v }))}
                    keyboardType="decimal-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Unit Price ($) *</Text>
                  <TextInput style={styles.input} placeholder="2.50" placeholderTextColor={colors.textMuted}
                    value={form.unit_price_dollars} onChangeText={(v) => setForm((p) => ({ ...p, unit_price_dollars: v }))}
                    keyboardType="decimal-pad" />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Unit</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 14 }}>
                {UNITS.map((u) => (
                  <TouchableOpacity key={u} style={[styles.pill, form.unit === u && styles.pillActive]}
                    onPress={() => setForm((p) => ({ ...p, unit: u }))}>
                    <Text style={[styles.pillText, form.unit === u && { color: colors.orange }]}>{u}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Preview total */}
              {form.quantity && form.unit_price_dollars && (
                <View style={styles.previewTotal}>
                  <Text style={styles.previewLabel}>Line Total:</Text>
                  <Text style={styles.previewAmount}>
                    {centsToDisplay(Math.round((parseFloat(form.quantity) || 0) * dollarsToCents(form.unit_price_dollars || "0")))}
                  </Text>
                </View>
              )}

              <Text style={styles.fieldLabel}>Billing Type</Text>
              <View style={{ flexDirection: "row", gap: 10, marginBottom: 14 }}>
                {(["scope", "tm"] as BillingType[]).map((bt) => (
                  <TouchableOpacity key={bt} style={[styles.pill, form.billing_type === bt && styles.pillActive]}
                    onPress={() => setForm((p) => ({ ...p, billing_type: bt }))}>
                    <Text style={[styles.pillText, form.billing_type === bt && { color: colors.orange }]}>
                      {bt === "tm" ? "T&M" : "Scope"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={saveLineItem} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Add to Scope</Text>}
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
  totalBar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: spacing.md, backgroundColor: colors.navyDark,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  totalLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, letterSpacing: 0.5 },
  totalAmount: { fontSize: 22, fontWeight: "900", color: colors.orange, marginTop: 2 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.orange,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md,
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  list: { paddingBottom: 24 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: colors.navyDark,
  },
  rowDesc: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
  rowMeta: { fontSize: 11, color: colors.textMuted, marginTop: 3 },
  rowRoom: { fontSize: 11, color: colors.orange, marginTop: 2 },
  rowTotal: { fontSize: 15, fontWeight: "800", color: colors.textPrimary, fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", marginTop: 64, gap: 8 },
  emptyText: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },
  modalOverlay: { flex: 1, backgroundColor: "#000000BB", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.navyDark, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.lg, maxHeight: "92%", borderTopWidth: 1, borderColor: colors.border,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginBottom: 8 },
  input: {
    backgroundColor: colors.navy, borderRadius: radius.md, height: 48,
    paddingHorizontal: 14, color: colors.textPrimary, fontSize: 15,
    borderWidth: 1, borderColor: colors.border, marginBottom: 14,
  },
  pill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full,
    backgroundColor: colors.navy, borderWidth: 1, borderColor: colors.border,
  },
  pillActive: { borderColor: colors.orange },
  pillText: { fontSize: 13, fontWeight: "600", color: colors.textMuted },
  previewTotal: {
    flexDirection: "row", justifyContent: "space-between",
    backgroundColor: colors.orange + "15", borderRadius: radius.md,
    padding: 12, marginBottom: 14,
  },
  previewLabel: { fontSize: 13, color: colors.orange, fontWeight: "600" },
  previewAmount: { fontSize: 16, color: colors.orange, fontWeight: "900" },
  saveBtn: {
    backgroundColor: colors.orange, borderRadius: radius.md,
    height: 52, alignItems: "center", justifyContent: "center", marginTop: 8,
  },
  saveBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
